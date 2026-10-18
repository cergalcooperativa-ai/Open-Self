# BLUEPRINT.md — Open-Self Master Rebuild & Architecture Manual

> **Documento Mestre de Reconstrução Integral**  
> Este documento contém a especificação exata, arquitetural, algorítmica e operacional para permitir que qualquer agente autônomo ou desenvolvedor reconstrua o **Open-Self** do zero absoluto, obtendo 100% de paridade comportamental, técnica e de segurança com a versão ativa em produção.
>
> **Última Atualização:** 2026-10-16  
> **Status:** Produção Ativa (Daemon Systemd permanente, Open-Self v1.2.0, Node.js v22.x, 714 testes / 75 arquivos aprovados)
>
> **Revisão verificada contra produção:** 2026-10-16 — estado real cruzado com systemctl, npm test e data/*.json (seção 9). Protocolo de manutenção: seção 10.

---

## 1. Visão Geral e Filosofia Operacional

### 1.1 O que é o Open-Self
O **Open-Self** é um clone digital de personalidade humana para WhatsApp baseado na biblioteca Baileys (Multi-Device Web API). Diferente de assistentes convencionais, o Open-Self opera sob a premissa de **mimetismo imperceptível (Stealth)**:
1. **Persona Real:** O clone replica **Johnny**, residente em Santa Catarina, Brasil, proprietário da **Megasom&luz** (serviços profissionais de sonorização e iluminação cênica para cultos, casamentos, teatros e eventos).
2. **Linguagem Natural de Santa Catarina:** Comunicação puramente coloquial e autêntica do Sul do Brasil (`tu`, `te`, `ti`, `contigo`; nunca `você`/`cê`), ritmo dinâmico, expressões regionais nativas (`pô`, `tô ligado`, `dae meu querido`, `tranquilo`, `fechou`, `de boa`, `tu é louco`, `os piás`, `homi`, `blz`, `né`), pouquíssimos emojis e zero jargões de atendente de IA.
3. **Escuta Passiva Universal:** O sistema monitora e aprende continuamente a partir de **todas** as mensagens recebidas e enviadas, populando memória de curto prazo e banco vetorial RAG isolado por contato.
4. **Resposta Estritamente Sob Demanda (Opt-in Soberano):** O bot permanece **100% silencioso por padrão**. Ele **nunca** responde a um contato a menos que o dono da conta ative explicitamente o chat via gatilho manual (` .`).
5. **Invisibilidade Anti-Detecção:** Delays humanos de leitura (10 a 28s), digitação proporcional (1.5 a 5s) com disparos de presença WhatsApp (`composing`/`paused`), confirmação de leitura azul (`readMessages`) enviada apenas no momento em que um humano terminaria de ler, e unificação de rajadas de mensagens (`burst batching`).

---

## 2. Invariantes de Segurança e Regras Operacionais

1. **Soberania do Gatilho do Dono:**
   * `texto .` ou `.` enviado pelo celular do dono → **ATIVA** o clone para aquele contato.
   * `texto ,` ou `,` enviado pelo celular do dono → **DESATIVA** o clone (volta ao silêncio absoluto).
   * Gatilhos enviados por terceiros são **ignorados com desprezo**.
   * Pontuação natural enviada pelo dono sem espaço anterior (ex.: `blz.`, `ok...`, `1.5`, `sim,`) **nunca** dispara ativação/desativação.
2. **Padrão Absoluto = Silêncio:** Se o contato não possuir estado `true` em `data/trigger-states.json`, o gateway descarta qualquer tentativa de resposta.
3. **Isolamento Criptográfico e de Dados por Contato:** Nenhum contexto, histórico, regra ou fragmento de RAG de um contato pode vazar para o prompt de outro contato. Todas as chaves são normalizadas (removendo tildes `~` e espaços).
4. **Supressão Silenciosa de Revelações:** Em chats ativados, o `SafetyGuard` opera em modo de observação permissiva para manter a fluidez humana, **com uma exceção crítica**: se a resposta gerada contiver revelação de IA (`ai_reveal`) ou vazamento de credenciais (`secret_leak`), o envio é **abortado em silêncio** (nada é transmitido ao WhatsApp).
5. **Anti-Loop de Ecos:** O gateway rastreia os IDs das mensagens enviadas pelo próprio bot (`sentIds`). Mensagens enviadas pelo bot nunca são interpretadas como mensagens do operador.
6. **Segurança no Sistema de Arquivos:**
   * Arquivo `.env`: Permissão estrita `chmod 600`.
   * Diretório `data/whatsapp-session`: Permissão estrita `chmod 700`.
   * Dados sensíveis, sessões e históricos jamais entram no controle de versão (`.gitignore`).

---

## 3. Topologia e Fluxo de Mensagens

```mermaid
flowchart TD
    WA[WhatsApp Network] -->|Baileys Socket messages.upsert| HM[handleMessage]
    
    HM --> IsSys{Evento de Sistema?}
    IsSys -- Sim --> Drop[Descartar]
    IsSys -- Não --> Who{msg.key.fromMe?}
    
    %% Fluxo do Dono (Operador)
    Who -- Sim (Dono) --> EchoCheck{ID em sentIds?}
    EchoCheck -- Sim --> Drop
    EchoCheck -- Não --> GroupCheck{Grupo ou Broadcast?}
    GroupCheck -- Sim --> Drop
    GroupCheck -- Não --> PT[processTriggers: . ou , exclusivo do dono 1:1]
    PT --> ActionCheck{Gatilho Detectado?}
    ActionCheck -- Ativar (. ) --> EmptyCheck{processedText vazio? (silent takeover)}
    EmptyCheck -- Sim (Apenas . ) --> CheckPend{Há [PENDING_REPLY]?}
    CheckPend -- Sim --> TriggerBotReply[queueReply imediato: Bot assume e responde pendências]
    CheckPend -- Não --> SetTrigOn1[setTriggerState = true]
    EmptyCheck -- Não (Texto + . ) --> CancelPending[_cancelPending]
    CancelPending --> SetTrigOn2[setTriggerState = true]
    SetTrigOn2 --> LearnSelf1[learnFromSelf: Grava texto do operador sanitizado]
    ActionCheck -- Desativar (, ) --> CancelPending2[_cancelPending]
    CancelPending2 --> SetTrigOff[setTriggerState = false]
    SetTrigOff --> LearnSelf2[learnFromSelf se texto real]
    ActionCheck -- Mensagem Comum --> CancelPending3[_cancelPending]
    CancelPending3 --> LearnSelf3[learnFromSelf: Aprende estilo do dono]
    
    %% Fluxo de Terceiros
    Who -- Não (Terceiros) --> ResKey[resolveContactKey: JID/LID -> Nome via jid-map.json]
    ResKey --> LearnContact[learnFromContact: Grava [PENDING_REPLY] + RAG isolado]
    LearnContact --> KillSwitch{RESPONSES_DISABLED?}
    KillSwitch -- Sim --> DropStats[stats.ignored++]
    KillSwitch -- Não --> TrigActive{trigger-states.json == true?}
    TrigActive -- Não --> DropStats
    TrigActive -- Sim --> EnsureProf[ensureProfile: Carrega perfil JIT ou cria]
    EnsureProf --> QReply[queueReply: Buffer de Rajada / Batch]
    
    %% Batch & Envio
    QReply --> Timer[Timer de Silêncio: 5s a 9s]
    Timer --> Flush[_flushPending: Unifica textos com \n]
    Flush --> GenReply[generateAndSendReply]
    GenReply --> Pipe[ClonePipeline.processMessage]
    Pipe --> Prompt[buildSystemPrompt: DNA SC + RAG Válido + Contexto Recente]
    Prompt --> LLMCall[LLM Brain: openai / deepseek / ollama]
    LLMCall --> Clean[cleanAIReveal: Remove fala de atendente e xá comigo]
    Clean --> GuardCheck{SafetyGuard: ai_reveal ou secret_leak?}
    GuardCheck -- Sim --> Suppress[Supressão Silenciosa: aborta envio]
    GuardCheck -- Não --> MimicryDelay[Delay de Leitura Humana: 10s a 28s]
    MimicryDelay --> ReadTick[readMessages: Tique azul após leitura]
    ReadTick --> TypState[sendPresenceUpdate: composing 1.5s a 5s]
    TypState --> SendWA[sendMessage: Transmite texto ao WhatsApp]
    SendWA --> StoreFinal[Salva troca completa unificada na Memória e RAG]
```

---

## 4. Estrutura do Repositório e Módulos de Código

```
Open-Self/
├── BLUEPRINT.md                        # Este documento mestre
├── AGENTS.md                           # Guia operacional de agentes
├── package.json                        # Definição de dependências e scripts
├── vitest.config.js                    # Configuração de testes automatizados
├── scripts/                            # Benchmarks e evals (benchmark-context, eval-compiler, evaluate-*)
├── tests/                              # 75 arquivos de teste (vitest, 714 testes)
├── .env                                # Chaves de API e configurações de runtime (chmod 600)
├── /etc/systemd/system/
│   └── openself-gateway.service        # Unidade daemon systemd permanente
├── data/                               # Diretório de dados de runtime (ignorado pelo git)
│   ├── SOUL.md                         # Persona central e regras de comportamento
│   ├── SOUL.auto.md                    # Rascunho de SOUL gerado automaticamente (não usar em produção)
│   ├── contacts.json                   # Perfis e regras personalizadas por contato
│   ├── trigger-states.json             # Estado booleano de ativação por contato
│   ├── jid-map.json                    # Mapeamento dinâmico LID/JID <-> Nome
│   ├── conversation-sessions.json      # Memória de curto prazo (últimas 20 trocas)
│   ├── conversations.json              # Exports brutos ingeridos (lista, 100 trocas)
│   ├── personality.json                # Estatísticas de estilo do dono (263 msgs analisadas)
│   ├── heartbeat.json                  # Estado online/lastSeen do daemon
│   ├── memory.md                       # Log auditável de trocas em Markdown
│   ├── gateway.log                     # Log do daemon systemd em produção
│   ├── memory-index/                   # Banco vetorial RAG
│   │   ├── metadata.json               # Metadados de mensagens ({contact, theirMessage, yourReply})
│   │   └── vectors.json                # Vetores Bag-of-Words normalizados
│   ├── whatsapp-session/               # Credenciais de autenticação Baileys (chmod 700)
│   └── whatsapp-session.unreg.*/       # Backups de sessões não-registradas (preservar)
└── src/
    ├── cli/                            # Interface de linha de comando
    │   ├── index.js                    # Entrypoint CLI (`openself start --whatsapp`)
    │   ├── start.js                    # Inicializador de gateways
    │   └── utils/error-handler.js      # Tratamento central de erros do CLI
    ├── gateway/
    │   └── whatsapp.js                 # Gateway Baileys, reconexão, batch e JIT
    ├── pipeline/
    │   └── clone.js                    # Orquestrador do clone, montagem de prompt e RAG
    ├── memory/
    │   ├── conversation.js             # ConversationMemory (curto prazo, resolveBatch)
    │   └── rag.js                      # ChatMemory (banco vetorial local Bag-of-Words)
    ├── brain/
    │   ├── router.js                   # Roteamento dinâmico de LLM
    │   └── providers/                  # Adaptadores (openai.js, anthropic.js, deepseek.js, ollama.js)
    ├── safety/
    │   ├── guard.js                    # SafetyGuard (detecção de credenciais e segredos)
    │   └── ai-detection.js             # Detecção e limpeza ativa de expressões de IA
    └── mimicry/
        ├── humanlike.js                # HumanMimicry (quebra de mensagens, delays)
        └── timing.js                   # Temporização e cálculo de digitação
