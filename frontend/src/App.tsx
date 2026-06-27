import { Suspense, lazy, useState, useEffect } from 'react';
import Auth from './components/Auth';
import { api, User } from './lib/api';
import { ThemeProvider } from './components/ThemeProvider';
import { ThemeToggle } from './components/ThemeToggle';
import { Button } from './components/ui/button';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Activity, BarChart3, FlaskConical, Info, ListChecks, LogOut, User as UserIcon, Loader2 } from 'lucide-react';

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

function RouteLoader() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
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
      <div className="min-h-screen flex items-center justify-center bg-background">
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
      <div className="min-h-screen bg-background text-foreground transition-colors duration-300">
        <div className="pt-4">
          <header className="sticky top-4 z-50 mx-auto max-w-[1600px] w-[95%] bg-background/70 dark:bg-zinc-950/70 backdrop-blur-md rounded-full border border-black/[0.03] dark:border-white/[0.06] shadow-sm px-6 py-3.5 flex justify-between items-center transition-premium">
            <div className="flex justify-between items-center w-full">
              <div className="flex items-center gap-2.5">
                <div className="h-8 w-8 bg-gradient-to-tr from-emerald-500 to-indigo-600 rounded-full flex items-center justify-center">
                  <span className="text-white font-extrabold italic text-xs tracking-tighter">SS</span>
                </div>
                <h1 className="text-sm sm:text-base font-extrabold tracking-tight text-foreground/90">SS Trading Platform</h1>
              </div>

              <div className="flex items-center gap-2">
                {devTradeTestsEnabled && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="rounded-full h-8 w-8 hover:bg-black/5 dark:hover:bg-white/5"
                    onClick={() => { window.location.href = '/dev/live-exit-test'; }}
                    title="Live Exit Test Console"
                  >
                    <FlaskConical className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="rounded-full h-8 w-8 hover:bg-black/5 dark:hover:bg-white/5"
                  onClick={() => { window.location.href = '/strategy-guide'; }}
                  title="Strategy Guide"
                >
                  <Info className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="rounded-full h-8 w-8 hover:bg-black/5 dark:hover:bg-white/5"
                  onClick={() => { window.location.href = '/system-health'; }}
                  title="System Health"
                >
                  <Activity className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="rounded-full h-8 w-8 hover:bg-black/5 dark:hover:bg-white/5"
                  onClick={() => { window.location.href = '/trade-intelligence'; }}
                  title="Trade Intelligence"
                >
                  <BarChart3 className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="rounded-full h-8 w-8 hover:bg-black/5 dark:hover:bg-white/5"
                  onClick={() => { window.location.href = '/trades'; }}
                  title="Wealthsimple Trades"
                >
                  <ListChecks className="h-3.5 w-3.5" />
                </Button>
                <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 bg-black/5 dark:bg-white/5 border border-black/[0.02] dark:border-white/[0.04] rounded-full text-[10px] font-bold uppercase tracking-wider">
                  <UserIcon className="h-2.5 w-2.5 text-muted-foreground" />
                  <span className="text-foreground/90">{user.username}</span>
                </div>
                <Button variant="ghost" size="icon" className="rounded-full h-8 w-8 hover:bg-black/5 dark:hover:bg-white/5" onClick={() => api.logout()} title="Sign Out">
                  <LogOut className="h-3.5 w-3.5" />
                </Button>
                <ThemeToggle />
              </div>
            </div>
          </header>
        </div>
        <main className="pt-2">
          <BrowserRouter>
            <Suspense fallback={<RouteLoader />}>
              <Routes>
                <Route path="/" element={<Dashboard user={user} onUserUpdate={setUser} />} />
                <Route path="/trades" element={<TradesPage />} />
                <Route path="/manual-entry" element={<ManualEntryPage />} />
                <Route path="/covered-calls" element={<CoveredCallsPage />} />
                <Route path="/trade-intelligence" element={<TradeIntelligencePage />} />
                <Route path="/trades/:id/command" element={<TradeCommandCenterPage />} />
                <Route path="/system-health" element={<SystemHealthPage />} />
                <Route path="/strategy-guide" element={<StrategyGuidePage />} />
                <Route path="/positions/:id" element={<PositionDetailsPage />} />
                <Route path="/dev/live-exit-test" element={<DevLiveExitTestPage />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
        </main>
      </div>
    </ThemeProvider>
  );
}

export default App;
