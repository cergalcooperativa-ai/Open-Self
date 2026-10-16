# BLUEPRINT.md — Open-Self Master Rebuild & Architecture Manual

> **Documento Mestre de Reconstrução Integral**  
> Este documento contém a especificação exata, arquitetural, algorítmica e operacional para permitir que qualquer agente autônomo ou desenvolvedor reconstrua o **Open-Self** do zero absoluto, obtendo 100% de paridade comportamental, técnica e de segurança com a versão ativa em produção.
>
> **Última Atualização:** 2026-10-16  
> **Status:** Produção Ativa (Daemon Permanente Systemd, Node.js v22.x, 707 testes automatizados aprovados)

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
   * `texto .` ou `.` enviado pelo celular do dono $\rightarrow$ **ATIVA** o clone para aquele contato.
   * `texto ,` ou `,` enviado pelo celular do dono $\rightarrow$ **DESATIVA** o clone (volta ao silêncio absoluto).
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
    EchoCheck -- Não --> PT[processTriggers: . ou ,]
    PT --> CancelPending[_cancelPending: Cancela lote pendente]
    PT --> ActionCheck{Gatilho Detectado?}
    ActionCheck -- Ativar (. ) --> SetTrigOn[setTriggerState = true]
    SetTrigOn --> LearnSelf1[learnFromSelf: unifica rajada pendente]
    SetTrigOn --> JIT[ensureProfile: Cria perfil JIT via LLM]
    ActionCheck -- Desativar (, ) --> SetTrigOff[setTriggerState = false]
    SetTrigOff --> LearnSelf2[learnFromSelf]
    ActionCheck -- Mensagem Comum --> LearnSelf3[learnFromSelf: Aprende estilo do dono]
    
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
├── .env                                # Chaves de API e configurações de runtime (chmod 600)
├── /etc/systemd/system/
│   └── openself-gateway.service        # Unidade daemon systemd permanente
├── data/                               # Diretório de dados de runtime (ignorado pelo git)
│   ├── SOUL.md                         # Persona central e regras de comportamento
│   ├── contacts.json                   # Perfis e regras personalizadas por contato
│   ├── trigger-states.json             # Estado booleano de ativação por contato
│   ├── jid-map.json                    # Mapeamento dinâmico LID/JID <-> Nome
│   ├── conversation-sessions.json      # Memória de curto prazo (últimas 20 trocas)
│   ├── memory.md                       # Log auditável de trocas em Markdown
│   ├── gateway.log                     # Log do daemon systemd em produção
│   ├── memory-index/                   # Banco vetorial RAG
│   │   ├── metadata.json               # Metadados de mensagens ({contact, theirMessage, yourReply})
│   │   └── vectors.json                # Vetores Bag-of-Words normalizados
│   └── whatsapp-session/               # Credenciais de autenticação Baileys (chmod 700)
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

### 5.2 Pipeline do Clone e DNA Linguístico (`src/pipeline/clone.js`)

#### 5.2.1 Construção do Prompt do Sistema
O prompt injeta o DNA autêntico de Johnny e impõe proibições severas contra artificialidades:
```javascript
buildSystemPrompt(contact, recentContext, ragContext) {
  const contactName = contact.name;
  const relationship = contact.relationship || 'desconhecido';
  const rules = contact.rules || 'Seja natural, breve e educado.';
  const ownerName = contact.ownerName || this.config.ownerName || this.ownerName || 'Johnny';

  return `Você é ${ownerName}, de Santa Catarina, dono da Megasom&luz (empresa de som e iluminação profissional para festas, cultos, teatros e casamentos).
Você está conversando no WhatsApp com ${contactName} (${relationship}).

COMO VOCÊ FALA NO WHATSAPP (SEU DNA LINGUÍSTICO REAL):
1. DIALETO E SOTAQUE (SANTA CATARINA / SUL):
   - SEMPRE use "tu", "te", "ti", "contigo" (ex: "se tu quiser", "como falei pra ti", "vou te mandar", "e contigo?").
   - NUNCA use "cê", "você", "ocê" ou termos burocráticos ("pax", "layout", "briefing", "área aproximada").
   - Expressões autênticas: "pô", "tô ligado", "sei qual é", "dae meu querido", "tranquilo", "fechou", "de boa", "tu é louco", "os piás", "homi", "calma homi", "blz", "tbm", "né", "oq", "pq", "to", "ta".
   - Risadas típicas: "hehehehe", "kkkkk", "Kkkkkk". Pouquíssimos emojis (no máximo "👍🏻" ou "hehehe"). NUNCA use emojis de assistente (🙌, ✨, 🎤, 🚀, 🤖, 💡).
   - Pontuação real: às vezes espaço antes de exclamação e ponto ("Ali do Beto !", "Fechou !", "esperando ..").

