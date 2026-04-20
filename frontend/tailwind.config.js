/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        agentmobile: {
          bg: 'var(--agentmobile-bg)',
          'bg-2': 'var(--agentmobile-bg2)',
          'menu-bg': 'var(--agentmobile-menu-bg)',
          border: 'var(--agentmobile-border)',
          text: 'var(--agentmobile-text)',
          'text-2': 'var(--agentmobile-text2)',
          muted: 'var(--agentmobile-muted)',
          'tab-active': 'var(--agentmobile-tab-active)',
          accent: 'var(--agentmobile-accent)',
          success: 'var(--agentmobile-success)',
          warning: 'var(--agentmobile-warning)',
          error: 'var(--agentmobile-error)',
        },
      },
      fontFamily: {
        mono: ['Menlo', 'Monaco', '"Cascadia Code"', '"Fira Code"', 'monospace'],
      },
      animation: {
        'spin': 'spin 1s linear infinite',
        'pulse': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'slide-up': 'slideUp 0.2s ease-out',
      },
      keyframes: {
        spin: {
          'to': { transform: 'rotate(360deg)' },
        },
        pulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.3' },
        },
        slideUp: {
          'from': { opacity: '0', transform: 'translateY(10px)' },
          'to': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
}
