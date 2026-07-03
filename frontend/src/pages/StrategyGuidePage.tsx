import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, BadgeDollarSign, Clock3, Info, Layers, ShieldAlert, Target, Workflow } from 'lucide-react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';

function RuleCard({ title, detail, icon: Icon, children }: { title: string; detail: string; icon: any; children: ReactNode }) {
  return (
    <section className="rounded-md border border-border bg-card p-4 sm:p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="shrink-0 rounded-md border border-border bg-muted/40 p-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <h3 className="break-words font-semibold">{title}</h3>
          <p className="mt-1 break-words text-sm text-muted-foreground">{detail}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Example({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="break-words text-sm">{children}</div>
    </div>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2 text-sm text-muted-foreground">
      {items.map((item) => (
        <li key={item} className="flex gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
          <span className="min-w-0 break-words">{item}</span>
        </li>
      ))}
    </ul>
  );
}

export default function StrategyGuidePage() {
  return (
    <div className="mx-auto w-full max-w-[1300px] px-3 py-4 sm:w-[95%] sm:px-0">
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-start gap-3 sm:items-center">
          <Button asChild variant="ghost" size="icon" className="shrink-0 rounded-full">
            <Link to="/">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="break-words text-xl font-semibold tracking-tight">Strategy Guide</h2>
              <Badge variant="outline">Day Trading</Badge>
            </div>
            <p className="break-words text-sm text-muted-foreground">How the app enters trades, takes profit, trims, and protects downside.</p>
          </div>
        </div>
      </div>

      <div className="mb-5 rounded-md border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300">
        This page describes the app logic currently implemented in code. It is not financial advice and it does not change live settings or execution behavior.
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RuleCard title="Entry Strategy" detail="Only high-quality scanner setups should reach execution." icon={Workflow}>
          <BulletList
            items={[
              'The scanner now requires one strict setup model: Gamma/GEX direction, EMA stack, VWAP alignment, volume confirmation, and trigger confirmation.',
              'RSI, macro, mega-cap internals, and nearby levels remain context. They cannot override a missing core setup pillar.',
              'The app blocks duplicate entries for the same user, symbol, side, strike, and expiration while an OPEN or PENDING_ORDER position already exists.',
              'If an opposite-side position exists, the app tries to clean it up first. Broker-review exit states block the new entry until Wealthsimple status is verified.',
              'After 1:00 PM ET, the scanner selects 1DTE instead of 0DTE to reduce same-day expiry pressure. High-impact event days block 0DTE auto-entry.'
            ]}
          />
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Example title="CALL allowed">
              Gamma flow is bullish, SPY is above VWAP, price is above EMA9 and EMA9 is above EMA21, the confirmation candle is green on high volume, and price reclaims the trigger.
            </Example>
            <Example title="CALL skipped">
              SPY is oversold and near support, but price is still below VWAP, EMA9 is below EMA21, and the candle has not reclaimed the prior high.
            </Example>
          </div>
        </RuleCard>

        <RuleCard title="High-Probability Setup Model" detail="Every executable setup must pass the same core checklist." icon={Target}>
          <BulletList
            items={[
              'Gamma/GEX direction: CALL needs bullish flow or price above gamma flip; PUT needs bearish flow or price below gamma flip.',
              'EMA stack: CALL needs price > EMA9 > EMA21. PUT needs price < EMA9 < EMA21.',
              'VWAP alignment: CALL needs price above or reclaiming VWAP. PUT needs price below or rejecting VWAP.',
              'Volume confirmation: CALL needs a high-volume green candle. PUT needs a high-volume red candle.',
              'Trigger confirmation: CALL needs reclaim or break above the prior candle high. PUT needs breakdown or rejection below the prior candle low.'
            ]}
          />
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Example title="PUT allowed">
              Gamma flow is bearish, SPY is below VWAP, price is below EMA9 and EMA9 is below EMA21, the confirmation candle is red on high volume, and price breaks the trigger.
            </Example>
            <Example title="PUT skipped">
              Price is above VWAP and looks extended, but EMA9 is still above EMA21 or volume is average. The scanner records the context but blocks execution.
            </Example>
          </div>
        </RuleCard>

        <RuleCard title="Initial Risk Plan" detail="The app stores both premium-based and underlying-based guardrails." icon={ShieldAlert}>
          <BulletList
            items={[
              'On entry, the default premium stop is 20 percent below fill or mark. A $2.00 entry creates a $1.60 displayed stop.',
              'If take-profit percentage is configured, the app stores a premium take-profit trigger from the entry price.',
              'The signal also stores underlying stop and target levels, so the exit monitor can consider both option premium and underlying structure.',
              'Entry orders default to LIMIT when mark is available and order settings allow it; otherwise the app can use MARKET based on settings.'
            ]}
          />
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Example title="Premium stop">
              Entry $2.00, default stop $1.60. If the option bid/mark weakens into that area, stop logic starts evaluating confirmation.
            </Example>
            <Example title="Premium target">
              Entry $2.00 with a 40 percent TP setting creates a $2.80 take-profit trigger.
            </Example>
          </div>
        </RuleCard>

        <RuleCard title="Take Profit Logic" detail="The app tries to take profits without overpaying spread when it is near target." icon={Target}>
          <BulletList
            items={[
              'The sellable premium is used for TP decisions, not only the last traded price.',
              'At or past the TP premium, the app prefers MARKET exits so profit is not missed.',
              'Near TP means 95 percent or more of the configured TP. In that zone, the app can submit a LIMIT order at the TP price.',
              'If the exit spread is wide and price is below target, near-TP limit submission can be blocked until conditions improve.',
              'If TP is triggered by underlying structure instead of premium, the app uses a LIMIT order around current premium unless late-day exit rules force MARKET.'
            ]}
          />
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Example title="Past TP market">
              TP is $2.80 and sellable premium is $2.84. The app treats this as past target and submits a MARKET close or trim.
            </Example>
            <Example title="Near TP limit">
              TP is $2.80 and sellable premium is $2.67. Since $2.67 is at least 95 percent of $2.80, the app can place a LIMIT sell at $2.80.
            </Example>
          </div>
        </RuleCard>

        <RuleCard title="Profit Trimming" detail="Multi-contract winners can reduce risk before the final exit." icon={Layers}>
          <BulletList
            items={[
              'If quantity is greater than one and profit trim has not already completed, the first TAKE_PROFIT event trims about half the position.',
              'For 2 contracts, the first TP sells 1 contract. For 3 contracts, it sells 1 contract because the quantity is floored.',
              'After a confirmed trim fill, realized P&L is recorded, remaining quantity is reduced, take-profit trigger is cleared, and the stop is moved to at least breakeven.',
              'Once trim status is DONE, future TAKE_PROFIT events target the remaining position instead of repeatedly trimming.'
            ]}
          />
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Example title="Two contracts">
              Buy 2 at $2.00. First TP sells 1 at $2.80. Remaining 1 contract gets protected with a stop no lower than $2.00.
            </Example>
            <Example title="One contract">
              Buy 1 at $2.00. There is no partial trim; TP exits the whole position.
            </Example>
          </div>
        </RuleCard>

        <RuleCard title="Stop Loss Logic" detail="Stops are strict, but the app avoids reacting to one noisy soft-stop tick when possible." icon={ShieldAlert}>
          <BulletList
            items={[
              'The displayed premium stop is the soft stop. Example: $2.00 entry creates a $1.60 displayed stop.',
              'A hard stop also exists: max(entry * 65 percent, soft stop * 85 percent). For $2.00 entry and $1.60 stop, hard stop is $1.36.',
              'If premium hits the hard stop or the quote has no bid during risk conditions, the app treats it as an emergency stop.',
              'If premium only hits the soft stop, the app waits for confirmation: underlying structure break, two below-stop quotes, or about 10 seconds below stop.',
              'If premium recovers above the stop before confirmation, the stop warning is cleared.'
            ]}
          />
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Example title="Soft stop confirmation">
              Entry $2.00, stop $1.60, premium prints $1.58 once. The app arms the stop and waits for confirmation unless structure already broke.
            </Example>
            <Example title="Hard stop">
              Same trade, premium drops to $1.34. That is below the $1.36 hard stop, so the app exits without waiting for a second quote.
            </Example>
          </div>
        </RuleCard>

        <RuleCard title="Broker Safety" detail="Wealthsimple/SnapTrade status is reconciled before risky follow-up actions." icon={BadgeDollarSign}>
          <BulletList
            items={[
              'Open, pending entry, pending trim, pending exit, and EXIT_* states are reconciled against recent SnapTrade orders.',
              'Raw broker status can be misleading, so the app also infers fills from execution time, fill price, and filled quantity when available.',
              'Manual close and retry-close check Wealthsimple status before submitting another close order.',
              'Limit exits that remain pending too long can become EXIT_STALE, which requires broker verification before retry.',
              'The command center records order IDs, broker statuses, event history, and next action so behavior is explainable after the fact.'
            ]}
          />
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Example title="Retry blocked">
              An exit shows EXIT_REJECTED locally. The app syncs Wealthsimple first; if the broker actually filled it, the trade is closed instead of retrying.
            </Example>
            <Example title="Pending close">
              A SELL_TO_CLOSE order exists. The close button stays blocked while execution_status is PENDING_EXIT to avoid duplicate close requests.
            </Example>
          </div>
        </RuleCard>

        <RuleCard title="Late-Day Behavior" detail="The app reduces same-day expiry and liquidity risk later in the session." icon={Clock3}>
          <BulletList
            items={[
              'Entries after 1:00 PM ET use 1DTE instead of 0DTE.',
              'Late-day take-profit exits can prefer MARKET so the app is not waiting on a limit order as time decays.',
              'Near-target limit orders that sit too long can be marked stale, requiring broker review before another close attempt.'
            ]}
          />
          <div className="mt-4">
            <Example title="After 1 PM">
              A QQQ CALL scan at 1:15 PM ET chooses tomorrow expiration instead of today. A 10:30 AM scan can still choose same-day expiry.
            </Example>
          </div>
        </RuleCard>

        <RuleCard title="What To Watch" detail="These are the states that need user attention." icon={Info}>
          <BulletList
            items={[
              'System Degraded or broker sync errors on the System Health page.',
              'EXIT_STALE, EXIT_REJECTED, EXIT_FAILED, or repeated UNKNOWN broker statuses.',
              'Wide spread near take profit, because the app may wait instead of placing a low-quality exit.',
              'No-bid emergency stops, because option liquidity is deteriorating quickly.',
              'Command Center timelines with missing broker proof, especially for live Wealthsimple trades.'
            ]}
          />
        </RuleCard>
      </div>
    </div>
  );
}
