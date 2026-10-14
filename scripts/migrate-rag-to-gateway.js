#!/usr/bin/env node
/**
 * Migra o indice legado (vectra: data/memory-index/index.json — Neia, Tayla, Edlayne...)
 * para o formato que o gateway le (data/memory-index/vectors.json + metadata.json).
 *
 * - Idempotente: ChatMemory.indexHistory deduplica por contato+data+hora+mensagens.
 * - Nao altera nem apaga o index.json legado (continua sendo lido por src/rag/memory.js).
 *
 * Uso: node scripts/migrate-rag-to-gateway.js [dataDir=./data] [--dry]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChatMemory } from '../src/memory/rag.js';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const dataDir = args.find((a) => !a.startsWith('--')) || './data';
const legacyFile = join(dataDir, 'memory-index', 'index.json');

if (!existsSync(legacyFile)) {
    console.error(`Indice legado nao encontrado: ${legacyFile}`);
    process.exit(1);
}

const legacy = JSON.parse(readFileSync(legacyFile, 'utf-8'));
const conversations = (legacy.items || [])
    .map((item) => item.metadata || {})
    .filter((m) => m.contact && (m.theirMessage || m.yourReply))
    .map((m) => ({
        contact: m.contact,
        theirMessage: m.theirMessage || '',
        yourReply: m.yourReply || '',
        date: m.date,
        time: m.time,
        replyDelay: m.replyDelay,
    }));

const perContact = {};
for (const c of conversations) perContact[c.contact] = (perContact[c.contact] || 0) + 1;
console.log(`Legado: ${legacy.items.length} itens, ${conversations.length} validos`, perContact);

const memory = new ChatMemory(dataDir);
await memory.init();
const before = memory.metadata.length;

if (dry) {
    console.log(`[dry-run] gateway tem ${before} entradas; nada gravado.`);
    process.exit(0);
}

await memory.indexHistory(conversations, { dedupe: true });
const after = memory.metadata.length;
console.log(`Gateway: ${before} -> ${after} entradas (+${after - before}).`);
console.log('Por contato (gateway):', Object.fromEntries(
    [...new Set(memory.metadata.map((m) => memory.normalizeContact(m.contact)))].map((c) => [
        c,
        memory.metadata.filter((m) => memory.normalizeContact(m.contact) === c).length,
    ]),
));
