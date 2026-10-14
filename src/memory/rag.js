/**
 * Chat Memory - RAG (Retrieval-Augmented Generation) over conversation history
 * Vector-based long-term memory with strict contact isolation
 */

import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

export class ChatMemory {
  constructor(dataDir = './data') {
    this.dataDir = dataDir;
    this.indexDir = join(dataDir, 'memory-index');
    this.vectors = [];
    this.metadata = [];
    this.vocabulary = new Set();
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    
    if (!existsSync(this.indexDir)) {
      mkdirSync(this.indexDir, { recursive: true });
    }

    this.indexFile = join(this.indexDir, 'vectors.json');
    this.metadataFile = join(this.indexDir, 'metadata.json');
    
    if (existsSync(this.indexFile)) {
      this.vectors = JSON.parse(readFileSync(this.indexFile, 'utf-8'));
      this.metadata = JSON.parse(readFileSync(this.metadataFile, 'utf-8'));
    } else {
      this.vectors = [];
      this.metadata = [];
    }
    
    // occurrence-aware keys: identical messages on the same day stay distinct, but
    // re-feeding the same export (opt-in dedupe) maps to the same keys and is skipped
    this._keys = new Set();
    const seen = new Map();
    for (const m of this.metadata) {
      const base = this._key(m);
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      this._keys.add(base + '#' + n);
    }
    this.initialized = true;
  }

  _key(c) {
    return [
      this.normalizeContact(c.contact),
      c.date || '',
      c.time || '',
      c.theirMessage || '',
      c.yourReply || ''
    ].join('\u0001');
  }

  createEmbedding(text) {
    const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 2);
    const vector = {};
    for (const word of words) {
      this.vocabulary.add(word);
      vector[word] = (vector[word] || 0) + 1;
    }
    const norm = Math.sqrt(Object.values(vector).reduce((a, b) => a + b * b, 0));
    for (const k of Object.keys(vector)) {
      vector[k] /= norm || 1;
    }
    return vector;
  }

  cosineSimilarity(vecA, vecB) {
    let dot = 0;
    for (const k of Object.keys(vecA)) {
      if (vecB[k]) dot += vecA[k] * vecB[k];
    }
    return dot;
  }

  async indexHistory(conversations, options = {}) {
    await this.init();
    
    const batchSize = options.batchSize || 20;
    
    // options.dedupe (feed / migration): idempotent re-runs. The live gateway indexes one
    // message at a time and never dedupes (a repeated "ok" is a real new message).
    const dedupe = options.dedupe === true;
    const seenInCall = new Map();

    for (const conv of conversations) {
      if (dedupe) {
        const base = this._key(conv);
        const n = seenInCall.get(base) || 0;
        seenInCall.set(base, n + 1);
        const key = base + '#' + n;
        if (this._keys.has(key)) continue;
        this._keys.add(key);
      }

      const text = `${conv.contact || ''}: ${conv.theirMessage ?? ''}\nYou: ${conv.yourReply ?? ''}`;
      const vector = this.createEmbedding(text);
      
      this.vectors.push(vector);
      this.metadata.push({
        contact: conv.contact,
        theirMessage: conv.theirMessage,
        yourReply: conv.yourReply,
        date: conv.date,
        time: conv.time,
        replyDelay: conv.replyDelay
      });
    }

    writeFileSync(join(this.indexDir, 'vectors.json'), JSON.stringify(this.vectors));
    writeFileSync(join(this.indexDir, 'metadata.json'), JSON.stringify(this.metadata));
    
    return this.metadata.length;
  }

  async findRelevant(query, contact, limit = 5) {
    await this.init();
    
    const queryVec = this.createEmbedding(query);
    const normalizedContact = String(contact).replace(/^[~\s]+/, '').trim();
    
    const candidates = this.metadata
      .map((meta, idx) => ({
        ...meta,
        score: this.cosineSimilarity(queryVec, this.vectors[idx]),
        idx
      }))
      .filter(m => this.normalizeContact(m.contact) === this.normalizeContact(contact))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    
    return candidates;
  }

  cosineSimilarity(vecA, vecB) {
    let dot = 0;
    for (const k of Object.keys(vecA)) {
      if (vecB[k]) dot += vecA[k] * vecB[k];
    }
    return dot;
  }

  normalizeContact(name) {
    return String(name).replace(/^[~\s]+/, '').trim();
  }

  formatContext(memories) {
    if (!memories || memories.length === 0) return '';
    return memories
      .map((m, i) => `[Memory ${i + 1}] ${m.contact || ''}: ${m.theirMessage}\nYou: ${m.yourReply}`)
      .join('\n\n');
  }

  getStats() {
    return {
      totalMemories: this.metadata.length,
      totalVectors: this.vectors.length,
      uniqueContacts: [...new Set(this.metadata.map(m => this.normalizeContact(m.contact)))].length,
      vocabularySize: this.vocabulary.size
    };
  }
}

