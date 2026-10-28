/**
 * Theme resolution. The setting is dark / light / system; `system` reads the OS
 * preference and follows it live. The palette itself is re-derived per theme in
 * tokens.css — nothing here inverts colours.
 */
import type { ThemePreference } from '@shared/types';

export type ResolvedTheme = 'dark' | 'light';

export const LIGHT_QUERY = '(prefers-color-scheme: light)';

export function resolveTheme(preference: ThemePreference, prefersLight: boolean): ResolvedTheme {
  if (preference === 'system') return prefersLight ? 'light' : 'dark';
  return preference;
}

export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
}

export function prefersLightScheme(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(LIGHT_QUERY).matches;
}

export function watchSystemScheme(onChange: (prefersLight: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => undefined;
  }
  const query = window.matchMedia(LIGHT_QUERY);
  const listener = (event: MediaQueryListEvent): void => onChange(event.matches);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}
