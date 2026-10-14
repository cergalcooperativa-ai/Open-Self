/**
 * AI Self-Reveal Detection
 * Prevents clone from accidentally revealing it's an AI.
 * "I am an AI"-style reveals are sourced per-language from the language registry
 * (src/lang/languages.js); the assistant-speak phrases below are English tells
 * (over-formal helpdesk lines a real person would never send).
 */

import { ALL_AI_REVEAL_PATTERNS } from '../lang/languages.js';

const ASSISTANT_SPEAK = [
    /\bI appreciate your patience\b/i,
    /\bI understand your concern\b/i,
    /\bI'?m here to (help|assist)\b/i,
    /\bHow can I (help|assist) you\b/i,
    /\bIs there anything else\b/i,
    /\bLet me know if you need\b/i,
    // --- Português (BR): revelações de IA e "fala de atendente" ---
    /\bcomo (uma?|o|a) (ia|i\.a\.?|inteligência artificial|inteligencia artificial|modelo de linguagem|modelo de ia|assistente virtual|chatbot)\b/i,
    /\b(eu )?(sou|estou como) (uma?|o|a) (ia|i\.a\.?|inteligência artificial|inteligencia artificial|modelo de linguagem|assistente virtual|chatbot)\b/i,
    /\bassistente virtual\b/i,
    /\bmodelo de linguagem\b/i,
    /\bn[ãa]o tenho (sentimentos|emo[çc][õo]es|opini[õo]es pessoais|corpo|consci[êe]ncia)\b/i,
    /\bn[ãa]o (sou|sou uma?) (pessoa|humano|humana|gente) (de verdade|real)\b/i,
    /\bfui (criado|criada|treinado|treinada|desenvolvido|desenvolvida|programado|programada) (pela|por|pelo)\b/i,
    /\bcomo posso (te |lhe |o |a )?(ajudar|auxiliar|ajudá-?lo|ajudá-?la)\b/i,
    /\bposso (te |lhe )?(ajudar|auxiliar) (em|com) (mais )?(algo|alguma coisa|mais alguma coisa)\b/i,
    /\bagrade[çc]o (a |pela )?(sua )?(paci[êe]ncia|compreens[ãa]o)\b/i,
    /\bentendo (a )?(sua )?preocupa[çc][ãa]o\b/i,
];

const AI_REVEAL_PATTERNS = [...ALL_AI_REVEAL_PATTERNS, ...ASSISTANT_SPEAK];

/**
 * Check if a reply contains AI self-reveal patterns
 */
export function detectAIReveal(text) {
    return AI_REVEAL_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Clean a reply by removing AI-like phrases
 * (Aggressive mode - replaces AI patterns with empty string)
 */
export function cleanAIReveal(text) {
    let result = text;

    // Remove overly formal assistant-like phrases
    const cleanPatterns = [
        /I appreciate your patience[.!]?\s*/gi,
        /I understand your concern[.!]?\s*/gi,
        /Is there anything else I can help (you )?with\??/gi,
        /Let me know if you need anything else[.!]?\s*/gi,
        /I'?m here to help[.!]?\s*/gi,
        /How can I assist you\??/gi,
        // Português (BR): fala de atendente removível (reveals "duros" abortam o envio)
        /como posso (te |lhe )?(ajudar|auxiliar)\??\s*/gi,
        /posso (te |lhe )?(ajudar|auxiliar) (em|com) (mais )?(algo|alguma coisa|mais alguma coisa)\??\s*/gi,
        /agrade[çc]o (a |pela )?(sua )?(paci[êe]ncia|compreens[ãa]o)[.!]?\s*/gi,
        /entendo (a )?(sua )?preocupa[çc][ãa]o[.!]?\s*/gi,
        /estou (aqui )?(para|pra) (te )?ajudar[.!]?\s*/gi,
    ];

    for (const pattern of cleanPatterns) {
        result = result.replace(pattern, '');
    }

    return result.trim();
}
