/**
 * Clipboard access. The renderer has no network and no direct OS access, so the
 * one capability it needs from the platform is "put this exact string on the
 * clipboard" — `navigator.clipboard` is available in the Electron renderer.
 */

export async function copyToClipboard(text: string): Promise<boolean> {
  const clipboard: Clipboard | undefined =
    typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== 'function') return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
