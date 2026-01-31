import { useState, useEffect } from 'react';
import Dashboard from './components/Dashboard';
import Auth from './components/Auth';
import { api, User } from './lib/api';
import { ThemeProvider } from './components/ThemeProvider';
import { ThemeToggle } from './components/ThemeToggle';
import { Button } from './components/ui/button';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { LogOut, User as UserIcon, Loader2 } from 'lucide-react';
import PositionDetailsPage from './pages/PositionDetailsPage';

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

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
        <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="container mx-auto px-4 py-4 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 bg-primary rounded-lg flex items-center justify-center">
                <span className="text-primary-foreground font-bold italic">SS</span>
              </div>
              <h1 className="text-xl font-bold tracking-tight">Options Monitor</h1>
            </div>

            <div className="flex items-center gap-3">
              <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-muted rounded-full text-xs font-medium">
                <UserIcon className="h-3 w-3" />
                <span>{user.username}</span>
              </div>
              <Button variant="ghost" size="icon" className="rounded-full" onClick={() => api.logout()} title="Sign Out">
                <LogOut className="h-4 w-4" />
              </Button>
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<Dashboard user={user} onUserUpdate={setUser} />} />
              <Route path="/positions/:id" element={<PositionDetailsPage />} />
            </Routes>
          </BrowserRouter>
        </main>
      </div>
    </ThemeProvider>
  );
}

export default App;
