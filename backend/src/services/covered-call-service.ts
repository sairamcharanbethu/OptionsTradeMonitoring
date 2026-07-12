import { FastifyInstance } from 'fastify';
import YahooFinance from 'yahoo-finance2';
import { AIService } from './ai-service';
import { IbkrMarketDataService, IbkrOptionChainQuote } from './ibkr-market-data-service';

const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

export type CoveredCallSymbolResult = {
  symbol: string;
  name: string;
  exchange?: string | null;
  quoteType?: string | null;
};

export type CoveredCallNewsItem = {
  title: string;
  publisher: string | null;
  link: string | null;
  publishedAt: string | null;
};

export type CoveredCallCandidate = {
  ticker: string;
  expiration: string;
  dte: number;
  strike: number;
  bid: number | null;
  ask: number | null;
  mark: number | null;
  spreadPct: number | null;
  volume: number | null;
  openInterest: number | null;
  delta: number | null;
  theta: number | null;
  impliedVolatility: number | null;
  premiumPerContract: number;
  premiumYieldPct: number;
  annualizedYieldPct: number;
  otmPct: number;
  score: number;
  eligible: boolean;
  reasons: string[];
};

export type CoveredCallAnalysis = {
  symbol: string;
  generatedAt: string;
  profile: 'conservative';
  quote: {
    price: number;
    name: string | null;
    currency: string | null;
    marketState: string | null;
  };
  scan: {
    minDte: number;
    maxDte: number;
    expirationsChecked: string[];
    contractsReviewed: number;
  };
  best: CoveredCallCandidate | null;
  candidates: CoveredCallCandidate[];
  news: CoveredCallNewsItem[];
  ai: {
    summary: string;
    bestContractTicker: string | null;
    riskNotes: string[];
    incomeRationale: string;
    avoidIf: string[];
    fallback: boolean;
    error?: string;
  };
};

const DEFAULTS = {
  minDte: 14,
  maxDte: 45,
  maxExpirations: 6,
  maxSpreadPct: 12,
  minVolume: 50,
  minOpenInterest: 100,
  minOtmPct: 1,
  maxConservativeDelta: 0.45
};

const toNumber = (value: any): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

export function calculateDte(expiration: string, now = new Date()): number {
  const [year, month, day] = String(expiration).split('T')[0].split('-').map(Number);
  if (!year || !month || !day) return -1;
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const expiryUtc = Date.UTC(year, month - 1, day);
  return Math.ceil((expiryUtc - todayUtc) / 86400000);
}

