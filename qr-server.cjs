// Servidor HTTP minimo: expoe o QR do WhatsApp como PNG escaneavel + status de pareamento
const http = require('http');
const fs = require('fs');
const QR = require('qrcode');

const PORT = 33157;

function qrState() {
  try {
    const s = fs.readFileSync('/tmp/wa_qr.txt', 'utf-8').trim();
    if (s.length > 20) return s;
  } catch (e) {}
  return null;
}
function paired() { return fs.existsSync('/tmp/wa_paired.json'); }

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  try {
    if (url === '/qr.img') {
      const s = qrState();
      if (!s) { res.writeHead(503, { 'Content-Type': 'text/plain' }); return res.end('QR ainda nao gerado'); }
      const buf = await QR.toBuffer(s, { width: 480, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(buf);
    }
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ qr_available: !!qrState(), paired: paired(), ts: Date.now() }));
    }
    // "/" e "/qr" — pagina do QR
    if (paired()) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset=utf-8><title>WhatsApp</title><body style="font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a7d32;color:#fff"><h1>CONECTADO — pode fechar esta pagina</h1></body>');
    }
    const ready = !!qrState();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>QR WhatsApp</title>' +
      '<body style="font-family:monospace;margin:0;background:#111;color:#eee;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh">' +
      '<div style="background:#fff;padding:16px;border-radius:12px">' +
      (ready ? '<img src="/qr.img" style="width:min(80vw,440px);image-rendering:pixelated">' : '<p style="color:#111">Gerando QR... aguarde</p>') +
      '</div>' +
      '<p style="font-size:13px;margin-top:14px">WhatsApp &rarr; Aparelhos conectados &rarr; Conectar aparelho</p>' +
      '<script>setTimeout(function(){location.reload()},4000)</script></body>');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('erro: ' + e.message);
  }
});

server.listen(PORT, '0.0.0.0', () => console.log('[QR-SERVER] ouvindo em http://0.0.0.0:' + PORT));
