import { Moon, Sun, Laptop } from "lucide-react"
import { useTheme } from "./ThemeProvider"
import { Button } from "./ui/button"

export function ThemeToggle() {
    const { theme, setTheme } = useTheme()

    return (
        <div className="flex items-center gap-1 rounded-full border bg-muted p-1">
            <Button
                variant={theme === "light" ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8 rounded-full"
                onClick={() => setTheme("light")}
                title="Light Mode"
            >
                <Sun className="h-4 w-4" />
                <span className="sr-only">Light</span>
            </Button>
            <Button
                variant={theme === "dark" ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8 rounded-full"
                onClick={() => setTheme("dark")}
                title="Dark Mode"
            >
                <Moon className="h-4 w-4" />
                <span className="sr-only">Dark</span>
            </Button>
            <Button
                variant={theme === "system" ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8 rounded-full"
                onClick={() => setTheme("system")}
                title="System Preference"
            >
                <Laptop className="h-4 w-4" />
                <span className="sr-only">System</span>
            </Button>
        </div>
    )
}
