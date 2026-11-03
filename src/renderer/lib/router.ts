/**
 * Tiny hash router. No dependency, no history API: the app is loaded from
 * `file://` in the packaged build, where the hash is the only reliable route
 * store. `#/chat`, `#/chat/<id>`, `#/agents`, `#/models`, `#/settings`, `#/sync`.
 */

export type RouteName = 'chat' | 'image' | 'video' | 'agents' | 'models' | 'settings' | 'sync';

export interface Route {
  name: RouteName;
  conversationId: string | null;
}

export interface RouteMeta {
  name: RouteName;
  label: string;
  title: string;
  description: string;
}

export const ROUTE_META: Record<RouteName, RouteMeta> = {
  chat: {
    name: 'chat',
    label: 'Chat',
    title: 'Chat',
    description: 'Talk to a model with the conversation history kept on this machine.',
  },
  image: {
    name: 'image',
    label: 'Image Studio',
    title: 'Image Studio',
    description: 'Generate images with a model you have configured. Results stay on this machine.',
  },
  video: {
    name: 'video',
    label: 'Video Studio',
    title: 'Video Studio',
    description: 'Generate video with a model you have configured. Jobs run in the background.',
  },
  agents: {
    name: 'agents',
    label: 'Agents',
    title: 'Agents',
    description: 'Reusable personas: a system prompt plus a model and its parameters.',
  },
  models: {
    name: 'models',
    label: 'Models & Providers',
    title: 'Models & Providers',
    description: 'Bring your own key. Providers, models and the parameters each one honours.',
  },
  settings: {
    name: 'settings',
    label: 'Settings',
    title: 'Settings',
    description: 'Application behaviour, generation defaults and local data.',
  },
  sync: {
    name: 'sync',
    label: 'Cloud Sync',
    title: 'Cloud Sync',
    description: 'Optional sync of conversations and configuration across machines.',
  },
};

/** Navigation order — also the order the sidebar renders. */
export const ROUTE_ORDER: readonly RouteName[] = ['chat', 'image', 'video', 'agents', 'models', 'settings', 'sync'];

const ROUTE_NAMES: readonly string[] = ROUTE_ORDER;

export const DEFAULT_ROUTE: Route = { name: 'chat', conversationId: null };

export function isRouteName(value: string): value is RouteName {
  return ROUTE_NAMES.includes(value);
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  if (!raw) return { ...DEFAULT_ROUTE };
  const [namePart, idPart] = raw.split('/');
  if (!namePart || !isRouteName(namePart)) return { ...DEFAULT_ROUTE };
  if (namePart === 'chat' && idPart) {
    return { name: 'chat', conversationId: decodeURIComponent(idPart) };
  }
  return { name: namePart, conversationId: null };
}

export function routeToHash(route: Route): string {
  if (route.name === 'chat' && route.conversationId) {
    return `#/chat/${encodeURIComponent(route.conversationId)}`;
  }
  return `#/${route.name}`;
}

export function routeLabel(route: Route): string {
  return ROUTE_META[route.name].label;
}

export function routesEqual(a: Route, b: Route): boolean {
  return a.name === b.name && a.conversationId === b.conversationId;
}