```

---

## 5. Implementação Detalhada dos Componentes Centrais

### 5.1 Gateway WhatsApp (`src/gateway/whatsapp.js`)
O gateway encapsula a conexão do socket WhatsApp via Baileys e implementa a lógica de buffer e aprendizado.

#### 5.1.1 Blindagem de Reconexão (Anti-Crash Node 22+)
No Node.js v22+, qualquer rejeição assíncrona não capturada aborta o processo. O tratador de desconexão foi blindado com `try/catch` assíncrono:
```javascript
this.sock.ev.on('connection.update', async (update) => {
  const { connection, lastDisconnect, qr } = update;
  if (connection === 'open') {
    console.log(chalk.green('✅ WhatsApp conectado!'));
  }
  if (connection === 'close') {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const shouldReconnect = statusCode !== DisconnectReason?.loggedOut;
    if (shouldReconnect && !this._reconnecting && !this._stopped) {
      this._reconnecting = true;
      setTimeout(async () => {
        this._reconnecting = false;
        if (this._stopped) return;
        try {
          await this._connect();
        } catch (err) {
          console.error(chalk.red('Erro ao reconectar: ' + (err?.message || err)));
        }
      }, 5000);
    }
  }
});
```

#### 5.1.2 Buffer de Rajadas (Burst Batching)
Impede que o bot responda individualmente a cada mensagem enviada em sequência por um contato:
* **Parâmetros:**
  * `batchMinMs = 5000` (5 segundos de silêncio mínimo)
  * `batchMaxMs = 9000` (9 segundos de silêncio máximo)
  * `batchCapMs = 60000` (limite máximo de 60 segundos de acúmulo)
* **Comportamento:** Ao chegar uma mensagem de um chat ativado, o timer é reiniciado. Quando o contato cessa a digitação pela janela sorteada, `_flushPending()` une todos os textos com quebra de linha (`\n`), realiza **uma única inferência no LLM** e despacha **uma única resposta**. Se o operador digitar no chat durante o buffer, o lote pendente é imediatamente cancelado (`_cancelPending`).

#### 5.1.3 Aprendizado com Rajadas do Operador (`learnFromSelf`)
Quando o dono responde pelo celular a uma rajada de mensagens enviadas por um contato:
```javascript
async learnFromSelf(contactName, text) {
  try {
    const normalized = this.normalizeContact(contactName);
    const session = this.conversationMemory.sessions.get(normalized) || 
                    this.conversationMemory.sessions.get(contactName) || [];
    
    // Coleta todas as mensagens pendentes da rajada
    const pendingThemList = [];
    for (let i = session.length - 1; i >= 0; i--) {
      if (session[i].clone === '[PENDING_REPLY]' || session[i].clone === '[TRIGGER]') {
        if (session[i].them) pendingThemList.unshift(session[i].them);
      } else {
        break;
      }
    }
    const pendingThem = pendingThemList.join('\n') || 
                        (session.length > 0 && session[session.length - 1].them ? session[session.length - 1].them : '');

    // Colapsa na memória de curto prazo
    if (pendingThemList.length > 1 && typeof this.conversationMemory.resolveBatch === 'function') {
      this.conversationMemory.resolveBatch(normalized, pendingThemList, text);
    } else {
      this.conversationMemory.recordUserReply(normalized, text);
    }

    // Indexa o par completo (rajada unificada -> resposta) no RAG
    if (pendingThem) {
      await this.chatMemory.indexHistory([{
        contact: normalized,
        theirMessage: pendingThem,
        yourReply: text,
        date: new Date().toISOString().split('T')[0],
        time: new Date().toTimeString().slice(0, 5),
        replyDelay: 0
      }], { batchSize: 1 });
      console.log(chalk.cyan('   [LEARN] Resposta do operador salva p/ ' + contactName + ' (memoria + RAG)'));
    }
  } catch (e) {
    console.log(chalk.yellow('   [LEARN] Falha ao aprender do operador: ' + e.message));
  }
}
```

---

### 5.2 Pipeline do Clone e Desacoplamento Total de Identidade (`src/pipeline/clone.js`)

#### 5.2.1 Construção Dinâmica do Prompt (Zero Hardcoding)
O código em `src/pipeline/clone.js` é 100% agnóstico e opera sem nenhum nome, empresa, região ou exemplos fixos em JavaScript. A identidade é lida dinamicamente de `data/SOUL.md` e combinada com o perfil do operador conectado (`this.sock.user.name` / `contact.ownerName`), regras de contato isoladas (`data/contacts.json`) e memórias filtradas (RAG):

```javascript
buildSystemPrompt(contact, recentContext, ragContext) {
  const contactName = contact.name || 'Contato';
  const relationship = contact.relationship || 'desconhecido';
  const rules = contact.rules || 'Seja natural, breve e educado.';
  const soulContent = this.loadSoul();
  const ownerName = contact.ownerName || this.config.ownerName || this.ownerName || this.getOwnerNameFromSoul(soulContent) || 'Operador';

  const identityIntro = `Você é ${ownerName}, respondendo mensagens no WhatsApp como você mesmo.\nVocê está conversando no WhatsApp com ${contactName} (${relationship}).`;

  return `${identityIntro}

${soulContent ? `PERFIL E DIRETRIZES DE PERSONALIDADE (SOUL):\n${soulContent.trim()}\n` : ''}
REGRAS ESPECÍFICAS DESTE CONTATO:
${rules}

CONTEXTO RECENTE DA CONVERSA:
${recentContext || '(início de conversa)'}

MEMÓRIAS RELEVANTES DESTE CONTATO (RAG):
${ragContext || '(nenhuma memória específica)'}

INSTRUÇÃO: Escreva apenas a sua resposta exata em UMA mensagem natural e humana, exatamente como ${ownerName} mandaria no WhatsApp.`;
}
```

#### 5.2.2 Centralização do DNA Linguístico em `data/SOUL.md`
Todo o DNA linguístico (sotaque catarinense, expressões autênticas, regras de fluidez, proibições de robô e exemplos de conversas reais) reside exclusivamente em `data/SOUL.md`:
* **Regra de Pontuação Sanitizada:** Permite espaço antes de exclamação, interrogação ou dois pontos (`"Ali do Beto !"`, `"Fechou !"`, `"esperando .."`), mas **PROÍBE rigorosamente** espaço antes de ponto final ou vírgula para não incitar geração de gatilhos acidentais pelo LLM.
* **Exemplos Sanitizados:** Todos os exemplos foram limpos (ex: `"Tamanho não sei, 100 pessoas"` em vez de ponto final com espaço).
* **Filtro Anti-Gatilho na Saída:** Em `generateAndSendReply`, qualquer ` .` ou ` ,` gerado acidentalmente no fim da frase é sanitizado com `reply.replace(/\s+[.,]$/g, '').trim()` antes do envio.

#### 5.2.2 Filtragem de RAG Útil
O pipeline filtra memórias para garantir que entradas de escuta passiva ainda não respondidas (`yourReply == ""`) não poluam o prompt:
```javascript
let ragContext = '';
if (this.chatMemory) {
  const memories = await this.chatMemory.findRelevant(text, contactName, 5);
  const validMemories = memories.filter(m => m.yourReply && !['[PENDING_REPLY]', '[TRIGGER]'].includes(m.yourReply.trim()));
  if (validMemories.length > 0) {
    ragContext = validMemories.map(m => 
      `${m.contact}: ${m.theirMessage}\nYou: ${m.yourReply}`
    ).join('\n\n');
  }
}
```

---

### 5.3 Banco Vetorial Local RAG (`src/memory/rag.js`)
O `ChatMemory` implementa busca semântica léxica leve sem dependências pesadas de C++:
* **Algoritmo:** Vetorização Term-Frequency (TF) Bag-of-Words normalizada por norma Euclidiana ($L_2$).
* **Similaridade:** Cosseno do ângulo entre o vetor da query e os vetores armazenados em `data/memory-index/vectors.json`.
* **Isolamento Rígido:** A busca filtra estritamente por `normalizeContact(m.contact) === normalizeContact(contact)`.
* **Persistência Atômica:** `metadata.json` armazena o histórico textual; `vectors.json` armazena os pesos calculados.

---

### 5.4 Filtro Ativo Anti-Detecção (`src/safety/ai-detection.js`)
Além da checagem de revelações de IA em múltiplos idiomas, a função `cleanAIReveal` atua como filtro de higienização de saída antes da transmissão:
```javascript
const cleanPatterns = [
  /I appreciate your patience[.!]?\s*/gi,
  /I understand your concern[.!]?\s*/gi,
  /como posso (te |lhe )?(ajudar|auxiliar)\??\s*/gi,
  /posso (te |lhe )?(ajudar|auxiliar) (em|com) (mais )?(algo|alguma coisa|mais alguma coisa)\??\s*/gi,
  /agrade[çc]o (a |pela )?(sua )?(paci[êe]ncia|compreens[ãa]o)[.!]?\s*/gi,
  /entendo (a )?(sua )?preocupa[çc][ãa]o[.!]?\s*/gi,
  /estou (aqui )?(para|pra) (te )?ajudar[.!]?\s*/gi,
  // Expressões artificiais banidas
  /[,.]?\s*\bx[aá] comigo!?\s*/gi,
];
```

---

## 6. Esquema de Arquivos de Dados (`data/`)

### 6.1 `data/contacts.json`
Armazena a inteligência e o perfil relacional de cada contato individual:
```json
{
  "Neia": {
    "messageCount": 2241,
    "relationship": "Parceira",
    "avgReplyWords": 10.8,
    "rules": "Fale com Neia do mesmo jeito que você fala nos exemplos. Vocabulário típico: não, que, pra, isso, mais, vou, com, por, você, tudo. Média de 11 palavras por resposta."
  },
  "Levi": {
    "name": "Levi",
    "relationship": "Cliente (Igreja Betel Sangão / eventos de som e luz)",
    "rules": "Comunicação profissional ultra minimalista (1 a 8 palavras). Calmo, objetivo, termos de som e luz. Gírias: dae meu querido, op, to carregando, 8 né, tbm. Confirma orçamentos e horários sem enrolar.",
    "avgReplyWords": 4,
    "formality": "casual",
    "messageCount": 18
  },
  "Johnny Teste": {
    "name": "Johnny Teste",
    "relationship": "Cliente / Amigo (orçamentos e eventos)",
    "rules": "Fale com total naturalidade como Johnny da Megasom&luz. Seja gente boa, prático, descontraído e catarinense nativo (tu/tá/pô/tô ligado/tranquilo/fechou/né). Responda com fluidez real, reagindo ao assunto sem chavões repetitivos.",
    "avgReplyWords": 10,
    "formality": "casual",
    "messageCount": 0
  }
}
```

### 6.2 `data/trigger-states.json`
Controla quais contatos estão ativos para resposta:
```json
{
  "Johnny Teste": true,
  "Diana": false,
  "Talita Silvério": false
}
```

### 6.3 `data/jid-map.json`
Mapeia identificadores de protocolo WhatsApp (LID e JID padrão) para o nome de exibição:
```json
{
  "135789837078696@lid": "Johnny Teste",
  "57286324154482@lid": "Diana",
  "260704682700937@lid": "Talita Silvério"
}
```

### 6.4 `data/conversation-sessions.json`
Sessão deslizante de curto prazo (últimas 20 trocas):
```json
{
  "Diana": [
    {
      "timestamp": "2026-10-16T00:07:23.071Z",
      "them": "Tais em casa neh ?",
      "clone": "[PENDING_REPLY]"
    },
    {
      "timestamp": "2026-10-16T00:07:26.499Z",
      "them": "Queis vim aqui ?",
      "clone": "[PENDING_REPLY]"
    }
  ]
}
```

---

## 7. Infraestrutura de Produção e Daemon Systemd

O serviço é mantido em execução ininterrupta através de uma unidade permanente no systemd.

### 7.1 Arquivo de Unidade (`/etc/systemd/system/openself-gateway.service`)
```ini
[Unit]
Description=OpenSelf WhatsApp Gateway - Passive Learning and Clone Service
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=user
Group=user
WorkingDirectory=/home/user/Open-Self
ExecStart=/usr/bin/node src/cli/index.js start --whatsapp
StandardOutput=append:/home/user/Open-Self/data/gateway.log
StandardError=append:/home/user/Open-Self/data/gateway.log
Restart=always
RestartSec=5s
KillMode=mixed
TimeoutStopSec=15s

