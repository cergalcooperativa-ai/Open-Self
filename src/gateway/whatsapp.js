/**
 * Open-Self WhatsApp Gateway - Passive Learning + Active Responding
 *
 * Architecture:
 * 1. Universal Learning (Passive) - learns from ALL incoming messages, isolated by contact key.
 *    The allowlist/trigger/kill-switch NEVER gate learning, only replying.
 * 2. Trigger-based State Management - " ." (ON) / " ," (OFF), sent BY THE OWNER only.
 *    Default for every chat is mute (trigger-states.json missing/false).
 * 3. Just-in-Time Personality Creation - when a chat is activated and has no profile in
 *    contacts.json, the accumulated history is analysed by the LLM and the profile is saved.
 * 4. Strict Isolation - all memory/RAG strictly isolated by contact key.
 */

import chalk from 'chalk';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { ConversationMemory } from '../memory/conversation.js';
import { ChatMemory } from '../memory/rag.js';
import { ClonePipeline } from '../pipeline/clone.js';
import { GhostMode } from '../ghost/ghost.js';
import { createProvider, autoDetectProvider } from '../brain/router.js';
import OpenAI, { toFile } from 'openai';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import { AdminController } from './admin-controller.js';

const SYSTEM_EVENT_RE =
  /^(mensagem apagada|mensagem editada|voc\u00ea apagou|\u00e1udio ocultado|imagem ocultada|v\u00eddeo omitido|liga\u00e7\u00e3o de voz( perdida| silenciada)?|missed (voice|video) call|you deleted|this message was deleted)/i;

const MARKER_REPLIES = new Set(['[TRIGGER]', '[PENDING_REPLY]', '']);

export class WhatsAppGateway {
  constructor(config = {}) {
    // Handle both calling conventions:
    // Option 1 (new): new WhatsAppGateway(config) - config object from loadConfig()
    // Option 2 (legacy): new WhatsAppGateway(sessionDir, pipeline, ghost) - legacy
    const isLegacyCall = typeof arguments[0] === 'string' || arguments[1] || arguments[2];

    let finalConfig = {};
    if (isLegacyCall) {
      // Legacy: (sessionDir, pipeline, ghost)
      finalConfig = {
        sessionDir: arguments[0],
        pipeline: arguments[1],
        ghost: arguments[2],
        dataDir: './data'
      };
    } else {
      // New style: config object from loadConfig()
      const cfg = arguments[0] || {};
      finalConfig = {
        sessionDir: cfg.sessionDir || join(cfg.data?.dir || cfg.dataDir || './data', 'whatsapp-session'),
        pipeline: cfg.pipeline,
        ghost: cfg.ghost,
        dataDir: cfg.data?.dir || cfg.dataDir || './data',
        appConfig: cfg
      };
    }

    this.sessionDir = finalConfig.sessionDir;
    this.appConfig = finalConfig.appConfig || {};
    this.now = () => new Date(); // injectable clock (tests)
    this.pipeline = finalConfig.pipeline || new ClonePipeline({ config: finalConfig.appConfig });
    this.ghost = finalConfig.ghost || new GhostMode(finalConfig.dataDir);
    this.sock = null;
    this.stats = { received: 0, replied: 0, ignored: 0, queued: 0 };
    this.conversationMemory = new ConversationMemory(join(finalConfig.dataDir, '..', 'data'));
    this.chatMemory = new ChatMemory(join(finalConfig.dataDir, '..', 'data'));

    // File paths - ensure data directory is string
    const dataDir = finalConfig.dataDir;
    this.dataDir = dataDir;
    this.contactsFile = join(dataDir, 'contacts.json');
    this.triggersFile = join(dataDir, 'trigger-states.json');
    this.jidMapFile = join(dataDir, 'jid-map.json');
    this.responsesDisabledFile = join(dataDir, 'RESPONSES_DISABLED');
    this.heartbeatFile = join(dataDir, 'heartbeat.json');

    // Operator presence & audio helpers
    this.downloadMediaMessage = finalConfig.downloadMediaMessage || downloadMediaMessage;
    this.toFile = finalConfig.toFile || toFile;
    this.operatorCooldownMs = Number(process.env.OPENSELF_OPERATOR_COOLDOWN_MS ?? 180000);
    this._lastOperatorActivity = 0;

    // ids of messages sent by the bot itself (echoes must never be read as owner triggers)
    this.sentIds = new Set();
    this._jitInFlight = new Map();
    this._stopped = false;

    // Self-Chat Control Panel (v1.4.0)
    this.sessionOwnerNumber = finalConfig.sessionOwnerNumber || process.env.OPENSELF_OWNER_NUMBER || null;
    this.adminController = finalConfig.adminController || new AdminController(this);

    // Message batching: a burst of messages from the same contact is merged into ONE reply.
    // Window = silence after the last message (random between min/max, hard-capped).
    // OPENSELF_BATCH_MAX_MS=0 disables batching (immediate reply per message).
    this.batchMinMs = Number(process.env.OPENSELF_BATCH_MIN_MS ?? 5000);
    this.batchMaxMs = Number(process.env.OPENSELF_BATCH_MAX_MS ?? 9000);
    this.batchCapMs = Number(process.env.OPENSELF_BATCH_CAP_MS ?? 60000);
    this._pending = new Map(); // contactKey -> { contactName, texts, firstAt, msg, timer, deferred }
    this._inFlight = new Map(); // contactKey -> Promise of the reply job being generated/sent

    this.loadContacts();
    this.loadTriggers();
    this.loadJidMap();
    this.wirePipeline();
  }

