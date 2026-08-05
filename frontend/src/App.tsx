import { Suspense, lazy, useState, useEffect } from 'react';
import Auth from './components/Auth';
import { api, User } from './lib/api';
import { ThemeProvider } from './components/ThemeProvider';
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
const CoveredCallsPage = lazy(() => import('./pages/CoveredCallsPage'));
const ManualEntryPage = lazy(() => import('./pages/ManualEntryPage'));
const ResearchPage = lazy(() => import('./pages/ResearchPage'));

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
        <Link to="/?tab=overview">Return to overview</Link>
      </Button>
    </div>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const devTradeTestsEnabled = import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEV_TRADING_TESTS === 'true';

  useEffect(() => {
    async function initAuth() {
      if (api.isAuthenticated()) {
        try {
          const userData = await api.getMe();
          setUser(userData);
        } catch (err) {
          console.error('Session restoration failed:', err);
          api.logout();
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

  if (!user) {
    return (
      <ThemeProvider defaultTheme="system" storageKey="options-trade-ui-theme">
        <Auth onLogin={setUser} />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider defaultTheme="system" storageKey="options-trade-ui-theme">
      <BrowserRouter>
        <AppShell user={user} onUserUpdate={setUser}>
            <Suspense fallback={<RouteLoader />}>
              <Routes>
                <Route path="/" element={<Dashboard user={user} />} />
                <Route path="/trades" element={<TradesPage />} />
                <Route path="/manual-entry" element={<ManualEntryPage />} />
                <Route path="/covered-calls" element={<CoveredCallsPage />} />
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
    </ThemeProvider>
  );
}

export default App;
