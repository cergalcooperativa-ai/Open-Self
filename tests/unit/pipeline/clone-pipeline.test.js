import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClonePipeline } from '../../../src/pipeline/clone.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('ClonePipeline — Decoupled & Agnostic Pipeline', () => {
  let root;
  let dataDir;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openself-clone-'));
    dataDir = join(root, 'data');
    writeFileSync(
      join(root, 'SOUL.md'),
      `# SOUL.md\n## Identity\n- Name: Carlos\n- Business: Padaria Central\n- Region: Curitiba / PR\n\n## Linguistic DNA\n- Dialeto: piá, leite quente`
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('buildSystemPrompt is agnostic and uses dynamic ownerName and SOUL.md content', () => {
    const pipeline = new ClonePipeline({ dataDir: root });
    const prompt = pipeline.buildSystemPrompt({ name: 'Ana', relationship: 'cliente' }, 'recent msg', 'rag msg');

    expect(prompt).toContain('Você é Carlos');
    expect(prompt).toContain('Ana');
    expect(prompt).toContain('Padaria Central');
    expect(prompt).toContain('Curitiba / PR');
    expect(prompt).not.toContain('Johnny');
    expect(prompt).not.toContain('Megasom&luz');
    expect(prompt).not.toContain('Santa Catarina');
  });

  it('respects contact.ownerName when provided by WhatsApp session', () => {
    const pipeline = new ClonePipeline({ dataDir: root });
    const prompt = pipeline.buildSystemPrompt({ name: 'Ana', ownerName: 'Mariana' });

    expect(prompt).toContain('Você é Mariana');
    expect(prompt).toContain('Ana');
  });

  it('has no hardcoded identity when SOUL.md is empty or missing', () => {
    const pipeline = new ClonePipeline({ dataDir: join(root, 'nonexistent') });
    const prompt = pipeline.buildSystemPrompt({ name: 'Pedro' });

    expect(prompt).toContain('Operador');
    expect(prompt).not.toContain('Johnny');
    expect(prompt).not.toContain('Megasom&luz');
  });
});