[Install]
WantedBy=multi-user.target
```

> **Nota OrbStack (verificada em produção):** esta unit roda ACTIVE+ENABLED na VM mesmo com `Wants=network-online.target`. Se o serviço um dia travar em `activating` (quirk OrbStack: networkd-wait-online pode nunca sinalizar), remova as linhas `network-online.target` — `After=network.target` basta.

### 7.2 Comandos Operacionais de Gestão
```bash
# Recarregar configuração do systemd
sudo systemctl daemon-reload

# Habilitar inicialização no boot
sudo systemctl enable openself-gateway.service

# Iniciar / Reiniciar serviço
sudo systemctl restart openself-gateway.service

# Verificar status ativo
sudo systemctl status openself-gateway.service

# Acompanhar logs em tempo real
tail -f /home/user/Open-Self/data/gateway.log
```

---

## 8. Guia de Reconstrução do Zero (Runbook para Agentes)

Caso o ambiente seja completamente destruído, execute os passos abaixo sequencialmente:

### Passo 1: Instalação de Pré-requisitos do Sistema
Em uma máquina ou VM Ubuntu/Debian arm64/x64:
```bash
sudo apt update && sudo apt install -y git curl build-essential
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

### Passo 2: Clonagem e Dependências
```bash
git clone <URL_DO_REPOSITORIO> Open-Self
cd Open-Self
npm install
```

