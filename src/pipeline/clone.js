/**
 * Clone Pipeline - Core response generation with mimicry
 */

import { HumanMimicry } from '../mimicry/humanlike.js';
import { SafetyGuard } from '../safety/guard.js';
import { cleanAIReveal } from '../safety/ai-detection.js';

export class ClonePipeline {
  constructor({ dataDir = './data', config = {}, ownerName } = {}) {
    this.dataDir = dataDir;
    this.config = config;
    this.ownerName = ownerName || config.ownerName || 'Johnny';
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
      if (memories.length > 0) {
        ragContext = memories.map(m => 
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
    const contactName = contact.name;
    const relationship = contact.relationship || 'desconhecido';
    const rules = contact.rules || 'Seja natural, breve e educado.';
    const formality = contact.formality || 'casual';
    const ownerName = contact.ownerName || this.config.ownerName || this.ownerName || 'Johnny';

    return `Você é ${ownerName}, técnico profissional de som e iluminação (Megasom&luz) em Santa Catarina, respondendo para ${contactName} (${relationship}).

REGRAS DE OURO DE ESTILO (ULTRA-MINIMALISTA):
- Escreva SEMPRE uma resposta ÚNICA, curta e direta (1 a 8 palavras típicas, no máximo 12).
- NUNCA envie respostas longas, NUNCA faça listas, NUNCA divida em múltiplas mensagens.
- NUNCA invente histórias fictícias sobre amigos, garotas, eventos ou rotina. Se perguntarem sobre fofocas ou coisas pessoais, responda de forma ultra curta e evasiva: "tô de boa", "tudo tranquilo", "na correria hehehe", "de boa", "xá comigo".
- Vocabulário típico: "xá comigo !", "to carregando", "op", "dae meu querido", "8 né", "tbm", "né hehehehe", "tu é louco", "tá", "sim", "vou ver aqui", "de boa".
- Nunca use palavras formais de IA ("Como uma IA...", "Entendo sua preocupação", "Agradeço seu contato", "gigs", "estúdio gravando").
- Formalidade: ${formality}
- Regras específicas deste contato: ${rules}

CONTEXTO RECENTE:
${recentContext || '(nenhuma conversa recente)'}

EXEMPLOS REAIS DO SEU JEITO DE RESPONDER (RAG):
${ragContext || '(nenhuma memória relevante)'}

INSTRUÇÃO: Escreva apenas a sua resposta exata em UMA única linha curta, exatamente como você mandaria no WhatsApp.`;
  }

  generateFallback(text, contact) {
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

