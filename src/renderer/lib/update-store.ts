/**
 * Update state for the renderer.
 *
 * One store, one subscription: the About panel and the settings page read the
 * same object, so "is an update ready" cannot disagree with itself across two
 * components. The initial read matters — a user can open Settings *while* a
 * download is running, and the panel must show the real progress rather than
 * "not checked yet".
 */
import { create } from 'zustand';
import type { UpdateState } from '@shared/updates';
import { asAppError } from '@shared/errors';
import { getApi } from './api';

export interface UpdateStore {
  state: UpdateState | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** Busy flag for the button whose action is in flight. */
  busy: 'check' | 'download' | 'install' | null;
  load(force?: boolean): Promise<void>;
  check(): Promise<void>;
  download(): Promise<void>;
  install(): Promise<void>;
  setAutoCheck(enabled: boolean): Promise<void>;
  attach(): () => void;
}

let detach: (() => void) | null = null;

export const useUpdatesStore = create<UpdateStore>((set, get) => ({
  state: null,
  status: 'idle',
  error: null,
  busy: null,

  async load(force = false) {
    const current = get().status;
    if (!force && (current === 'loading' || current === 'ready')) return;
    set({ status: 'loading', error: null });
    try {
      const state = await getApi().updates.state();
      set({ status: 'ready', state });
    } catch (error) {
      set({ status: 'error', error: asAppError(error).message });
    }
  },

  async check() {
    set({ busy: 'check', error: null });
    try {
      const state = await getApi().updates.check();
      set({ status: 'ready', state });
    } catch (error) {
      set({ error: asAppError(error).message });
    } finally {
      set({ busy: null });
    }
  },

  async download() {
    set({ busy: 'download', error: null });
    try {
      const state = await getApi().updates.download();
      set({ status: 'ready', state });
    } catch (error) {
      set({ error: asAppError(error).message });
    } finally {
      set({ busy: null });
    }
  },

  async install() {
    set({ busy: 'install', error: null });
    try {
      await getApi().updates.install();
      // The app is restarting; keep the button busy rather than inviting a second
      // click that would ask the same process to quit twice.
    } catch (error) {
      set({ error: asAppError(error).message, busy: null });
    }
  },

  async setAutoCheck(enabled) {
    try {
      const state = await getApi().updates.setAutoCheck(enabled);
      set({ state });
    } catch (error) {
      set({ error: asAppError(error).message });
    }
  },

  attach() {
    if (detach) return detach;
    try {
      detach = getApi().updates.onEvent((state) => set({ state, status: 'ready' }));
    } catch {
      detach = () => undefined;
    }
    return detach;
  },
}));

/** Test seam: drop the subscription so a suite starts clean. */
export function resetUpdatesStoreForTest(): void {
  detach?.();
  detach = null;
  useUpdatesStore.setState({ state: null, status: 'idle', error: null, busy: null });
}
