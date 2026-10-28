/**
 * Design tokens for the mobile app.
 *
 * These mirror the desktop palette (`.work/2026-10-29-ui-screenshot` and
 * `src/renderer/styles/tokens.css`): same warm dark neutrals, same amber accent,
 * same radius and spacing rhythm. A second, unrelated look would make the two
 * apps feel like different products.
 */
export const colors = {
  bg: '#0e0e11',
  surface: '#15161a',
  surface2: '#1b1d22',
  border: 'rgba(235,231,225,0.12)',
  borderStrong: 'rgba(235,231,225,0.22)',
  text: '#ebe7e1',
  textMuted: '#a7a29b',
  textSubtle: '#7d7871',
  accent: '#e9a94b',
  accentContrast: '#1a1206',
  danger: '#e26d5c',
  dangerSurface: 'rgba(226,109,92,0.12)',
  warning: '#e0b457',
  warningSurface: 'rgba(224,180,87,0.12)',
  success: '#7fbf8a',
  info: '#7aa5d8',
} as const;

/** 4px base scale — the same steps as the desktop token file. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  pill: 999,
} as const;

export const type = {
  caption: 12,
  body: 16,
  label: 14,
  title: 20,
  hero: 25,
} as const;

/** Minimum touch target, per WCAG 2.5.5 / platform guidance. */
export const touchTarget = 44;
