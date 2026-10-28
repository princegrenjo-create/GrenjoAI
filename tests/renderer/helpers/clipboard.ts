import { vi } from 'vitest';

/** Install a clipboard double on `navigator` for a test. */
export function stubClipboard() {
  const writeText = vi.fn(async (text: string) => {
    void text;
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}
