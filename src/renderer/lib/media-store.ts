/**
 * Generated media, in one place.
 *
 * The studio pages need the same three things: the library, the live jobs, and a
 * subscription that keeps both current. Putting that in component state meant a
 * generation disappeared from the list the moment you navigated away and back —
 * which for a video job that takes minutes is the difference between "it is
 * running" and "it vanished".
 *
 * So the state lives here, above the route: one load, one event subscription, and
 * both studios read from the same place. It also means the Image and Video pages
 * cannot drift apart in how they refresh or how they handle a failed read.
 */
import { create } from 'zustand';
import type { GenerationJob, GenerationMedia } from '@shared/media';
import { asAppError } from '@shared/errors';
import { getApi } from './api';

export type MediaLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface MediaState {
  status: MediaLoadStatus;
  error: string | null;
  items: GenerationMedia[];
  jobs: GenerationJob[];
  /** Reads the library and the recent jobs. Safe to call repeatedly. */
  load(force?: boolean): Promise<void>;
  /** Re-reads only the library, after a job finishes. */
  refreshItems(): Promise<void>;
  /** Drops an item locally once the main process confirmed the delete. */
  forgetItem(id: string): void;
  /** Applies one job event; exported for tests that cannot wire the bridge. */
  applyJob(job: GenerationJob): void;
  /**
   * A prompt handed from a conversation to the Image Studio.
   *
   * The chat never generates an image itself; it can only hand a starting prompt
   * to the studio, which is where the controls live.
   */
  draftPrompt: string | null;
  setDraftPrompt(prompt: string | null): void;
  /** Subscribes to job events exactly once per renderer session. */
  attach(): () => void;
}

/** One subscription for the whole renderer, not one per mounted page. */
let detach: (() => void) | null = null;

export const useMediaStore = create<MediaState>((set, get) => ({
  status: 'idle',
  error: null,
  items: [],
  jobs: [],
  draftPrompt: null,

  async load(force = false) {
    const current = get().status;
    if (!force && (current === 'loading' || current === 'ready')) return;
    set({ status: 'loading', error: null });
    try {
      const [items, jobs] = await Promise.all([getApi().media.list(), getApi().media.jobs(20)]);
      set({ status: 'ready', error: null, items, jobs });
    } catch (error) {
      set({ status: 'error', error: asAppError(error).message });
    }
  },

  async refreshItems() {
    try {
      const items = await getApi().media.list();
      set({ items });
    } catch {
      // A failed refresh must not replace a good library with an error screen;
      // the next event or navigation will try again.
    }
  },

  setDraftPrompt(prompt) {
    set({ draftPrompt: prompt });
  },

  forgetItem(id) {
    set((state) => ({ items: state.items.filter((item) => item.id !== id) }));
  },

  applyJob(job) {
    set((state) => {
      const known = state.jobs.some((entry) => entry.id === job.id);
      const jobs = known
        ? state.jobs.map((entry) => (entry.id === job.id ? job : entry))
        : [job, ...state.jobs];
      return { jobs: jobs.slice(0, 20) };
    });
    if (job.status === 'succeeded') void get().refreshItems();
  },

  attach() {
    if (detach) return detach;
    try {
      detach = getApi().media.onEvent((job) => get().applyJob(job));
    } catch {
      // No bridge: the app shows its own fatal screen. A store that threw here
      // would replace that screen with a stack trace, so it degrades to a no-op.
      detach = () => undefined;
    }
    return detach;
  },
}));

/** Test seam: drop the subscription so a suite starts clean. */
export function resetMediaStoreForTest(): void {
  detach?.();
  detach = null;
  useMediaStore.setState({ status: 'idle', error: null, items: [], jobs: [], draftPrompt: null });
}
