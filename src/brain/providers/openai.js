/**
 * OpenAI GPT Provider
 */

import OpenAI from 'openai';

export class OpenAIProvider {
    constructor(config = {}) {
        this.client = new OpenAI({
            apiKey: config.apiKey || process.env.OPENAI_API_KEY,
            baseURL: config.baseURL || process.env.OPENAI_BASE_URL || undefined,
        });
        this.model = config.model || process.env.LLM_MODEL || 'gpt-4o-mini';
        this.maxTokens = config.maxTokens || 500;
    }

    async chat(systemPrompt, userMessage) {
        const params = {
            model: this.model,
            max_tokens: this.maxTokens,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
            ],
        };
        // Groq/gpt-oss: baixa o esforco de raciocinio e sobe o budget de tokens
        // (sem isso o modelo esgota max_tokens raciocinando e devolve content vazio)
        if (this.client.baseURL && /groq\.com/.test(String(this.client.baseURL))) {
            params.reasoning_effort = 'low';
            params.max_tokens = Math.max(this.maxTokens, 1500);
        }
        const response = await this.client.chat.completions.create(params);

        const msg = response.choices[0]?.message;
        // FP-R fix: NUNCA usar msg.reasoning como resposta — e o raciocinio
        // interno em EN; vaza-lo pro contato e assinatura de bot instantanea.
        // Content vazio = sem resposta (o pipeline trata).
        return msg?.content || '';
    }

    get name() {
        return 'openai';
    }
}
