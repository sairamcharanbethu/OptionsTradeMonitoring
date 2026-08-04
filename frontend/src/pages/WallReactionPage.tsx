import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Clock3, Loader2, Pause, Play, RefreshCw, ShieldCheck, Target } from 'lucide-react';
import { api, User, WallReactionCandidate, WallReactionPaperSummary, WallReactionState } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

function value(value: unknown, digits = 2) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : '—';
}

function statusVariant(status?: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'CANDIDATE' || status === 'ARMED' || status === 'UP' || status === 'ACTIVE' || status === 'READY') return 'default';
  if (status === 'BLOCKED' || status === 'DEGRADED' || status === 'ERROR' || status === 'COVERAGE_MISSING') return 'destructive';
  return 'secondary';
}

function eventTime(timestamp?: string | null) {
  if (!timestamp) return 'No upcoming event in current coverage';
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return 'Invalid event timestamp';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  }).format(parsed);
}

function CandidateCard({ candidate, canManage, busy, onArm }: { candidate?: WallReactionCandidate; canManage: boolean; busy: boolean; onArm: (candidate: WallReactionCandidate) => void }) {
  if (!candidate) return <Card><CardContent className="py-8 text-sm text-muted-foreground">Waiting for provider data…</CardContent></Card>;
  const actionable = candidate.status === 'CANDIDATE' && Boolean(candidate.contract && candidate.plan);
  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b bg-muted/20 pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2"><CardTitle className="text-xl">{candidate.symbol}</CardTitle><Badge variant={statusVariant(candidate.status)}>{candidate.status}</Badge></div>
            <p className="mt-1 text-xs text-muted-foreground">{candidate.decision.code.replaceAll('_', ' ')}</p>
          </div>
          <div className="text-right"><div className="text-2xl font-semibold tabular-nums">${value(candidate.context?.spot)}</div><div className="text-xs text-muted-foreground">IBKR / ZeroGEX context</div></div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 pt-5">
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Metric label="Call wall" value={`$${value(candidate.context?.callWall)}`} />
          <Metric label="Put wall" value={`$${value(candidate.context?.putWall)}`} />
          <Metric label="Gamma flip" value={`$${value(candidate.context?.gammaFlip)}`} />
          <Metric label="MSI" value={value(candidate.context?.msi, 1)} />
        </div>

        <div className={`rounded-md border p-3 text-sm ${candidate.macro.blocked ? 'border-amber-500/40 bg-amber-500/10' : 'border-emerald-500/30 bg-emerald-500/5'}`}>
          <div className="flex items-center gap-2 font-medium">
            {candidate.macro.blocked ? <AlertTriangle className="h-4 w-4 text-amber-500" /> : <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
            Macro gate {candidate.macro.blocked ? 'closed' : 'clear'}
          </div>
          {candidate.macro.reason && <p className="mt-1 text-xs text-muted-foreground">{candidate.macro.reason}</p>}
        </div>

        {candidate.plan && candidate.contract ? (
          <>
            <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Invalidation" value={`$${value(candidate.plan.invalidation)}`} />
              <Metric label="Target 1" value={`$${value(candidate.plan.target1)}`} />
              <Metric label="Target 2" value={candidate.contract.quantity < 2 ? 'Not used (1 contract)' : candidate.plan.target2 === null ? 'Not available' : `$${value(candidate.plan.target2)}`} />
              <Metric label="Debit budget" value={money.format(candidate.plan.debitBudget)} />
            </div>
            <div className="rounded-lg border bg-muted/15 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-mono text-sm font-semibold">{candidate.contract.ticker}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{candidate.contract.quantity} contract{candidate.contract.quantity === 1 ? '' : 's'} · protected limit ${value(candidate.contract.protectedLimit)} · spread {value(candidate.contract.spreadPct)}%</div>
                </div>
                <Badge variant="outline">Δ {value(candidate.contract.delta)}</Badge>
              </div>
            </div>
          </>
        ) : (
          <div className="rounded-lg border border-dashed p-4">
            <div className="flex items-start gap-3"><Clock3 className="mt-0.5 h-4 w-4 text-muted-foreground" /><div><p className="text-sm font-medium">No paper entry is available</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{candidate.decision.action}</p></div></div>
          </div>
        )}

        {(candidate.decision.reasons.length > 0 || candidate.decision.warnings.length > 0) && (
          <details className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">Decision evidence</summary>
            <ul className="mt-2 list-disc space-y-1 pl-4">{[...candidate.decision.reasons, ...candidate.decision.warnings].map((reason, index) => <li key={`${reason}-${index}`}>{reason}</li>)}</ul>
          </details>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <p className="max-w-xl text-xs text-muted-foreground">Manual arm expires after five minutes. Fill-time gates and the protected price are checked again. This feature cannot place a live broker order.</p>
          {canManage ? <Button disabled={!actionable || busy} onClick={() => onArm(candidate)}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Arm paper entry</Button> : <Badge variant="secondary">Admin approval required</Badge>}
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value: metric }: { label: string; value: string }) {
  return <div><div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div><div className="mt-1 font-semibold tabular-nums">{metric}</div></div>;
}

export default function WallReactionPage({ user }: { user: User }) {
  const [state, setState] = useState<WallReactionState | null>(null);
  const [paper, setPaper] = useState<WallReactionPaperSummary | null>(null);
  const [journal, setJournal] = useState<Array<Record<string, any>>>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCandidate, setConfirmCandidate] = useState<WallReactionCandidate | null>(null);

  const load = useCallback(async (showLoader = false) => {
    if (showLoader) setLoading(true);
    try {
      const [nextState, nextPaper, nextJournal] = await Promise.all([api.getWallReaction(), api.getWallReactionPaperAccount(), api.getWallReactionJournal()]);
      setState(nextState); setPaper(nextPaper); setJournal(nextJournal.items); setError(null);
    } catch (requestError: any) { setError(requestError.message || 'Wall Reaction data is unavailable'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void load(true);
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const openPositions = useMemo(() => (paper?.positions || []).filter((position) => position.status === 'OPEN'), [paper]);

  async function act(key: string, action: () => Promise<any>) {
    setBusy(key); setError(null);
    try { await action(); await load(); }
    catch (actionError: any) { setError(actionError.message || 'Action failed'); }
    finally { setBusy(null); }
  }

  if (loading && !state) return <div className="rounded-lg border bg-card p-8 text-sm text-muted-foreground"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading Wall Reaction…</div>;

  return (
    <main className="mx-auto w-full max-w-[1440px] space-y-5" aria-live="polite">
      <div className="flex flex-col gap-4 rounded-xl border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2"><Target className="h-5 w-5 text-primary" /><h1 className="text-xl font-semibold">Wall Reaction</h1><Badge variant="outline" className="border-sky-500/40 text-sky-600">Paper only</Badge></div>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">A separately gated SPY/QQQ wall-fade workspace. It has its own candidates, manual approval, paper account, and ledger.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={statusVariant(state?.health.status)}><Activity className="mr-1 h-3 w-3" />Runtime {state?.health.status || 'unknown'}</Badge>
          <Badge variant={statusVariant(state?.calendar.status)}><Clock3 className="mr-1 h-3 w-3" />Calendar {state?.calendar.status || 'unknown'}</Badge>
          <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={loading}><RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</Button>
        </div>
      </div>

      {error && <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4" /><span>{error}</span></div>}

      {state?.calendar && (
        <div className={`flex flex-col gap-2 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between ${state.calendar.status === 'READY' ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/10'}`}>
          <div className="flex items-start gap-2">
            {state.calendar.status === 'READY' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />}
            <div><div className="font-medium">Official macro calendar · covered through {state.calendar.coverageThrough}</div><p className="mt-0.5 text-xs text-muted-foreground">BLS, BEA, Federal Reserve, and ISM · {state.calendar.eventCount} verified events</p>{state.calendar.lastError && <p className="mt-1 text-xs text-muted-foreground">Refresh note: {state.calendar.lastError}</p>}</div>
          </div>
          <div className="text-xs text-muted-foreground sm:text-right"><div className="font-medium text-foreground">Next: {state.calendar.nextEvent?.name || 'None scheduled'}</div><div>{eventTime(state.calendar.nextEvent?.scheduledAt)}</div></div>
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card><CardContent className="pt-5"><Metric label="Paper equity" value={paper ? money.format(Number(paper.account.equity)) : '—'} /></CardContent></Card>
        <Card><CardContent className="pt-5"><Metric label="Available cash" value={paper ? money.format(Number(paper.account.cash_balance) - Number(paper.account.reserved_cash)) : '—'} /></CardContent></Card>
        <Card><CardContent className="pt-5"><Metric label="Open positions" value={String(openPositions.length)} /></CardContent></Card>
        <Card><CardContent className="flex items-center justify-between gap-3 pt-5"><Metric label="Paper automation" value={paper?.account.automation_status || '—'} />{user.role === 'ADMIN' && paper && <Button variant="outline" size="icon" title={paper.account.automation_status === 'ACTIVE' ? 'Pause paper entries' : 'Resume paper entries'} onClick={() => void act('automation', () => api.setWallReactionPaperAutomation(paper.account.automation_status !== 'ACTIVE'))} disabled={busy !== null}>{paper.account.automation_status === 'ACTIVE' ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</Button>}</CardContent></Card>
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        {(['SPY', 'QQQ'] as const).map((symbol) => <CandidateCard key={symbol} candidate={state?.symbols[symbol]} canManage={user.role === 'ADMIN'} busy={busy === `arm:${symbol}`} onArm={setConfirmCandidate} />)}
      </section>

      <Card>
        <CardHeader><CardTitle className="text-base">Open Wall Reaction positions</CardTitle></CardHeader>
        <CardContent>
          {openPositions.length === 0 ? <div className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">No open positions in this paper account.</div> : (
            <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Contract</TableHead><TableHead>Entry</TableHead><TableHead>Bid</TableHead><TableHead>Qty</TableHead><TableHead>Invalidation</TableHead><TableHead>T1 / T2</TableHead><TableHead className="text-right">Action</TableHead></TableRow></TableHeader><TableBody>
              {openPositions.map((position) => <TableRow key={position.id}><TableCell><div className="font-medium">{position.symbol} {position.option_type} {value(position.strike_price)}</div><div className="text-xs text-muted-foreground">{String(position.expiration_date).slice(0, 10)}</div></TableCell><TableCell>${value(position.entry_price)}</TableCell><TableCell>${value(position.current_price)}</TableCell><TableCell>{position.quantity}</TableCell><TableCell>${value(position.suggested_stop_loss)}</TableCell><TableCell>${value(position.suggested_take_profit_1)} / {position.suggested_take_profit_2 ? `$${value(position.suggested_take_profit_2)}` : '—'}</TableCell><TableCell className="text-right">{user.role === 'ADMIN' && <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => { if (window.confirm('Close this paper position at a fresh IBKR bid?')) void act(`close:${position.id}`, () => api.closeWallReactionPosition(position.id)); }}>Close paper</Button>}</TableCell></TableRow>)}
            </TableBody></Table></div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" /><CardTitle className="text-base">Paper ledger</CardTitle></div></CardHeader>
        <CardContent>{journal.length === 0 ? <p className="text-sm text-muted-foreground">No Wall Reaction ledger events yet.</p> : <div className="space-y-2">{journal.slice(0, 12).map((item) => <div key={item.id} className="flex flex-col gap-1 rounded-md border px-3 py-2 sm:flex-row sm:items-start sm:justify-between"><div><div className="text-sm font-medium">{String(item.event_type).replaceAll('_', ' ')}</div><p className="text-xs text-muted-foreground">{item.message}</p></div><time className="shrink-0 text-xs text-muted-foreground">{new Date(item.created_at).toLocaleString()}</time></div>)}</div>}</CardContent>
      </Card>

      <Dialog open={Boolean(confirmCandidate)} onOpenChange={(open) => { if (!open) setConfirmCandidate(null); }}>
        <DialogContent><DialogHeader><DialogTitle>Arm paper entry?</DialogTitle><DialogDescription>This authorizes only the displayed Wall Reaction paper candidate for five minutes. The backend will recheck freshness, macro, wall return, contract, cash, and protected price. No live broker order can be sent.</DialogDescription></DialogHeader>
          {confirmCandidate && <div className="rounded-md border bg-muted/20 p-3 text-sm"><div className="font-semibold">{confirmCandidate.symbol} · {confirmCandidate.contract?.ticker}</div><div className="mt-1 text-muted-foreground">Up to {confirmCandidate.contract?.quantity} contract(s) at ${value(confirmCandidate.contract?.protectedLimit)}</div></div>}
          <DialogFooter><Button variant="outline" onClick={() => setConfirmCandidate(null)}>Cancel</Button><Button onClick={() => { const candidate = confirmCandidate; if (!candidate) return; setConfirmCandidate(null); void act(`arm:${candidate.symbol}`, () => api.armWallReactionCandidate(candidate.id)); }}>Arm paper entry</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
