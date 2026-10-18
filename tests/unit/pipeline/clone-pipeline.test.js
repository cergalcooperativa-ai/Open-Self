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

  it('injects transientDirective when active and not expired', () => {
    const pipeline = new ClonePipeline({ dataDir: root });
    const future = new Date(Date.now() + 3600000).toISOString();
    const prompt = pipeline.buildSystemPrompt({
      name: 'Levi',
      relationship: 'cliente',
      rules: 'Seja breve.',
      transientDirective: {
        directive: 'conduza para fechar o som sem o painel de LED por 800',
        createdAt: new Date().toISOString(),
        expiresAt: future
      }
    });

    expect(prompt).toContain('🎯 OBJETIVO ATUAL DEFINIDO PELO OPERADOR PARA ESTA CONVERSA:');
    expect(prompt).toContain('conduza para fechar o som sem o painel de LED por 800');
    expect(prompt).toContain('Conduza o diálogo com naturalidade e brevidade para atingir esse objetivo');
  });

  it('does NOT inject transientDirective when expired', () => {
    const pipeline = new ClonePipeline({ dataDir: root });
    const past = new Date(Date.now() - 3600000).toISOString();
    const prompt = pipeline.buildSystemPrompt({
      name: 'Levi',
      relationship: 'cliente',
      rules: 'Seja breve.',
      transientDirective: {
        directive: 'diretriz expirada antiga',
        createdAt: new Date(Date.now() - 7200000).toISOString(),
        expiresAt: past
      }
    });

    expect(prompt).not.toContain('🎯 OBJETIVO ATUAL DEFINIDO PELO OPERADOR');
    expect(prompt).not.toContain('diretriz expirada antiga');
  });

  it('generateFallback uses deflection fallback for risk questions', () => {
    const pipeline = new ClonePipeline({ dataDir: root });
    const reply1 = pipeline.generateFallback('que horas tu vem aqui?');
    const reply2 = pipeline.generateFallback('onde tu tá?');
    const reply3 = pipeline.generateFallback('fez o contrato?');

    expect(reply1).toBe('to na correria aqui na rua, mais tarde te confirmo certinho');
    expect(reply2).toBe('to na correria aqui na rua, mais tarde te confirmo certinho');
    expect(reply3).toBe('to na correria aqui na rua, mais tarde te confirmo certinho');
  });
});
