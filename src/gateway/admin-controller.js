/**
 * Open-Self Admin Controller — WhatsApp Self-Chat Control Panel (v1.4.0)
 *
 * Permite que o dono controle, instrua e receba alertas do clone diretamente
 * pelo WhatsApp na conversa consigo mesmo (Self-Chat).
 */

import chalk from 'chalk';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export class AdminController {
  constructor(gateway) {
    this.gateway = gateway;
    this._riskAlertTimestamps = new Map();
  }

  getOwnerJid(msg = null) {
    if (msg?.key?.remoteJid) {
      this._lastOwnerJid = msg.key.remoteJid;
      return msg.key.remoteJid;
    }
    if (this._lastOwnerJid) {
      return this._lastOwnerJid;
    }
    if (this.gateway.sock?.user?.id) {
      const num = this.gateway.sock.user.id.split('@')[0].split(':')[0];
      return `${num}@s.whatsapp.net`;
    }
    if (this.gateway.sessionOwnerNumber) {
      return `${this.gateway.sessionOwnerNumber}@s.whatsapp.net`;
    }
    return null;
  }

  async sendReply(ownerJid, text) {
    if (!this.gateway.sock || !ownerJid) return null;
    try {
      const sent = await this.gateway.sock.sendMessage(ownerJid, { text });
      if (sent?.key?.id) {
        this.gateway.sentIds.add(sent.key.id);
        if (this.gateway.sentIds.size > 500) {
          this.gateway.sentIds.delete(this.gateway.sentIds.values().next().value);
        }
      }
      return sent;
    } catch (e) {
      console.log(chalk.yellow('   [ADMIN] Falha ao enviar no Self-Chat: ' + e.message));
      return null;
    }
  }

  findContactKey(name) {
    const raw = String(name || '').trim();
    const norm = this.gateway.normalizeContact(raw).toLowerCase();
    const contacts = this.gateway.contacts || {};
    // 1. Match exato normalizado
    for (const key of Object.keys(contacts)) {
      if (this.gateway.normalizeContact(key).toLowerCase() === norm) {
        return key;
      }
    }
    // 2. Match parcial / substring
    for (const key of Object.keys(contacts)) {
      const kNorm = this.gateway.normalizeContact(key).toLowerCase();
      if (kNorm.includes(norm) || norm.includes(kNorm)) {
        return key;
      }
    }
    // 3. Match contra chaves com mensagens pendentes no buffer
    for (const k of (this.gateway._pending?.keys() || [])) {
      const kNorm = this.gateway.normalizeContact(k).toLowerCase();
      if (kNorm === norm || kNorm.includes(norm) || norm.includes(kNorm)) {
        return k;
      }
    }
    return raw;
  }

  formatTime(isoString) {
    try {
      if (!isoString) return '';
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleTimeString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      });
    } catch {
      return '';
    }
  }

  async handleCommand(rawText, msg) {
    const text = String(rawText || '').trim();
    if (!text) return;

    if (text.startsWith('/instruir')) {
      return this.handleInstruir(text, msg);
    }
    if (text.startsWith('/pendencias') || text.startsWith('/resumo')) {
      return this.handlePendencias(text, msg);
    }
    if (text.startsWith('/status')) {
      return this.handleStatus(text, msg);
    }
    if (text.startsWith('/responder')) {
      return this.handleResponder(text, msg);
    }
    if (text.startsWith('/ajuda') || text.startsWith('/help')) {
      return this.handleHelp(text, msg);
    }

    return this.handleUnknown(text, msg);
  }

  async handleInstruir(text, msg) {
    const ownerJid = this.getOwnerJid(msg);
    const match = text.match(/^\/instruir\s+([^\s]+)\s+(.+)$/s);
    if (!match) {
      await this.sendReply(
        ownerJid,
        '⚠️ Sintaxe: /instruir [NomeDoContato] [diretriz]\nExemplo: /instruir Levi conduza para fechar o som sem o painel de LED por 800'
      );
      return;
    }

    const targetInput = match[1];
    const directive = match[2].trim();
    const contactKey = this.findContactKey(targetInput);

    if (!this.gateway.contacts[contactKey]) {
      this.gateway.contacts[contactKey] = {
        name: targetInput,
        relationship: 'desconhecido',
        rules: 'Seja natural, breve e educado.',
        avgReplyWords: 10,
        formality: 'casual',
        createdAt: new Date().toISOString()
      };
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // TTL de 24h
    this.gateway.contacts[contactKey].transientDirective = {
      directive,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
    this.gateway.saveContacts();

    console.log(chalk.green(`   [ADMIN] Diretriz gravada para ${targetInput}: "${directive}"`));
    await this.sendReply(
      ownerJid,
      `✅ Diretriz gravada para ${targetInput}. O clone seguirá este objetivo nas próximas respostas.`
    );
  }

  async handlePendencias(text, msg) {
    const ownerJid = this.getOwnerJid(msg);
    let sessionsMap = this.gateway.conversationMemory?.sessions;

    if (!sessionsMap || sessionsMap.size === 0) {
      try {
        const sessionsFile = join(this.gateway.dataDir, 'conversation-sessions.json');
        if (existsSync(sessionsFile)) {
          const raw = JSON.parse(readFileSync(sessionsFile, 'utf-8'));
          sessionsMap = new Map(Object.entries(raw));
        }
      } catch {}
    }

    const pendencies = [];
    if (sessionsMap) {
      for (const [contact, exchanges] of sessionsMap.entries()) {
        if (!Array.isArray(exchanges) || exchanges.length === 0) continue;

        // Procura a última troca pendente
        const last = exchanges[exchanges.length - 1];
        if (last && (last.clone === '[PENDING_REPLY]' || last.clone === '[TRIGGER]')) {
          const time = this.formatTime(last.timestamp);
          const timeLabel = time ? ` (${time})` : '';
          const isTriggerActive = this.gateway.getTriggerState(contact) === true;
          const statusLabel = isTriggerActive ? 'ATIVO' : 'INATIVO';
          const snippet = (last.them || '').replace(/\n+/g, ' ');
          const preview = snippet.length > 50 ? snippet.slice(0, 50) + '...' : snippet;

          pendencies.push(`• ${contact}: "${preview}"${timeLabel} [Gatilho: ${statusLabel}]`);
        }
      }
    }

    if (pendencies.length > 0) {
      const response = `📋 CONVERSAS PENDENTES:\n${pendencies.join('\n')}`;
      await this.sendReply(ownerJid, response);
    } else {
      await this.sendReply(ownerJid, '📋 CONVERSAS PENDENTES:\nNenhuma conversa pendente no momento.');
    }
  }

  async handleStatus(text, msg) {
    const ownerJid = this.getOwnerJid(msg);
    const uptimeSec = Math.floor(process.uptime());
    const h = Math.floor(uptimeSec / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const s = uptimeSec % 60;
    const uptimeStr = `${h}h ${m}m ${s}s`;

    const memMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);

    const activeTriggers = Object.entries(this.gateway.triggers || {})
      .filter(([_, v]) => v === true)
      .map(([k]) => k);
    const triggersStr = activeTriggers.length > 0 ? activeTriggers.join(', ') : 'Nenhum';

    const isConnected = Boolean(this.gateway.sock?.user);
    const userPn = this.gateway.sock?.user?.id || 'Desconectado';

    const reply = `📊 STATUS DO SISTEMA:\n• Uptime: ${uptimeStr}\n• Memória (RSS): ${memMb} MB\n• Socket: ${isConnected ? `Conectado (${userPn})` : 'Desconectado'}\n• Gatilhos Ativos: ${triggersStr}\n• Modo: Produção (Daemon)`;

    await this.sendReply(ownerJid, reply);
  }

  async handleResponder(text, msg) {
    const ownerJid = this.getOwnerJid(msg);
    const match = text.match(/^\/responder\s+([^\s]+)\s+(.+)$/s);
    if (!match) {
      await this.sendReply(
        ownerJid,
        '⚠️ Sintaxe: /responder [NomeDoContato] [orientação]\nExemplo: /responder Levi vou passar aí pelas 18h com os cabos'
      );
      return;
    }

    const targetInput = match[1];
    const guidance = match[2].trim();
    const contactKey = this.findContactKey(targetInput);

    if (!this.gateway.contacts[contactKey]) {
      this.gateway.contacts[contactKey] = {
        name: targetInput,
        relationship: 'desconhecido',
        rules: 'Seja educado, breve e natural.',
        createdAt: new Date().toISOString()
      };
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000); // 1h TTL para disparo imediato
    this.gateway.contacts[contactKey].transientDirective = {
      directive: guidance,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
    this.gateway.saveContacts();

    console.log(chalk.green(`   [ADMIN] Orientação de resposta gravada para ${targetInput}: "${guidance}"`));

    // Verificar se há mensagens pendentes no buffer para disparar imediatamente
    let pendingKey = null;
    const normContact = this.gateway.normalizeContact(contactKey).toLowerCase();
    const normTarget = this.gateway.normalizeContact(targetInput).toLowerCase();
    for (const k of (this.gateway._pending?.keys() || [])) {
      const lk = this.gateway.normalizeContact(k).toLowerCase();
      if (lk === normContact || lk === normTarget || lk.includes(normTarget) || normTarget.includes(lk)) {
        pendingKey = k;
        break;
      }
    }

    if (pendingKey && this.gateway._pending?.has(pendingKey)) {
      this.gateway._flushPending(pendingKey).catch((e) => {
        console.error(chalk.red('   [ADMIN] Erro ao disparar resposta guiada: ' + e.message));
      });
      await this.sendReply(
        ownerJid,
        `✅ Resposta guiada registrada para ${targetInput}. Disparando resposta agora.`
      );
    } else {
      await this.sendReply(
        ownerJid,
        `✅ Orientação gravada para ${targetInput}. O clone utilizará esta diretriz na próxima resposta.`
      );
    }
  }

  async handleHelp(text, msg) {
    const ownerJid = this.getOwnerJid(msg);
    const helpText = `🤖 PAINEL DE CONTROLE (Open-Self v1.4.0):
• /instruir [Contato] [diretriz] - Injeta diretriz temporária (24h)
• /responder [Contato] [orientação] - Responde imediatamente com orientação
• /pendencias ou /resumo - Exibe conversas pendentes
• /status - Uptime, memória e integridade do bot
• /ajuda - Exibe esta mensagem de ajuda`;

    await this.sendReply(ownerJid, helpText);
  }

  async handleUnknown(text, msg) {
    const ownerJid = this.getOwnerJid(msg);
    await this.sendReply(
      ownerJid,
      'Comando não reconhecido. Use /ajuda para ver os comandos disponíveis no Painel de Controle.'
    );
  }

  async notifyRiskQuestion(contactName, questionText) {
    const key = this.gateway.normalizeContact(contactName);
    const now = Date.now();
    const lastNotified = this._riskAlertTimestamps.get(key) || 0;
    if (now - lastNotified < 60000) {
      return;
    }
    this._riskAlertTimestamps.set(key, now);

    const ownerJid = this.getOwnerJid();
    if (!ownerJid) return;

    const preview = questionText.length > 80 ? questionText.slice(0, 80) + '...' : questionText;
    const alert = `⚠️ [Pergunta de Risco - ${contactName}]: "${preview}"\nResponda: "/responder ${contactName} [sua orientação]"`;
    await this.sendReply(ownerJid, alert);
  }
}
