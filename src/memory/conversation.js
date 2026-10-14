/**
 * Conversation Memory — Per-contact context tracking
 * Keeps track of recent exchanges for coherent multi-turn conversations
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export class ConversationMemory {
    constructor(dataDir = './data') {
        this.dataDir = dataDir;
        this.memoryFile = join(dataDir, 'memory.md');
        this.sessionsFile = join(dataDir, 'conversation-sessions.json');
        // modo teste: E2E/debug nao polui o historico real do operator
        this.persist = process.env.OPENSELF_NO_PERSIST !== '1';
        this.sessions = new Map(); // In-memory per-contact sessions
        this._loadSessions();
    }

    /**
     * Reload persisted sessions (survives gateway restarts — the clone
     * keeps live-conversation context after any restart)
     */
    _loadSessions() {
        try {
            if (existsSync(this.sessionsFile)) {
                const data = JSON.parse(readFileSync(this.sessionsFile, 'utf-8'));
                for (const [contact, exchanges] of Object.entries(data)) {
                    this.sessions.set(contact, exchanges);
                }
            }
        } catch {
            // arquivo corrompido: comeca limpo (nao derruba o gateway)
        }
    }

    _saveSessions() {
        // sessions.json = CONTEXTO OPERACIONAL: grava sempre (sobrevive a
        // restart). OPENSELF_NO_PERSIST controla apenas o log de auditoria.
        try {
            const obj = {};
            for (const [contact, exs] of this.sessions) obj[contact] = exs;
            writeFileSync(this.sessionsFile, JSON.stringify(obj), 'utf-8');
        } catch {
            // non-critical
        }
    }

    /**
     * Add a message exchange to the conversation context
     */
    addExchange(contact, theirMessage, cloneReply) {
        if (!this.sessions.has(contact)) {
            this.sessions.set(contact, []);
        }

        const session = this.sessions.get(contact);
        const last = session[session.length - 1];

        // Atualiza a mensagem pendente em vez de duplicar
        if (
            last &&
            last.them === theirMessage &&
            last.clone === '[PENDING_REPLY]' &&
            cloneReply !== '[PENDING_REPLY]'
        ) {
            last.clone = cloneReply;
            last.timestamp = new Date().toISOString();
        } else {
            session.push({
                timestamp: new Date().toISOString(),
                them: theirMessage,
                clone: cloneReply,
            });
        }

        // Keep only last 20 exchanges per contact (sliding window)
        if (session.length > 20) {
            session.splice(0, session.length - 20);
        }

        // Persist sessions (contexto vivo p/ proximas respostas e restarts)
        this._saveSessions();
        // Persist to memory.md (log de auditoria)
        if (this.persist) this._appendToFile(contact, theirMessage, cloneReply);
    }

    /**
     * Collapse a burst of pending messages (one per incoming message) into a single
     * exchange: theirs joined by newline, followed by the one merged reply.
     */
    resolveBatch(contact, texts, reply) {
        if (!this.sessions.has(contact)) this.sessions.set(contact, []);
        const session = this.sessions.get(contact);
        const remaining = [...texts];
        while (
            session.length &&
            session[session.length - 1].clone === '[PENDING_REPLY]' &&
            remaining.includes(session[session.length - 1].them)
        ) {
            const gone = session.pop();
            remaining.splice(remaining.lastIndexOf(gone.them), 1);
        }
        session.push({
            timestamp: new Date().toISOString(),
            them: texts.join('\n'),
            clone: reply,
        });
        if (session.length > 20) session.splice(0, session.length - 20);
        this._saveSessions();
        if (this.persist) this._appendToFile(contact, texts.join(' / '), reply);
    }

    /**
     * Record a reply from the operator/user, resolving pending contact messages
     */
    recordUserReply(contact, reply) {
        if (!this.sessions.has(contact)) {
            this.sessions.set(contact, []);
        }
        const session = this.sessions.get(contact);
        const last = session[session.length - 1];
        if (last && (last.clone === '[PENDING_REPLY]' || last.clone === '[TRIGGER]')) {
            last.clone = reply;
            last.timestamp = new Date().toISOString();
        } else {
            session.push({
                timestamp: new Date().toISOString(),
                them: '',
                clone: reply,
            });
        }
        if (session.length > 20) session.splice(0, session.length - 20);
        this._saveSessions();
    }

    /**
     * Get recent conversation context for a contact (filters internal markers)
     */
    getRecentContext(contact, maxExchanges = 10) {
        const session = this.sessions.get(contact);
        if (!session || session.length === 0) return '';

        const MARKER_REPLIES = new Set(['[TRIGGER]', '[PENDING_REPLY]', '']);
        const recent = session.slice(-maxExchanges);
        const lines = [];

        for (const ex of recent) {
            if (ex.them) lines.push(`${contact}: ${ex.them}`);
            if (ex.clone && !MARKER_REPLIES.has(ex.clone)) lines.push(`You: ${ex.clone}`);
        }

        return lines.join('\n\n');
    }

    /**
     * Get all active contacts
     */
    getActiveContacts() {
        const contacts = [];
        for (const [name, session] of this.sessions) {
            contacts.push({
                name,
                messageCount: session.length,
                lastMessage: session[session.length - 1]?.timestamp || '',
            });
        }
        return contacts.sort((a, b) => b.lastMessage.localeCompare(a.lastMessage));
    }

    /**
     * Clear session for a contact
     */
    clearSession(contact) {
        this.sessions.delete(contact);
    }

    /**
     * Append exchange to memory.md (long-term memory)
     */
    _appendToFile(contact, theirMessage, cloneReply) {
        if (!existsSync(this.dataDir)) {
            mkdirSync(this.dataDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
        const entry = `\n## ${timestamp} — ${contact}\n- **Them:** ${theirMessage}\n- **Clone:** ${cloneReply}\n`;

        try {
            let content = '';
            if (existsSync(this.memoryFile)) {
                content = readFileSync(this.memoryFile, 'utf-8');
            } else {
                content =
                    '# OpenSelf — Conversation Memory\n\nAuto-generated log of clone conversations.\n';
            }
            writeFileSync(this.memoryFile, content + entry, 'utf-8');
        } catch {
            // Non-critical, don't crash
        }
    }

    /**
     * Load memory.md summary
     */
    getMemorySummary() {
        if (!existsSync(this.memoryFile)) return null;

        try {
            const content = readFileSync(this.memoryFile, 'utf-8');
            const lines = content.split('\n');
            const exchanges = lines.filter((l) => l.startsWith('## ')).length;
            return {
                file: this.memoryFile,
                totalExchanges: exchanges,
                sizeBytes: Buffer.byteLength(content),
            };
        } catch {
            return null;
        }
    }
}
