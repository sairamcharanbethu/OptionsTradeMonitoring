import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BadgeDollarSign, ExternalLink, Loader2, RefreshCw, Search, ShieldCheck, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, CoveredCallAnalysis, CoveredCallCandidate, CoveredCallSymbolResult } from '../lib/api';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

const currency = (value?: number | null) => {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '-';
  return `$${Number(value).toFixed(2)}`;
};

const pct = (value?: number | null) => {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '-';
  return `${Number(value).toFixed(2)}%`;
};

const compactNumber = (value?: number | null) => {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '-';
  return Number(value).toLocaleString();
};

const compactDate = (value?: string | null) => {
  if (!value) return '-';
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
      .toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-sm font-semibold">{value}</div>
    </div>
  );
}

function CandidateMetrics({ candidate }: { candidate: CoveredCallCandidate }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
      <Metric label="Strike" value={currency(candidate.strike)} />
      <Metric label="Premium" value={currency(candidate.premiumPerContract)} />
      <Metric label="Yield" value={pct(candidate.premiumYieldPct)} />
      <Metric label="Ann. Yield" value={pct(candidate.annualizedYieldPct)} />
      <Metric label="OTM" value={pct(candidate.otmPct)} />
      <Metric label="Delta" value={candidate.delta === null ? '-' : Number(candidate.delta).toFixed(2)} />
    </div>
  );
}

