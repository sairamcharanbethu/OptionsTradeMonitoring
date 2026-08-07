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
  Moon,
  PanelTop,
  ShieldCheck,
  Sun,
  Target,
  Trophy,
  UserRoundCog,
  WalletCards,
  Zap
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { User, api } from '@/lib/api';
import { useMarketStatus } from '@/hooks/useDashboardData';
import { useTheme } from './ThemeProvider';
import SettingsDialog from './SettingsDialog';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
      { label: 'Overview', description: 'Positions and account pulse', to: '/?tab=overview', icon: House },
      { label: 'Portfolio', description: 'Exposure and performance', to: '/?tab=portfolio', icon: BriefcaseBusiness },
      { label: 'Wealthsimple', description: 'Connected account holdings', to: '/?tab=wealthsimple', icon: Landmark },
      { label: 'Goals', description: 'Trading targets and progress', to: '/?tab=goals', icon: Trophy }
    ]
  },
  {
    label: 'Strategies',
    targets: [
      { label: 'Day Trading', description: 'Guarded strategy monitor', to: '/?tab=day-trading', icon: Gauge },
      { label: 'Wall Reaction', description: 'Paper-only wall fades', to: '/?tab=wall-reaction', icon: Target },
      { label: 'Covered Calls', description: 'Covered-call analysis', to: '/covered-calls', icon: ShieldCheck }
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
      { label: 'User Management', description: 'Manage application users', to: '/?tab=users', icon: UserRoundCog, adminOnly: true },
      ...((import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEV_TRADING_TESTS === 'true')
        ? [{ label: 'Live Exit Test', description: 'Development-only exit console', to: '/dev/live-exit-test', icon: FlaskConical }]
        : [])
    ]
  }
];

function normalizedDashboardTab(search: string) {
  return new URLSearchParams(search).get('tab') || 'overview';
}

function targetIsActive(target: NavTarget, pathname: string, search: string) {
  const targetUrl = new URL(target.to, window.location.origin);
  if (targetUrl.pathname === '/') {
    return pathname === '/' && normalizedDashboardTab(search) === normalizedDashboardTab(targetUrl.search);
  }
  if (targetUrl.pathname === '/trades') {
    return pathname === '/trades' || pathname.startsWith('/trades/') || pathname.startsWith('/positions/');
  }
  return pathname === targetUrl.pathname;
}

function currentPageTitle(pathname: string, search: string) {
  if (pathname === '/') {
    const tab = normalizedDashboardTab(search);
    const target = NAV_GROUPS.flatMap(group => group.targets).find(item => {
      const targetUrl = new URL(item.to, window.location.origin);
      return targetUrl.pathname === '/' && normalizedDashboardTab(targetUrl.search) === tab;
    });
    return target?.label || 'Overview';
  }
  if (pathname.startsWith('/trades/') && pathname.endsWith('/command')) return 'Trade Command';
  if (pathname.startsWith('/positions/')) return 'Position Details';
  if (pathname === '/dev/live-exit-test') return 'Live Exit Test';
  return NAV_GROUPS.flatMap(group => group.targets).find(item => pathname === new URL(item.to, window.location.origin).pathname)?.label || 'StrikePilot';
}

