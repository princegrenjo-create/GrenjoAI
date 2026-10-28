/**
 * Opening a link in the system browser is the one action that leaves the app.
 * It goes through the shared URL policy first, and the renderer never navigates
 * itself: the CSP forbids it and a navigation would replace the app window.
 */
import { isExternalLinkAllowed } from '@shared/url-policy';
import { getApi } from './api';
import { toast } from './toast';

export async function openExternalLink(url: string): Promise<boolean> {
  if (!isExternalLinkAllowed(url)) {
    toast.warning(
      'That link was blocked',
      'Only plain HTTPS links without embedded credentials can be opened.',
    );
    return false;
  }
  try {
    await getApi().app.openExternal(url);
    return true;
  } catch {
    toast.danger('The link could not be opened', 'The system browser did not accept the address.');
    return false;
  }
}
