#!/bin/bash
# Orquestra o pareamento do WhatsApp:
# 1) garante qr-server no ar (PNG escaneavel na porta 33157) — checa POR PORTA, nao pgrep
# 2) mantem pair-qr.cjs vivo ate o usuario escanear (max 45 min)
# 3) ao parear, sobe o gateway real (Open-Self) com a sessao salva
cd /home/user/Open-Self
rm -f /tmp/wa_paired.json /tmp/wa_pair_error.txt /tmp/wa_final_status.txt /tmp/wa_qr.txt

# 1. QR server (guard por PORTA — pgrep -f dava falso-positivo no cmdline do launcher)
if ! ss -tln 2>/dev/null | grep -q ":33157 "; then
  nohup node qr-server.cjs > /tmp/wa_qr_server.log 2>&1 &
  sleep 2
fi

# 2. Loop de pareamento
DEADLINE=$((SECONDS + 2700))
WIPED=0
while [ $SECONDS -lt $DEADLINE ]; do
  [ -f /tmp/wa_paired.json ] && break
  node pair-qr.cjs >> /tmp/wa_pair.log 2>&1
  [ -f /tmp/wa_paired.json ] && break
  # sessao antiga rejeitada pelo servidor? limpa UMA vez e tenta fresh
  if [ -f /tmp/wa_pair_error.txt ] && [ "$WIPED" = "0" ]; then
    mv data/whatsapp-session "data/whatsapp-session.bak.$(date +%s)" 2>/dev/null
    mkdir -p data/whatsapp-session
    rm -f /tmp/wa_pair_error.txt
    WIPED=1
    echo "[FLOW] Sessao antiga rejeitada - limpa, tentando fresh" >> /tmp/wa_pair.log
  fi
  sleep 2
done

if [ ! -f /tmp/wa_paired.json ]; then
  echo "TIMEOUT_NAO_PAREOU (45 min sem scan)" > /tmp/wa_final_status.txt
  exit 1
fi

# 3. Soba o gateway real com a sessao pareada (conecta sem QR)
sleep 2
nohup node src/cli/index.js start --whatsapp > /tmp/wa_gateway.log 2>&1 &
sleep 15
{
  echo "=== PAIRED ==="
  cat /tmp/wa_paired.json
  echo ""
  echo "=== GATEWAY LOG (tail 25) ==="
  tail -25 /tmp/wa_gateway.log
} > /tmp/wa_final_status.txt
echo FLOW_DONE
