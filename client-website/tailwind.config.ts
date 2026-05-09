import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'PingFang SC', 'sans-serif'],
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
