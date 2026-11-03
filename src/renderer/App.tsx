import { useEffect, useRef, useState, type ReactElement } from 'react';
import { toAppError } from '@shared/errors';
import type { AppErrorShape } from '@shared/types';
import { getApi } from './lib/api';
import { parseHash, ROUTE_META, type Route } from './lib/router';
import {
  useChatStore,
  useConversationsStore,
  useSettingsStore,
  useShellStore,
} from './lib/store';
import { applyTheme, prefersLightScheme, resolveTheme, watchSystemScheme } from './lib/theme';
import { AppNav } from './components/layout/AppNav';
import { ErrorState, ToastHost } from './components/ui';
import { ChatPage } from './pages/chat/ChatPage';
import { ImagePage } from './pages/image/ImagePage';
import { VideoPage } from './pages/video/VideoPage';
import { AgentsPage } from './pages/agents/AgentsPage';
import { ModelsPage } from './pages/models/ModelsPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { SyncPage } from './pages/sync/SyncPage';
import './components/layout/shell.css';

function RouteView({ route }: { route: Route }): ReactElement {
  switch (route.name) {
    case 'chat':
      return <ChatPage />;
    case 'image':
      return <ImagePage />;
    case 'video':
      return <VideoPage />;
    case 'agents':
      return <AgentsPage />;
    case 'models':
      return <ModelsPage />;
    case 'settings':
      return <SettingsPage />;
    case 'sync':
      return <SyncPage />;
    default:
      return <ChatPage />;
  }
}

export function App(): ReactElement {
  const route = useShellStore((state) => state.route);
  const navigate = useShellStore((state) => state.navigate);
  const themePreference = useSettingsStore((state) => state.settings.general.theme);
  const reduceMotion = useSettingsStore((state) => state.settings.general.reduceMotion);
  const settingsStatus = useSettingsStore((state) => state.status);
  const settingsError = useSettingsStore((state) => state.error);
  const loadSettings = useSettingsStore((state) => state.load);
  const [bridgeError, setBridgeError] = useState<AppErrorShape | null>(null);
  const mainRef = useRef<HTMLElement>(null);

  /* One hash listener; the shell store is the only writer of the route. */
  useEffect(() => {
    const onHashChange = (): void => {
      useShellStore.getState().setRoute(parseHash(window.location.hash));
    };
    window.addEventListener('hashchange', onHashChange);
    useShellStore.getState().setRoute(parseHash(window.location.hash));
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  /* Bootstrap: stream subscription plus the first data load. */
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    try {
      const api = getApi();
      unsubscribe = api.chat.onEvent((event) => useChatStore.getState().applyEvent(event));
      void useSettingsStore.getState().load();
      void useConversationsStore.getState().load();
      void useChatStore.getState().loadCatalog();
    } catch (error) {
      setBridgeError(toAppError(error));
    }
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  /* Theme: dark/light are re-derived palettes; `system` follows the OS live. */
  useEffect(() => {
    const apply = (): void => applyTheme(resolveTheme(themePreference, prefersLightScheme()));
    apply();
    if (themePreference !== 'system') return undefined;
    return watchSystemScheme(apply);
  }, [themePreference]);

  useEffect(() => {
    document.documentElement.dataset.reduceMotion = reduceMotion ? 'true' : 'false';
  }, [reduceMotion]);

  useEffect(() => {
    document.title = `${ROUTE_META[route.name].title} · Grenjo AI Tool`;
  }, [route.name]);

  if (bridgeError) {
    return (
      <div className="pds-app pds-app--fatal">
        <ErrorState
          title="The desktop bridge did not load"
          description={bridgeError.message}
          detail="Restart Grenjo AI Tool. If the window is opened outside the desktop app, the renderer has no access to the application."
        />
      </div>
    );
  }

  return (
    <div className="pds-app">
      <button type="button" className="pds-skip-link" onClick={() => mainRef.current?.focus()}>
        Skip to content
      </button>

      <AppNav
        route={route}
        onNavigate={(name) => navigate({ name, conversationId: null })}
      />

      <main ref={mainRef} id="pds-main" className="pds-main" tabIndex={-1}>
        {settingsStatus === 'error' && settingsError ? (
          <div className="pds-main__banner">
            <ErrorState
              inline
              title="Settings could not be loaded"
              description={settingsError.message}
              onRetry={() => {
                void loadSettings();
              }}
            />
          </div>
        ) : null}
        <div className="pds-main__content">
          <RouteView route={route} />
        </div>
      </main>

      <ToastHost />
    </div>
  );
}