function CandidateTable({ candidates }: { candidates: CoveredCallCandidate[] }) {
  if (candidates.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        No call contracts returned for the conservative scan window.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Contract</TableHead>
          <TableHead>DTE</TableHead>
          <TableHead>Bid / Ask</TableHead>
          <TableHead>Yield</TableHead>
          <TableHead>OTM</TableHead>
          <TableHead>Liquidity</TableHead>
          <TableHead>Score</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {candidates.map((candidate) => (
          <TableRow key={candidate.ticker} className={candidate.eligible ? 'bg-emerald-500/5' : ''}>
            <TableCell>
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-semibold">{candidate.ticker}</span>
                  <Badge variant={candidate.eligible ? 'default' : 'outline'} className="h-5 text-[10px]">
                    {candidate.eligible ? 'FIT' : 'WATCH'}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground">
                  {compactDate(candidate.expiration)} {currency(candidate.strike)}C
                </div>
                <div className="max-w-[420px] text-[11px] text-muted-foreground">
                  {candidate.reasons.slice(0, 3).join(' / ')}
                </div>
              </div>
            </TableCell>
            <TableCell className="font-mono">{candidate.dte}</TableCell>
            <TableCell className="font-mono text-xs">
              {currency(candidate.bid)} / {currency(candidate.ask)}
              <div className="text-[11px] text-muted-foreground">Spread {pct(candidate.spreadPct)}</div>
            </TableCell>
            <TableCell className="font-mono text-xs">
              {pct(candidate.premiumYieldPct)}
              <div className="text-[11px] text-muted-foreground">{pct(candidate.annualizedYieldPct)} ann.</div>
            </TableCell>
            <TableCell className="font-mono">{pct(candidate.otmPct)}</TableCell>
            <TableCell className="font-mono text-xs">
              Vol {compactNumber(candidate.volume)}
              <div className="text-[11px] text-muted-foreground">OI {compactNumber(candidate.openInterest)}</div>
            </TableCell>
            <TableCell className="font-mono">{Number(candidate.score).toFixed(1)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function CoveredCallsPage() {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CoveredCallSymbolResult | null>(null);
  const [suggestions, setSuggestions] = useState<CoveredCallSymbolResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<CoveredCallAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canAnalyze = Boolean((selected?.symbol || query.trim()).trim()) && !analyzing;
  const topAlternatives = useMemo(() => analysis?.candidates.filter((candidate) => candidate.ticker !== analysis.best?.ticker) || [], [analysis]);

  useEffect(() => {
    const value = query.trim();
    if (value.length < 1) {
      setSuggestions([]);
      return;
    }
    if (selected?.symbol === value) {
      setSuggestions([]);
      setSearching(false);
      return;
    }

    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setSearching(true);
      try {
        const results = await api.searchCoveredCallSymbols(value);
        if (!cancelled) setSuggestions(results);
      } catch {
        if (!cancelled) setSuggestions([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query, selected]);

  const runAnalysis = async () => {
    const symbol = (selected?.symbol || query.trim()).toUpperCase();
    if (!symbol) return;
    setError(null);
    setAnalyzing(true);
    try {
      const result = await api.analyzeCoveredCalls(symbol);
      setAnalysis(result);
      setSelected({ symbol: result.symbol, name: result.quote.name || result.symbol });
      setQuery(result.symbol);
      setSuggestions([]);
    } catch (err: any) {
      setError(err.message || 'Failed to analyze covered calls');
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className="mx-auto w-[95%] max-w-[1500px] space-y-5 py-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <Link to="/">
            <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <BadgeDollarSign className="h-5 w-5 text-emerald-500" />
              <h1 className="text-2xl font-bold tracking-tight">Covered Calls</h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Research only. Selling one covered call requires 100 shares of the underlying stock.
            </p>
          </div>
        </div>
        {analysis && (
          <div className="text-xs text-muted-foreground">
            Updated {new Date(analysis.generatedAt).toLocaleString()}
          </div>
        )}
      </div>

      <Card className="rounded-md">
        <CardContent className="p-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value.toUpperCase());
                  setSelected(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && canAnalyze) runAnalysis();
                }}
                placeholder="Search US ticker"
                className="h-10 pl-9 font-mono uppercase"
              />
              {(searching || suggestions.length > 0) && (
                <div className="absolute z-20 mt-2 max-h-72 w-full overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg">
                  {searching && (
                    <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching
                    </div>
                  )}
                  {!searching && suggestions.map((item) => (
                    <button
                      type="button"
                      key={`${item.symbol}-${item.exchange || ''}`}
                      className="flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left text-sm hover:bg-muted"
                      onClick={() => {
                        setSelected(item);
                        setQuery(item.symbol);
                        setSuggestions([]);
                      }}
                    >
                      <span>
                        <span className="font-mono font-semibold">{item.symbol}</span>
                        <span className="ml-2 text-muted-foreground">{item.name}</span>
                      </span>
                      <span className="shrink-0 text-[10px] uppercase text-muted-foreground">{item.exchange || item.quoteType || ''}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button onClick={runAnalysis} disabled={!canAnalyze} className="h-10 min-w-[140px]">
              {analyzing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Analyze
            </Button>
          </div>
          {selected && (
            <div className="mt-3 text-xs text-muted-foreground">
              Selected <span className="font-mono font-semibold text-foreground">{selected.symbol}</span> - {selected.name}
            </div>
          )}
          {error && (
            <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
              {error}
            </div>
          )}
        </CardContent>
      </Card>

      {!analysis && (
        <div className="rounded-md border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          Search a ticker to scan conservative 14-45 DTE call premium.
        </div>
      )}

      {analysis && (
        <div className="space-y-5">
          <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <Card className="rounded-md">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center justify-between gap-3 text-base">
                  <span>{analysis.symbol} Best Fit</span>
                  <Badge variant={analysis.best ? 'default' : 'outline'}>{analysis.best ? 'Candidate Found' : 'No Fit'}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-2 sm:grid-cols-4">
                  <Metric label="Stock" value={currency(analysis.quote.price)} />
                  <Metric label="Window" value={`${analysis.scan.minDte}-${analysis.scan.maxDte} DTE`} />
                  <Metric label="Expirations" value={String(analysis.scan.expirationsChecked.length)} />
                  <Metric label="Contracts" value={String(analysis.scan.contractsReviewed)} />
                </div>
                {analysis.best ? (
                  <>
                    <div>
                      <div className="font-mono text-lg font-bold">{analysis.best.ticker}</div>
                      <div className="text-sm text-muted-foreground">
                        {compactDate(analysis.best.expiration)} expiration, {analysis.best.dte} DTE
                      </div>
                    </div>
                    <CandidateMetrics candidate={analysis.best} />
                    <div className="flex flex-wrap gap-2">
                      {analysis.best.reasons.slice(0, 6).map((reason) => (
                        <Badge key={reason} variant="outline" className="text-[10px]">{reason}</Badge>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-200">
                    No contract passed all conservative liquidity, spread, OTM, and assignment-risk filters.
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="rounded-md">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="h-4 w-4 text-amber-500" /> AI Review
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {analysis.ai.fallback && (
                  <Badge variant="outline" className="border-amber-500/50 text-amber-600">Deterministic fallback</Badge>
                )}
                <p className="leading-relaxed">{analysis.ai.summary}</p>
                <div className="rounded-md border border-border/70 bg-background/70 p-3">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Income rationale</div>
                  <p className="text-sm">{analysis.ai.incomeRationale}</p>
                </div>
                <div className="space-y-2">
                  {analysis.ai.riskNotes.map((note) => (
                    <div key={note} className="flex gap-2 text-xs text-muted-foreground">
                      <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                      <span>{note}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="rounded-md">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Ranked Calls</CardTitle>
            </CardHeader>
            <CardContent>
              <CandidateTable candidates={analysis.best ? [analysis.best, ...topAlternatives] : analysis.candidates} />
            </CardContent>
          </Card>

          <Card className="rounded-md">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Recent News</CardTitle>
            </CardHeader>
            <CardContent>
              {analysis.news.length === 0 ? (
                <div className="text-sm text-muted-foreground">No recent Yahoo Finance headlines returned.</div>
              ) : (
                <div className="grid gap-2 md:grid-cols-2">
                  {analysis.news.map((item) => (
                    <a
                      key={`${item.title}-${item.publishedAt || ''}`}
                      href={item.link || '#'}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md border border-border/70 bg-background/70 p-3 text-sm hover:bg-muted/50"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <span className="font-medium leading-snug">{item.title}</span>
                        {item.link && <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground">
                        {item.publisher || 'Yahoo Finance'} {item.publishedAt ? `- ${compactDate(item.publishedAt)}` : ''}
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
