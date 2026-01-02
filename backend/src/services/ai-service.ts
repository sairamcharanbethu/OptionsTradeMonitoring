
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

        return `You are a practical options trading advisor. Analyze this position and give clear, actionable guidance.

POSITION:
${data.symbol} ${data.type} $${data.strike} 
Expires: ${data.expiration} (${daysToExp} days left)
Entry: $${data.entry.toFixed(2)} → Current: $${data.price.toFixed(2)}
P&L: ${pnl.toFixed(2)}%
Delta: ${data.greeks.delta ?? 'N/A'} | Theta: ${data.greeks.theta ?? 'N/A'} | IV: ${data.greeks.iv ? data.greeks.iv.toFixed(2) + '%' : 'N/A'}

Give me ONE action and why:
- HOLD: Keep the position as-is
- CLOSE: Exit now and take the gain/loss
- ROLL: Close and reopen at a different strike or date

RULES:
- Maximum 2 sentences in reasoning
- Use plain English (avoid phrases like "indicates that the market expects")
- Be direct and decisive
- Don't hedge with "may be worth" or "it might"

Respond with ONLY this JSON (no extra text before or after):
{
  "verdict": "HOLD" | "CLOSE" | "ROLL",
  "reasoning": "Your explanation here"
}

GOOD EXAMPLE:
{
  "verdict": "HOLD",
  "reasoning": "You're down 44% but have 7 weeks left and high IV means big moves are possible. Hold for now and reassess in 2 weeks."
}`;
    }
}
