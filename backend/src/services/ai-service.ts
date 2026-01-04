
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
    underlying_price: number | null;
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

    async generateAlertSummary(data: any): Promise<{ summary: string; discord_message: string }> {
        const prompt = `Option Alert: ${data.symbol} ${data.type} ${data.strike} Exp: ${data.expiration}
Event: ${data.event}
Price: $${data.price} (PnL: ${data.pnl}%)
Greeks: ${JSON.stringify(data.greeks)}

Task: Concise summary (20 words) + Discord message (markdown, emoji).
Format: JSON { "verdict": "...", "analysis": "...", "discord": "..." }`;

        const response = await this.generateAnalysisInternal(prompt);
        return {
            summary: response.analysis,
            discord_message: response.discord || response.analysis
        };
    }

    async generateAnalysis(data: AIAnalysisRequest): Promise<{ verdict: string; analysis: string }> {
        const prompt = this.buildPrompt(data);
        const response = await this.generateAnalysisInternal(prompt);
        return {
            verdict: response.verdict,
            analysis: response.analysis
        };
    }

    private async generateAnalysisInternal(prompt: string): Promise<{ verdict: string; analysis: string; discord?: string }> {
        try {
            // 1. Fetch settings from DB
            let currentProvider = 'ollama';
            let openRouterKey = '';
            let currentModel = this.model;

            try {
                const { rows } = await (this.fastify as any).pg.query('SELECT key, value FROM settings');
                const settings = rows.reduce((acc: any, row: any) => {
                    acc[row.key] = row.value;
                    return acc;
                }, {});

                if (settings.ai_provider) currentProvider = settings.ai_provider;
                if (settings.openrouter_key) openRouterKey = settings.openrouter_key;
                if (settings.ai_model) currentModel = settings.ai_model;

            } catch (err) {
                console.warn('[AIService] Failed to fetch settings, using defaults:', err);
            }

            // 2. Route based on provider
            if (currentProvider === 'openrouter') {
                if (!openRouterKey) throw new Error('OpenRouter selected but no API Key found.');
                return this.callOpenRouter(currentModel, openRouterKey, prompt);
            } else {
                return this.callOllama(currentModel, prompt);
            }

        } catch (error: any) {
            this.fastify.log.error(error);
            throw new Error(`AI Analysis Failed: ${error.message}`);
        }
    }

    private async callOpenRouter(model: string, apiKey: string, prompt: string): Promise<{ verdict: string; analysis: string; discord?: string }> {
        console.log(`[AIService] Using OpenRouter (${model}) [Token Efficient]`);

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': 'http://localhost:3000',
                'X-Title': 'OptionsTradeMonitor',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'system', content: 'You are a concise trading bot. Respond ONLY with valid JSON. Keep messages short.' },
                    { role: 'user', content: prompt }
                ],
                response_format: { type: 'json_object' },
                temperature: 0,
                max_tokens: 300 // Token efficiency
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenRouter Error: ${response.status} - ${errText}`);
        }

        const data = await response.json();
        const text = data.choices[0].message.content;

        try {
            const parsed = JSON.parse(text);
            return {
                verdict: parsed.verdict || 'UNKNOWN',
                analysis: parsed.reasoning || parsed.analysis || parsed.summary || text,
                discord: parsed.discord
            };
        } catch (e) {
            return { verdict: 'Review', analysis: text };
        }
    }

    private async callOllama(model: string, prompt: string): Promise<{ verdict: string; analysis: string; discord?: string }> {
        console.log(`[AIService] Using Ollama (${model}) [Token Efficient]`);

        const response = await fetch(`${this.ollamaUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model,
                prompt: `You are a concise trading bot. Respond ONLY with valid JSON. Keep messages short.\n\n${prompt}`,
                stream: false,
                format: 'json',
                options: {
                    temperature: 0,
                    num_predict: 300 // Token efficiency
                }
            })
        });

        if (!response.ok) {
            throw new Error(`Ollama Error: ${response.status} ${response.statusText}`);
        }

        const result = await response.json();
        const text = result.response;

        try {
            const parsed = JSON.parse(text);
            return {
                verdict: parsed.verdict || 'UNKNOWN',
                analysis: parsed.reasoning || parsed.analysis || parsed.summary || text,
                discord: parsed.discord
            };
        } catch (e) {
            return {
                verdict: 'Review',
                analysis: text
            };
        }
    }

    private buildPrompt(data: AIAnalysisRequest): string {
        const pnl = (data.price - data.entry) / data.entry * 100;
        const daysToExp = Math.ceil((new Date(data.expiration).getTime() - Date.now()) / (1000 * 60 * 60 * 24));

        return `Analyze this options position and recommend ONE action.

POSITION:
${data.symbol} ${data.type} $${data.strike} 
Expires: ${data.expiration} (${daysToExp} days left)
Entry: $${data.entry.toFixed(2)} → Current: $${data.price.toFixed(2)}
P&L: ${pnl.toFixed(2)}%
Delta: ${data.greeks.delta ?? 'N/A'} | Theta: ${data.greeks.theta ?? 'N/A'} | IV: ${data.greeks.iv ? data.greeks.iv.toFixed(2) + '%' : 'N/A'}
Stock Reference Price: ${data.underlying_price ? '$' + data.underlying_price.toFixed(2) : 'N/A'}

RISK SCENARIOS (Estimated PnL change):
${this.buildScenarios(data)}

ACTIONS:
- HOLD: Keep position unchanged
- CLOSE: Exit and take the profit/loss  
- ROLL: Close and reopen at different strike/expiration

REASONING REQUIREMENTS (2-3 sentences, ~40-50 words):
1. State the current situation (P&L, time, key Greek)
2. Explain WHY this matters (the risk or opportunity)
3. Give specific action with timeline and what to watch for
4. Be decisive - no "might", "could", "may want to consider"
5. If HOLD: include checkpoint and trigger to exit
6. If ROLL: suggest direction (further out? different strike?)
7. If CLOSE: explain what risk you're avoiding

STYLE: Sound like an experienced trader explaining to a colleague, not a textbook.

EXAMPLES:

Losing position with time and volatility:
{"verdict":"HOLD","reasoning":"You're down 44% with 7 weeks left, but IV at 58% means the underlying could make big moves. Hold for 2 more weeks to catch a potential bounce. If you're still down 40%+ by then or IV drops below 45%, cut it and move on."}

Losing position without time:
{"verdict":"CLOSE","reasoning":"Down 50% with only 8 days to expiration. Theta decay at -$0.15/day is eating what's left, and delta of 0.18 means only 18% chance of profit. Cut the loss now and redeploy the capital somewhere with better odds."}

Winning position near expiration:
{"verdict":"HOLD","reasoning":"Up 35% with 4 weeks left and delta at 0.72 means you're likely to stay ITM. Let it run to 50% profit or until 10 days out, whichever comes first. Watch for delta dropping below 0.60 as your exit signal."}

Roll scenario with weak position:
{"verdict":"ROLL","reasoning":"Down 30% with delta of 0.25 and only 3 weeks left—low probability of recovery on this timeline. Roll out 45-60 days to reduce time pressure and give the position room to work. Consider moving to a lower strike if capital allows."}

Strong position taking profit:
{"verdict":"CLOSE","reasoning":"Up 65% with 2 weeks left. You've captured most of the move and delta is starting to flatten. Take the win now before theta accelerates or the underlying reverses on you."}

CRITICAL: Your reasoning should help the trader understand:
- What the numbers actually mean for THIS position
- What specific risk they're facing or opportunity they have
- Exactly when to reassess or what to watch for next

YOUR RESPONSE (valid JSON only, no other text):
{
  "verdict": "HOLD" | "CLOSE" | "ROLL",
  "reasoning": "Your detailed analysis here (2-3 sentences)"
}
}`;
    }

    private buildScenarios(data: AIAnalysisRequest): string {
        if (!data.underlying_price || !data.greeks.delta) return 'Scenarios not available (missing Greeks or underlying price).';

        const scenarios = [-10, -5, 5, 10];
        return scenarios.map(pct => {
            const underlying_price = data.underlying_price!;
            const dS = underlying_price * (pct / 100);
            const deltaEffect = (data.greeks.delta || 0) * dS;
            const gammaEffect = 0.5 * (data.greeks.gamma || 0) * Math.pow(dS, 2);
            const estNewPrice = Math.max(0.01, data.price + deltaEffect + gammaEffect);
            const pnlChange = ((estNewPrice - data.price) / data.price) * 100;

            const sign = pct > 0 ? '+' : '';
            const pnlSign = pnlChange > 0 ? '+' : '';

            return "- If stock moves " + sign + pct + "%: Option price becomes ~$" + estNewPrice.toFixed(2) + " (" + pnlSign + pnlChange.toFixed(1) + "% change from current)";
        }).join('\n');
    }
}