### Passo 3: Configuração de Variáveis de Ambiente
Crie o arquivo `.env` com permissão restrita:
```bash
cat << 'EOF' > .env
LLM_PROVIDER=openai
# ATENÇÃO — PROVIDER REAL = GROQ via endpoint compatível OpenAI (NUNCA OpenAI direto):
OPENAI_API_KEY=gsk_sua-chave-groq-aqui
OPENAI_BASE_URL=https://api.groq.com/openai/v1
LLM_MODEL=openai/gpt-oss-120b
OPENSELF_USER_NAME=Megasom&luz
OPENSELF_MIN_DELAY=10000
OPENSELF_MAX_DELAY=28000
OPENSELF_BATCH_MIN_MS=5000
OPENSELF_BATCH_MAX_MS=9000
EOF
chmod 600 .env
```

### Passo 4: Estruturação dos Diretórios de Dados
```bash
mkdir -p data/memory-index data/whatsapp-session
chmod 700 data/whatsapp-session
echo "{}" > data/contacts.json
echo "{}" > data/trigger-states.json
echo "{}" > data/jid-map.json
echo "{}" > data/conversation-sessions.json
echo "[]" > data/conversations.json
echo "[]" > data/memory-index/metadata.json
echo "[]" > data/memory-index/vectors.json
```

