import { Suspense, lazy, useState, useEffect } from 'react';
import Auth from './components/Auth';
import { api, User } from './lib/api';
import { BrowserRouter, Link, Routes, Route } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import AppShell from './components/AppShell';
import { Button } from './components/ui/button';

const Dashboard = lazy(() => import('./components/Dashboard'));
const PositionDetailsPage = lazy(() => import('./pages/PositionDetailsPage'));
const DevLiveExitTestPage = lazy(() => import('./pages/DevLiveExitTestPage'));
const TradesPage = lazy(() => import('./pages/TradesPage'));
const SystemHealthPage = lazy(() => import('./pages/SystemHealthPage'));
const TradeCommandCenterPage = lazy(() => import('./pages/TradeCommandCenterPage'));
const StrategyGuidePage = lazy(() => import('./pages/StrategyGuidePage'));
const TradeIntelligencePage = lazy(() => import('./pages/TradeIntelligencePage'));
const ManualEntryPage = lazy(() => import('./pages/ManualEntryPage'));
const OptionsCalculatorPage = lazy(() => import('./pages/OptionsCalculatorPage'));
const ResearchPage = lazy(() => import('./pages/ResearchPage'));

// Dashboard sections are real routes now, not ?tab= query params, so browser
// back behaves the same everywhere in the app.
const DASHBOARD_ROUTES = [
  'overview', 'portfolio', 'wealthsimple', 'goals',
  'day-trading', 'position-monitor', 'paper-accounts', 'users'
] as const;

function RouteLoader() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

function NotFoundPage() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center px-6 text-center">
      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Page not found</div>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight">This route is not available.</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Use the navigation to continue, or return to your account overview.</p>
      <Button asChild className="mt-5 h-11 px-5">
        <Link to="/overview">Return to overview</Link>
      </Button>
    </div>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authDegraded, setAuthDegraded] = useState(false);
  const devTradeTestsEnabled = import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEV_TRADING_TESTS === 'true';

  useEffect(() => {
    async function initAuth() {
      if (api.isAuthenticated()) {
        try {
          const userData = await api.getMe();
          setUser(userData);
        } catch (err: any) {
          const status = Number(err?.status);
          if (status === 401 || status === 403) {
            api.logout();
          } else {
            console.error('Session check failed; keeping the session and retrying:', err);
            try {
              const retried = await api.getMe();
              setUser(retried);
            } catch (retryErr: any) {
              if (Number(retryErr?.status) === 401 || Number(retryErr?.status) === 403) api.logout();
              else setAuthDegraded(true);
            }
          }
        }
      }
      setLoading(false);
    }
    initAuth();
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user && authDegraded) {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <div className="text-2xs font-semibold uppercase tracking-[0.16em] text-sev-warn">Server unreachable</div>
        <h2 className="text-xl font-semibold tracking-tight">You are still signed in.</h2>
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
          StrikePilot could not reach the backend to confirm your session. Your sign-in has been kept.
          This is usually brief — retry once the service responds.
        </p>
        <Button className="mt-1 h-11 px-5" onClick={() => window.location.reload()}>Retry</Button>
      </div>
    );
  }

  if (!user) {
    return (
      <Auth onLogin={setUser} />
    );
  }

  return (
    <BrowserRouter>
      <AppShell user={user} onUserUpdate={setUser}>
          <Suspense fallback={<RouteLoader />}>
            <Routes>
              <Route path="/" element={<Dashboard user={user} />} />
              {DASHBOARD_ROUTES.map((tab) => (
                <Route key={tab} path={`/${tab}`} element={<Dashboard user={user} />} />
              ))}
              <Route path="/trades" element={<TradesPage user={user} />} />
              <Route path="/manual-entry" element={<ManualEntryPage />} />
              <Route path="/options-calculator" element={<OptionsCalculatorPage />} />
              <Route path="/trade-intelligence" element={<TradeIntelligencePage />} />
              <Route path="/research" element={<ResearchPage />} />
              <Route path="/trades/:id/command" element={<TradeCommandCenterPage />} />
              <Route path="/system-health" element={<SystemHealthPage />} />
              <Route path="/strategy-guide" element={<StrategyGuidePage />} />
              <Route path="/positions/:id" element={<PositionDetailsPage />} />
              {devTradeTestsEnabled && <Route path="/dev/live-exit-test" element={<DevLiveExitTestPage />} />}
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
      </AppShell>
    </BrowserRouter>
  );
}

export default App;