export function scoreCoveredCallCandidate(
  quote: IbkrOptionChainQuote,
  stockPrice: number,
  now = new Date()
): CoveredCallCandidate {
  const dte = calculateDte(quote.expiration, now);
  const bid = toNumber(quote.bid);
  const ask = toNumber(quote.ask);
  const mark = toNumber(quote.mark);
  const spreadPct = toNumber(quote.spreadPct);
  const volume = toNumber(quote.volume);
  const openInterest = toNumber(quote.openInterest);
  const delta = toNumber(quote.delta);
  const theta = toNumber(quote.theta);
  const impliedVolatility = toNumber(quote.impliedVolatility);
  const premiumPerContract = mark && mark > 0 ? mark * 100 : 0;
  const premiumYieldPct = mark && stockPrice > 0 ? (mark / stockPrice) * 100 : 0;
  const annualizedYieldPct = dte > 0 ? premiumYieldPct * (365 / dte) : 0;
  const otmPct = stockPrice > 0 ? ((quote.strike - stockPrice) / stockPrice) * 100 : 0;
  const reasons: string[] = [];
  let score = 100;

  if (dte < DEFAULTS.minDte || dte > DEFAULTS.maxDte) {
    score -= 35;
    reasons.push(`outside ${DEFAULTS.minDte}-${DEFAULTS.maxDte} DTE`);
  } else {
    score += 12;
    reasons.push('target DTE');
  }

  if (!mark || mark <= 0) {
    score -= 90;
    reasons.push('no usable premium');
  } else if (premiumYieldPct < 0.25) {
    score -= 14;
    reasons.push('premium yield is thin');
  } else if (premiumYieldPct <= 3) {
    score += 14;
    reasons.push('balanced premium yield');
  } else {
    score += 4;
    reasons.push('high premium, review assignment risk');
  }

  if (!bid || !ask || bid <= 0 || ask <= 0) {
    score -= 70;
    reasons.push('missing bid/ask');
  }

  if (spreadPct === null) {
    score -= 18;
    reasons.push('spread unavailable');
  } else if (spreadPct > DEFAULTS.maxSpreadPct) {
    score -= Math.min(40, (spreadPct - DEFAULTS.maxSpreadPct) * 2.5);
    reasons.push(`wide spread ${spreadPct.toFixed(1)}%`);
  } else {
    score += Math.max(0, DEFAULTS.maxSpreadPct - spreadPct);
    reasons.push('spread acceptable');
  }

  if (volume === null) {
    reasons.push('volume unavailable');
  } else if (volume < DEFAULTS.minVolume) {
    score -= 12;
    reasons.push(`volume below ${DEFAULTS.minVolume}`);
  } else {
    score += Math.min(10, Math.log10(volume + 1) * 2.5);
  }

  if (openInterest === null) {
    score -= 10;
    reasons.push('OI unavailable');
  } else if (openInterest < DEFAULTS.minOpenInterest) {
    score -= 14;
    reasons.push(`OI below ${DEFAULTS.minOpenInterest}`);
  } else {
    score += Math.min(10, Math.log10(openInterest + 1) * 2);
  }

  if (otmPct < 0) {
    score -= 45;
    reasons.push('in the money assignment risk');
  } else if (otmPct < DEFAULTS.minOtmPct) {
    score -= 24;
    reasons.push('too close to stock price');
  } else if (otmPct <= 8) {
    score += 16;
    reasons.push('useful upside cushion');
  } else if (otmPct > 20) {
    score -= 8;
    reasons.push('far OTM premium may be inefficient');
  }

  const absDelta = delta === null ? null : Math.abs(delta);
  if (absDelta === null) {
    reasons.push('delta unavailable');
  } else if (absDelta > DEFAULTS.maxConservativeDelta) {
    score -= 34;
    reasons.push(`delta ${absDelta.toFixed(2)} assignment risk`);
  } else if (absDelta >= 0.15 && absDelta <= 0.35) {
    score += 18;
    reasons.push('delta in conservative income band');
  } else if (absDelta < 0.08) {
    score -= 10;
    reasons.push(`delta low ${absDelta.toFixed(2)}`);
  }

  const eligible = Boolean(
    quote.right === 'call' &&
    dte >= DEFAULTS.minDte &&
    dte <= DEFAULTS.maxDte &&
    mark &&
    mark > 0 &&
    bid &&
    bid > 0 &&
    ask &&
    ask > 0 &&
    spreadPct !== null &&
    spreadPct <= DEFAULTS.maxSpreadPct &&
    otmPct >= DEFAULTS.minOtmPct &&
    (volume === null || volume >= DEFAULTS.minVolume) &&
    openInterest !== null &&
    openInterest >= DEFAULTS.minOpenInterest &&
    (absDelta === null || absDelta <= DEFAULTS.maxConservativeDelta)
  );

  return {
    ticker: quote.ticker,
    expiration: quote.expiration,
    dte,
    strike: quote.strike,
    bid,
    ask,
    mark,
    spreadPct,
    volume,
    openInterest,
    delta,
    theta,
    impliedVolatility,
    premiumPerContract: round(premiumPerContract),
    premiumYieldPct: round(premiumYieldPct),
    annualizedYieldPct: round(annualizedYieldPct),
    otmPct: round(otmPct),
    score: round(score),
    eligible,
    reasons
  };
}

export function rankCoveredCallCandidates(
  chain: IbkrOptionChainQuote[],
  stockPrice: number,
  now = new Date()
): CoveredCallCandidate[] {
  return chain
    .filter((quote) => quote.right === 'call' && Number.isFinite(quote.strike))
    .map((quote) => scoreCoveredCallCandidate(quote, stockPrice, now))
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      return b.score - a.score;
    });
}

