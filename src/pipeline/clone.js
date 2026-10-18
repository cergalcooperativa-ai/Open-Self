/**
 * Clone Pipeline - Core response generation with mimicry
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { HumanMimicry } from '../mimicry/humanlike.js';
import { SafetyGuard } from '../safety/guard.js';
import { cleanAIReveal } from '../safety/ai-detection.js';

export class ClonePipeline {
  constructor({ dataDir = './data', config = {}, ownerName } = {}) {
    this.dataDir = dataDir;
    this.config = config;
    this.ownerName = ownerName || config.ownerName || '';
    this.conversationMemory = null;
    this.chatMemory = null;
    this.mimicry = new HumanMimicry({ responseTimeAvg: 3940000 });
    this.brain = null;
    this.guard = new SafetyGuard(config.personality || {});
  }

  setMemory(conversationMemory, chatMemory) {
    this.conversationMemory = conversationMemory;
    this.chatMemory = chatMemory;
  }

  setBrain(brain) {
    this.brain = brain;
  }

  loadSoul() {
    if (this.dataDir) {
      const explicitPath = join(this.dataDir, 'SOUL.md');
      if (existsSync(explicitPath)) {
        try {
          return readFileSync(explicitPath, 'utf-8');
        } catch {}
      }
      // If dataDir is a custom directory (e.g. in tests), don't leak global process.cwd()
      if (this.dataDir !== './data' && this.dataDir !== 'data') {
        return '';
      }
    }
    const candidates = [
      join(process.cwd(), 'data', 'SOUL.md'),
      './data/SOUL.md'
    ];
    for (const p of candidates) {
      try {
        if (existsSync(p)) {
          return readFileSync(p, 'utf-8');
        }
      } catch {}
    }
    return '';
  }

  getOwnerNameFromSoul(soulText) {
    if (!soulText) return '';
    const m = soulText.match(/(?:Name|Nome):\s*([^\r\n]+)/i);
    return m ? m[1].trim() : '';
  }

  async processMessage(message, contact) {
    const text = message.text || message;
    const isGroup = message.isGroup || false;
    const contactName = contact.name;

    // Get recent conversation context (short-term)
    let recentContext = '';
    if (this.conversationMemory) {
      recentContext = this.conversationMemory.getRecentContext(contactName, 8);
    }

    // Get relevant long-term memories (RAG)
    let ragContext = '';
    if (this.chatMemory) {
      const memories = await this.chatMemory.findRelevant(text, contactName, 5);
      const validMemories = memories.filter(m => m.yourReply && !['[PENDING_REPLY]', '[TRIGGER]'].includes(m.yourReply.trim()));
      if (validMemories.length > 0) {
        ragContext = validMemories.map(m => 
          `${m.contact}: ${m.theirMessage}\nYou: ${m.yourReply}`
        ).join('\n\n');
      }
    }

    // Build system prompt
    const systemPrompt = this.buildSystemPrompt(contact, recentContext, ragContext);

    // Generate response via LLM
    let rawReply;
    if (this.brain) {
      if (typeof this.brain.generate === 'function') {
        rawReply = await this.brain.generate(systemPrompt, text);
      } else if (typeof this.brain.chat === 'function') {
        rawReply = await this.brain.chat(systemPrompt, text);
      } else {
        rawReply = this.generateFallback(text, contact);
      }
    } else {
      rawReply = this.generateFallback(text, contact);
    }

    // Empty LLM output (provider failure) must never turn into a sent message
    const cleanReply = cleanAIReveal(String(rawReply || ''));
    if (!cleanReply) {
      return { action: 'ignore', replies: [], delay: 0, issues: [] };
    }

    // Safety guard: for chats explicitly activated by the owner (contact.autoSend) it only
    // OBSERVES (issues are returned for logging) and never blocks or queues the send.
    const verdict = this.guard.checkReply(cleanReply, message, contact);
    const issues = verdict.issues || [];
    // Chat ativado + (revelação de IA | vazamento de segredo) => aborta EM SILÊNCIO:
    // nada é enviado e nada é enfileirado. Quem chama só registra no log.
    if (contact.autoSend && issues.some((i) => i.type === 'ai_reveal' || i.type === 'secret_leak')) {
      return { action: 'suppressed', replies: [], delay: 0, issues };
    }
    if (!verdict.safe && !contact.autoSend) {
      return { action: 'blocked', replies: [], delay: 0, issues };
    }

    // Apply mimicry (human-like variations)
    const replies = this.mimicry.processReply(cleanReply);
    const delay = this.mimicry.getReplyDelay(text, contact);
    const typingDuration = this.mimicry.getTypingDuration(replies.join(' '));

    return {
      action: 'reply',
      replies,
      delay,
      typingDuration,
      issues
    };
  }

  buildSystemPrompt(contact, recentContext, ragContext) {
    const contactName = contact.name || 'Contato';
    const relationship = contact.relationship || 'desconhecido';
    let rules = contact.rules || 'Seja natural, breve e educado.';
    const soulContent = this.loadSoul();
    const ownerName = contact.ownerName || this.config.ownerName || this.ownerName || this.getOwnerNameFromSoul(soulContent) || 'Operador';

    // Injeção de Diretriz Temporária no Pipeline (v1.4.0)
    if (contact.transientDirective?.directive && contact.transientDirective?.expiresAt) {
      const expiresAt = new Date(contact.transientDirective.expiresAt);
      if (!isNaN(expiresAt.getTime()) && new Date() < expiresAt) {
        const directiveBlock = `🎯 OBJETIVO ATUAL DEFINIDO PELO OPERADOR PARA ESTA CONVERSA:
"${contact.transientDirective.directive}"
Conduza o diálogo com naturalidade e brevidade para atingir esse objetivo, sem quebrar o sotaque e o disfarce.`;
        rules = `${directiveBlock}\n\n${rules}`;
      }
    }

    const identityIntro = `Você é ${ownerName}, respondendo mensagens no WhatsApp como você mesmo.\nVocê está conversando no WhatsApp com ${contactName} (${relationship}).`;

    return `${identityIntro}

${soulContent ? `PERFIL E DIRETRIZES DE PERSONALIDADE (SOUL):\n${soulContent.trim()}\n` : ''}
REGRAS ESPECÍFICAS DESTE CONTATO:
${rules}

CONTEXTO RECENTE DA CONVERSA:
${recentContext || '(início de conversa)'}

MEMÓRIAS RELEVANTES DESTE CONTATO (RAG):
${ragContext || '(nenhuma memória específica)'}

INSTRUÇÃO: Escreva apenas a sua resposta exata em UMA mensagem natural e humana, exatamente como ${ownerName} mandaria no WhatsApp.`;
  }

  generateFallback(text, contact) {
    const RISK_RE = /(que horas|onde\s+(?:tu|voc[eê]|vc)\s+t[aá]|vai\s+vir|vem\s+aqui|fez\s+o\s+contrato|quando\s+vai|vai\s+l[aá]|vai\s+passar)/i;
    if (RISK_RE.test(String(text || ''))) {
      return "to na correria aqui na rua, mais tarde te confirmo certinho";
    }
    const fallbacks = [
      "tá bom",
      "entendi",
      "depois eu te falo",
      "beleza",
      "ok",
      "hehe"
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
}
