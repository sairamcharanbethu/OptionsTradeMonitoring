import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  BarChart3,
  BookOpen,
  BriefcaseBusiness,
  Calculator,
  Check,
  ChevronDown,
  CircleUserRound,
  FlaskConical,
  Gauge,
  HeartPulse,
  House,
  Landmark,
  ListChecks,
  LogOut,
  Menu,
  Target,
  Trophy,
  UserRoundCog,
  WalletCards,
  Zap
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { User, api } from '@/lib/api';
import { useKillSwitch, useMarketStatus, useSettings } from '@/hooks/useDashboardData';
import { useRealtimeSync } from '@/hooks/useRealtimeSync';
import ActionBar from '@/components/ActionBar';
import SettingsDialog from './SettingsDialog';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from './ui/dropdown-menu';
import { cn } from '@/lib/utils';

type NavTarget = {
  label: string;
  description: string;
  to: string;
  icon: LucideIcon;
  adminOnly?: boolean;
};

type NavGroup = {
  label: string;
  targets: NavTarget[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Monitor',
    targets: [
      { label: 'Overview', description: 'Positions and account pulse', to: '/overview', icon: House },
      { label: 'Portfolio', description: 'Exposure and performance', to: '/portfolio', icon: BriefcaseBusiness },
      { label: 'Wealthsimple', description: 'Connected account holdings', to: '/wealthsimple', icon: Landmark },
    ]
  },
  {
    label: 'Strategies',
    targets: [
      { label: 'Day Trading', description: 'Guarded strategy monitor', to: '/day-trading', icon: Gauge },
      { label: 'Position Monitor', description: 'Take-profit target alerts', to: '/position-monitor', icon: Target },
      { label: 'Paper Account', description: 'Shared cash, orders, and P&L', to: '/paper-accounts', icon: WalletCards },
      { label: 'Goals', description: 'Trading targets and progress', to: '/goals', icon: Trophy }
    ]
  },
  {
    label: 'Trade',
    targets: [
      { label: 'Manual Entry', description: 'Controlled SnapTrade entry', to: '/manual-entry', icon: Zap },
      { label: 'Calculator', description: 'Plan option risk and exits', to: '/options-calculator', icon: Calculator },
      { label: 'Positions', description: 'Live and working orders', to: '/trades', icon: ListChecks }
    ]
  },
  {
    label: 'Insights',
    targets: [
      { label: 'Trade Intelligence', description: 'Execution outcomes', to: '/trade-intelligence', icon: BarChart3 },
      { label: 'Research', description: 'Strategy replay and evidence', to: '/research', icon: FlaskConical }
    ]
  },
  {
    label: 'System',
    targets: [
      { label: 'System Health', description: 'Runtime and provider status', to: '/system-health', icon: HeartPulse },
      { label: 'Strategy Guide', description: 'Rules and lifecycle guide', to: '/strategy-guide', icon: BookOpen },
      { label: 'User Management', description: 'Manage application users', to: '/users', icon: UserRoundCog, adminOnly: true },
      ...((import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEV_TRADING_TESTS === 'true')
        ? [{ label: 'Live Exit Test', description: 'Development-only exit console', to: '/dev/live-exit-test', icon: FlaskConical }]
        : [])
    ]
  }
];

// "/" renders the cockpit, so treat the bare root as /day-trading.
const ALL_TARGETS = NAV_GROUPS.flatMap(group => group.targets);

function targetIsActive(target: NavTarget, pathname: string) {
  const here = pathname === '/' ? '/day-trading' : pathname.replace(/\/+$/, '') || '/';
  if (target.to === '/trades') {
    return here === '/trades' || here.startsWith('/trades/') || here.startsWith('/positions/');
  }
  return here === target.to;
}

function currentPageTitle(pathname: string) {
  if (pathname.startsWith('/trades/') && pathname.endsWith('/command')) return 'Trade Command';
  if (pathname.startsWith('/positions/')) return 'Position Details';
  if (pathname === '/dev/live-exit-test') return 'Live Exit Test';
  return ALL_TARGETS.find(target => targetIsActive(target, pathname))?.label || 'StrikePilot';
}

