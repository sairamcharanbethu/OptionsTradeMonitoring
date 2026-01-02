
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

        return `You are an options trading analyst. Analyze this position and provide a trading recommendation.

POSITION DATA:
- Symbol: ${data.symbol}
- Type: ${data.type}
- Strike: $${data.strike}
- Expiration: ${data.expiration} (${daysToExp} days to expiration)
- Entry Price: $${data.entry.toFixed(2)}
- Current Price: $${data.price.toFixed(2)}
- P&L: ${pnl.toFixed(2)}%

GREEKS:
- Delta: ${data.greeks.delta ?? 'N/A'} (directional exposure)
- Theta: ${data.greeks.theta ?? 'N/A'} (daily time decay in $)
- Vega: ${data.greeks.vega ?? 'N/A'} (IV sensitivity)
- Implied Volatility: ${data.greeks.iv ? data.greeks.iv.toFixed(2) + '%' : 'N/A'}

ANALYSIS REQUIREMENTS:
1. **Verdict**: Choose ONE action:
   - "HOLD": Keep the position unchanged
   - "CLOSE": Exit the position entirely
   - "ROLL": Close and reopen with different strike/expiration

2. **Reasoning**: Provide 2-3 sentences referencing:
   - Time decay risk (Theta) if DTE < 30 days
   - Directional probability (Delta) if position is near ITM/OTM boundary
   - P&L and risk/reward given time remaining

CRITICAL: Respond with ONLY valid JSON. No preamble, no markdown, no explanation outside the JSON.

{
  "verdict": "HOLD" | "CLOSE" | "ROLL",
  "reasoning": "Your analysis here"
}

EXAMPLE:
{
  "verdict": "CLOSE",
  "reasoning": "With only 5 days to expiration, theta decay of -$12/day is eroding value rapidly. Delta of 0.23 suggests only 23% probability of profit. Lock in current 15% gain before time decay accelerates."
}`;
    }
}
