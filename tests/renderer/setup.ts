/**
 * Renderer test setup: jest-dom matchers, plus the browser APIs jsdom does not
 * implement but the renderer legitimately uses (ResizeObserver, matchMedia,
 * scrollIntoView). No test here touches Electron: the desktop bridge is always
 * a fake installed through `__setApiForTest`.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { __setApiForTest } from '@renderer/lib/api';

class ResizeObserverStub {
  observe(): void {
    return undefined;
  }

  unobserve(): void {
    return undefined;
  }

  disconnect(): void {
    return undefined;
  }
}

vi.stubGlobal('ResizeObserver', ResizeObserverStub);

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }) as unknown as MediaQueryList,
});

if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = vi.fn();
}

if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
}

afterEach(() => {
  cleanup();
  __setApiForTest(null);
  document.documentElement.classList.remove('pds-scroll-lock');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-reduce-motion');
});
