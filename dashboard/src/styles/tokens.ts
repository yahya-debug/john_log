// Industry design tokens, mirrored from styles.css for use in TS/TSX
// (charts, inline styles, canvas). CSS-authored components should use the
// var(--*) names directly instead of these constants.

export const color = {
  bg: 'var(--color-bg)',
  surface: 'var(--color-surface)',
  text: 'var(--color-text)',
  accent: 'var(--color-accent)',
  divider: 'var(--color-divider)',
  neutral: {
    100: 'var(--color-neutral-100)', 200: 'var(--color-neutral-200)',
    300: 'var(--color-neutral-300)', 400: 'var(--color-neutral-400)',
    500: 'var(--color-neutral-500)', 600: 'var(--color-neutral-600)',
    700: 'var(--color-neutral-700)', 800: 'var(--color-neutral-800)',
    900: 'var(--color-neutral-900)',
  },
  accentRamp: {
    100: 'var(--color-accent-100)', 200: 'var(--color-accent-200)',
    300: 'var(--color-accent-300)', 400: 'var(--color-accent-400)',
    500: 'var(--color-accent-500)', 600: 'var(--color-accent-600)',
    700: 'var(--color-accent-700)', 800: 'var(--color-accent-800)',
    900: 'var(--color-accent-900)',
  },
} as const;

export const font = {
  heading: 'var(--font-heading)',
  body: 'var(--font-body)',
  mono: 'ui-monospace, Consolas, monospace',
} as const;

/** Log level -> accent ramp step. Matches the mockup. */
export const levelColor: Record<'debug' | 'info' | 'warn' | 'error', string> = {
  debug: color.neutral[400],
  info: color.accentRamp[400],
  warn: color.accentRamp[600],
  error: color.accentRamp[900],
};

export const levelBg: Record<'debug' | 'info' | 'warn' | 'error', string> = {
  debug: color.neutral[100],
  info: color.accentRamp[100],
  warn: color.accentRamp[200],
  error: color.accentRamp[300],
};