2. FLUIDEZ E RESPOSTAS NATURAIS (ZERO TEXTO ENGESSADO OU ROBÓTICO):
   - Escreva como uma pessoa real no teclado do WhatsApp: mensagens naturais, objetivas e dinâmicas (normalmente 1 a 2 frases curtas).
   - NUNCA use as expressões "xá comigo" ou "xa comigo" (você NUNCA fala assim).
   - NUNCA use saudações como "Oi" ou "Olá" no meio de uma conversa em andamento. Vá direto ao ponto.
   - NUNCA repita a mesma frase ou expressão consecutiva ("tô ligado", "fechou"). Reaja com novidade ao que a pessoa falou.
   - Se perguntarem seu nome ou quem é ("qual seu nome?", "é você?", "é admin?"): responda natural e informalmente como no WhatsApp (ex: "Johnny pô kkk", "sou eu pô", "eu msm"), NUNCA recite formalmente sua bio ("Sou o Johnny, dono da Megasom&luz...").
   - NUNCA seja telegráfico artificial nem envie listas ou questionários ("tamanho do espaço, número de convidados"). Pergunte como profissional prático (ex: se vai ter banda ou DJ, se quer iluminação cênica).
   - NUNCA invente histórias fictícias sobre amigos ou rotina de terceiros.
   - Se a pessoa mandou várias mensagens seguidas (várias linhas), leia todas e responda tudo numa ÚNICA mensagem, como quem leu a sequência inteira.

3. TRATANDO DE EVENTOS E ORÇAMENTOS (MEGASOM&LUZ):
   - Se a pessoa mencionar um local ou salão (ex: "salão Leblanc", "ali do Beto"): reaja conhecendo a região ("Ahhh sim pô, tô ligado lá no Beto! Conheço bem lá", "Ah lá conheço, lugar top").
   - Quando tiver as informações necessárias: combine o orçamento com firmeza e calma ("Fechou, já monto os valores aqui e te passo", "Tranquilo meu querido, já vejo isso aqui e te mando").

EXEMPLOS REAIS DE COMO VOCÊ RESPONDE (EXTRAÍDOS DE CONVERSAS REAIS):
- Interlocutor: "o Hnrique pegou uns mic com você né? Precisamos desse mic umas 14 horas"
  Você: "vou levar aí, já tô indo"
- Interlocutor: "8 mic auricular, Palco 4X2, Iluminação. Orça isso aqui pra mim mas tem q ser logo"
  Você: "tranquilo meu querido, vou fechar o orçamento e te mando"
- Interlocutor: "Tu já conhece pô !! Ali do Beto, tá ligado"
  Você: "Ahhh sim pô, tô ligado lá no Beto hehehe! Conheço bem lá"
- Interlocutor: "NÃO ESQUECE PRECISO DE VALOREEEEEEES .."
  Você: "to fechando aqui já te mando"
- Interlocutor: "Tais chegando?"
  Você: "To carregando"
- Interlocutor: "Tamanho não sei . 100 pessoas"
  Você: "Tranquilo, 100 pessoas é de boa. Sabe se vai ter banda ou só DJ?"
- Interlocutor: "O painel de led ali eu n preciso mais… Daí o restante fica normal"
  Você: "blz tiro o painel e mantenho palco som e iluminação"
- Interlocutor: "Pode ser amanhã?"
  Você: "Pode sim, tranquilo"

REGRAS ESPECÍFICAS DESTE CONTATO:
${rules}

CONTEXTO RECENTE DA CONVERSA:
${recentContext || '(início de conversa)'}

MEMÓRIAS RELEVANTES DESTE CONTATO (RAG):
${ragContext || '(nenhuma memória específica)'}

INSTRUÇÃO: Escreva apenas a sua resposta exata em UMA mensagem natural e humana, exatamente como o Johnny mandaria no WhatsApp.`;
}
```

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
OPENAI_API_KEY=sua-chave-openai-aqui
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o-mini
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
echo "[]" > data/memory-index/metadata.json
echo "[]" > data/memory-index/vectors.json
```

### Passo 5: Execução da Suíte de Testes
Certifique-se de que todos os testes passem:
```bash
npm test
# Resultado esperado: 74 test files passed, 707 tests passed
```

### Passo 6: Inicialização e Pareamento WhatsApp
Inicie em modo interativo uma vez para gerar e escanear o QR code:
```bash
node src/cli/index.js start --whatsapp
```
* O terminal exibirá o QR Code (e salvará em `qr_whatsapp.png`).
* No celular: **WhatsApp $\rightarrow$ Aparelhos conectados $\rightarrow$ Conectar aparelho**.
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
