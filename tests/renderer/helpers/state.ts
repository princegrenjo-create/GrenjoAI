/**
 * Store reset between renderer tests. The stores are module singletons, so a
 * test that forgets this would leak state into the next one.
 */
import { DEFAULT_SETTINGS } from '@shared/defaults';
import {
  useChatStore,
  useConversationsStore,
  useSettingsStore,
  useShellStore,
} from '@renderer/lib/store';
import { resetMediaStoreForTest } from '@renderer/lib/media-store';
import { useToastStore } from '@renderer/lib/toast';

export function resetStores(): void {
  useShellStore.setState({
    route: { name: 'chat', conversationId: null },
    conversationsVisible: true,
  });
  useSettingsStore.setState({
    status: 'idle',
    settings: DEFAULT_SETTINGS,
    error: null,
  });
  useConversationsStore.setState({
    status: 'idle',
    items: [],
    search: '',
    error: null,
  });
  useChatStore.setState({
    conversationId: null,
    entries: [],
    status: 'idle',
    error: null,
    isSending: false,
    activeRequestId: null,
    pending: null,
    models: [],
    agents: [],
    catalogStatus: 'idle',
    catalogError: null,
  });
  // The media store also owns the one job-event subscription, so it is dropped
  // here rather than left pointing at the previous test's bridge double.
  resetMediaStoreForTest();
  useToastStore.setState({ items: [] });
  window.history.replaceState(null, '', '#/chat');
}

export function setSendOnEnter(sendOnEnter: boolean): void {
  const current = useSettingsStore.getState().settings;
  useSettingsStore.setState({
    status: 'ready',
    settings: {
      ...current,
      general: { ...current.general, sendOnEnter },
    },
  });
}
