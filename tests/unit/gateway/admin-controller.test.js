import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AdminController } from '../../../src/gateway/admin-controller.js';
import { WhatsAppGateway } from '../../../src/gateway/whatsapp.js';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('AdminController — WhatsApp Self-Chat Control Panel (v1.4.0)', () => {
  let tmpDir;
  let mockGateway;
  let sentMessages;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openself-admin-test-'));
    sentMessages = [];

    mockGateway = {
      dataDir: tmpDir,
      sessionOwnerNumber: '554899999999',
      contacts: {
        Levi: {
          name: 'Levi',
          relationship: 'cliente',
          rules: 'Seja breve.',
          avgReplyWords: 8,
          formality: 'casual'
        }
      },
      triggers: {
        Levi: true,
        Diana: false
      },
      sentIds: new Set(),
      _pending: new Map(),
      normalizeContact: (c) => String(c).replace(/^[~\s]+/, '').trim(),
      saveContacts: vi.fn(),
      getTriggerState: (c) => mockGateway.triggers[c] === true,
      sock: {
        user: { id: '554899999999:1@s.whatsapp.net', name: 'Johnny' },
        sendMessage: vi.fn(async (jid, content) => {
          const sent = { key: { id: 'MSG_' + Math.random().toString(36).slice(2), remoteJid: jid } };
          sentMessages.push({ jid, text: content.text, id: sent.key.id });
          return sent;
        })
      },
      _flushPending: vi.fn(async () => {})
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Directives Management (/instruir)', () => {
    it('saves transientDirective with 24h TTL and confirms via Self-Chat', async () => {
      const admin = new AdminController(mockGateway);
      const msg = { key: { remoteJid: '554899999999@s.whatsapp.net' } };

      await admin.handleCommand('/instruir Levi fechar o som sem LED por 800', msg);

      expect(mockGateway.contacts.Levi.transientDirective).toBeDefined();
      expect(mockGateway.contacts.Levi.transientDirective.directive).toBe('fechar o som sem LED por 800');
      expect(mockGateway.saveContacts).toHaveBeenCalled();

      const expires = new Date(mockGateway.contacts.Levi.transientDirective.expiresAt);
      const now = new Date();
      const diffHours = (expires.getTime() - now.getTime()) / (1000 * 60 * 60);
      expect(diffHours).toBeGreaterThan(23);
      expect(diffHours).toBeLessThanOrEqual(24.1);

      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].text).toContain('✅ Diretriz gravada para Levi. O clone seguirá este objetivo nas próximas respostas.');
      expect(mockGateway.sentIds.has(sentMessages[0].id)).toBe(true);
    });

    it('creates profile if contact does not exist yet', async () => {
      const admin = new AdminController(mockGateway);
      const msg = { key: { remoteJid: '554899999999@s.whatsapp.net' } };

      await admin.handleCommand('/instruir Marcos cobrar os cabos pendentes', msg);

      expect(mockGateway.contacts.Marcos).toBeDefined();
      expect(mockGateway.contacts.Marcos.transientDirective.directive).toBe('cobrar os cabos pendentes');
      expect(sentMessages[0].text).toContain('✅ Diretriz gravada para Marcos.');
    });

    it('shows usage message when syntax is incomplete', async () => {
      const admin = new AdminController(mockGateway);
      const msg = { key: { remoteJid: '554899999999@s.whatsapp.net' } };

      await admin.handleCommand('/instruir', msg);
      expect(sentMessages[0].text).toContain('⚠️ Sintaxe: /instruir [NomeDoContato] [diretriz]');

      await admin.handleCommand('/instruir Levi', msg);
      expect(sentMessages[1].text).toContain('⚠️ Sintaxe: /instruir [NomeDoContato] [diretriz]');
    });
  });

  describe('Pending Conversations (/pendencias e /resumo)', () => {
    it('reports pending messages with time and trigger status', async () => {
      const sessions = {
        Levi: [
          { timestamp: '2026-10-18T17:32:00.000Z', them: 'Consegue me passar os valores hoje?', clone: '[PENDING_REPLY]' }
        ],
        Diana: [
          { timestamp: '2026-10-18T18:10:00.000Z', them: 'Tais em casa neh ?', clone: '[PENDING_REPLY]' }
        ],
        Neia: [
          { timestamp: '2026-10-18T18:00:00.000Z', them: 'Oi amor', clone: 'Oi linda' }
        ]
      };
      writeFileSync(join(tmpDir, 'conversation-sessions.json'), JSON.stringify(sessions));

      const admin = new AdminController(mockGateway);
      const msg = { key: { remoteJid: '554899999999@s.whatsapp.net' } };

      await admin.handleCommand('/pendencias', msg);

      expect(sentMessages.length).toBe(1);
      const reply = sentMessages[0].text;
      expect(reply).toContain('📋 CONVERSAS PENDENTES:');
      expect(reply).toContain('• Levi: "Consegue me passar os valores hoje?"');
      expect(reply).toContain('[Gatilho: ATIVO]');
      expect(reply).toContain('• Diana: "Tais em casa neh ?"');
      expect(reply).toContain('[Gatilho: INATIVO]');
      expect(reply).not.toContain('Neia');
    });

    it('reports clean message when there are no pending conversations', async () => {
      writeFileSync(join(tmpDir, 'conversation-sessions.json'), JSON.stringify({}));
      const admin = new AdminController(mockGateway);
      const msg = { key: { remoteJid: '554899999999@s.whatsapp.net' } };

      await admin.handleCommand('/resumo', msg);

      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].text).toContain('Nenhuma conversa pendente no momento.');
    });
  });

  describe('System Status (/status)', () => {
    it('returns uptime, memory, socket status, and active triggers', async () => {
      const admin = new AdminController(mockGateway);
      const msg = { key: { remoteJid: '554899999999@s.whatsapp.net' } };

      await admin.handleCommand('/status', msg);

      expect(sentMessages.length).toBe(1);
      const reply = sentMessages[0].text;
      expect(reply).toContain('📊 STATUS DO SISTEMA:');
      expect(reply).toContain('• Uptime:');
      expect(reply).toContain('• Memória (RSS):');
      expect(reply).toContain('• Socket: Conectado (554899999999:1@s.whatsapp.net)');
      expect(reply).toContain('• Gatilhos Ativos: Levi');
    });
  });

  describe('Human-in-the-Loop Responding (/responder)', () => {
    it('flushes pending buffer immediately when /responder is issued for a buffered contact', async () => {
      mockGateway._pending.set('Levi', { contactName: 'Levi', texts: ['vai vir aqui que horas?'] });

      const admin = new AdminController(mockGateway);
      const msg = { key: { remoteJid: '554899999999@s.whatsapp.net' } };

      await admin.handleCommand('/responder Levi vou passar aí pelas 18h com os cabos', msg);

      expect(mockGateway.contacts.Levi.transientDirective).toBeDefined();
      expect(mockGateway.contacts.Levi.transientDirective.directive).toBe('vou passar aí pelas 18h com os cabos');
      expect(mockGateway._flushPending).toHaveBeenCalledWith('Levi');
      expect(sentMessages[0].text).toContain('✅ Resposta guiada registrada para Levi. Disparando resposta agora.');
    });

    it('saves guidance for next reply when contact is not in buffer', async () => {
      const admin = new AdminController(mockGateway);
      const msg = { key: { remoteJid: '554899999999@s.whatsapp.net' } };

      await admin.handleCommand('/responder Diana to terminando um som e já chego', msg);

      expect(mockGateway.contacts.Diana.transientDirective.directive).toBe('to terminando um som e já chego');
      expect(sentMessages[0].text).toContain('✅ Orientação gravada para Diana. O clone utilizará esta diretriz na próxima resposta.');
    });
  });

  describe('Risk Question Notifications (notifyRiskQuestion)', () => {
    it('sends an alert to the self-chat with guidance instructions', async () => {
      const admin = new AdminController(mockGateway);
      await admin.notifyRiskQuestion('Levi', 'que horas tu vem aqui hoje?');

      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].jid).toBe('554899999999@s.whatsapp.net');
      expect(sentMessages[0].text).toContain('⚠️ [Pergunta de Risco - Levi]: "que horas tu vem aqui hoje?"');
      expect(sentMessages[0].text).toContain('Responda: "/responder Levi [sua orientação]"');
    });

    it('debounces multiple risk alerts for the same contact within 60s', async () => {
      const admin = new AdminController(mockGateway);
      await admin.notifyRiskQuestion('Levi', 'que horas tu vem aqui?');
      await admin.notifyRiskQuestion('Levi', 'vai vir hoje?');

      expect(sentMessages.length).toBe(1);
    });
  });

  describe('Help and Unknown Command Handling', () => {
    it('returns full command menu on /ajuda', async () => {
      const admin = new AdminController(mockGateway);
      const msg = { key: { remoteJid: '554899999999@s.whatsapp.net' } };

      await admin.handleCommand('/ajuda', msg);

      expect(sentMessages[0].text).toContain('🤖 PAINEL DE CONTROLE (Open-Self v1.4.0):');
      expect(sentMessages[0].text).toContain('/instruir');
      expect(sentMessages[0].text).toContain('/responder');
      expect(sentMessages[0].text).toContain('/pendencias');
      expect(sentMessages[0].text).toContain('/status');
    });

    it('handles unrecognized commands gracefully', async () => {
      const admin = new AdminController(mockGateway);
      const msg = { key: { remoteJid: '554899999999@s.whatsapp.net' } };

      await admin.handleCommand('/qualquercoisa', msg);

      expect(sentMessages[0].text).toContain('Comando não reconhecido. Use /ajuda');
    });
  });

  describe('Self-Chat Isolation in WhatsAppGateway', () => {
    it('routes self-chat message to AdminController without saving to RAG or firing triggers', async () => {
      const gw = new WhatsAppGateway({ dataDir: tmpDir, sessionOwnerNumber: '554899999999' });
      gw.sock = {
        user: { id: '554899999999@s.whatsapp.net', name: 'Johnny' },
        sendMessage: vi.fn(async () => ({ key: { id: 'REPLY_123' } }))
      };
      gw.adminController.handleCommand = vi.fn(async () => {});
      gw.learnFromContact = vi.fn();
      gw.processTriggers = vi.fn();

      const selfMsg = {
        key: { remoteJid: '554899999999@s.whatsapp.net', id: 'CMD_001', fromMe: true },
        message: { conversation: '/status' }
      };

      await gw.handleMessage(selfMsg);

      expect(gw.adminController.handleCommand).toHaveBeenCalledWith('/status', selfMsg);
      expect(gw.learnFromContact).not.toHaveBeenCalled();
      expect(gw.processTriggers).not.toHaveBeenCalled();
    });

    it('matches self-chat even with device suffix (:20) or LID', async () => {
      const gw = new WhatsAppGateway({ dataDir: tmpDir, sessionOwnerNumber: '554899999999' });
      gw.sock = {
        user: { id: '554899999999:20@s.whatsapp.net', lid: '19796259246217:20@lid', name: 'Johnny' },
        sendMessage: vi.fn(async () => ({ key: { id: 'REPLY_123' } }))
      };
      gw.adminController.handleCommand = vi.fn(async () => {});

      const selfLidMsg = {
        key: { remoteJid: '19796259246217@lid', id: 'CMD_002', fromMe: true },
        message: { conversation: '/status' }
      };

      await gw.handleMessage(selfLidMsg);

      expect(gw.adminController.handleCommand).toHaveBeenCalledWith('/status', selfLidMsg);
    });

    it('ignores echoes sent by the bot itself', async () => {
      const gw = new WhatsAppGateway({ dataDir: tmpDir, sessionOwnerNumber: '554899999999' });
      gw.sentIds.add('BOT_SENT_999');
      gw.adminController.handleCommand = vi.fn();

      const echoMsg = {
        key: { remoteJid: '554899999999@s.whatsapp.net', id: 'BOT_SENT_999', fromMe: true },
        message: { conversation: '✅ Diretriz gravada' }
      };

      await gw.handleMessage(echoMsg);

      expect(gw.adminController.handleCommand).not.toHaveBeenCalled();
    });
  });
});
