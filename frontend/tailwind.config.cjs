/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
	],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1600px",
      },
    },
    extend: {
      fontFamily: {
        sans: ['Plus Jakarta Sans', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SF Mono', 'SFMono-Regular', 'JetBrains Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      // Type scale. 12px is the floor — nothing in a screen you stare at for
      // six hours should be smaller. Hierarchy below 14px is carried by
      // weight and colour, not by shaving pixels off the size.
      fontSize: {
        '2xs': ['0.75rem', { lineHeight: '1rem' }],       // 12 — labels, chips
        xs: ['0.8125rem', { lineHeight: '1.125rem' }],    // 13 — dense values
        sm: ['0.875rem', { lineHeight: '1.25rem' }],      // 14 — body
        base: ['1rem', { lineHeight: '1.5rem' }],         // 16
        lg: ['1.125rem', { lineHeight: '1.625rem' }],     // 18
        xl: ['1.25rem', { lineHeight: '1.75rem' }],       // 20 — key figures
        '2xl': ['1.5rem', { lineHeight: '1.875rem' }],    // 24
        '3xl': ['1.875rem', { lineHeight: '2.25rem' }],   // 30 — hero number
        '4xl': ['2.25rem', { lineHeight: '2.5rem' }],     // 36
        '5xl': ['3rem', { lineHeight: '1.1' }],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },

        // Money direction. Bare numerals only — never a chip, never a button.
        pnl: {
          up: "hsl(var(--pnl-up) / <alpha-value>)",
          "up-soft": "hsl(var(--pnl-up-soft) / <alpha-value>)",
          down: "hsl(var(--pnl-down) / <alpha-value>)",
          "down-soft": "hsl(var(--pnl-down-soft) / <alpha-value>)",
          flat: "hsl(var(--pnl-flat) / <alpha-value>)",
          "flat-soft": "hsl(var(--pnl-flat-soft) / <alpha-value>)",
        },

        // System severity. Always a chip. A healthy system is deliberately
        // quiet: sev-ok is neutral text, not green.
        sev: {
          ok: "hsl(var(--sev-ok) / <alpha-value>)",
          "ok-dot": "hsl(var(--sev-ok-dot) / <alpha-value>)",
          "ok-soft": "hsl(var(--sev-ok-soft) / <alpha-value>)",
          info: "hsl(var(--sev-info) / <alpha-value>)",
          "info-soft": "hsl(var(--sev-info-soft) / <alpha-value>)",
          warn: "hsl(var(--sev-warn) / <alpha-value>)",
          "warn-soft": "hsl(var(--sev-warn-soft) / <alpha-value>)",
          critical: "hsl(var(--sev-critical) / <alpha-value>)",
          "critical-soft": "hsl(var(--sev-critical-soft) / <alpha-value>)",
        },

        // Things you can press. Always a 40px control with an icon.
        act: {
          primary: "hsl(var(--act-primary) / <alpha-value>)",
          "primary-fg": "hsl(var(--act-primary-fg) / <alpha-value>)",
          danger: "hsl(var(--act-danger) / <alpha-value>)",
          "danger-fg": "hsl(var(--act-danger-fg) / <alpha-value>)",
          warn: "hsl(var(--act-warn) / <alpha-value>)",
          "warn-fg": "hsl(var(--act-warn-fg) / <alpha-value>)",
          neutral: "hsl(var(--act-neutral) / <alpha-value>)",
          "neutral-fg": "hsl(var(--act-neutral-fg) / <alpha-value>)",
          "disabled-bg": "hsl(var(--act-disabled-bg) / <alpha-value>)",
          "disabled-fg": "hsl(var(--act-disabled-fg) / <alpha-value>)",
          "disabled-line": "hsl(var(--act-disabled-line) / <alpha-value>)",
        },
      },
      borderRadius: {
        xs: "var(--radius-xs)",
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        "2xl": "1.25rem",
      },
      keyframes: {
        "accordion-down": {
          from: { height: 0 },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: 0 },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
