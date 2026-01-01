import Dashboard from './components/Dashboard';
import { ThemeProvider } from './components/ThemeProvider';
import { ThemeToggle } from './components/ThemeToggle';

function App() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="options-trade-ui-theme">
      <div className="min-h-screen bg-background text-foreground transition-colors duration-300">
        <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="container mx-auto px-4 py-4 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 bg-primary rounded-lg flex items-center justify-center">
                <span className="text-primary-foreground font-bold italic">SS</span>
              </div>
              <h1 className="text-xl font-bold tracking-tight">Options Trading</h1>
            </div>
            <ThemeToggle />
          </div>
        </header>
        <main>
          <Dashboard />
        </main>
      </div>
    </ThemeProvider>
  )
}

export default App
