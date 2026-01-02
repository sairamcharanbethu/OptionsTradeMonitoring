
import { FastifyInstance } from 'fastify';

interface AIAnalysisRequest {
    symbol: string;
    price: number;
    entry: number;
    type: string;
    strike: number;
    expiration: string;
    greeks: {
        delta: number | null;
        theta: number | null;
        gamma: number | null;
        vega: number | null;
        iv: number | null;
    };
}

export class AIService {
    private fastify: FastifyInstance;
    private ollamaUrl: string;
    private model: string;

    constructor(fastify: FastifyInstance) {
        this.fastify = fastify;
        // On Windows Docker, host.docker.internal resolves to the host machine
        this.ollamaUrl = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
        this.model = process.env.AI_MODEL || 'mistral:7b-instruct-q4_K_M';
    }

    async generateAnalysis(data: AIAnalysisRequest): Promise<{ verdict: string; analysis: string }> {
        const prompt = this.buildPrompt(data);

        console.log(`[AIService] Sending prompt to Ollama (${this.ollamaUrl}) for model ${this.model}...`);

        try {
            const response = await fetch(`${this.ollamaUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.model,
                    prompt: prompt,
                    stream: false,
                    format: 'json' // Request JSON mode from Ollama
                })
            });

            if (!response.ok) {
                throw new Error(`Ollama API Error: ${response.status} ${response.statusText}`);
            }

            const result = await response.json();
            const text = result.response;

            try {
                const parsed = JSON.parse(text);
                return {
                    verdict: parsed.verdict || 'UNKNOWN',
                    analysis: parsed.reasoning || parsed.analysis || text
                };
            } catch (e) {
                // Fallback if model returns bad JSON
                return {
                    verdict: 'Review',
                    analysis: text
                };
            }

        } catch (error) {
            this.fastify.log.error(error);
            throw new Error('Failed to generate AI analysis. Is Ollama running?');
        }
    }

    private buildPrompt(data: AIAnalysisRequest): string {
        const pnl = (data.price - data.entry) / data.entry * 100;
        const daysToExp = Math.ceil((new Date(data.expiration).getTime() - Date.now()) / (1000 * 60 * 60 * 24));

        return `You are an expert options trading assistant. Analyze this position and provide a recommendation.

Position: ${data.symbol} ${data.type} $${data.strike}
Expiration: ${data.expiration} (${daysToExp} days left)
Entry Price: $${data.entry.toFixed(2)}
Current Price: $${data.price.toFixed(2)}
PnL: ${pnl.toFixed(2)}%

Greeks (CRITICAL FACTORS):
- Delta: ${data.greeks.delta ?? 'N/A'} (Probability ITM)
- Theta: ${data.greeks.theta ?? 'N/A'} (Time Decay risk)
- Vega: ${data.greeks.vega ?? 'N/A'} (Volatility risk)
- IV: ${data.greeks.iv ? data.greeks.iv.toFixed(2) + '%' : 'N/A'}

INSTRUCTIONS:
1. Analyze the Greeks specifically (mention Theta decay or Delta probability if relevant).
2. Determine a VERDICT: "HOLD", "CLOSE", or "ADJUST".
3. Provide a concise "reasoning" (max 2 sentences).

RESPONSE FORMAT:
Return ONLY a JSON object:
{
  "verdict": "HOLD" | "CLOSE" | "ADJUST",
  "reasoning": "Your concise analysis here referencing specific Greeks."
}`;
    }
}