  /**
   * Make sure the (gateway-owned) pipeline has memory + an LLM. Without this the
   * pipeline silently falls back to canned replies and the JIT profile never runs.
   */
  wirePipeline() {
    try {
      if (typeof this.pipeline.setMemory === 'function' && !this.pipeline.chatMemory) {
        this.pipeline.setMemory(this.conversationMemory, this.chatMemory);
      }
      if (typeof this.pipeline.setBrain === 'function' && !this.pipeline.brain) {
        const providerName = autoDetectProvider();
        const provider = createProvider(process.env.LLM_PROVIDER || providerName);
        this.pipeline.setBrain({
          generate: (systemPrompt, userMessage) => provider.chat(systemPrompt, userMessage)
        });
      }
    } catch (e) {
      console.log(chalk.yellow('   [LLM] Nao foi possivel configurar o provider: ' + e.message));
    }
  }

  loadContacts() {
    let raw = {};
    try {
      raw = JSON.parse(readFileSync(this.contactsFile, 'utf-8'));
    } catch {
      raw = {};
    }
    // exports BR gravam "~Nome": re-chaveia pela forma normalizada que o gateway usa
    this.contacts = {};
    for (const [name, profile] of Object.entries(raw)) {
      const key = this.normalizeContact(name);
      if (!(key in this.contacts) || name === key) this.contacts[key] = profile;
    }
  }

