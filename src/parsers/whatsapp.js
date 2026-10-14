import { readFileSync } from 'fs';

/**
 * Parse WhatsApp chat export (.txt) files
 * Format: "DD/MM/YYYY, HH:MM - Name: Message"
 */

const WHATSAPP_PATTERN = /^(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s(\d{1,2}:\d{2}(?::\d{2})?)\s-\s([^:]+):\s(.+)/;
const SYSTEM_PATTERN = /^(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s(\d{1,2}:\d{2}(?::\d{2})?)\s-\s(.+)/;
// BR/PT export: [DD/MM/YYYY, HH:MM:SS] Name: message  (may carry invisible LRM U+200E)
const BIDI_CHARS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const WHATSAPP_BR_PATTERN = /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^:]{1,60}?)\s*:\s*(.*)$/;
// media placeholders (PT-BR + EN)
// sufixo de midia anexada em mensagem com texto: "Matei ele imagem ocultada"
const MEDIA_SUFFIX_RE = /[\s\u200e]*(\u200e)?((audio|\u00e1udio|imagem|image|foto|photo|video|v\u00eddeo|sticker|figurinha|documento|document|gif|localiza\u00e7\u00e3o|location|poll|enquete|contact|contato|recado de v\u00eddeo|recado de video)\b[^,]{0,50}\b(ocultad|omitid|omiti)[oa]?)/gi;
const MEDIA_RE = /^((audio|\u00e1udio|imagem|image|foto|photo|video|v\u00eddeo|sticker|figurinha|documento|document|gif|localiza\u00e7\u00e3o|location|poll|enquete|contact|contato)\b[^,]{0,50}\b(ocultad|omitid|omitted|excluded|deleted|omiti)|ligacao de (voz|video) perdida|missed (voice|video) call)/i;

export function parseWhatsApp(filePath) {
    const content = readFileSync(filePath, 'utf-8');
    return parseWhatsAppContent(content);
}

export function parseWhatsAppContent(content) {
    // WhatsApp exports embed invisible bidi marks — strip them up front
    content = content.replace(BIDI_CHARS, '');
    const lines = content.split('\n').map((l) => l.replace(/\r$/, ''));
    const messages = [];
    let currentMessage = null;

    for (const line of lines) {
        let match = line.match(WHATSAPP_BR_PATTERN);
        if (match) {
            if (currentMessage) {
                messages.push(currentMessage);
            }
            let brText = (match[4] || '').trim();
            const brSender = match[3].trim();
            // texto legitimo + midia anexada: preserva o texto, descarta o sufixo de midia
            brText = brText.replace(MEDIA_SUFFIX_RE, '').trim();
            const isMedia = brText && MEDIA_RE.test(brText);
            const isSystem = !brText; // header "Name:" vazio = mensagem em branco/multi-line
            if (isMedia) {
                currentMessage = null; // media placeholder — skip continuations
            } else if (isSystem) {
                // mensagem iniciada com conteudo em linhas seguintes (raro) — ignora header vazio
                currentMessage = null;
            } else {
                currentMessage = {
                    date: match[1],
                    time: match[2],
                    sender: brSender,
                    text: brText,
                };
            }
            continue;
        }
        // Linha de sistema BR: timestamp sem ": sender" (ex.: criptografia, "X entrou no grupo")
        if (line.match(/^\[\d{1,2}\/\d{1,2}\/\d{2,4},?\s\d{1,2}:\d{2}(?::\d{2})?\]\s*[^:]{0,200}$/)) {
            if (currentMessage) {
                messages.push(currentMessage);
                currentMessage = null;
            }
            continue;
        }
        match = line.match(WHATSAPP_PATTERN);
        if (match) {
            // Save previous message
            if (currentMessage) {
                messages.push(currentMessage);
            }
            const clsText = (match[4] || '').replace(MEDIA_SUFFIX_RE, '').trim();
            currentMessage = {
                date: match[1],
                time: match[2],
                sender: match[3].trim(),
                text: clsText,
            };
        } else if (SYSTEM_PATTERN.test(line) && !WHATSAPP_PATTERN.test(line)) {
            // System message (e.g., "Messages are end-to-end encrypted")
            if (currentMessage) {
                messages.push(currentMessage);
                currentMessage = null;
            }
        } else if (currentMessage && line.trim()) {
            // Multi-line message continuation
            currentMessage.text += '\n' + line.trim();
        }
    }

    // Push last message
    if (currentMessage) {
        messages.push(currentMessage);
    }

    // Filter out media-only messages
    return messages.filter((m) => !m.text.includes('<Media omitted>') && !MEDIA_RE.test(m.text));
}

/**
 * Split messages by sender: YOUR messages vs OTHERS
 */
export function splitBySender(messages, yourName) {
    const yours = messages.filter((m) => m.sender === yourName);
    const others = messages.filter((m) => m.sender !== yourName);
    const conversations = groupIntoConversations(messages, yourName);

    return { yours, others, conversations };
}

/**
 * Group messages into Q&A conversation pairs
 * Each pair: someone asks → you reply
 */
export function groupIntoConversations(messages, yourName) {
    const conversations = [];
    let pendingQuestion = null;

    for (const msg of messages) {
        if (msg.sender !== yourName) {
            // Someone else's message — potential question
            pendingQuestion = msg;
        } else if (pendingQuestion) {
            // Your reply to their message
            conversations.push({
                contact: pendingQuestion.sender,
                date: pendingQuestion.date,
                time: pendingQuestion.time,
                theirMessage: pendingQuestion.text,
                yourReply: msg.text,
                replyDelay: calculateDelay(pendingQuestion.time, msg.time),
            });
            pendingQuestion = null;
        }
    }

    return conversations;
}

/**
 * Detect the user's name from messages (most frequent sender, or manual)
 */
export function detectUserName(messages) {
    const senderCounts = {};
    for (const msg of messages) {
        senderCounts[msg.sender] = (senderCounts[msg.sender] || 0) + 1;
    }

    // Sort by frequency — the most frequent sender is likely the user
    const sorted = Object.entries(senderCounts).sort((a, b) => b[1] - a[1]);
    return {
        likelyUser: sorted[0]?.[0] || 'Unknown',
        allSenders: sorted.map(([name, count]) => ({ name, count })),
    };
}

function calculateDelay(time1, time2) {
    const [h1, m1] = time1.split(':').map(Number);
    const [h2, m2] = time2.split(':').map(Number);
    return (h2 * 60 + m2 - (h1 * 60 + m1)) * 60 * 1000; // ms
}
