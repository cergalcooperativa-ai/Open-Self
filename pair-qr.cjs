// Pareamento standalone WhatsApp (Baileys) — grava a string do QR em /tmp/wa_qr.txt
// Fix: logger pino (hand-rolled quebra em child-of-child) + require() (igual ao teste provado)
// NAO chama logout: apenas pareia, salva creds e sai. O gateway real reconecta com a mesma sessao.
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const baileys = require('@whiskeysockets/baileys');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;

const SESSION_DIR = path.join(__dirname, 'data', 'whatsapp-session');

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  console.log('[PAIR] iniciando ' + new Date().toISOString());

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    qrTimeout: 60000,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      try {
        fs.writeFileSync('/tmp/wa_qr.txt', qr);
        console.log('[PAIR] QR novo salvo em /tmp/wa_qr.txt (' + new Date().toISOString() + ')');
      } catch (e) {
        console.log('[PAIR] erro ao gravar QR: ' + e.message);
      }
    }
    if (connection === 'open') {
      console.log('[PAIR] *** CONECTADO *** me=' + JSON.stringify(sock.user && sock.user.id));
      try {
        fs.writeFileSync('/tmp/wa_paired.json', JSON.stringify({ paired: true, ts: Date.now(), me: sock.user && sock.user.id }));
      } catch (e) {}
      // creds ja salvos via creds.update — sai limpo sem logout
      setTimeout(() => process.exit(0), 2000);
    }
    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
      console.log('[PAIR] connection close, statusCode=' + code);
      if (code === DisconnectReason.loggedOut) {
        try { fs.writeFileSync('/tmp/wa_pair_error.txt', 'loggedOut'); } catch (e) {}
        process.exit(2);
      }
      process.exit(1);
    }
  });
}

main().catch(e => { console.error('[PAIR] FATAL: ' + ((e && e.message) || e)); process.exit(3); });