function GroupMenu({ group, pathname, search, user }: { group: NavGroup; pathname: string; search: string; user: User }) {
  const navigate = useNavigate();
  const targets = group.targets.filter(target => !target.adminOnly || user.role === 'ADMIN');
  const active = targets.some(target => targetIsActive(target, pathname, search));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            'h-9 gap-1.5 rounded-md px-3 text-[13px] font-semibold text-muted-foreground transition-colors',
            active && 'bg-foreground/[0.07] text-foreground dark:bg-white/[0.08]'
          )}
        >
          {group.label}
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 rounded-xl p-1.5">
        {targets.map(target => {
          const Icon = target.icon;
          const selected = targetIsActive(target, pathname, search);
          return (
            <DropdownMenuItem
              key={target.to}
              onSelect={() => navigate(target.to)}
              aria-current={selected ? 'page' : undefined}
              className={cn('items-start rounded-lg px-3 py-2.5', selected && 'bg-accent')}
            >
              <Icon className="mt-0.5 h-4 w-4 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{target.label}</span>
                <span className="block text-[11px] leading-4 text-muted-foreground">{target.description}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MobileMenu({ label, icon: Icon, targets, pathname, search }: {
  label: string;
  icon: LucideIcon;
  targets: NavTarget[];
  pathname: string;
  search: string;
}) {
  const navigate = useNavigate();
  const active = targets.some(target => targetIsActive(target, pathname, search));
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
          const selected = targetIsActive(target, pathname, search);
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
                <span className="block text-[11px] text-muted-foreground">{target.description}</span>
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
  const { theme, setTheme } = useTheme();
  const title = currentPageTitle(location.pathname, location.search);
  const strategyTargets = NAV_GROUPS.find(group => group.label === 'Strategies')!.targets;
  const calculatorTarget = NAV_GROUPS.find(group => group.label === 'Trade')!.targets.find(target => target.to === '/options-calculator')!;
  const moreTargets = [
    ...NAV_GROUPS
      .filter(group => ['Monitor', 'Insights', 'System'].includes(group.label))
      .flatMap(group => group.targets)
      .filter(target => target.to !== '/?tab=overview' && (!target.adminOnly || user.role === 'ADMIN')),
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
          <Link to="/?tab=overview" aria-label="StrikePilot home" className="motion-press flex min-h-11 min-w-0 items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-10">
            <img src="/strikepilot.svg" alt="" aria-hidden="true" className="h-8 w-8 shrink-0 rounded-[9px]" />
            <span className="min-w-0 leading-tight">
              <span className="hidden text-sm font-extrabold tracking-tight sm:block">StrikePilot</span>
              <span className="block max-w-[9rem] truncate text-sm font-semibold sm:hidden">{title}</span>
            </span>
          </Link>

          <nav className="hidden items-center gap-0.5 lg:flex" aria-label="Primary navigation">
            {NAV_GROUPS.map(group => <GroupMenu key={group.label} group={group} pathname={location.pathname} search={location.search} user={user} />)}
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <Link
              to="/system-health"
              className="motion-press flex h-11 items-center gap-2 rounded-lg px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-10 sm:px-3"
              aria-label={statusLabel}
            >
              <span className={cn(
                'h-2 w-2 rounded-full',
                marketStatusLoading ? 'animate-pulse bg-zinc-400' : marketStatusUnavailable ? 'bg-amber-500' : dataConnected ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-red-500'
              )} aria-hidden="true" />
              <span className="text-[10px] sm:text-xs md:hidden">{shortStatusLabel}</span>
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
                  <span className="block text-[11px] font-normal text-muted-foreground">{user.role}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as 'light' | 'dark' | 'system')}>
                  <DropdownMenuRadioItem value="light" className="rounded-lg py-2.5 pr-3"><Sun />Light appearance</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark" className="rounded-lg py-2.5 pr-3"><Moon />Dark appearance</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system" className="rounded-lg py-2.5 pr-3"><PanelTop />Use device setting</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => api.logout()} className="rounded-lg px-3 py-2.5 text-red-600 focus:text-red-600">
                  <LogOut />Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main id="main-content" className="app-shell-content pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-0">
        {children}
      </main>

      <nav className="mobile-bottom-nav lg:hidden" aria-label="Mobile navigation">
        <Link
          to={homeTarget.to}
          aria-current={targetIsActive(homeTarget, location.pathname, location.search) ? 'page' : undefined}
          className={cn('mobile-nav-item', targetIsActive(homeTarget, location.pathname, location.search) && 'mobile-nav-item-active')}
        >
          <House className="h-5 w-5" /><span>Home</span>
        </Link>
        <MobileMenu label="Strategies" icon={Target} targets={strategyTargets} pathname={location.pathname} search={location.search} />
        <Link to="/manual-entry" aria-current={location.pathname === '/manual-entry' ? 'page' : undefined} className={cn('mobile-nav-item', location.pathname === '/manual-entry' && 'mobile-nav-item-active')}>
          <WalletCards className="h-5 w-5" /><span>Trade</span>
        </Link>
        <Link
          to={positionsTarget.to}
          aria-current={targetIsActive(positionsTarget, location.pathname, location.search) ? 'page' : undefined}
          className={cn('mobile-nav-item', targetIsActive(positionsTarget, location.pathname, location.search) && 'mobile-nav-item-active')}
        >
          <ListChecks className="h-5 w-5" /><span>Positions</span>
        </Link>
        <MobileMenu label="More" icon={Menu} targets={moreTargets} pathname={location.pathname} search={location.search} />
      </nav>
    </div>
  );
}
