import Dashboard from './components/Dashboard';

function App() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-xl font-bold tracking-tight">SS Options Trading</h1>
        </div>
      </header>
      <main>
        <Dashboard />
      </main>
    </div>
  )
}

export default App
