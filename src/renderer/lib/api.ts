/**
 * The renderer's only door to the application.
 *
 * The production page makes no network requests at all: every capability is a
 * method on `window.api`, injected by the preload bridge. Keeping the lookup in
 * one place means a test can install a double with `__setApiForTest` and no
 * component ever touches `window` or Electron directly.
 */
import type { DesktopApi } from '@shared/api';

let override: DesktopApi | null = null;

/** Module-level test double. Passing `null` restores the real bridge. */
export function __setApiForTest(api: DesktopApi | null): void {
  override = api;
}

/** True when a bridge is available; used for the degraded-shell screen. */
export function hasApi(): boolean {
  if (override) return true;
  const candidate: DesktopApi | undefined =
    typeof window === 'undefined' ? undefined : window.api;
  return Boolean(candidate);
}

/** The desktop bridge. Throws only when the preload bridge failed to load. */
export function getApi(): DesktopApi {
  if (override) return override;
  const candidate: DesktopApi | undefined =
    typeof window === 'undefined' ? undefined : window.api;
  if (!candidate) {
    throw new Error('The desktop bridge is unavailable. Restart Grenjo AI Tool.');
  }
  return candidate;
}
