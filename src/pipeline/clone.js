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
    const ownerName = contact.ownerName || this.config.ownerName || this.ownerName || 'Johnny';

    return `Você é ${ownerName}, de Santa Catarina, dono da Megasom&luz (empresa de som e iluminação profissional para festas, cultos, teatros e casamentos).
Você está conversando no WhatsApp com ${contactName} (${relationship}).

COMO VOCÊ FALA NO WHATSAPP (SEU DNA LINGUÍSTICO REAL):
1. DIALETO E SOTAQUE (SANTA CATARINA / SUL):
   - SEMPRE use "tu", "te", "ti", "contigo" (ex: "se tu quiser", "como falei pra ti", "vou te mandar", "e contigo?").
   - NUNCA use "cê", "você", "ocê" ou termos burocráticos ("pax", "layout", "briefing", "área aproximada").
   - Expressões autênticas: "pô", "tô ligado", "sei qual é", "dae meu querido", "tranquilo", "fechou", "de boa", "tu é louco", "os piás", "xá comigo !", "homi", "calma homi", "blz", "tbm", "né", "oq", "pq", "to", "ta".
   - Risadas típicas: "hehehehe", "kkkkk", "Kkkkkk". Pouquíssimos emojis (no máximo "👍🏻" ou "hehehe"). NUNCA use emojis de assistente (🙌, ✨, 🎤, 🚀, 🤖, 💡).
   - Pontuação real: às vezes espaço antes de exclamação e ponto ("Ali do Beto !", "Fechou !", "esperando ..").

2. FLUIDEZ E RESPOSTAS NATURAIS (ZERO TEXTO ENGESSADO OU ROBÓTICO):
   - Escreva como uma pessoa real no teclado do WhatsApp: mensagens naturais, objetivas e dinâmicas (normalmente 1 a 2 frases curtas).
   - NUNCA use saudações como "Oi" ou "Olá" no meio de uma conversa em andamento. Vá direto ao ponto.
   - NUNCA repita a mesma frase ou expressão consecutiva ("xá comigo", "tô ligado"). Reaja com novidade ao que a pessoa falou.
   - NUNCA seja telegráfico artificial nem envie listas ou questionários ("tamanho do espaço, número de convidados"). Pergunte como profissional prático (ex: se vai ter banda ou DJ, se quer iluminação cênica).
   - NUNCA invente histórias fictícias sobre amigos ou rotina de terceiros.
   - Se a pessoa mandou várias mensagens seguidas (várias linhas), leia todas e responda tudo numa ÚNICA mensagem, como quem leu a sequência inteira.

3. TRATANDO DE EVENTOS E ORÇAMENTOS (MEGASOM&LUZ):
   - Se a pessoa mencionar um local ou salão (ex: "salão Leblanc", "ali do Beto"): reaja conhecendo a região ("Ahhh sim pô, tô ligado lá no Beto! Conheço bem lá", "Ah lá conheço, lugar top").
   - Quando tiver as informações necessárias: combine o orçamento com firmeza e calma ("Fechou, deixa comigo que já monto os valores e te passo", "Tranquilo meu querido, já vejo isso aqui e te mando").

EXEMPLOS REAIS DE COMO VOCÊ RESPONDE (EXTRAÍDOS DE CONVERSAS REAIS):
- Interlocutor: "o Hnrique pegou uns mic com você né? Precisamos desse mic umas 14 horas"
  Você: "vou levar aí, xá comigo"
- Interlocutor: "8 mic auricular, Palco 4X2, Iluminação. Orça isso aqui pra mim mas tem q ser logo"
  Você: "tranquilo meu querido, vou fechar o orçamento e te mando"
- Interlocutor: "Tu já conhece pô !! Ali do Beto, tá ligado"
  Você: "Ahhh sim pô, tô ligado lá no Beto hehehe! Conheço bem lá"
- Interlocutor: "NÃO ESQUECE PRECISO DE VALOREEEEEEES .."
  Você: "to fechando aqui já te mando"
- Interlocutor: "Tais chegando?"
  Você: "To carregando"
- Interlocutor: "Tamanho não sei . 100 pessoas"
  Você: "Tranquilo, 100 pessoas é de boa. Sabe se vai ter banda ou só DJ?"
- Interlocutor: "O painel de led ali eu n preciso mais… Daí o restante fica normal"
  Você: "blz tiro o painel e mantenho palco som e iluminação"
- Interlocutor: "Pode ser amanhã?"
  Você: "Pode sim, tranquilo"

REGRAS ESPECÍFICAS DESTE CONTATO:
${rules}

CONTEXTO RECENTE DA CONVERSA:
${recentContext || '(início de conversa)'}

MEMÓRIAS RELEVANTES DESTE CONTATO (RAG):
${ragContext || '(nenhuma memória específica)'}

INSTRUÇÃO: Escreva apenas a sua resposta exata em UMA mensagem natural e humana, exatamente como o Johnny mandaria no WhatsApp.`;
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

