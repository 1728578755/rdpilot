/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        line: 'var(--border)',
        t1: 'var(--text-1)',
        t2: 'var(--text-2)',
        t3: 'var(--text-3)',
        primary: {
          DEFAULT: 'var(--primary)',
          hover: 'var(--primary-hover)',
          active: 'var(--primary-active)',
          30: 'var(--primary-30)',
          '08': 'var(--primary-08)'
        },
        success: 'var(--success)',
        warning: 'var(--warning)',
        danger: 'var(--danger)',
        offline: 'var(--offline)',
        unconnected: 'var(--unconnected)',
        'surface-hover': 'var(--surface-hover)',
        'border-strong': 'var(--border-strong)',
        star: 'var(--star)'
      },
      borderRadius: {
        card: 'var(--radius-card)',
        btn: 'var(--radius-btn)',
        input: 'var(--radius-input)',
        modal: 'var(--radius-modal)',
        icon: 'var(--radius-icon)',
        pill: '999px'
      },
      fontFamily: {
        sans: ['"Segoe UI"', '"Microsoft YaHei UI"', '"PingFang SC"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Cascadia Code"', 'Consolas', 'monospace']
      },
      transitionTimingFunction: {
        std: 'cubic-bezier(.4,0,.2,1)'
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        'card-hover': 'var(--shadow-card-hover)'
      }
    }
  },
  plugins: []
}
