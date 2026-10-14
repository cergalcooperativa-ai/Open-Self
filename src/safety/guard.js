/**
 * Safety Guard
 * Enforces boundaries before sending any reply
 */

import { detectAIReveal } from './ai-detection.js';

// Credenciais/segredos que NUNCA podem sair numa resposta (chaves de API, tokens, senhas ditas em claro)
const SECRET_PATTERNS = [
    /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/,
    /\bsk-[A-Za-z0-9_-]{16,}/,
    /\bgsk_[A-Za-z0-9]{16,}/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bAIza[0-9A-Za-z_-]{30,}/,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    // "a senha é abc123", "token: 9f8a...", "pin = 4821" (valor precisa conter dígito)
    /\b(senha|password|passwd|pwd|token|api[ _-]?key|chave de acesso|pin|c[óo]digo de acesso)\b[^\n]{0,20}?(?:[:=]|\b(?:é|e|eh|is)\b)\s*(?=\S*\d)\S{4,}/i,
];

export function detectSecretLeak(text) {
    return SECRET_PATTERNS.some((p) => p.test(String(text || '')));
}

export class SafetyGuard {
    constructor(soul = {}) {
        this.soul = soul;
    }

    /**
     * Check a reply before sending — returns safety verdict
     */
    checkReply(reply, message = {}, contact = {}) {
        const issues = [];

        // 1. AI self-reveal check
        if (detectAIReveal(reply)) {
            issues.push({ type: 'ai_reveal', severity: 'critical' });
        }

        // 1b. Credential / secret leak
        if (detectSecretLeak(reply)) {
            issues.push({ type: 'secret_leak', severity: 'critical' });
        }

        // 2. Sensitive info leak
        const neverShare = this.soul.neverShare || 'personal finances, health info, passwords';
        const neverShareTopics = neverShare.split(',').map((s) => s.trim().toLowerCase());
        for (const topic of neverShareTopics) {
            if (topic && reply.toLowerCase().includes(topic)) {
                issues.push({ type: 'sensitive_info', topic, severity: 'high' });
            }
        }

        // 3. Avoided topics in incoming message
        const avoidTopics = this.soul.avoidTopics || '';
        const avoidList = avoidTopics
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
        for (const topic of avoidList) {
            if (message.text && message.text.toLowerCase().includes(topic)) {
                const deflect =
                    this.soul.deflectMessage ||
                    this.soul.unsureFallback ||
                    "Let's not get into that 😅";
                return {
                    safe: false,
                    action: 'deflect',
                    deflectMessage: deflect,
                    issues: [{ type: 'avoided_topic', topic, severity: 'medium' }],
                };
            }
        }

        // 4. Unknown contact → caution mode
        if (!contact.known && contact.name === 'Unknown') {
            issues.push({ type: 'unknown_contact', severity: 'low' });
        }

        // Determine action
        if (issues.some((i) => i.severity === 'critical')) {
            return { safe: false, action: 'block', issues };
        }
        if (issues.some((i) => i.severity === 'high')) {
            return { safe: false, action: 'queue_for_review', issues };
        }

        return { safe: true, issues };
    }
}
