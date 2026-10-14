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
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';

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

    // ids of messages sent by the bot itself (echoes must never be read as owner triggers)
    this.sentIds = new Set();
    this._jitInFlight = new Map();
    this._stopped = false;

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
    return this.appConfig?.ownerName || process.env.OPENSELF_NAME || 'Johnny';
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

    const jid = msg.key.remoteJid || '';
    if (jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;

    const text = msg.message.conversation ||
                 msg.message.extendedTextMessage?.text ||
                 msg.message.imageMessage?.caption || '';

    if (!text.trim()) return;

    // 1. Skip system events
    if (SYSTEM_EVENT_RE.test(text.trim())) return;

    // 2. FROM ME: only owner triggers. Echoes of the bot's own replies are ignored.
    if (msg.key.fromMe) {
      if (msg.key.id && this.sentIds.has(msg.key.id)) return;

      const { processedText, triggerAction } = this.processTriggers(text);
      if (!triggerAction) return;

      const contactName = this.resolveContactKey(msg);
      if (!contactName) return;

      if (triggerAction === 'activate') {
        if (!this.jidMap[jid]) {
          this.jidMap[jid] = contactName;
          this.saveJidMap();
        }
        this.setTriggerState(contactName, true);
        if (processedText) await this.learnFromSelf(contactName, processedText);
        console.log(chalk.green('   [TRIGGER] Ativado para ' + contactName + ' (pelo dono da sessao)'));
        // Just-in-Time Personality: build the profile right now from accumulated history
        await this.ensureProfile(contactName);
      } else {
        this.setTriggerState(contactName, false);
        if (processedText) await this.learnFromSelf(contactName, processedText);
        console.log(chalk.yellow('   [TRIGGER] Desativado para ' + contactName + ' (pelo dono da sessao)'));
      }
      return;
    }

    this.stats.received++;

    // 3. FROM OTHERS - Universal Learning (ALWAYS learns, before any gate).
    //    Triggers sent by other people are NOT honoured: only the owner can toggle the bot.
    const normalizedSender = this.resolveContactKey(msg);
    const { processedText } = this.processTriggers(text);
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

    // 6. Generate and send reply
    await this.generateAndSendReply(normalizedSender, processedText, msg);
  }

  // Learn from self trigger messages
  async learnFromSelf(contactName, text) {
    try {
      this.conversationMemory.addExchange(contactName, text, '[TRIGGER]');

      await this.chatMemory.indexHistory([{
        contact: this.normalizeContact(contactName),
        theirMessage: text,
        yourReply: '[TRIGGER]',
        date: new Date().toISOString().split('T')[0],
        time: new Date().toTimeString().slice(0, 5),
        replyDelay: 0
      }], { batchSize: 1 });
    } catch (e) {
      console.log(chalk.yellow('   [LEARN] Falha ao aprender trigger proprio: ' + e.message));
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
  async generateAndSendReply(contactName, text, msg) {
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
        const readDelay = Math.min(result.delay * 0.3, 5000);
        const typingTime = Math.min(result.replies[0].length * 60, 4000);
        const totalDelaySec = ((readDelay + typingTime) / 1000).toFixed(1);
        console.log(chalk.cyan(`   [MIMICRY] Aguardando ${totalDelaySec}s antes de responder...`));

        await this.sleep(readDelay);

        try {
          await this.sock.readMessages([msg.key]);
        } catch {}

        const fullReply = result.replies.join(' ');

        for (let i = 0; i < result.replies.length; i++) {
          await this.sock.presenceSubscribe(msg.key.remoteJid);
          await this.sock.sendPresenceUpdate('composing', msg.key.remoteJid);
          const typingTime = Math.min(result.replies[i].length * 60, 4000);
          await this.sleep(typingTime);
          await this.sock.sendPresenceUpdate('paused', msg.key.remoteJid);

          const sent = await this.sock.sendMessage(msg.key.remoteJid, { text: result.replies[i] });
          if (sent?.key?.id) {
            this.sentIds.add(sent.key.id);
            if (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.values().next().value);
          }

          const replyPreview = result.replies[i].slice(0, 60) + (result.replies[i].length > 60 ? '...' : '');
          console.log(chalk.green('   -> ' + replyPreview));

          if (i < result.replies.length - 1) {
            await this.sleep(1000 + Math.random() * 2000);
          }
        }

        this.conversationMemory.addExchange(contactName, text, fullReply);

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
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason?.loggedOut;
        if (shouldReconnect && !this._reconnecting && !this._stopped) {
          this._reconnecting = true;
          setTimeout(() => {
            this._reconnecting = false;
            this._connect();
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
