import cron from 'node-cron';
import { FastifyInstance } from 'fastify';
import { SWING_EXPECTATIONS } from '../config/swing-expectations';
import { PAPER_SWING_VARIANT_NAMES } from '../config/paper-variants';
import { SHARED_PAPER_ACCOUNT_ID } from './paper-account-constants';
import { DiscordAlertService } from './discord-alert-service';

export type LaneWeekStats = {
  lane: string;
  label: string;
  automationStatus: string;
  week: { closed: number; wins: number; realizedPnl: number; profitFactor: number | null };
  cumulative: {
    closed: number; wins: number; winRate: number | null; realizedPnl: number; profitFactor: number | null; expectancy: number | null; openTrades: number;
  };
  rolling30: { closed: number; wins: number; profitFactor: number | null; avgPnl: number | null; stopShare: number | null };
  drawdown: { fromPeak: number; peak: number };
  benchmark: { winRateZ: number | null; avgPnlDelta: number | null };
  milestone: 'NOISE' | 'PRELIMINARY' | 'DECISION';
  breaches: string[];
};

export type WeeklyParityReport = {
  weekEnding: string;
  generatedAt: string;
  benchmark: { trades: number; winRate: number; avgPnlPerTrade: number; profitFactor: number; window: { start: string; end: string } };
  lanes: LaneWeekStats[];
  liveLane: Omit<LaneWeekStats, 'label' | 'automationStatus'> | null;
  breaches: Array<{ lane: string; rule: string; value: string }>;
};

export const KILL_RULES = {
  rollingWindow: 30,
  minTradesForPf: 30,
  pfFloor: 0.9,
  winRateZFloor: -2.0,
  drawdownLimitDollars: 1000,
  minTradesForExpectancy: 50,
  stopShareCeiling: 0.6
} as const;

const pf = (gains: number, losses: number): number | null => (losses > 0 ? Number((gains / losses).toFixed(2)) : gains > 0 ? 99.99 : null);

/**
 * Pure evaluation of the kill rules in docs/kill-criteria.md for one lane.
 * `closedTrades` must be ordered oldest -> newest.
 */
