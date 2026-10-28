/**
 * Accessibility hooks shared by the pages.
 */
import { useEffect, useRef, type RefObject } from 'react';

/**
 * A page heading is focus target #1 after a route change. The heading is
 * `tabIndex={-1}` and only focused on mount, so selecting a conversation inside
 * the chat page never steals focus from the control the user just used.
 */
export function useHeadingFocus<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: false });
  }, []);
  return ref;
}