export class CoveredCallService {
  constructor(
    private fastify: FastifyInstance,
    private ibkrMarketData = new IbkrMarketDataService(fastify),
    private aiService = new AIService(fastify)
  ) {}

  async searchSymbols(query: string): Promise<CoveredCallSymbolResult[]> {
    const cleaned = query.trim();
    if (cleaned.length < 1) return [];

    const result = await (yahooFinance as any).search(cleaned, { quotesCount: 8, newsCount: 0 });
    const quotes = Array.isArray(result?.quotes) ? result.quotes : [];
    return quotes
      .filter((quote: any) => {
        const type = String(quote.quoteType || '').toUpperCase();
        return quote.symbol && ['EQUITY', 'ETF'].includes(type);
      })
      .slice(0, 8)
      .map((quote: any) => ({
        symbol: String(quote.symbol).toUpperCase(),
        name: String(quote.shortname || quote.longname || quote.name || quote.symbol),
        exchange: quote.exchange || null,
        quoteType: quote.quoteType || null
      }));
  }

  async analyze(symbol: string, userId: number): Promise<CoveredCallAnalysis> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(normalizedSymbol)) {
      throw new Error('Enter a valid US stock or ETF ticker.');
    }

    const [quote, news, expirations] = await Promise.all([
      this.fetchStockQuote(normalizedSymbol),
      this.fetchNews(normalizedSymbol),
      this.ibkrMarketData.getOptionExpirations(normalizedSymbol)
    ]);

    const targetExpirations = expirations
      .filter((expiration) => {
        const dte = calculateDte(expiration);
        return dte >= DEFAULTS.minDte && dte <= DEFAULTS.maxDte;
      })
      .slice(0, DEFAULTS.maxExpirations);

    const chains = await Promise.all(targetExpirations.map((expiration) =>
      this.ibkrMarketData.getOptionChainSnapshot(userId, normalizedSymbol, expiration, 'call')
        .catch((err: any) => {
          this.fastify.log.warn(`[CoveredCallService] IBKR chain failed for ${normalizedSymbol} ${expiration}: ${err.message || String(err)}`);
          return [];
        })
    ));

    const combinedChain = chains.flat();
    const candidates = rankCoveredCallCandidates(combinedChain, quote.price).slice(0, 20);
    const best = candidates.find((candidate) => candidate.eligible) || null;
    const ai = await this.buildAiReview(normalizedSymbol, quote.price, candidates.slice(0, 8), news, userId, best);

    return {
      symbol: normalizedSymbol,
      generatedAt: new Date().toISOString(),
      profile: 'conservative',
      quote,
      scan: {
        minDte: DEFAULTS.minDte,
        maxDte: DEFAULTS.maxDte,
        expirationsChecked: targetExpirations,
        contractsReviewed: combinedChain.length
      },
      best,
      candidates,
      news,
      ai
    };
  }

  private async fetchStockQuote(symbol: string): Promise<CoveredCallAnalysis['quote']> {
    const quote = await (yahooFinance as any).quoteSummary(symbol, { modules: ['price'] });
    const price = toNumber(quote?.price?.regularMarketPrice ?? quote?.price?.postMarketPrice ?? quote?.price?.preMarketPrice);
    if (!price || price <= 0) {
      throw new Error(`No live stock price found for ${symbol}.`);
    }

    return {
      price: round(price),
      name: quote?.price?.shortName || quote?.price?.longName || null,
      currency: quote?.price?.currency || null,
      marketState: quote?.price?.marketState || null
    };
  }

  private async fetchNews(symbol: string): Promise<CoveredCallNewsItem[]> {
    try {
      const result = await (yahooFinance as any).search(symbol, { quotesCount: 0, newsCount: 6 });
      const news = Array.isArray(result?.news) ? result.news : [];
      return news.slice(0, 6).map((item: any) => ({
        title: String(item.title || '').slice(0, 180),
        publisher: item.publisher ? String(item.publisher) : null,
        link: item.link ? String(item.link) : null,
        publishedAt: item.providerPublishTime
          ? new Date(Number(item.providerPublishTime) * 1000).toISOString()
          : null
      })).filter((item: CoveredCallNewsItem) => item.title);
    } catch (err: any) {
      this.fastify.log.warn(`[CoveredCallService] News fetch failed for ${symbol}: ${err.message || String(err)}`);
      return [];
    }
  }

  private async buildAiReview(
    symbol: string,
    stockPrice: number,
    candidates: CoveredCallCandidate[],
    news: CoveredCallNewsItem[],
    userId: number,
    best: CoveredCallCandidate | null
  ): Promise<CoveredCallAnalysis['ai']> {
    if (candidates.length === 0) {
      return {
        summary: 'No covered-call candidates were found in the conservative 14-45 DTE window.',
        bestContractTicker: null,
        riskNotes: ['IBKR returned no usable call contracts for the selected window.'],
        incomeRationale: 'Wait for a liquid out-of-the-money contract before selling premium.',
        avoidIf: ['You do not own at least 100 shares per contract.'],
        fallback: true
      };
    }

    const fallback = {
      summary: best
        ? `${best.ticker} is the top deterministic match for conservative covered-call income.`
        : 'No candidate passed all conservative filters; review the ranked list before selling premium.',
      bestContractTicker: best?.ticker || null,
      riskNotes: best ? best.reasons.filter((reason) => /risk|wide|below|unavailable|thin|close/i.test(reason)).slice(0, 3) : ['No candidate passed every conservative filter.'],
      incomeRationale: best ? `It balances ${best.premiumYieldPct}% premium yield with ${best.otmPct}% upside cushion.` : 'The available premium does not clear the conservative liquidity and assignment-risk checks.',
      avoidIf: ['You do not own at least 100 shares per contract.', 'You are not willing to sell shares at the strike price.'],
      fallback: true
    };

    const prompt = `Analyze covered call candidates for ${symbol}.
Stock price: $${stockPrice}

Candidates:
${candidates.map((c) => `- ${c.ticker}: exp ${c.expiration}, strike ${c.strike}, mark ${c.mark}, bid/ask ${c.bid}/${c.ask}, delta ${c.delta}, OTM ${c.otmPct}%, yield ${c.premiumYieldPct}%, ann ${c.annualizedYieldPct}%, volume ${c.volume}, OI ${c.openInterest}, eligible ${c.eligible}, reasons ${c.reasons.join('; ')}`).join('\n')}

Recent news:
${news.length ? news.map((item) => `- ${item.title}`).join('\n') : '- No recent news found.'}

Task: Pick the best conservative covered-call candidate or say none pass. Do not suggest selling calls unless the investor owns 100 shares per contract.
Return JSON only:
{
  "summary": "one concise paragraph",
  "bestContractTicker": "ticker or null",
  "riskNotes": ["short note"],
  "incomeRationale": "why this premium is or is not worth it",
  "avoidIf": ["condition"]
}`;

    try {
      const parsed = await this.aiService.askTradingJSON(prompt, userId, 1000);
      return {
        summary: String(parsed.summary || parsed.analysis || fallback.summary).slice(0, 700),
        bestContractTicker: parsed.bestContractTicker ? String(parsed.bestContractTicker) : fallback.bestContractTicker,
        riskNotes: Array.isArray(parsed.riskNotes) ? parsed.riskNotes.map((item: any) => String(item)).slice(0, 5) : fallback.riskNotes,
        incomeRationale: String(parsed.incomeRationale || fallback.incomeRationale).slice(0, 500),
        avoidIf: Array.isArray(parsed.avoidIf) ? parsed.avoidIf.map((item: any) => String(item)).slice(0, 5) : fallback.avoidIf,
        fallback: false
      };
    } catch (err: any) {
      return {
        ...fallback,
        error: err.message || String(err)
      };
    }
  }
}
