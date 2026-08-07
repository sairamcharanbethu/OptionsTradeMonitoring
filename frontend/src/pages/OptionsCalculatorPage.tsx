import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Calculator, CircleAlert, RotateCcw, ShieldCheck, TrendingUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import {
  calculateOptionsPlan,
  DEFAULT_OPTIONS_CALCULATOR_INPUTS,
  normalizeCalculatorInputs,
  OPTIONS_CALCULATOR_STORAGE_KEY,
  type OptionsCalculatorInputs,
  type OptionType,
  type TrailingType
} from '@/lib/options-calculator';

const money = (value: number, digits = 2) => value.toLocaleString('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: digits,
  maximumFractionDigits: digits
});
const signedMoney = (value: number) => `${value >= 0 ? '+' : '−'}${money(Math.abs(value))}`;
const signedPercent = (value: number) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}%`;
const premium = (value: number) => money(value, 3);

type NumericField = Exclude<keyof OptionsCalculatorInputs, 'optionType' | 'trailingType'>;

function NumberField({
  id,
  label,
  value,
  onChange,
  affix,
  min,
  max,
  step = '0.01',
  hint,
  error
}: {
  id: NumericField;
  label: string;
  value: string;
  onChange: (field: NumericField, value: string) => void;
  affix?: string;
  min?: number;
  max?: number;
  step?: string;
  hint?: string;
  error?: string;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={id} className="text-xs font-semibold text-foreground/80">{label}</Label>
      <div className="relative">
        <Input
          id={id}
          name={id}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={event => onChange(id, event.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          className={cn(
            'h-12 rounded-xl bg-background/60 pr-12 font-mono tabular-nums focus-visible:ring-1',
            error && 'border-red-500/70 focus-visible:ring-red-500'
          )}
        />
        {affix && <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 font-mono text-[11px] text-muted-foreground">{affix}</span>}
      </div>
      {error
        ? <p id={`${id}-error`} className="text-[11px] leading-4 text-red-600 dark:text-red-400">{error}</p>
        : hint && <p id={`${id}-hint`} className="text-[11px] leading-4 text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: T;
  options: { label: string; value: T }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-xs font-semibold text-foreground/80">{label}</legend>
      <div className="grid grid-cols-2 gap-1 rounded-xl border bg-background/60 p-1">
        {options.map(option => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              'min-h-10 rounded-lg px-3 text-xs font-semibold text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              value === option.value && 'bg-foreground text-background shadow-sm'
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function InputSection({ index, title, description, children }: {
  index: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="double-bezel-shell">
      <section className="double-bezel-core p-5 sm:p-6">
        <div className="mb-6 flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground/[0.05] font-mono text-[11px] font-bold text-emerald-600 dark:text-emerald-400">{index}</span>
          <div>
            <h2 className="text-base font-semibold tracking-tight">{title}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        {children}
      </section>
    </div>
  );
}

function MetricCard({ label, detail, value, subvalue, tone = 'neutral', className }: {
  label: string;
  detail: string;
  value: string;
  subvalue: string;
  tone?: 'neutral' | 'positive' | 'negative';
  className?: string;
}) {
  return (
    <article className={cn('rounded-2xl border bg-card/70 p-5 shadow-sm', className)}>
      <div className="mb-6 flex items-center justify-between gap-3 text-[10px] font-bold uppercase tracking-[0.13em] text-muted-foreground">
        <span>{label}</span><span className="text-right">{detail}</span>
      </div>
      <div className={cn(
        'font-mono text-2xl font-semibold tracking-[-0.055em] sm:text-3xl',
        tone === 'positive' && 'text-emerald-600 dark:text-emerald-400',
        tone === 'negative' && 'text-red-600 dark:text-red-400'
      )}>{value}</div>
      <div className={cn(
        'mt-2 text-xs text-muted-foreground',
        tone === 'positive' && 'text-emerald-600/80 dark:text-emerald-400/80',
        tone === 'negative' && 'text-red-600/80 dark:text-red-400/80'
      )}>{subvalue}</div>
    </article>
  );
}

export default function OptionsCalculatorPage() {
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const [inputs, setInputs] = useState<OptionsCalculatorInputs>(() => {
    try {
      return normalizeCalculatorInputs(JSON.parse(localStorage.getItem(OPTIONS_CALCULATOR_STORAGE_KEY) || 'null'));
    } catch {
      return DEFAULT_OPTIONS_CALCULATOR_INPUTS;
    }
  });
  const result = useMemo(() => calculateOptionsPlan(inputs), [inputs]);
  const firstErrors = useMemo(() => new Map(result.errors.map(error => [error.field, error.message])), [result.errors]);

  useEffect(() => {
    try {
      localStorage.setItem(OPTIONS_CALCULATOR_STORAGE_KEY, JSON.stringify(inputs));
    } catch {
      // The calculator remains usable when browser storage is unavailable.
    }
  }, [inputs]);

  const updateNumber = (field: NumericField, value: string) => setInputs(current => ({ ...current, [field]: value }));
  const setOptionType = (optionType: OptionType) => setInputs(current => ({ ...current, optionType }));
  const setTrailingType = (trailingType: TrailingType) => setInputs(current => ({ ...current, trailingType }));
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (result.errors.length) errorSummaryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const riskDetail = result.protectedProfit > 0
    ? `${money(result.protectedProfit)} profit protected`
    : `${result.plannedLossPercent.toFixed(2)}% of account`;
  const targetSentence = result.profitTarget === null
    ? 'No profit target is currently defined.'
    : `The ${money(result.profitTarget)} target estimates ${signedMoney(result.targetProfit || 0)} of P&L.`;
  const riskSentence = result.protectedProfit > 0
    ? `The manual stop protects approximately ${money(result.protectedProfit)} of profit before execution differences.`
    : `Planned loss is ${money(result.plannedLoss)}, or ${result.plannedLossPercent.toFixed(2)}% of the account.`;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-3 py-6 sm:px-5 sm:py-8 xl:px-8">
      <header className="mb-7 grid gap-5 border-b pb-7 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.42fr)] lg:items-end">
        <div>
          <Badge variant="outline" className="mb-4 gap-2 border-emerald-500/20 bg-emerald-500/[0.06] text-[10px] uppercase tracking-[0.15em] text-emerald-700 dark:text-emerald-300">
            <Calculator className="h-3.5 w-3.5" /> Local planning only
          </Badge>
          <h1 className="max-w-3xl text-3xl font-semibold tracking-[-0.045em] sm:text-4xl lg:text-5xl">Options risk, made tangible.</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
            Plan a long call or put before the order—premium exposure, protected exits, trailing-stop behavior, spread quality, and account-level risk in one view.
          </p>
        </div>
        <div className="border-l pl-4 text-xs leading-5 text-muted-foreground">
          <div className="mb-1 font-semibold uppercase tracking-[0.12em] text-foreground">Planning mode</div>
          Nothing here connects to a broker or submits an order. Values remain in this browser and calculations update as you type.
        </div>
      </header>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(410px,0.78fr)_minmax(0,1.22fr)]">
        <form onSubmit={handleSubmit} noValidate className="grid min-w-0 gap-4">
          <InputSection index="01" title="Entry" description="Define the long option position.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <SegmentedControl<OptionType>
                  label="Option type"
                  value={inputs.optionType}
                  options={[{ label: 'Call', value: 'CALL' }, { label: 'Put', value: 'PUT' }]}
                  onChange={setOptionType}
                />
              </div>
              <NumberField id="quantity" label="Contracts" value={inputs.quantity} onChange={updateNumber} min={1} max={10000} step="1" affix="×100" error={firstErrors.get('quantity')} />
              <NumberField id="entryPrice" label="Entry price" value={inputs.entryPrice} onChange={updateNumber} min={0.01} affix="$" error={firstErrors.get('entryPrice')} />
            </div>
          </InputSection>

          <InputSection index="02" title="Position & market" description="Use the latest option premium and quote.">
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField id="currentPrice" label="Current option price" value={inputs.currentPrice} onChange={updateNumber} min={0} affix="$" error={firstErrors.get('currentPrice')} />
              <NumberField id="highestPrice" label="Highest price since entry" value={inputs.highestPrice} onChange={updateNumber} min={0} affix="$" error={firstErrors.get('highestPrice')} />
              <NumberField id="currentBid" label="Current bid" value={inputs.currentBid} onChange={updateNumber} min={0} affix="$" error={firstErrors.get('currentBid')} />
              <NumberField id="currentAsk" label="Current ask" value={inputs.currentAsk} onChange={updateNumber} min={0} affix="$" error={firstErrors.get('currentAsk')} />
              <div className="sm:col-span-2">
                <Button type="button" variant="secondary" className="h-11 w-full rounded-xl sm:w-auto" onClick={() => updateNumber('highestPrice', inputs.currentPrice)}>
                  Use current price as high
                </Button>
                <p className="mt-2 text-[11px] text-muted-foreground">The high-water mark cannot be below the current option price.</p>
              </div>
            </div>
          </InputSection>

          <InputSection index="03" title="Trailing stop" description="Model the trigger and limit offset.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <SegmentedControl<TrailingType>
                  label="Trailing stop type"
                  value={inputs.trailingType}
                  options={[{ label: 'Dollar', value: 'DOLLAR' }, { label: 'Percentage', value: 'PERCENT' }]}
                  onChange={setTrailingType}
                />
              </div>
              <NumberField id="trailingAmount" label="Trailing amount" value={inputs.trailingAmount} onChange={updateNumber} min={0.01} max={inputs.trailingType === 'PERCENT' ? 100 : undefined} affix={inputs.trailingType === 'PERCENT' ? '%' : '$'} error={firstErrors.get('trailingAmount')} />
              <NumberField id="limitOffset" label="Stop-limit offset" value={inputs.limitOffset} onChange={updateNumber} min={0} affix="$" error={firstErrors.get('limitOffset')} />
            </div>
          </InputSection>

          <InputSection index="04" title="Risk & target" description="Set the loss budget and planned reward.">
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField id="manualStop" label="Manual stop-loss price" value={inputs.manualStop} onChange={updateNumber} min={0} affix="$" hint="Leave blank to model full premium loss." error={firstErrors.get('manualStop')} />
              <NumberField id="profitTarget" label="Profit target price" value={inputs.profitTarget} onChange={updateNumber} min={0} affix="$" error={firstErrors.get('profitTarget')} />
              <NumberField id="accountSize" label="Account size" value={inputs.accountSize} onChange={updateNumber} min={1} step="100" affix="$" error={firstErrors.get('accountSize')} />
              <NumberField id="maxRiskPercent" label="Maximum risk per trade" value={inputs.maxRiskPercent} onChange={updateNumber} min={0.01} max={100} step="0.1" affix="%" error={firstErrors.get('maxRiskPercent')} />
            </div>
            <div className="mt-6 grid gap-2">
              <Button type="submit" className="h-12 rounded-xl">
                Calculate <ArrowUpRight className="ml-2 h-4 w-4" />
              </Button>
              <Button type="button" variant="outline" className="h-11 rounded-xl" onClick={() => setInputs(DEFAULT_OPTIONS_CALCULATOR_INPUTS)}>
                <RotateCcw className="mr-2 h-4 w-4" /> Reset
              </Button>
            </div>
          </InputSection>
        </form>

        <section aria-label="Calculated trade plan" className="grid min-w-0 gap-4">
          {result.errors.length > 0 && (
            <div ref={errorSummaryRef} role="alert" aria-live="polite" className="rounded-2xl border border-red-500/25 bg-red-500/[0.06] p-4 text-sm text-red-700 dark:text-red-300">
              <div className="flex items-center gap-2 font-semibold"><CircleAlert className="h-4 w-4" /> Review {result.errors.length} input{result.errors.length === 1 ? '' : 's'}</div>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">{result.errors.map(error => <li key={`${error.field}-${error.message}`}>{error.message}</li>)}</ul>
            </div>
          )}

          <div className="double-bezel-shell">
            <div className="grid gap-3 p-1 sm:grid-cols-2 lg:grid-cols-12">
              <MetricCard className="lg:col-span-7" label="Position" detail={`Long ${inputs.optionType.toLowerCase()}`} value={money(result.totalCost)} subvalue={`${money(result.currentValue)} current market value`} />
              <MetricCard className="lg:col-span-5" label="Open P&L" detail="Mark based" value={signedMoney(result.currentPnl)} subvalue={signedPercent(result.currentPnlPercent)} tone={result.currentPnl >= 0 ? 'positive' : 'negative'} />
              <MetricCard className="lg:col-span-4" label="Planned risk" detail={result.protectedProfit > 0 ? 'Protected' : 'Manual stop'} value={money(result.plannedLoss)} subvalue={riskDetail} />
              <MetricCard className="lg:col-span-4" label="Trailing stop" detail={inputs.trailingType === 'PERCENT' ? `${result.trailingAmount}%` : money(result.trailingAmount)} value={premium(result.trailingTrigger)} subvalue={`${premium(result.trailingLimit)} estimated limit`} />
              <MetricCard className="lg:col-span-4" label="Profit target" detail={result.protectedProfit > 0 ? 'Profit protected' : result.riskReward === null ? '—' : `${result.riskReward.toFixed(2)} : 1`} value={result.targetProfit === null ? '—' : signedMoney(result.targetProfit)} subvalue="Estimated target P&L" tone={result.targetProfit === null ? 'neutral' : result.targetProfit >= 0 ? 'positive' : 'negative'} />
            </div>
          </div>

          <div className="double-bezel-shell">
            <section className="double-bezel-core p-5 sm:p-6">
              <div className="mb-5 flex items-center gap-3">
                <ShieldCheck className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                <div><h2 className="font-semibold">Position details</h2><p className="text-xs text-muted-foreground">Execution-aware planning metrics.</p></div>
              </div>
              <div className="grid overflow-hidden rounded-xl border bg-border sm:grid-cols-2">
                {[
                  ['Stop-limit P&L', signedMoney(result.stopPnl), result.stopPnl],
                  ['Allowed account risk', money(result.allowedRisk), null],
                  ['Bid / ask spread', money(result.spreadDollars), null],
                  ['Spread percentage', `${result.spreadPercent.toFixed(2)}%`, null]
                ].map(([label, value, tone]) => (
                  <div key={String(label)} className="bg-background p-4">
                    <div className="text-[11px] text-muted-foreground">{label}</div>
                    <div className={cn('mt-1 font-mono text-sm font-semibold', typeof tone === 'number' && (tone >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'))}>{value}</div>
                  </div>
                ))}
              </div>
              <div className={cn(
                'mt-3 rounded-xl px-4 py-3 text-xs font-medium',
                result.riskWithinBudget ? 'bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300' : 'bg-red-500/[0.08] text-red-700 dark:text-red-300'
              )}>
                {result.riskWithinBudget ? `Planned risk is within the ${money(result.allowedRisk)} budget.` : `Planned risk is ${money(result.plannedLoss - result.allowedRisk)} over the configured budget.`}
              </div>
            </section>
          </div>

          <div className="double-bezel-shell">
            <section className="double-bezel-core p-5 sm:p-6">
              <div className="mb-5 flex items-center gap-3">
                <TrendingUp className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                <div><h2 className="font-semibold">Trailing Stop Planner</h2><p className="text-xs text-muted-foreground">Suggestions anchored to the {premium(result.highestPrice)} high-water mark.</p></div>
              </div>
              <div className="overflow-hidden rounded-xl border">
                <table className="w-full table-fixed text-right text-[11px] sm:text-xs">
                  <thead className="bg-muted/40 text-[9px] uppercase tracking-[0.08em] text-muted-foreground sm:text-[10px]">
                    <tr><th className="px-2 py-3 text-left sm:px-4">Trail</th><th className="px-2 py-3 sm:px-4">Amount</th><th className="px-2 py-3 sm:px-4">Trigger</th><th className="px-2 py-3 sm:px-4">P&L</th></tr>
                  </thead>
                  <tbody>{result.planner.map(row => (
                    <tr key={row.percent} className="border-t">
                      <td className="px-2 py-3 text-left font-mono font-semibold sm:px-4">{row.percent}%</td>
                      <td className="px-2 py-3 font-mono sm:px-4">{premium(row.amount)}</td>
                      <td className="px-2 py-3 font-mono sm:px-4">{premium(row.trigger)}</td>
                      <td className={cn('px-2 py-3 font-mono font-semibold sm:px-4', row.pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{signedMoney(row.pnl)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </section>
          </div>

          <div className="double-bezel-shell">
            <section className="double-bezel-core p-5 sm:p-6">
              <h2 className="font-semibold">Trade Plan</h2>
              <p className="mt-4 text-sm leading-7 text-foreground/80">
                You bought {result.quantity} contract{result.quantity === 1 ? '' : 's'} of a long {inputs.optionType.toLowerCase()} at {money(result.entryPrice)} for a total cost of {money(result.totalCost)}. The option is currently {money(result.currentPrice)}. A {inputs.trailingType === 'PERCENT' ? `${result.trailingAmount}%` : money(result.trailingAmount)} trailing stop from a {money(result.highestPrice)} high would trigger around {premium(result.trailingTrigger)}. With a {money(result.limitOffset)} limit offset, the approximate limit price would be {premium(result.trailingLimit)}. {riskSentence} {targetSentence}
              </p>
              <div className="mt-5 flex gap-3 rounded-xl bg-amber-500/[0.08] p-4 text-xs leading-5 text-amber-800 dark:text-amber-200">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>A stop trigger does not guarantee execution at the trigger or limit price. Fast option-price movement, low liquidity, and wide spreads can cause delayed, partial, or no execution.</span>
              </div>
            </section>
          </div>
        </section>
      </div>

      <footer className="mx-auto max-w-4xl px-4 pb-2 pt-8 text-center text-[11px] leading-5 text-muted-foreground">
        For planning and educational purposes only—not investment advice. Option contracts can lose their entire premium. Stop and limit orders may execute differently during volatile or illiquid markets.
      </footer>
    </div>
  );
}