### Passo 5: Execução da Suíte de Testes
Certifique-se de que todos os testes passem:
```bash
npm test
# Resultado esperado: 75 test files passed, 714 tests passed
```

### Passo 6: Inicialização e Pareamento WhatsApp
Inicie em modo interativo uma vez para gerar e escanear o QR code:
```bash
node src/cli/index.js start --whatsapp
```
* O terminal exibirá o QR Code (e salvará em `qr_whatsapp.png`).
* No celular: **WhatsApp → Aparelhos conectados → Conectar aparelho**.
* Uma vez autenticado, encerre com `Ctrl+C`. A sessão fica gravada em `data/whatsapp-session/`.

### Passo 7: Instalação e Ativação do Daemon Permanente
```bash
sudo tee /etc/systemd/system/openself-gateway.service << 'EOF'
[Unit]
Description=OpenSelf WhatsApp Gateway - Passive Learning and Clone Service
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=user
Group=user
WorkingDirectory=/home/user/Open-Self
ExecStart=/usr/bin/node src/cli/index.js start --whatsapp
StandardOutput=append:/home/user/Open-Self/data/gateway.log
StandardError=append:/home/user/Open-Self/data/gateway.log
Restart=always
RestartSec=5s
KillMode=mixed
TimeoutStopSec=15s

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable openself-gateway.service
sudo systemctl start openself-gateway.service
```