export function evaluateLane(closedTrades: Array<{ pnl: number; exitReason: string | null }>, openTrades: number, benchmark = SWING_EXPECTATIONS) {
  const closed = closedTrades.length;
  const wins = closedTrades.filter((t) => t.pnl > 0).length;
  const gains = closedTrades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const losses = Math.abs(closedTrades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const realized = Number((gains - losses).toFixed(2));
  const recent = closedTrades.slice(-KILL_RULES.rollingWindow);
  const rGains = recent.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const rLosses = Math.abs(recent.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const stopExits = recent.filter((t) => /PREMIUM_STOP$/.test(String(t.exitReason || ''))).length;
  let peak = 0; let equity = 0; let maxDd = 0;
  for (const t of closedTrades) { equity += t.pnl; peak = Math.max(peak, equity); maxDd = Math.max(maxDd, peak - equity); }
  const fromPeak = Number((peak - equity).toFixed(2));
  const p = benchmark.winRate;
  const winRateZ = closed >= KILL_RULES.minTradesForPf && p > 0 && p < 1
    ? Number((((wins / closed) - p) / Math.sqrt((p * (1 - p)) / closed)).toFixed(2))
    : null;
  const avgPnl = closed ? (gains - losses) / closed : null;
  const breaches: string[] = [];
  const rollingPf = pf(rGains, rLosses);
  if (recent.length >= KILL_RULES.minTradesForPf && rollingPf !== null && rollingPf < KILL_RULES.pfFloor) breaches.push('PF_BELOW_FLOOR');
  if (winRateZ !== null && winRateZ <= KILL_RULES.winRateZFloor) breaches.push('WIN_RATE_BELOW_BENCHMARK');
  if (fromPeak > KILL_RULES.drawdownLimitDollars) breaches.push('DRAWDOWN_LIMIT');
  if (closed >= KILL_RULES.minTradesForExpectancy && avgPnl !== null && avgPnl < 0) breaches.push('NEGATIVE_EXPECTANCY');
  if (recent.length >= KILL_RULES.minTradesForPf && stopExits / recent.length > KILL_RULES.stopShareCeiling) breaches.push('STOP_HEAVY');
  return {
    cumulative: {
      closed, wins, winRate: closed ? Number(((wins / closed) * 100).toFixed(1)) : null, realizedPnl: realized,
      profitFactor: pf(gains, losses), expectancy: avgPnl === null ? null : Number(avgPnl.toFixed(2)), openTrades
    },
    rolling30: {
      closed: recent.length, wins: recent.filter((t) => t.pnl > 0).length, profitFactor: rollingPf,
      avgPnl: recent.length ? Number(((rGains - rLosses) / recent.length).toFixed(2)) : null,
      stopShare: recent.length ? Number((stopExits / recent.length).toFixed(2)) : null
    },
    drawdown: { fromPeak, peak: Number(peak.toFixed(2)), maxDrawdown: Number(maxDd.toFixed(2)) },
    benchmark: { winRateZ, avgPnlDelta: avgPnl === null ? null : Number((avgPnl - benchmark.avgPnlPerTrade).toFixed(2)) },
    milestone: (closed >= 100 ? 'DECISION' : closed >= 30 ? 'PRELIMINARY' : 'NOISE') as LaneWeekStats['milestone'],
    breaches
  };
}

/**
 * Friday 16:45 ET: per-lane paper results (and the live lane when it has
 * trades) against the backtest benchmark and the kill rules, stored in
 * weekly_parity_reports and posted to Discord. This is the forward
 * out-of-sample tracker: it answers "is the system doing what the backtest
 * said" with numbers, every week, without anyone running a script.
 */
export class WeeklyParityReportService {
  private started = false;
  private task: any = null;
  public now: () => Date = () => new Date();

  constructor(private fastify: FastifyInstance) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    const schedule = process.env.WEEKLY_PARITY_REPORT_SCHEDULE || '45 16 * * 5';
    this.task = cron.schedule(schedule, () => {
      this.generate().catch((err: any) => this.fastify.log.warn(`[WeeklyParity] report failed: ${err?.message || String(err)}`));
    }, { timezone: 'America/New_York' });
    this.fastify.log.info(`[WeeklyParity] scheduled (${schedule} America/New_York)`);
  }

  stop(): void {
    this.task?.stop?.();
    this.task = null;
  }

  /** ISO date (ET) of the Friday that ends the week containing `now`. */
  weekEnding(now: Date = this.now()): string {
    const et = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(now);
    const get = (type: string) => et.find((p) => p.type === type)?.value || '';
    const dateKey = `${get('year')}-${get('month')}-${get('day')}`;
    const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    const base = new Date(`${dateKey}T12:00:00Z`);
    const offset = weekdayIndex <= 5 ? 5 - weekdayIndex : 6; // Sat -> next Fri
    base.setUTCDate(base.getUTCDate() + offset);
    return base.toISOString().slice(0, 10);
  }

  async generate(options: { weekEnding?: string; post?: boolean } = {}): Promise<WeeklyParityReport> {
    const pg = (this.fastify as any).pg;
    const weekEnding = options.weekEnding || this.weekEnding();
    const weekStart = new Date(`${weekEnding}T00:00:00Z`); weekStart.setUTCDate(weekStart.getUTCDate() - 6);
    const weekStartKey = weekStart.toISOString().slice(0, 10);

    const { rows: controls } = await pg.query(`SELECT strategy_name, automation_status FROM paper_strategy_controls WHERE strategy_name = ANY($1::text[]) ORDER BY strategy_name`, [[...PAPER_SWING_VARIANT_NAMES]]);
    const { rows: closedRows } = await pg.query(
      `SELECT paper_strategy AS lane, realized_pnl, exit_reason, updated_at
         FROM positions
        WHERE paper_account_id=$1 AND paper_strategy = ANY($2::text[]) AND status='CLOSED'
        ORDER BY updated_at ASC, id ASC`,
      [SHARED_PAPER_ACCOUNT_ID, [...PAPER_SWING_VARIANT_NAMES]]
    );
    const { rows: openRows } = await pg.query(
      `SELECT paper_strategy AS lane, COUNT(*)::int AS n FROM positions WHERE paper_account_id=$1 AND paper_strategy = ANY($2::text[]) AND status='OPEN' GROUP BY 1`,
      [SHARED_PAPER_ACCOUNT_ID, [...PAPER_SWING_VARIANT_NAMES]]
    );
    const openByLane = new Map<string, number>(openRows.map((r: any) => [r.lane, Number(r.n)]));
    const { PAPER_SWING_VARIANTS } = await import('../config/paper-variants');

    const lanes: LaneWeekStats[] = controls.map((control: any) => {
      const laneClosed = closedRows.filter((r: any) => r.lane === control.strategy_name).map((r: any) => ({ pnl: Number(r.realized_pnl || 0), exitReason: r.exit_reason, at: String(r.updated_at) }));
      const evaluated = evaluateLane(laneClosed, openByLane.get(control.strategy_name) || 0);
      const weekTrades = laneClosed.filter((t: any) => t.at.slice(0, 10) >= weekStartKey && t.at.slice(0, 10) <= weekEnding);
      const wGains = weekTrades.filter((t: any) => t.pnl > 0).reduce((s: number, t: any) => s + t.pnl, 0);
      const wLosses = Math.abs(weekTrades.filter((t: any) => t.pnl <= 0).reduce((s: number, t: any) => s + t.pnl, 0));
      return {
        lane: control.strategy_name,
        label: PAPER_SWING_VARIANTS.find((v) => v.name === control.strategy_name)?.label || control.strategy_name,
        automationStatus: control.automation_status,
        week: { closed: weekTrades.length, wins: weekTrades.filter((t: any) => t.pnl > 0).length, realizedPnl: Number((wGains - wLosses).toFixed(2)), profitFactor: pf(wGains, wLosses) },
        ...evaluated
      };
    });

    // Live lane (all users' real swing positions), when any exist.
    const { rows: liveRows } = await pg.query(
      `SELECT realized_pnl, exit_reason FROM positions
        WHERE execution_broker='wealthsimple_snaptrade' AND COALESCE(is_simulated,FALSE)=FALSE AND strategy_managed=TRUE AND status='CLOSED'
        ORDER BY updated_at ASC, id ASC`
    ).catch(() => ({ rows: [] }));
    const { rows: liveOpen } = await pg.query(
      `SELECT COUNT(*)::int AS n FROM positions WHERE execution_broker='wealthsimple_snaptrade' AND COALESCE(is_simulated,FALSE)=FALSE AND strategy_managed=TRUE AND status='OPEN'`
    ).catch(() => ({ rows: [{ n: 0 }] }));
    const liveLane = liveRows.length > 0
      ? { lane: 'LIVE', week: { closed: 0, wins: 0, realizedPnl: 0, profitFactor: null }, ...evaluateLane(liveRows.map((r: any) => ({ pnl: Number(r.realized_pnl || 0), exitReason: r.exit_reason })), Number(liveOpen[0]?.n || 0)) }
      : null;

    const breaches = [
      ...lanes.flatMap((lane) => lane.breaches.map((rule) => ({ lane: lane.lane, rule, value: this.describeBreach(lane, rule) }))),
      ...(liveLane ? liveLane.breaches.map((rule) => ({ lane: 'LIVE', rule, value: this.describeBreach(liveLane as any, rule) })) : [])
    ];
    const report: WeeklyParityReport = {
      weekEnding,
      generatedAt: this.now().toISOString(),
      benchmark: { trades: SWING_EXPECTATIONS.trades, winRate: SWING_EXPECTATIONS.winRate, avgPnlPerTrade: SWING_EXPECTATIONS.avgPnlPerTrade, profitFactor: SWING_EXPECTATIONS.profitFactor, window: SWING_EXPECTATIONS.window },
      lanes,
      liveLane: liveLane as any,
      breaches
    };

    const inserted = await pg.query(
      `INSERT INTO weekly_parity_reports (week_ending, report) VALUES ($1, $2)
       ON CONFLICT (week_ending) DO UPDATE SET report = EXCLUDED.report, generated_at = NOW()
       RETURNING id, discord_sent_at`,
      [weekEnding, JSON.stringify(report)]
    ).catch((err: any) => { this.fastify.log.warn(`[WeeklyParity] persist failed: ${err?.message || String(err)}`); return { rows: [] }; });
    if (options.post !== false) await this.post(report, inserted.rows?.[0]);
    return report;
  }

  private describeBreach(lane: { rolling30: any; benchmark: any; drawdown: any; cumulative: any }, rule: string): string {
    switch (rule) {
      case 'PF_BELOW_FLOOR': return `rolling PF ${lane.rolling30.profitFactor} over ${lane.rolling30.closed}`;
      case 'WIN_RATE_BELOW_BENCHMARK': return `win-rate z ${lane.benchmark.winRateZ}`;
      case 'DRAWDOWN_LIMIT': return `$${lane.drawdown.fromPeak} from peak`;
      case 'NEGATIVE_EXPECTANCY': return `$${lane.cumulative.expectancy}/trade over ${lane.cumulative.closed}`;
      case 'STOP_HEAVY': return `${Math.round((lane.rolling30.stopShare || 0) * 100)}% premium-stop exits`;
      default: return rule;
    }
  }

  formatDiscord(report: WeeklyParityReport): string {
    const lines = report.lanes.map((lane) => {
      const c = lane.cumulative;
      return `• ${lane.label}: wk ${lane.week.closed} closed ${lane.week.realizedPnl >= 0 ? '+' : ''}$${lane.week.realizedPnl.toFixed(0)} · all ${c.closed} closed, win ${c.winRate ?? '—'}%, PF ${c.profitFactor ?? '—'}, exp ${c.expectancy === null ? '—' : `$${c.expectancy}`}, DD $${lane.drawdown.fromPeak} [${lane.milestone}]${lane.breaches.length ? ` ⚠ ${lane.breaches.join(', ')}` : ''}`;
    });
    if (report.liveLane) {
      const c = report.liveLane.cumulative;
      lines.push(`• LIVE: ${c.closed} closed, win ${c.winRate ?? '—'}%, PF ${c.profitFactor ?? '—'}, exp ${c.expectancy === null ? '—' : `$${c.expectancy}`} [${report.liveLane.milestone}]${report.liveLane.breaches.length ? ` ⚠ ${report.liveLane.breaches.join(', ')}` : ''}`);
    }
    const b = report.benchmark;
    lines.push(`Benchmark (backtest ${b.window.start}→${b.window.end}, modelled premiums): ${b.trades} trades, win ${(b.winRate * 100).toFixed(0)}%, PF ${b.profitFactor}, exp $${b.avgPnlPerTrade}/trade.`);
    if (report.breaches.length) lines.push(`Kill-rule breaches: ${report.breaches.map((x) => `${x.lane} ${x.rule} (${x.value})`).join('; ')}. See docs/kill-criteria.md.`);
    return lines.join('\n');
  }

  private async post(report: WeeklyParityReport, row: any): Promise<void> {
    const pg = (this.fastify as any).pg;
    const admin = await pg.query(`SELECT id FROM users WHERE role='ADMIN' ORDER BY id LIMIT 1`).catch(() => ({ rows: [] }));
    const userId = Number(admin.rows?.[0]?.id || 0);
    const sent = await new DiscordAlertService(this.fastify).send({
      userId,
      title: `Weekly parity report — week ending ${report.weekEnding}`,
      message: this.formatDiscord(report),
      severity: report.breaches.length ? 'warning' : 'info',
      category: 'weekly-parity-report',
      dedupeKey: `weekly-parity:${report.weekEnding}`,
      dedupeSeconds: 6 * 24 * 3600
    }).catch(() => false);
    if (sent && row?.id) await pg.query(`UPDATE weekly_parity_reports SET discord_sent_at=NOW() WHERE id=$1`, [row.id]).catch(() => undefined);
  }

  async list(limit = 12): Promise<any[]> {
    const { rows } = await (this.fastify as any).pg.query(`SELECT id, week_ending, report, generated_at, discord_sent_at FROM weekly_parity_reports ORDER BY week_ending DESC LIMIT $1`, [limit]);
    return rows;
  }
}