  saveContacts() {
    this._ensureDataDir();
    writeFileSync(this.contactsFile, JSON.stringify(this.contacts, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  loadTriggers() {
    try {
      this.triggers = JSON.parse(readFileSync(this.triggersFile, 'utf-8'));
    } catch {
      this.triggers = {};
    }
  }

  saveTriggers() {
    this._ensureDataDir();
    writeFileSync(this.triggersFile, JSON.stringify(this.triggers, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  loadJidMap() {
    try {
      this.jidMap = JSON.parse(readFileSync(this.jidMapFile, 'utf-8'));
    } catch {
      this.jidMap = {};
    }
  }

  saveJidMap() {
    this._ensureDataDir();
    writeFileSync(this.jidMapFile, JSON.stringify(this.jidMap, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  _ensureDataDir() {
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
  }

  // Record active heartbeat and operator activity
  recordHeartbeat() {
    try {
      const now = this.now ? this.now() : new Date();
      const ts = now.getTime();
      this._lastOperatorActivity = ts;
      const data = {
        online: true,
        lastSeen: now.toISOString(),
        timestamp: ts
      };
      this._ensureDataDir();
      writeFileSync(this.heartbeatFile, JSON.stringify(data, null, 2), 'utf-8');
      if (this.ghost && typeof this.ghost.ping === 'function') {
        this.ghost.ping();
      }
    } catch (e) {
      console.log(chalk.yellow('   [HEARTBEAT] Falha ao gravar heartbeat: ' + e.message));
    }
  }

  // Remaining ms of the 3-minute cooldown after the operator's last manual message
  getOperatorCooldownRemaining() {
    let lastActivity = this._lastOperatorActivity;
    if (!lastActivity) {
      try {
        if (existsSync(this.heartbeatFile)) {
          const hb = JSON.parse(readFileSync(this.heartbeatFile, 'utf-8'));
          if (hb?.timestamp) lastActivity = Number(hb.timestamp);
        }
      } catch {}
    }
    if (!lastActivity) return 0;
    const now = this.now ? this.now().getTime() : Date.now();
    const elapsed = now - lastActivity;
    const cooldown = this.operatorCooldownMs;
    const remaining = cooldown - elapsed;
    return remaining > 0 ? remaining : 0;
  }

  // Automatic Audio Transcription via Groq (whisper-large-v3-turbo)
  async transcribeAudio(audioBuffer) {
    if (!audioBuffer || audioBuffer.length === 0) return '';
    try {
      const apiKey = process.env.OPENAI_API_KEY || this.appConfig.openaiApiKey;
      const baseURL = process.env.OPENAI_BASE_URL || this.appConfig.openaiBaseUrl || 'https://api.groq.com/openai/v1';
      if (!apiKey) {
        console.log(chalk.yellow('   [WHISPER] OPENAI_API_KEY nao configurada para transcricao'));
        return '';
      }
      if (!this._openaiClient || this._openaiKey !== apiKey || this._openaiBaseURL !== baseURL) {
        this._openaiKey = apiKey;
        this._openaiBaseURL = baseURL;
        this._openaiClient = new OpenAI({ apiKey, baseURL });
      }
      const toFileFn = this.toFile || toFile;
      const file = await toFileFn(audioBuffer, 'audio.ogg', { type: 'audio/ogg' });
      const res = await this._openaiClient.audio.transcriptions.create({
        file,
        model: process.env.OPENSELF_WHISPER_MODEL || 'whisper-large-v3-turbo'
      });
      const transcript = res?.text?.trim() || '';
      if (transcript) {
        console.log(chalk.cyan('   [WHISPER] Audio transcrito: "' + (transcript.length > 60 ? transcript.slice(0, 60) + '...' : transcript) + '"'));
      }
      return transcript;
    } catch (e) {
      console.log(chalk.yellow('   [WHISPER] Falha ao transcrever audio: ' + e.message));
      return '';
    }
  }

  // Normalize contact name (strip ~ prefix from BR exports)
  normalizeContact(name) {
    return String(name).replace(/^[~\s]+/, '').trim();
  }

  // Dynamic identity name of the connected WhatsApp owner session / clone
  getOwnerName() {
    if (this.sock?.user?.name) return this.sock.user.name;
    try {
      const soul = readFileSync(join(this.dataDir, 'SOUL.md'), 'utf-8');
      const m = soul.match(/Name:\s*([^\r\n]+)/i) || soul.match(/Nome:\s*([^\r\n]+)/i);
      if (m && m[1].trim()) return m[1].trim();
    } catch {}
    return this.appConfig?.ownerName || process.env.OPENSELF_NAME || 'Operador';
  }

  // Check if global kill-switch is active
  isGloballyDisabled() {
    return existsSync(this.responsesDisabledFile);
  }

  // Load trigger state for contact (default: false/OFF => bot is mute)
  getTriggerState(contactName) {
    const normalized = this.normalizeContact(contactName);
    return this.triggers[normalized] === true;
  }

  setTriggerState(contactName, active) {
    const normalized = this.normalizeContact(contactName);
    this.triggers[normalized] = active;
    this.saveTriggers();
  }

  // Verifica se o contato possui diretriz temporária ativa (TTL válido)
  hasActiveDirective(contactName) {
    const key = this.normalizeContact(contactName);
    const profile = this.contacts[key] || this.contacts[contactName];
    const td = profile?.transientDirective;
    if (!td || !td.directive || !td.expiresAt) return false;
    const exp = new Date(td.expiresAt);
    return !isNaN(exp.getTime()) && new Date() < exp;
  }

  // Identifica perguntas de risco sobre agenda física, compromissos ou horários
  isRiskQuestion(text) {
    const RISK_RE = /(que horas|onde\s+(?:tu|voc[eê]|vc)\s+t[aá]|vai\s+vir|vem\s+aqui|fez\s+o\s+contrato|quando\s+vai|vai\s+l[aá]|vai\s+passar)/i;
    return RISK_RE.test(String(text || ''));
  }

  // online_hours "HH:MM-HH:MM" from data/SOUL.md (fallback: config.onlineHours / 08-23)
  getOnlineHours() {
    let start = (this.appConfig.onlineHours?.start ?? 8) * 60;
    let end = (this.appConfig.onlineHours?.end ?? 23) * 60;
    try {
      const soul = readFileSync(join(this.dataDir, 'SOUL.md'), 'utf-8');
      const m = soul.match(/online_hours:\s*(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?/);
      if (m) {
        start = Number(m[1]) * 60 + Number(m[2] || 0);
        end = Number(m[3]) * 60 + Number(m[4] || 0);
      }
    } catch {}
    return { start, end };
  }

  isWithinOnlineHours() {
    const { start, end } = this.getOnlineHours();
    const tz = this.appConfig.timezone || process.env.OPENSELF_TZ || 'America/Sao_Paulo';
    const parts = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz
    }).formatToParts(this.now());
    const h = Number(parts.find((p) => p.type === 'hour').value);
    const mi = Number(parts.find((p) => p.type === 'minute').value);
    const cur = h * 60 + mi;
    if (start === end) return true;
    return start < end ? cur >= start && cur < end : cur >= start || cur < end;
  }

  // Detect owner triggers: "texto ." / "texto ," or a message that is only "." / ","
  // Returns { processedText, triggerAction: 'activate'|'deactivate'|null }
  processTriggers(text) {
    const trimmed = text.trim();
    if (trimmed === '.') return { processedText: '', triggerAction: 'activate' };
    if (trimmed === ',') return { processedText: '', triggerAction: 'deactivate' };
    if (trimmed.endsWith(' .')) {
      return { processedText: trimmed.slice(0, -2), triggerAction: 'activate' };
    }
    if (trimmed.endsWith(' ,')) {
      return { processedText: trimmed.slice(0, -2), triggerAction: 'deactivate' };
    }
    return { processedText: trimmed, triggerAction: null };
  }

  /**
   * Stable contact key for a 1:1 chat. The owner's trigger (fromMe) only carries the chat
   * JID while incoming messages carry pushName, so both sides resolve through jid-map.json.
   * Groups keep the participant name (replies there still require mention/quote).
   */
  resolveContactKey(msg) {
    const jid = msg.key.remoteJid || '';
    const isGroup = jid.endsWith('@g.us');
    const number = this.normalizeContact(jid.split('@')[0] || 'Unknown');

    if (msg.key.fromMe) {
      return this.jidMap[jid] || number;
    }
    const pushName = msg.pushName ? this.normalizeContact(msg.pushName) : '';
    if (isGroup) {
      return pushName || this.normalizeContact(msg.key.participant?.split('@')[0] || 'Unknown');
    }
    if (!this.jidMap[jid]) {
      // Do not assign the owner's own session name to an external contact
      const ownerName = this.getOwnerName();
      const safeName = (pushName && pushName.toLowerCase() !== ownerName.toLowerCase()) ? pushName : number;
      this.jidMap[jid] = safeName;
      this.saveJidMap();
    }
    return this.jidMap[jid];
  }

  // Main message handler
  async handleMessage(msg) {
    if (!msg.message) return;
    if (msg.key?.id && this.sentIds.has(msg.key.id)) return;

    const jid = msg.key.remoteJid || '';
    const isBroadcast = jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast');
    if (isBroadcast) return;

    let text = msg.message.conversation ||
                 msg.message.extendedTextMessage?.text ||
                 msg.message.imageMessage?.caption || '';

    // Interceptação automática de áudio via Whisper (Groq) — áudios diretos, efêmeros e visualização única
    const audioMsg = msg.message.audioMessage ||
                     msg.message.ephemeralMessage?.message?.audioMessage ||
                     msg.message.viewOnceMessage?.message?.audioMessage ||
                     msg.message.viewOnceMessageV2?.message?.audioMessage;
    if (audioMsg) {
      try {
        const downloadFn = this.downloadMediaMessage || downloadMediaMessage;
        const audioBuffer = await downloadFn(msg, 'buffer', {});
        if (audioBuffer) {
          const transcribed = await this.transcribeAudio(audioBuffer);
          if (transcribed) {
            text = transcribed;
          }
        }
      } catch (err) {
        console.log(chalk.yellow('   [WHISPER] Erro ao processar midia de audio: ' + err.message));
      }
    }

    if (!text.trim()) return;

    // 1. Skip system events
    if (SYSTEM_EVENT_RE.test(text.trim())) return;

    // === INTERCEPTAÇÃO EXCLUSIVA DO SELF-CHAT (PAINEL DE CONTROLE v1.4.0) ===
    const senderJid = msg.key.remoteJid || '';
    const ownerNumFromSock = this.sock?.user?.id ? this.sock.user.id.split('@')[0].split(':')[0] : null;
    if (ownerNumFromSock && !this.sessionOwnerNumber) {
      this.sessionOwnerNumber = ownerNumFromSock;
    }
    const effectiveOwnerNum = this.sessionOwnerNumber || ownerNumFromSock;
    const isSelfChat = senderJid === this.sock?.user?.id ||
                       (this.sock?.user?.lid && senderJid === this.sock.user.lid) ||
                       (Boolean(effectiveOwnerNum) && senderJid?.split('@')[0]?.split(':')[0] === effectiveOwnerNum);

    if (isSelfChat) {
      if (this.adminController && typeof this.adminController.handleCommand === 'function') {
        await this.adminController.handleCommand(text, msg);
      }
      return;
    }

    const isGroup = jid.endsWith('@g.us');

    // 2. FROM ME: owner triggers & manual messages (sent from phone)
    // Trava Absoluta de Autoridade: processTriggers só pode ser executada se:
    // - msg.key && msg.key.fromMe === true
    // - !this.sentIds.has(msg.key.id) (garantindo que mensagens geradas pelo próprio bot nunca acionem gatilhos)
    // - Não seja mensagem de grupo nem status/broadcast
    if (msg.key && msg.key.fromMe === true) {
      if (msg.key.id && this.sentIds.has(msg.key.id)) return;
      if (isGroup) return; // Grupo nunca processa gatilhos de ativação

      // Atualização Ativa do Heartbeat: operador enviou mensagem pelo celular
      this.recordHeartbeat();

      const { processedText, triggerAction } = this.processTriggers(text);
      const contactName = this.resolveContactKey(msg);
      if (!contactName) return;

      if (triggerAction === 'activate') {
        if (!this.jidMap[jid]) {
          this.jidMap[jid] = contactName;
          this.saveJidMap();
        }
        this.setTriggerState(contactName, true);
        await this.ensureProfile(contactName);

        // Se após remover o gatilho o texto for vazio (processedText.trim() === ''),
        // significa sinal silencioso para o bot assumir a conversa e responder pendências!
        if (processedText.trim() === '') {
          this._lastOperatorActivity = 0; // Handover explícito: libera o clone para responder imediatamente
          console.log(chalk.green('   [TRIGGER] Ativado silenciosamente para ' + contactName + ' (assumindo mensagens pendentes)'));

          const normalized = this.normalizeContact(contactName);
          const session = this.conversationMemory.sessions.get(normalized) || this.conversationMemory.sessions.get(contactName) || [];
          const pendingThem = [];
          for (let i = session.length - 1; i >= 0; i--) {
            if (session[i].clone === '[PENDING_REPLY]') {
              if (session[i].them) pendingThem.unshift(session[i].them);
            } else {
              break;
            }
          }

          const pendingBurst = this._pending.get(normalized);
          if (pendingBurst && pendingBurst.texts.length > 0) {
            this._flushPending(normalized).catch((e) => console.error(chalk.red('   [TRIGGER] Erro ao disparar resposta: ' + e.message)));
          } else if (pendingThem.length > 0) {
            const combinedText = pendingThem.join('\n');
            await this.queueReply(contactName, combinedText, msg, pendingThem);
          }
        } else {
          // Operador enviou texto real junto com o gatilho (ex: "Vou ver aqui .")
          this._cancelPending(contactName);
          await this.learnFromSelf(contactName, processedText);
          console.log(chalk.green('   [TRIGGER] Ativado para ' + contactName + ' com mensagem do operador'));
        }
      } else if (triggerAction === 'deactivate') {
        this._cancelPending(contactName);
        this.setTriggerState(contactName, false);
        if (processedText.trim() !== '') {
          await this.learnFromSelf(contactName, processedText);
        }
        console.log(chalk.yellow('   [TRIGGER] Desativado para ' + contactName + ' (pelo dono da sessao)'));
      } else {
        // Mensagem normal do dono pelo celular (sem gatilho): registra como fala do operador
        this._cancelPending(contactName);
        if (processedText.trim() !== '') {
          await this.learnFromSelf(contactName, processedText);
        }
      }
      return;
    }

    this.stats.received++;

    // 3. FROM OTHERS - Universal Learning (ALWAYS learns, before any gate).
    //    Mensagens de terceiros JAMAIS passam por processTriggers nem alteram trigger-states.
    const normalizedSender = this.resolveContactKey(msg);
    const processedText = text.trim();
    if (!processedText) return;

    await this.learnFromContact(normalizedSender, processedText);

    // 4. Should we respond? (mute by default)
    if (this.isGloballyDisabled()) {
      this.stats.ignored++;
      return;
    }

    if (!this.getTriggerState(normalizedSender)) {
      this.stats.ignored++;
      return;
    }

    // Group check
    if (jid.endsWith('@g.us')) {
      const mentionedMe = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.some(
        (j) => j === this.sock?.user?.id
      );
      const quotedMe = msg.message.extendedTextMessage?.contextInfo?.participant === this.sock?.user?.id;
      if (!mentionedMe && !quotedMe) {
        this.stats.ignored++;
        return;
      }
    }

    // Owner's explicit trigger (" .") is sovereign over ghost mode's inactivity timer.
    // By default, the owner's manual activation has absolute sovereignty even during nighttime.
    // Only if OPENSELF_ENFORCE_ONLINE_HOURS === '1' or 'true' will it enforce the schedule.
    if ((process.env.OPENSELF_ENFORCE_ONLINE_HOURS === '1' || process.env.OPENSELF_ENFORCE_ONLINE_HOURS === 'true') && !this.isWithinOnlineHours()) {
      this.stats.ignored++;
      console.log(chalk.gray('   [HORARIO] fora do online_hours - ' + normalizedSender + ' aprendeu, nao responde'));
      return;
    }

    // 5. Activated chat without profile (e.g. activated while the process was down): JIT now
    await this.ensureProfile(normalizedSender);

    // Human-in-the-Loop para Perguntas de Risco (Horários e Compromissos)
    if (this.isRiskQuestion(processedText) && !this.hasActiveDirective(normalizedSender)) {
      if (this.adminController && typeof this.adminController.notifyRiskQuestion === 'function') {
        this.adminController.notifyRiskQuestion(normalizedSender, processedText).catch((err) => {
          console.log(chalk.yellow('   [ADMIN] Erro ao notificar pergunta de risco: ' + err.message));
        });
      }
    }

    // 6. Generate and send reply
    await this.queueReply(normalizedSender, processedText, msg);
  }

  /**
   * Buffer incoming messages per contact and answer the whole burst once, like a human
   * who reads everything before replying (one reply per message is a bot tell).
   */
  async queueReply(contactName, text, msg, batchTexts = null) {
    const key = this.normalizeContact(contactName);
    const textsToAdd = Array.isArray(batchTexts) && batchTexts.length > 0 ? batchTexts : [text];
    if (this.batchMaxMs <= 0) {
      return this.generateAndSendReply(contactName, textsToAdd.join('\n'), msg, textsToAdd);
    }
    let p = this._pending.get(key);
    if (!p) {
      p = { contactName, texts: [], firstAt: Date.now(), msg, timer: null, deferred: false };
      this._pending.set(key, p);
    }
    p.texts.push(...textsToAdd);
    p.msg = msg;
    this._armBatchTimer(key);
    if (p.texts.length > 1) {
      console.log(chalk.gray('   [BATCH] ' + p.texts.length + ' mensagens de ' + contactName + ' agrupadas em uma resposta'));
    }
  }

  _armBatchTimer(key) {
    const p = this._pending.get(key);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    const span = Math.max(this.batchMaxMs - this.batchMinMs, 0);
    let wait = this.batchMinMs + Math.random() * span;
    const remainingCap = this.batchCapMs - (Date.now() - p.firstAt);
    wait = Math.max(0, Math.min(wait, remainingCap));
    p.timer = setTimeout(() => {
      this._flushPending(key).catch((e) => console.error(chalk.red('   [BATCH] Erro: ' + e.message)));
    }, wait);
    p.timer.unref?.();
  }

  _cancelPending(contactName) {
    const key = this.normalizeContact(contactName);
    const p = this._pending.get(key);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this._pending.delete(key);
    console.log(chalk.gray('   [BATCH] resposta pendente de ' + contactName + ' cancelada (dono assumiu o chat)'));
  }

  async _flushPending(key) {
    const p = this._pending.get(key);
    if (!p || this._stopped) return;
    // A reply for this contact is still being generated/sent: wait for it, then re-arm
    if (this._inFlight.has(key)) {
      p.deferred = true;
      return;
    }
    if (p.timer) clearTimeout(p.timer);
    this._pending.delete(key);

    // Owner may have paused the bot / hit the kill-switch while we were waiting
    if (this.isGloballyDisabled() || !this.getTriggerState(key)) {
      this.stats.ignored++;
      return;
    }

    const texts = p.texts.slice();
    const job = (async () => {
      const res = await this.generateAndSendReply(p.contactName, texts.join('\n'), p.msg, texts);
      if (res && res.superseded) {
        // New messages arrived while we were "reading": merge them into the next batch
        const np = this._pending.get(key);
        if (np) {
          np.texts = [...texts, ...np.texts];
          np.firstAt = p.firstAt;
        }
      }
    })().finally(() => {
      this._inFlight.delete(key);
      const np = this._pending.get(key);
      if (np && np.deferred) {
        np.deferred = false;
        this._armBatchTimer(key);
      }
    });
    this._inFlight.set(key, job);
    await job;
  }

  // Learn from self: operator messages sent directly from phone
  async learnFromSelf(contactName, text) {
    try {
      const normalized = this.normalizeContact(contactName);
      const session = this.conversationMemory.sessions.get(normalized) || this.conversationMemory.sessions.get(contactName) || [];
      
      // Collect all pending incoming messages that the operator is now replying to
      const pendingThemList = [];
      for (let i = session.length - 1; i >= 0; i--) {
        if (session[i].clone === '[PENDING_REPLY]' || session[i].clone === '[TRIGGER]') {
          if (session[i].them) pendingThemList.unshift(session[i].them);
        } else {
          break;
        }
      }
      const pendingThem = pendingThemList.join('\n') || (session.length > 0 && session[session.length - 1].them ? session[session.length - 1].them : '');

      if (pendingThemList.length > 1 && typeof this.conversationMemory.resolveBatch === 'function') {
        this.conversationMemory.resolveBatch(normalized, pendingThemList, text);
      } else {
        this.conversationMemory.recordUserReply(normalized, text);
      }

      if (pendingThem) {
        await this.chatMemory.indexHistory([{
          contact: normalized,
          theirMessage: pendingThem,
          yourReply: text,
          date: new Date().toISOString().split('T')[0],
          time: new Date().toTimeString().slice(0, 5),
          replyDelay: 0
        }], { batchSize: 1 });
        console.log(chalk.cyan('   [LEARN] Resposta do operador salva p/ ' + contactName + ' (memoria + RAG)'));
      }
    } catch (e) {
      console.log(chalk.yellow('   [LEARN] Falha ao aprender do operador: ' + e.message));
    }
  }

  // Universal Learning - ALWAYS saves incoming messages (short-term memory + isolated RAG)
  async learnFromContact(contactName, text) {
    try {
      const contactKey = this.normalizeContact(contactName);

      // Save to short-term memory
      this.conversationMemory.addExchange(contactKey, text, '[PENDING_REPLY]');

      // Index in RAG for future context
      await this.chatMemory.indexHistory([{
        contact: contactKey,
        theirMessage: text,
        yourReply: '',
        date: new Date().toISOString().split('T')[0],
        time: new Date().toTimeString().slice(0, 5),
        replyDelay: 0
      }], { batchSize: 1 });

      console.log(chalk.cyan('   [LEARN] Mensagem de ' + contactKey + ' salva (memoria + RAG isolado)'));
    } catch (e) {
      console.log(chalk.yellow('   [LEARN] Falha ao aprender de ' + contactName + ': ' + e.message));
    }
  }

  // Returns the saved profile, running JIT creation first when it does not exist yet
  async ensureProfile(contactName) {
    if (this.contacts[contactName]) return this.contacts[contactName];
    if (this._jitInFlight.has(contactName)) return this._jitInFlight.get(contactName);

    const job = this.createPersonalityJIT(contactName).finally(() => {
      this._jitInFlight.delete(contactName);
    });
    this._jitInFlight.set(contactName, job);
    return job;
  }

  // Just-in-Time Personality Creation
  async createPersonalityJIT(contactName) {
    console.log(chalk.magenta('   [JIT] Criando personalidade para ' + contactName + '...'));

    let memories = [];
    try {
      // Isolated RAG history of THIS contact only (most recent last)
      memories = (await this.chatMemory.findRelevant('', contactName, 200)).slice(-60);
    } catch (e) {
      console.log(chalk.yellow('   [JIT] Falha ao ler historico: ' + e.message));
    }

    if (memories.length === 0) {
      console.log(chalk.yellow('   [JIT] Sem historico para ' + contactName + ', usando padrao'));
      return this.createDefaultProfile(contactName);
    }

    const contextLines = [];
    for (const m of memories) {
      contextLines.push(contactName + ': ' + m.theirMessage);
      if (m.yourReply && !MARKER_REPLIES.has(m.yourReply)) contextLines.push('Voce: ' + m.yourReply);
    }

    const llmProfile = await this.analyzeAndCreateProfile(contactName, contextLines.join('\n'));
    if (!llmProfile) {
      return this.createDefaultProfile(contactName);
    }

    const profile = {
      name: contactName,
      relationship: String(llmProfile.relationship || 'desconhecido'),
      rules: String(llmProfile.rules || 'Seja educado, breve e natural. Nao finja intimidade.'),
      avgReplyWords: Number(llmProfile.avgReplyWords) || 10,
      formality: String(llmProfile.formality || 'casual'),
      messageCount: memories.length,
      jit: true,
      createdAt: new Date().toISOString()
    };
    this.contacts[contactName] = profile;
    this.saveContacts();
    console.log(chalk.green('   [JIT] Perfil criado para ' + contactName + ': ' + profile.relationship));
    return profile;
  }

  createDefaultProfile(contactName) {
    const profile = {
      name: contactName,
      relationship: 'desconhecido',
      rules: 'Seja educado, breve e natural. Nao finja intimidade.',
      avgReplyWords: 10,
      formality: 'casual',
      jit: 'default',
      createdAt: new Date().toISOString()
    };
    this.contacts[contactName] = profile;
    this.saveContacts();
    return profile;
  }

  // Ask the LLM for the contact profile. Returns a plain object or null on any failure.
  async analyzeAndCreateProfile(contactName, context) {
    const ownerName = this.getOwnerName();
    const prompt = 'Analise este historico de conversa entre o usuario (' + ownerName + ') e ' + contactName + '.\n' +
      'Determine: 1) Tipo de relacionamento (amigo, familiar, cliente, trabalho, desconhecido)\n' +
      '2) Tom apropriado (casual, formal, intimo, profissional)\n' +
      '3) Regras de comunicacao (o que evitar, como responder)\n' +
      '4) Tamanho medio de resposta tipico (em palavras)\n\n' +
      'Historico:\n' + context + '\n\n' +
      'Responda em JSON: {"relationship": "", "rules": "", "avgReplyWords": 0, "formality": ""}';

    try {
      if (this.pipeline && this.pipeline.brain) {
        const fn = this.pipeline.brain.chat || this.pipeline.brain.generate;
        if (typeof fn === 'function') {
          const response = await fn.call(
            this.pipeline.brain,
            'Voce e um analista de personalidade. Responda apenas em JSON valido.',
            prompt
          );
          const start = String(response).indexOf('{');
          const end = String(response).lastIndexOf('}');
          if (start === -1 || end <= start) throw new Error('resposta sem JSON');
          return JSON.parse(String(response).slice(start, end + 1));
        }
      }
    } catch (e) {
      console.log(chalk.yellow('   [JIT] Falha ao analisar com LLM: ' + e.message));
    }
    return null;
  }

  // Generate and send reply
  async generateAndSendReply(contactName, text, msg, batchTexts = [text]) {
    const normalizedContact = this.normalizeContact(contactName);
    const profile = this.contacts[normalizedContact] || {};

    const contact = {
      name: contactName,
      ownerName: this.getOwnerName(),
      jid: msg.key.remoteJid,
      isGroup: msg.key.remoteJid?.endsWith('@g.us'),
      channel: 'WhatsApp',
      relationship: profile.relationship || '',
      rules: profile.rules || '',
      formality: profile.formality,
      closeness: profile.closeness || 'normal',
      transientDirective: profile.transientDirective,
      // Chat explicitly activated by the owner (" ."): guard/review-queue never block the send
      autoSend: true
    };

    const preview = text.slice(0, 60) + (text.length > 60 ? '...' : '');
    console.log(chalk.cyan('[MSG] ' + contact.name + ': ' + preview));

    try {
      const result = await this.pipeline.processMessage({ text, isGroup: contact.isGroup }, contact);

      if (result.action !== 'suppressed' && result.issues && result.issues.length > 0) {
        console.log(chalk.gray('   [GUARD] observacao (nao bloqueia): ' + result.issues.map((i) => i.type).join(', ')));
      }

      if (result.action === 'ignore') {
        this.stats.ignored++;
        return;
      }
      if (result.action === 'queued') {
        this.stats.queued++;
        return;
      }
      if (result.action === 'suppressed') {
        // Disguise/secret leak in an activated chat: abort SILENTLY (nothing is sent to WhatsApp)
        this.stats.ignored++;
        console.log(chalk.red('   [GUARD] resposta SUPRIMIDA em silencio p/ ' + contactName + ': ' +
          (result.issues || []).map((i) => i.type).join(', ')));
        return;
      }
      if (result.action === 'blocked') {
        return;
      }

      if (result.action === 'reply' && result.replies.length > 0) {
        // Cooldown de 3 minutos de inatividade do operador antes de o clone responder em paralelo
        const operatorCooldown = this.getOperatorCooldownRemaining();
        if (operatorCooldown > 0) {
          console.log(chalk.cyan(`   [GHOST] Operador ativo nos ultimos 3min. Aguardando ${(operatorCooldown/1000).toFixed(0)}s de intervalo...`));
          await this.sleep(operatorCooldown);

          // Verificar se durante a espera o operador assumiu, desativou o bot ou acionou kill-switch
          if (this.isGloballyDisabled() || !this.getTriggerState(normalizedContact)) {
            this.stats.ignored++;
            return { aborted: true };
          }
          if (this._pending.get(normalizedContact)?.texts.length) {
            console.log(chalk.gray('   [BATCH] chegou mais mensagem de ' + contactName + ' durante a espera - unificando resposta'));
            return { superseded: true };
          }
        }

        // Natural human delay: notice + read message before typing.
        // Fast mode (testing): OPENSELF_FAST_REPLY=1 uses 2-4s.
        // Normal mode (production human mimicry): 10s to 30s.
        const isFast = process.env.OPENSELF_FAST_REPLY === '1';
        const minRead = isFast ? 1000 : (Number(process.env.OPENSELF_MIN_DELAY) || 10000);
        const maxRead = isFast ? 3000 : (Number(process.env.OPENSELF_MAX_DELAY) || 28000);
        const rawDelay = typeof result.delay === 'number' && result.delay > 0 ? result.delay * 0.25 : 12000;
        const readDelay = Math.min(Math.max(rawDelay, minRead), maxRead);
        const typingTime = Math.min(Math.max(result.replies[0].length * 90, 1500), 5000);
        const totalDelaySec = ((readDelay + typingTime) / 1000).toFixed(1);
        console.log(chalk.cyan(`   [MIMICRY] Aguardando ${totalDelaySec}s antes de responder (${(readDelay/1000).toFixed(1)}s leitura + ${(typingTime/1000).toFixed(1)}s digitando)...`));

        await this.sleep(readDelay);

        // Owner took over / kill-switch during the "reading" time: send nothing
        if (this.isGloballyDisabled() || !this.getTriggerState(normalizedContact)) {
          this.stats.ignored++;
          return { aborted: true };
        }
        // More messages arrived while "reading": drop this draft, answer everything at once
        if (this._pending.get(normalizedContact)?.texts.length) {
          console.log(chalk.gray('   [BATCH] chegou mais mensagem de ' + contactName + ' durante a leitura - unificando resposta'));
          return { superseded: true };
        }

        try {
          await this.sock.readMessages([msg.key]);
        } catch {}

        for (let i = 0; i < result.replies.length; i++) {
          result.replies[i] = result.replies[i].replace(/\s+[.,]$/g, '').trim();
        }

        const fullReply = result.replies.join(' ');

        for (let i = 0; i < result.replies.length; i++) {
          await this.sock.presenceSubscribe(msg.key.remoteJid);
          await this.sock.sendPresenceUpdate('composing', msg.key.remoteJid);
          const currentTypingTime = Math.min(Math.max(result.replies[i].length * 90, 1500), 5000);
          await this.sleep(currentTypingTime);
          await this.sock.sendPresenceUpdate('paused', msg.key.remoteJid);

          const sent = await this.sock.sendMessage(msg.key.remoteJid, { text: result.replies[i] });
          if (sent?.key?.id) {
            this.sentIds.add(sent.key.id);
            if (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.values().next().value);
          }

          const replyPreview = result.replies[i].slice(0, 60) + (result.replies[i].length > 60 ? '...' : '');
          console.log(chalk.green('   -> ' + replyPreview));

          if (i < result.replies.length - 1) {
            await this.sleep(3000 + Math.random() * 3000);
          }
        }

        if (batchTexts.length > 1 && typeof this.conversationMemory.resolveBatch === 'function') {
          this.conversationMemory.resolveBatch(contactName, batchTexts, fullReply);
        } else {
          this.conversationMemory.addExchange(contactName, text, fullReply);
        }

        try {
          await this.chatMemory.indexHistory([{
            contact: normalizedContact,
            theirMessage: text,
            yourReply: fullReply,
            date: new Date().toISOString().split('T')[0],
            time: new Date().toTimeString().slice(0, 5),
            replyDelay: result.delay
          }], { batchSize: 1 });
          console.log(chalk.cyan('   [LEARN] Troca completa salva p/ ' + contactName + ' (memoria + RAG)'));
        } catch (e) {
          console.log(chalk.yellow('   [LEARN] Falha ao indexar resposta: ' + e.message));
        }

        this.stats.replied++;
      }
    } catch (err) {
      console.error(chalk.red('   -> Erro: ' + err.message));
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStats() {
    return { ...this.stats };
  }

  async stop() {
    this._stopped = true;
    if (this._keepAlive) {
      clearInterval(this._keepAlive);
      this._keepAlive = null;
    }
    try {
      this.sock?.ev?.removeAllListeners();
      this.sock?.end?.(undefined);
    } catch {}
    process.exit(0);
  }

  async start() {
    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
    }
    await this._connect();
    console.log(chalk.gray('  WhatsApp -> Configuracoes -> Aparelhos conectados -> Conectar aparelho'));
    console.log(chalk.gray('  Sessao sera salva para reconexoes futuras'));
    if (!this._keepAlive) {
      this._keepAlive = setInterval(() => {}, 60000);
    }
  }

  async _connect() {
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
      } catch {}
      try {
        this.sock.end?.(undefined);
      } catch {}
    }

    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);

    this.sock = makeWASocket({
      auth: state,
      browser: ['OpenSelf', 'Chrome', '120.0'],
      syncFullHistory: false,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrcodeTerminal.generate(qr, { small: true });
        console.log(chalk.gray('  QR code gerado - escaneie com seu WhatsApp'));
        try {
          writeFileSync('/tmp/wa_qr.txt', qr, 'utf-8');
          await QRCode.toFile(join(this.dataDir, '..', 'qr_whatsapp.png'), qr, { width: 480, margin: 2 });
        } catch {}
      }

      if (connection === 'open') {
        console.log(chalk.green('\u2705 WhatsApp conectado!'));
        console.log(chalk.gray('  Escuta passiva ativa - respostas somente em chats ativados com " ."'));
        if (this.sock?.user?.id) {
          this.sessionOwnerNumber = this.sock.user.id.split('@')[0].split(':')[0];
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason?.loggedOut;
        if (shouldReconnect && !this._reconnecting && !this._stopped) {
          this._reconnecting = true;
          setTimeout(async () => {
            this._reconnecting = false;
            if (this._stopped) return;
            try {
              await this._connect();
            } catch (err) {
              console.error(chalk.red('Erro ao reconectar: ' + (err?.message || err)));
            }
          }, 5000);
        }
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type === 'notify') {
        for (const msg of messages) {
          try {
            await this.handleMessage(msg);
          } catch (e) {
            console.error(chalk.red('Erro ao processar mensagem: ' + e.message));
          }
        }
      }
    });
  }
}