### Passo 8: Validação Final
Consulte o log para atestar o sucesso da inicialização:
```bash
tail -n 20 /home/user/Open-Self/data/gateway.log
# Deve conter: "✅ WhatsApp conectado! Escuta passiva ativa - respostas somente em chats ativados com ' .'"
```
Pronto! A ferramenta estará 100% reconstruída, segura, autônoma e idêntica à versão de produção.


---

## 9. Estado de Produção Verificado (snapshot gerado ao vivo: 2026-10-17 21:38 -03)

| Item | Estado real |
|---|---|
| Serviço systemd | `active` / enabled=enabled, PID 56852, uptime 1-04:44:07, cgroup `system.slice/openself-gateway.service` |
| Gateway | `node src/cli/index.js start --whatsapp` (unit `/etc/systemd/system/openself-gateway.service`) |
| Sessão WhatsApp | me=`554899036346:20@s.whatsapp.net`, registered=`False` (sessão funcional; backup preservado em `whatsapp-session.unreg.1791953900/`) |
| Gatilhos (trigger-states.json) | `{
  "Johnny Teste": true,
  "Diana": false
}` |
| Contatos com perfil isolado | Neia (2241 msgs); Tayla Moreno dos Santos (103 msgs); Edlayne (395 msgs); Johnny Teste (0 msgs); Levi (18 msgs); Diana (8 msgs) |
| LLM Brain | Groq `gpt-oss-120b` via endpoint compatível OpenAI (`OPENAI_BASE_URL=https://api.groq.com/openai/v1`) |
| Personalidade base | 263 mensagens analisadas (`personality.json`); `SOUL.auto.md` rascunho PT 63% / ES 26% |
| Testes | 714/714 passando (75 arquivos) — verificado 2026-10-16 |
| Legacy | `personaclone.service` = inactive (Digital-Personality-Clone descontinuado; Open-Self é o sucessor) |
| Manutenção pendente | `heartbeat.json` stale (lastSeen 2026-10-11) — monitorar |