// Flat primary navigation. Every destination used to sit two clicks deep
// inside one of five dropdowns; the six an operator actually reaches for
// during a session are now one click, and the rest live behind a single
// overflow menu rather than being scattered across five.
const PRIMARY_NAV: string[] = [
  '/day-trading',
  '/trades',
  '/overview',
  '/goals',
  '/trade-intelligence',
  '/system-health'
];

const PRIMARY_LABELS: Record<string, string> = {
  '/day-trading': 'Cockpit',
  '/trades': 'Positions',
  '/overview': 'Portfolio',
  '/goals': 'Goals',
  '/trade-intelligence': 'Insights',
  '/system-health': 'System'
};

function PrimaryLink({ target, pathname }: { target: NavTarget; pathname: string }) {
  const selected = targetIsActive(target, pathname);
  const Icon = target.icon;
  return (
    <Link
      to={target.to}
      aria-current={selected ? 'page' : undefined}
      title={target.description}
      className={cn(
        'motion-press flex h-9 items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected
          ? 'bg-foreground/[0.09] text-foreground'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
      )}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {PRIMARY_LABELS[target.to] || target.label}
    </Link>
  );
}

function OverflowMenu({ targets, pathname }: { targets: NavTarget[]; pathname: string }) {
  const navigate = useNavigate();
  const active = targets.some(target => targetIsActive(target, pathname));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            'h-9 gap-1.5 rounded-md px-3 text-xs font-semibold text-muted-foreground transition-colors',
            active && 'bg-foreground/[0.09] text-foreground'
          )}
        >
          More
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 rounded-lg p-1.5">
        {targets.map(target => {
          const Icon = target.icon;
          const selected = targetIsActive(target, pathname);
          return (
            <DropdownMenuItem
              key={target.to}
              onSelect={() => navigate(target.to)}
              aria-current={selected ? 'page' : undefined}
              className={cn('items-start rounded-md px-3 py-2.5', selected && 'bg-accent')}
            >
              <Icon className="mt-0.5 h-4 w-4 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{target.label}</span>
                <span className="block text-2xs leading-4 text-muted-foreground">{target.description}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MobileMenu({ label, icon: Icon, targets, pathname }: {
  label: string;
  icon: LucideIcon;
  targets: NavTarget[];
  pathname: string;
}) {
  const navigate = useNavigate();
  const active = targets.some(target => targetIsActive(target, pathname));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn('mobile-nav-item', active && 'mobile-nav-item-active')}
          aria-label={`Open ${label} navigation`}
          aria-current={active ? 'page' : undefined}
        >
          <Icon className="h-5 w-5" />
          <span>{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="center" sideOffset={12} className="max-h-[min(70dvh,32rem)] w-[min(20rem,calc(100vw-1.5rem))] overflow-y-auto overscroll-contain rounded-2xl p-2">
        <DropdownMenuLabel className="px-3 pb-2 text-xs text-muted-foreground">{label}</DropdownMenuLabel>
        {targets.map(target => {
          const TargetIcon = target.icon;
          const selected = targetIsActive(target, pathname);
          return (
            <DropdownMenuItem
              key={target.to}
              onSelect={() => navigate(target.to)}
              aria-current={selected ? 'page' : undefined}
              className={cn('rounded-xl px-3 py-3', selected && 'bg-accent')}
            >
              <TargetIcon className="h-5 w-5 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block font-medium">{target.label}</span>
                <span className="block text-2xs text-muted-foreground">{target.description}</span>
              </span>
              {selected && <Check className="ml-auto h-4 w-4 shrink-0" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function AppShell({ user, onUserUpdate, children }: {
  user: User;
  onUserUpdate: (user: User) => void;
  children: ReactNode;
}) {
  const location = useLocation();
  const { data: marketStatus, isError: marketStatusUnavailable, isLoading: marketStatusLoading } = useMarketStatus();
  const { data: killSwitch, isError: killSwitchUnavailable } = useKillSwitch(10000);
  const { data: shellSettings = {} } = useSettings();
  // Applies server pushes (strategy state, positions, kill switch, events) to the query caches app-wide.
  useRealtimeSync();
  // One glanceable truth on every page: is this system armed for real money?
  const liveConfigured = shellSettings.shadow_trading_enabled !== 'true'
    && shellSettings.execution_broker === 'wealthsimple_snaptrade'
    && shellSettings.snaptrade_auto_trade === 'true';
  const liveChip = killSwitchUnavailable
    ? { label: 'LIVE ?', className: 'border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-300', title: 'Kill-switch status unavailable' }
    : killSwitch?.live.disarmed
      ? { label: 'LIVE DISARMED', className: 'border-zinc-500/50 bg-zinc-500/10 text-zinc-500 dark:text-zinc-400', title: killSwitch.live.reason || 'Live trading manually disarmed' }
      : killSwitch?.live.halted
        ? { label: 'HALTED', className: 'border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-400', title: killSwitch.live.reason || 'Kill switch halted new entries' }
        : liveConfigured
          ? { label: 'LIVE ARMED', className: 'border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-300', title: 'Real-money execution is armed' }
          : { label: 'PAPER', className: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300', title: 'No live broker execution configured' };
  const title = currentPageTitle(location.pathname);
  const visibleTargets = ALL_TARGETS.filter(target => !target.adminOnly || user.role === 'ADMIN');
  const primaryTargets = PRIMARY_NAV
    .map(to => visibleTargets.find(target => target.to === to))
    .filter((target): target is NavTarget => Boolean(target));
  const overflowTargets = visibleTargets.filter(target => !PRIMARY_NAV.includes(target.to));
  const strategyTargets = NAV_GROUPS.find(group => group.label === 'Strategies')!.targets;
  const calculatorTarget = NAV_GROUPS.find(group => group.label === 'Trade')!.targets.find(target => target.to === '/options-calculator')!;
  const moreTargets = [
    ...NAV_GROUPS
      .filter(group => ['Monitor', 'Insights', 'System'].includes(group.label))
      .flatMap(group => group.targets)
      .filter(target => target.to !== '/overview' && (!target.adminOnly || user.role === 'ADMIN')),
    calculatorTarget
  ];
  const homeTarget = NAV_GROUPS[0].targets[0];
  const positionsTarget = NAV_GROUPS[2].targets.find(target => target.to === '/trades')!;
  const dataConnected = marketStatus?.connectionStatus === 'CONNECTED';
  const statusLabel = marketStatusLoading
    ? 'Checking status'
    : marketStatusUnavailable
      ? 'Status unavailable'
      : !dataConnected
        ? 'Data offline'
        : marketStatus?.open ? 'Market open' : 'Market closed';
  const shortStatusLabel = marketStatusLoading
    ? 'Checking'
    : marketStatusUnavailable
      ? 'Unavailable'
      : !dataConnected
        ? 'Offline'
        : marketStatus?.open ? 'Open' : 'Closed';

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <a href="#main-content" className="sr-only z-50 rounded-md bg-background px-4 py-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
        Skip to content
      </a>
      <header className="app-shell-header sticky top-0 z-40 border-b border-border/70 bg-background/90 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80">
        <div className="app-shell-header-inner mx-auto flex w-full max-w-[1600px] items-center gap-3">
          <Link to="/overview" aria-label="StrikePilot home" className="motion-press flex min-h-11 min-w-0 items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-10">
            <img src="/strikepilot.svg" alt="" aria-hidden="true" className="h-8 w-8 shrink-0 rounded-[9px]" />
            <span className="min-w-0 leading-tight">
              <span className="hidden text-sm font-extrabold tracking-tight sm:block">StrikePilot</span>
              <span className="block max-w-[9rem] truncate text-sm font-semibold sm:hidden">{title}</span>
            </span>
          </Link>

          <nav className="hidden items-center gap-0.5 lg:flex" aria-label="Primary navigation">
            {primaryTargets.map(target => <PrimaryLink key={target.to} target={target} pathname={location.pathname} />)}
            <OverflowMenu targets={overflowTargets} pathname={location.pathname} />
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <Link
              to="/day-trading"
              className={cn(
                'motion-press flex h-7 items-center rounded-full border px-2.5 text-2xs font-bold tracking-wide focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                liveChip.className
              )}
              title={liveChip.title}
              aria-label={`Live trading state: ${liveChip.label}. ${liveChip.title}`}
            >
              {liveChip.label}
            </Link>
            <Link
              to="/system-health"
              className="motion-press flex h-11 items-center gap-2 rounded-lg px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-10 sm:px-3"
              aria-label={statusLabel}
            >
              <span className={cn(
                'h-2 w-2 rounded-full',
                marketStatusLoading ? 'animate-pulse bg-zinc-400' : marketStatusUnavailable ? 'bg-amber-500' : dataConnected ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-red-500'
              )} aria-hidden="true" />
              <span className="text-2xs sm:text-xs md:hidden">{shortStatusLabel}</span>
              <span className="hidden md:inline">{statusLabel}</span>
            </Link>
            <SettingsDialog user={user} onUpdate={onUserUpdate} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-11 w-11 rounded-lg sm:h-10 sm:w-10" aria-label="Open account menu">
                  <CircleUserRound className="h-5 w-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 rounded-xl p-1.5">
                <DropdownMenuLabel className="px-3 py-2">
                  <span className="block text-sm font-semibold">{user.username}</span>
                  <span className="block text-2xs font-normal text-muted-foreground">{user.role}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => api.logout()} className="rounded-lg px-3 py-2.5 text-act-danger focus:text-act-danger">
                  <LogOut />Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      {/* Operator bar — exactly one instance, or Shift+D fires twice.
          On desktop these wrappers form a docked strip below the header, so
          the bar can never sit on top of a trade row the way the floating
          island did. On mobile they collapse to display:contents and the bar
          falls back to its own fixed position above the bottom nav, with
          <main> reserving matching space underneath. */}
      <div className="contents lg:sticky lg:top-[calc(3.5rem+env(safe-area-inset-top))] lg:z-30 lg:block lg:border-b lg:border-border/70 lg:bg-background/90 lg:backdrop-blur-xl">
        <div className="contents lg:mx-auto lg:flex lg:w-full lg:max-w-[1600px] lg:items-center lg:px-5 lg:py-2">
          <ActionBar user={user} />
        </div>
      </div>

      <main id="main-content" className="app-shell-content pb-[calc(9.5rem+env(safe-area-inset-bottom))] pt-3 lg:pb-10">
        {children}
      </main>

      <nav className="mobile-bottom-nav lg:hidden" aria-label="Mobile navigation">
        <Link
          to={homeTarget.to}
          aria-current={targetIsActive(homeTarget, location.pathname) ? 'page' : undefined}
          className={cn('mobile-nav-item', targetIsActive(homeTarget, location.pathname) && 'mobile-nav-item-active')}
        >
          <House className="h-5 w-5" /><span>Home</span>
        </Link>
        <MobileMenu label="Strategies" icon={Target} targets={strategyTargets} pathname={location.pathname} />
        <Link to="/manual-entry" aria-current={location.pathname === '/manual-entry' ? 'page' : undefined} className={cn('mobile-nav-item', location.pathname === '/manual-entry' && 'mobile-nav-item-active')}>
          <WalletCards className="h-5 w-5" /><span>Trade</span>
        </Link>
        <Link
          to={positionsTarget.to}
          aria-current={targetIsActive(positionsTarget, location.pathname) ? 'page' : undefined}
          className={cn('mobile-nav-item', targetIsActive(positionsTarget, location.pathname) && 'mobile-nav-item-active')}
        >
          <ListChecks className="h-5 w-5" /><span>Positions</span>
        </Link>
        <MobileMenu label="More" icon={Menu} targets={moreTargets} pathname={location.pathname} />
      </nav>
    </div>
  );
}
