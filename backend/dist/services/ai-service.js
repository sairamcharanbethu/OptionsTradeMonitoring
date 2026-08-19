"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIService = exports.DEFAULT_AI_MODEL = exports.DEFAULT_AI_PROVIDER = void 0;
const yahoo_finance2_1 = __importDefault(require("yahoo-finance2"));
const settings_utils_1 = require("../lib/settings-utils");
const yahooFinance = new yahoo_finance2_1.default({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });
exports.DEFAULT_AI_PROVIDER = 'openrouter';
exports.DEFAULT_AI_MODEL = 'deepseek/deepseek-chat';
function toCavemanStyle(text) {
    if (!text)
        return '';
    // Strip common filler words/articles/prepositions/auxiliary verbs
    const fillers = /\b(the|a|an|and|of|to|for|with|on|in|at|by|as|after|about|from|into|over|through|is|are|was|were|be|been|being)\b/gi;
    return text
        .replace(fillers, '')
        .replace(/\s+/g, ' ')
        .trim();
}
class AIService {
    fastify;
    ollamaUrl;
    model;
    constructor(fastify) {
        this.fastify = fastify;
        // On Windows Docker, host.docker.internal resolves to the host machine
        this.ollamaUrl = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
        this.model = process.env.AI_MODEL || exports.DEFAULT_AI_MODEL;
    }
    async generateAlertSummary(data, userId) {
        const prompt = `Option Alert: ${data.symbol} ${data.type} ${data.strike} Exp: ${data.expiration}
Event: ${data.event}
Price: $${data.price} (PnL: ${data.pnl}%)
Underlying: $${data.underlying_price || 'N/A'}
Greeks: ${JSON.stringify(data.greeks)}

Task: Concise summary (20 words) + Discord message (markdown, emoji).
Format: JSON { "verdict": "...", "analysis": "...", "discord": "..." }`;
        const response = await this.generateAnalysisInternal(prompt, 300, userId);
        return {
            summary: response.analysis,
            discord_message: response.discord || response.analysis
        };
    }
    async generateBriefing(positions) {
        if (positions.length === 0)
            return { briefing: "No active positions.", discord_message: "No active positions." };
        const posSummary = positions.map(p => {
            const pnl = ((Number(p.current_price) - Number(p.entry_price)) / Number(p.entry_price) * 100).toFixed(1);
            return `- ${p.symbol} ${p.option_type} $${p.strike_price} Exp: ${p.expiration_date}: Price $${p.current_price} (${pnl}%) | Delta: ${p.delta}`;
        }).join('\n');
        const prompt = `Morning Briefing for ${positions[0].user_id}
Positions:
${posSummary}

Task: Provide a high-level summary of the portfolio's health, highlight positions needing immediate attention (due to PnL or Greek shifts), and suggest next steps.
Style: Professional trader tone, concise but insightful.
Format: JSON { "analysis": "Full analysis here...", "discord": "Formatted Discord message with emojis..." }`;
        const userId = positions[0]?.user_id;
        const response = await this.generateAnalysisInternal(prompt, 2048, userId);
        return {
            briefing: response.analysis,
            discord_message: response.discord || response.analysis
        };
    }
    async generateWealthsimpleBriefing(positions, userId) {
        if (positions.length === 0) {
            return {
                briefing: {
                    summary: "No active Wealthsimple positions.",
                    actionRequired: [],
                    holdWatch: []
                }
            };
        }
        // Sort by value descending and take top 5 to keep it fast
        const sortedPositions = [...positions].sort((a, b) => {
            const valA = Number(a.price) * Number(a.units);
            const valB = Number(b.price) * Number(b.units);
            return valB - valA;
        });
        const topPositions = sortedPositions.slice(0, 5);
        let insightsText = "";
        try {
            const promises = topPositions.map(async (p) => {
                let ticker = p.symbol.trim().toUpperCase();
                const isCrypto = p.asset_type?.toLowerCase() === 'crypto' || ['XRP', 'BTC', 'ETH', 'LTC', 'SOL', 'ADA', 'DOGE', 'DOT'].includes(ticker);
                if (isCrypto && !ticker.endsWith('-USD')) {
                    ticker = `${ticker}-USD`;
                }
                try {
                    const quote = await yahooFinance.quoteSummary(ticker, { modules: ['summaryDetail', 'price'] });
                    const news = await yahooFinance.search(ticker, { newsCount: 5 });
                    const price = quote.price?.regularMarketPrice || p.price;
                    const pe = quote.summaryDetail?.trailingPE?.toFixed(2) || 'N/A';
                    const fiftyTwoHigh = quote.summaryDetail?.fiftyTwoWeekHigh?.toFixed(2) || 'N/A';
                    // Filter news relevant to this specific ticker
                    const baseSymbol = ticker.split('.')[0].split('-')[0];
                    const uppercaseTicker = ticker.toUpperCase();
                    const uppercaseBase = baseSymbol.toUpperCase();
                    const relevantNews = (news.news || []).filter((n) => {
                        const hasRelatedTicker = n.relatedTickers?.some((t) => {
                            const uppercaseT = t.toUpperCase();
                            return uppercaseT === uppercaseTicker || uppercaseT === uppercaseBase;
                        });
                        const titleLower = (n.title || '').toLowerCase();
                        const tickerLower = ticker.toLowerCase();
                        const baseLower = baseSymbol.toLowerCase();
                        const hasInTitle = titleLower.includes(tickerLower) || titleLower.includes(baseLower);
                        return hasRelatedTicker || hasInTitle;
                    });
                    const headlines = relevantNews.slice(0, 2).map((n) => `- "${toCavemanStyle(n.title)}"`).join('\n      ');
                    return `  [${ticker}] P/E: ${pe} | 52w High: $${fiftyTwoHigh} | Current: $${price}\n      Recent News:\n      ${headlines || 'No recent news.'}`;
                }
                catch (e) {
                    return `  [${ticker}] No extended data available.`;
                }
            });
            const resolvedInsights = await Promise.all(promises);
            insightsText = resolvedInsights.join('\n\n');
        }
        catch (e) {
            console.error("[AIService] Failed to fetch Yahoo Finance insights for Wealthsimple briefing", e);
        }
        const posSummary = positions.map(p => {
            const pnl = p.open_pnl ? Number(p.open_pnl).toFixed(2) : '0.00';
            const val = (Number(p.price) * Number(p.units)).toFixed(2);
            return `- ${p.symbol} (${p.asset_type}): ${p.units} units @ $${p.average_purchase_price} | Current: $${p.price} | Value: $${val} | PnL: $${pnl}`;
        }).join('\n');
        const prompt = `Wealthsimple Portfolio Briefing
Positions:
${posSummary}

Fundamental & News Insights (Top Holdings):
${insightsText}

Task: Generate a highly structured, professional wealth manager summary and classification of the entire portfolio.
You MUST analyze the entire portfolio's risk profile, but pay special attention to the top holdings.

To keep the briefing concise and avoid token limits, you MUST limit the detailed actionRequired and holdWatch list to:
- All holdings requiring active decisions (TRIM, BUY, SELL).
- The top 10 remaining holdings (by value) for the "holdWatch" list.

For each holding analyzed:
1. Determine if it needs action (TRIM, BUY, SELL) or should be held (HOLD).
2. If TRIM: specify a precise percentage or share amount to trim.
3. If HOLD/BUY: specify a clear holding/watching timeline (e.g., "Hold for 2 weeks", "Accumulate on 5% dip", "Hold indefinitely").
4. Provide a clear 1-sentence action plan/rationale.

Format: Respond ONLY with a valid JSON object matching this schema:
{
  "summary": "A 1-2 sentence high-level summary of the overall portfolio health and asset allocation.",
  "actionRequired": [
    {
      "symbol": "TICKER",
      "verdict": "TRIM" | "BUY" | "SELL",
      "actionPlan": "Brief 1-sentence rationale explaining the verdict.",
      "amount": "Specific trim percentage/amount (e.g., 'Trim 30%', 'Sell 50%', or 'N/A' for BUY)",
      "timeline": "Suggested execution window (e.g., 'Immediately', 'On next rally', 'Over next 5 days')"
    }
  ],
  "holdWatch": [
    {
      "symbol": "TICKER",
      "verdict": "HOLD",
      "actionPlan": "Brief 1-sentence rationale explaining why to hold.",
      "timeline": "Suggested monitoring timeframe (e.g., 'Hold for 3 months', 'Monitor weekly', 'Hold indefinitely')"
    }
  ]
}
Do NOT include any extra keys or explanations outside the JSON. All JSON fields must be completed.`;
        try {
            const parsedBriefing = await this.generateJSONInternal(prompt, 3000, userId);
            return {
                briefing: parsedBriefing
            };
        }
        catch (err) {
            console.error("[AIService] Failed to generate/parse structured Wealthsimple briefing", err);
            // Fallback structured briefing
            return {
                briefing: {
                    summary: "AI review failed to generate. Please check your AI provider or retry.",
                    actionRequired: [],
                    holdWatch: []
                }
            };
        }
    }
    async generateAnalysis(data, userId) {
        const prompt = this.buildPrompt(data);
        const response = await this.generateAnalysisInternal(prompt, 300, userId);
        return {
            verdict: response.verdict,
            analysis: response.analysis
        };
    }
    async askAI(prompt, userId) {
        const response = await this.generateAnalysisInternal(prompt, 300, userId);
        return {
            verdict: response.verdict,
            analysis: response.analysis
        };
    }
    async askTradingJSON(prompt, userId, maxTokens = 600, timeoutMs) {
        const parsed = await this.generateJSONInternal(prompt, maxTokens, userId, timeoutMs);
        const analysis = parsed.analysis || parsed.rationale || parsed.reason || parsed.summary || '';
        return {
            verdict: parsed.verdict || parsed.mode || 'UNKNOWN',
            analysis: typeof analysis === 'object' ? JSON.stringify(analysis) : String(analysis || ''),
            usage: parsed.usage || null,
            ...parsed
        };
    }
    async getSettings(userId) {
        let currentProvider = process.env.AI_PROVIDER || exports.DEFAULT_AI_PROVIDER;
        let openRouterKey = '';
        let currentModel = this.model;
        try {
            const settings = userId !== undefined
                ? await (0, settings_utils_1.getSettingsWithGlobalFallback)(this.fastify.pg, userId)
                : await (0, settings_utils_1.getGlobalSettings)(this.fastify.pg);
            if (settings.ai_provider)
                currentProvider = settings.ai_provider;
            if (settings.openrouter_key)
                openRouterKey = settings.openrouter_key;
            if (settings.ai_model)
                currentModel = settings.ai_model;
        }
        catch (err) {
            console.warn('[AIService] Failed to fetch settings, using defaults:', err);
        }
        return {
            ai_provider: currentProvider,
            openrouter_key: openRouterKey,
            ai_model: currentModel
        };
    }
    async checkHealth(userId) {
        const settings = await this.getSettings(userId);
        if (settings.ai_provider === 'openrouter') {
            if (!settings.openrouter_key) {
                throw new Error('OpenRouter selected but no API Key found in settings.');
            }
            try {
                const response = await fetch('https://openrouter.ai/api/v1/key', {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${settings.openrouter_key}`
                    }
                });
                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(`OpenRouter accessibility check failed: ${response.status} - ${errText}`);
                }
                const data = await response.json();
                if (data && data.error) {
                    throw new Error(`OpenRouter API Key check returned error: ${JSON.stringify(data.error)}`);
                }
            }
            catch (err) {
                throw new Error(`OpenRouter is not accessible. Error: ${err.message}`);
            }
        }
        else if (settings.ai_provider === 'ollama') {
            try {
                const response = await fetch(`${this.ollamaUrl}/api/tags`, {
                    method: 'GET'
                });
                if (!response.ok) {
                    throw new Error(`Ollama health check failed: ${response.status} ${response.statusText}`);
                }
            }
            catch (err) {
                throw new Error(`Ollama is not accessible at ${this.ollamaUrl}. Error: ${err.message}`);
            }
        }
    }
    async generateJSONInternal(prompt, maxTokens = 600, userId, timeoutMs) {
        const controller = timeoutMs ? new AbortController() : null;
        const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
        try {
            const settings = await this.getSettings(userId);
            let text = '';
            let providerUsage = null;
            if (settings.ai_provider === 'openrouter') {
                if (!settings.openrouter_key)
                    throw new Error('OpenRouter selected but no API Key found.');
                let response;
                let useJsonFormat = true;
                try {
                    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                        method: 'POST',
                        signal: controller?.signal,
                        headers: {
                            'Authorization': `Bearer ${settings.openrouter_key}`,
                            'HTTP-Referer': 'http://localhost:3000',
                            'X-Title': 'OptionsTradeMonitor',
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            model: settings.ai_model,
                            messages: [
                                { role: 'system', content: 'You are a concise trading bot. Respond ONLY with valid JSON.' },
                                { role: 'user', content: prompt }
                            ],
                            response_format: { type: 'json_object' },
                            temperature: 0,
                            max_tokens: maxTokens
                        })
                    });
                    if (!response.ok) {
                        const errText = await response.text();
                        if (response.status === 400 || errText.includes('response_format') || errText.includes('json_object')) {
                            console.warn(`[AIService] OpenRouter JSON format unsupported or failed (Status ${response.status}). Retrying without response_format...`);
                            useJsonFormat = false;
                        }
                        else {
                            throw new Error(`OpenRouter Error: ${response.status} - ${errText}`);
                        }
                    }
                }
                catch (fetchErr) {
                    console.warn(`[AIService] OpenRouter JSON fetch failed, retrying without response_format: ${fetchErr.message}`);
                    useJsonFormat = false;
                }
                if (!useJsonFormat) {
                    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                        method: 'POST',
                        signal: controller?.signal,
                        headers: {
                            'Authorization': `Bearer ${settings.openrouter_key}`,
                            'HTTP-Referer': 'http://localhost:3000',
                            'X-Title': 'OptionsTradeMonitor',
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            model: settings.ai_model,
                            messages: [
                                { role: 'system', content: 'You are a concise trading bot. Respond ONLY with valid JSON.' },
                                { role: 'user', content: prompt }
                            ],
                            temperature: 0,
                            max_tokens: maxTokens
                        })
                    });
                    if (!response.ok) {
                        const errText = await response.text();
                        throw new Error(`OpenRouter Error: ${response.status} - ${errText}`);
                    }
                }
                const data = await response.json();
                if (data.error)
                    throw new Error(data.error.message || JSON.stringify(data.error));
                providerUsage = data.usage || null;
                text = data.choices[0].message?.content;
            }
            else {
                const response = await fetch(`${this.ollamaUrl}/api/generate`, {
                    method: 'POST',
                    signal: controller?.signal,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: settings.ai_model,
                        prompt: `You are a concise trading bot. Respond ONLY with valid JSON.\n\n${prompt}`,
                        stream: false,
                        format: 'json',
                        options: {
                            temperature: 0,
                            num_predict: maxTokens
                        }
                    })
                });
                if (!response.ok)
                    throw new Error(`Ollama Error: ${response.statusText}`);
                const result = await response.json();
                providerUsage = {
                    prompt_tokens: Number(result.prompt_eval_count || 0),
                    completion_tokens: Number(result.eval_count || 0),
                    total_tokens: Number(result.prompt_eval_count || 0) + Number(result.eval_count || 0)
                };
                text = result.response;
            }
            if (text === undefined || text === null || text.trim() === '') {
                throw new Error("AI returned an empty response.");
            }
            let cleanText = text.trim();
            if (cleanText.startsWith('```json')) {
                cleanText = cleanText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
            }
            else if (cleanText.startsWith('```')) {
                cleanText = cleanText.replace(/^```\n?/, '').replace(/\n?```$/, '');
            }
            cleanText = cleanText.trim();
            // Strip trailing commas from JSON arrays/objects to make parsing more robust
            cleanText = cleanText.replace(/,\s*}/g, '}').replace(/,\s*\]/g, ']');
            const withUsage = (value) => providerUsage
                ? { ...value, usage: value?.usage || providerUsage }
                : value;
            try {
                return withUsage(JSON.parse(cleanText));
            }
            catch (e) {
                // If direct parse fails, try to repair the JSON first (in case it was truncated)
                try {
                    const repaired = this.repairJson(cleanText);
                    return withUsage(JSON.parse(repaired));
                }
                catch (repairError) {
                    // If repair fails, fall back to extracting and repairing the JSON block
                    const jsonMatch = cleanText.match(/\{[\s\S]*/);
                    if (jsonMatch) {
                        try {
                            const repairedMatch = this.repairJson(jsonMatch[0]);
                            return withUsage(JSON.parse(repairedMatch));
                        }
                        catch (innerError) {
                            // ignore and throw original error
                        }
                    }
                }
                throw e;
            }
        }
        catch (error) {
            this.fastify.log.error(error);
            throw new Error(`AI JSON Generation Failed: ${error.message}`);
        }
        finally {
            if (timeout)
                clearTimeout(timeout);
        }
    }
    async generateAnalysisInternal(prompt, maxTokens = 300, userId) {
        try {
            // 1. Fetch settings from DB
            const settings = await this.getSettings(userId);
            // 2. Route based on provider
            if (settings.ai_provider === 'openrouter') {
                if (!settings.openrouter_key)
                    throw new Error('OpenRouter selected but no API Key found.');
                return this.callOpenRouter(settings.ai_model, settings.openrouter_key, prompt, maxTokens);
            }
            else {
                return this.callOllama(settings.ai_model, prompt, maxTokens);
            }
        }
        catch (error) {
            this.fastify.log.error(error);
            throw new Error(`AI Analysis Failed: ${error.message}`);
        }
    }
    async callOpenRouter(model, apiKey, prompt, maxTokens = 300) {
        console.log(`[AIService] Using OpenRouter (${model}) [Token limit: ${maxTokens}]`);
        let response;
        let useJsonFormat = true;
        try {
            response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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
                    max_tokens: maxTokens
                })
            });
            if (!response.ok) {
                const errText = await response.text();
                if (response.status === 400 || errText.includes('response_format') || errText.includes('json_object')) {
                    console.warn(`[AIService] OpenRouter JSON format unsupported or failed in callOpenRouter (Status ${response.status}). Retrying without response_format...`);
                    useJsonFormat = false;
                }
                else {
                    throw new Error(`OpenRouter Error: ${response.status} - ${errText}`);
                }
            }
        }
        catch (fetchErr) {
            console.warn(`[AIService] OpenRouter JSON fetch failed in callOpenRouter, retrying without response_format: ${fetchErr.message}`);
            useJsonFormat = false;
        }
        if (!useJsonFormat) {
            response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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
                    temperature: 0,
                    max_tokens: maxTokens
                })
            });
            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`OpenRouter Error: ${response.status} - ${errText}`);
            }
        }
        const data = await response.json();
        if (data.error) {
            throw new Error(`OpenRouter API Error: ${data.error.message || JSON.stringify(data.error)}`);
        }
        if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
            throw new Error(`OpenRouter response structure invalid. Response: ${JSON.stringify(data)}`);
        }
        const text = data.choices[0].message?.content;
        if (text === undefined || text === null) {
            throw new Error(`OpenRouter choice message content missing. Response: ${JSON.stringify(data)}`);
        }
        try {
            // Strip markdown json blocks if present
            let cleanText = text.trim();
            if (cleanText.startsWith('```json')) {
                cleanText = cleanText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
            }
            else if (cleanText.startsWith('```')) {
                cleanText = cleanText.replace(/^```\n?/, '').replace(/\n?```$/, '');
            }
            const parsed = JSON.parse(cleanText);
            let analysisText = parsed.analysis || parsed.reasoning || parsed.summary || parsed.briefing || cleanText;
            if (typeof analysisText === 'object') {
                analysisText = JSON.stringify(analysisText, null, 2);
            }
            return {
                verdict: parsed.verdict || 'UNKNOWN',
                analysis: analysisText,
                discord: parsed.discord
            };
        }
        catch (e) {
            return { verdict: 'Review', analysis: text };
        }
    }
    async callOllama(model, prompt, maxTokens = 300) {
        console.log(`[AIService] Using Ollama (${model}) [Token limit: ${maxTokens}]`);
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
                    num_predict: maxTokens
                }
            })
        });
        if (!response.ok) {
            throw new Error(`Ollama Error: ${response.status} ${response.statusText}`);
        }
        const result = await response.json();
        const text = result.response;
        try {
            // Strip markdown json blocks if present
            let cleanText = text.trim();
            if (cleanText.startsWith('```json')) {
                cleanText = cleanText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
            }
            else if (cleanText.startsWith('```')) {
                cleanText = cleanText.replace(/^```\n?/, '').replace(/\n?```$/, '');
            }
            const parsed = JSON.parse(cleanText);
            let analysisText = parsed.analysis || parsed.reasoning || parsed.summary || parsed.briefing || cleanText;
            if (typeof analysisText === 'object') {
                analysisText = JSON.stringify(analysisText, null, 2);
            }
            return {
                verdict: parsed.verdict || 'UNKNOWN',
                analysis: analysisText,
                discord: parsed.discord
            };
        }
        catch (e) {
            return {
                verdict: 'Review',
                analysis: text
            };
        }
    }
    buildPrompt(data) {
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
    buildScenarios(data) {
        if (!data.underlying_price || !data.greeks.delta)
            return 'Scenarios not available (missing Greeks or underlying price).';
        const scenarios = [-10, -5, 5, 10];
        return scenarios.map(pct => {
            const underlying_price = data.underlying_price;
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
    repairJson(jsonStr) {
        let s = jsonStr.trim();
        if (!s)
            return '{}';
        let inString = false;
        let isEscaped = false;
        const stack = [];
        // Track JSON structure
        for (let i = 0; i < s.length; i++) {
            const char = s[i];
            if (isEscaped) {
                isEscaped = false;
                continue;
            }
            if (char === '\\') {
                isEscaped = true;
                continue;
            }
            if (char === '"') {
                inString = !inString;
                continue;
            }
            if (!inString) {
                if (char === '{' || char === '[') {
                    stack.push(char);
                }
                else if (char === '}') {
                    if (stack[stack.length - 1] === '{') {
                        stack.pop();
                    }
                }
                else if (char === ']') {
                    if (stack[stack.length - 1] === '[') {
                        stack.pop();
                    }
                }
            }
        }
        // If we ended inside a string, close it
        if (inString) {
            s += '"';
        }
        // Clean up trailing commas, colons, or incomplete object keys/values at the end of the truncated string
        let previousLength = 0;
        while (s.length !== previousLength) {
            previousLength = s.length;
            s = s.trim();
            if (s.endsWith(',')) {
                s = s.slice(0, -1);
                continue;
            }
            if (s.endsWith(':')) {
                s = s.slice(0, -1);
                continue;
            }
            s = s.replace(/,\s*"[^"]*"\s*$/, '');
            s = s.replace(/,\s*"[^"]*"\s*:\s*$/, '');
        }
        // Close any unclosed braces/brackets in reverse order
        while (stack.length > 0) {
            const openChar = stack.pop();
            if (openChar === '{') {
                s += '}';
            }
            else if (openChar === '[') {
                s += ']';
            }
        }
        return s;
    }
}
exports.AIService = AIService;
//# sourceMappingURL=ai-service.js.map