/**
 * Toast store. A single writer (`push`/`dismiss`) and a host component that
 * renders it; nothing pushes a toast by mutating component state. Toasts are
 * how the UI reports an action that has no place to show an inline error.
 */
import { create } from 'zustand';

export type ToastVariant = 'info' | 'success' | 'warning' | 'danger';

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
}

export interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
}

interface ToastState {
  items: ToastItem[];
  push(input: ToastInput): string;
  dismiss(id: string): void;
  clear(): void;
}

let sequence = 0;

export function nextToastId(): string {
  sequence += 1;
  return `toast-${sequence}`;
}

/** Auto-dismiss delay; the CSS token documents the same intent. */
export const TOAST_DURATION_MS = 6000;

export const useToastStore = create<ToastState>((set) => ({
  items: [],
  push(input) {
    const id = nextToastId();
    const item: ToastItem = {
      id,
      title: input.title,
      variant: input.variant ?? 'info',
      ...(input.description ? { description: input.description } : {}),
    };
    set((state) => ({ items: [...state.items, item].slice(-4) }));
    return id;
  },
  dismiss(id) {
    set((state) => ({ items: state.items.filter((item) => item.id !== id) }));
  },
  clear() {
    set({ items: [] });
  },
}));

/** Imperative helpers for event handlers and stores. */
export const toast = {
  info(title: string, description?: string): string {
    return useToastStore.getState().push({ title, description, variant: 'info' });
  },
  success(title: string, description?: string): string {
    return useToastStore.getState().push({ title, description, variant: 'success' });
  },
  warning(title: string, description?: string): string {
    return useToastStore.getState().push({ title, description, variant: 'warning' });
  },
  danger(title: string, description?: string): string {
    return useToastStore.getState().push({ title, description, variant: 'danger' });
  },
};