Últimas linhas do log de produção:
```
[LEARN] Mensagem de Diana salva (memoria + RAG isolado)
   [LEARN] Mensagem de Diana salva (memoria + RAG isolado)
```

---

## 10. Protocolo de Manutenção — Fonte Única de Verdade

> **REGRA MÁXIMA:** Este arquivo é a FONTE ÚNICA DE VERDADE da ferramenta Open-Self. Nenhuma memória de sessão, skill ou contexto de agente substitui este documento.

1. **Todo agente autônomo (Hermes, CLI, subagente) DEVE ler este arquivo ANTES de operar, modificar ou reconstruir a ferramenta** — e re-verificar contra o estado real: `systemctl status openself-gateway`, `npm test`, conteúdo de `data/*.json`, e `.env` (com secrets redigidos). Se documento e realidade divergirem, a realidade manda — e o documento é corrigido no mesmo commit.
2. **Toda evolução (feature, fix, mudança de config ou infra) DEVE atualizar este documento no mesmo commit** (`docs(blueprint): ...`). A seção 9 (snapshot ao vivo) é regenerada a cada mudança relevante — o script de sync lê o estado real, nunca inventa.
3. **Isolamento absoluto de contexto:** configurações do Open-Self (máquina "VM") NUNCA se misturam com configurações do Hermes Agent (guest "ubuntu", `~/.hermes`). São sistemas distintos em máquinas distintas. Este documento contém apenas o Open-Self.
4. **Disinformações corrigidas na revisão 2026-10-16:** exemplo `.env` apontava OpenAI direto (o provider real é Groq/gpt-oss-120b); contagem de testes 707→714 (75 arquivos); inventário `data/` incompleto (faltavam conversations.json, personality.json, heartbeat.json, SOUL.auto.md, backups .unreg); runbook sem init de `conversations.json`.
5. **Secrets:** este documento NUNCA contém chaves reais — apenas placeholders (`gsk_sua-chave-groq-aqui`). Chaves vivem exclusivamente em `.env` (chmod 600), fora do git.
