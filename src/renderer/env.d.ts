import type { DesktopApi } from '@shared/api';

declare global {
  interface Window {
    /** Injected by the preload bridge; the only capability surface. */
    api: DesktopApi;
  }
}

export {};
