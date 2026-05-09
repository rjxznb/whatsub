import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // System UI stack — gives the OS native sans-serif. On Windows
        // resolves to Microsoft YaHei UI / Segoe UI; on macOS to PingFang
        // SC / SF Pro; on Linux varies. Renders Chinese characters with
        // the OS-default Chinese font, which has matching metrics with
        // the Latin chars (no jarring fallback transition).
        sans: ['system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        display: ['Caveat', 'cursive'],
      },
      colors: {
        // Brand tokens copied verbatim from client/src/components/WelcomeIntro.tsx
        bg: '#000000',
        'bg-soft': '#0a0a0c',
        'bg-elev': '#141418',
        ink: '#ffffff',
        accent: '#3B9BFF',
        amber: '#FCD34D',
      },
    },
  },
  plugins: [],
};

export default config;
