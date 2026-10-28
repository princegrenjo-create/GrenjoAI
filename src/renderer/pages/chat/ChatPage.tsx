import { useEffect, useRef, type ReactElement } from 'react';
import { ChatIcon, PanelIcon } from '@renderer/components/icons';
import { Button, EmptyState, ErrorState, IconButton, Select } from '@renderer/components/ui';
import { useHeadingFocus } from '@renderer/lib/hooks';
import { formatCount, formatConversationStamp } from '@renderer/lib/format';
import {
  useChatStore,
  useConversationsStore,
  useSettingsStore,
  useShellStore,
} from '@renderer/lib/store';
import { Composer } from './Composer';
import { ConversationSidebar } from './ConversationSidebar';
import { MessageList } from './MessageList';
import './chat.css';

export function ChatPage(): ReactElement {
  const route = useShellStore((state) => state.route);
  const conversationId = route.conversationId;
  const navigate = useShellStore((state) => state.navigate);
  const conversationsVisible = useShellStore((state) => state.conversationsVisible);
  const toggleConversations = useShellStore((state) => state.toggleConversations);

  const conversations = useConversationsStore((state) => state.items);
  const conversationsStatus = useConversationsStore((state) => state.status);
  const conversation = useConversationsStore((state) =>
    conversationId ? (state.items.find((item) => item.id === conversationId) ?? null) : null,
  );
  const loadConversations = useConversationsStore((state) => state.load);
  const createConversation = useConversationsStore((state) => state.create);

  const entries = useChatStore((state) => state.entries);
  const chatStatus = useChatStore((state) => state.status);
  const chatError = useChatStore((state) => state.error);
  const isSending = useChatStore((state) => state.isSending);
  const models = useChatStore((state) => state.models);
  const agents = useChatStore((state) => state.agents);
  const catalogStatus = useChatStore((state) => state.catalogStatus);
  const catalogError = useChatStore((state) => state.catalogError);
  const loadCatalog = useChatStore((state) => state.loadCatalog);
  const openConversation = useChatStore((state) => state.open);
  const closeChat = useChatStore((state) => state.close);
  const reloadChat = useChatStore((state) => state.reload);
  const send = useChatStore((state) => state.send);
  const stop = useChatStore((state) => state.stop);
  const retryLast = useChatStore((state) => state.retryLast);
  const setModel = useChatStore((state) => state.setModel);
  const setAgent = useChatStore((state) => state.setAgent);

  const settings = useSettingsStore((state) => state.settings);
  const headingRef = useHeadingFocus<HTMLHeadingElement>();
  const modelSelectorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    if (conversationId) void openConversation(conversationId);
    else closeChat();
  }, [conversationId, openConversation, closeChat]);

  /* With no explicit selection, open the most recent conversation. */
  useEffect(() => {
    if (route.name !== 'chat' || conversationId || conversationsStatus !== 'ready') return;
    const first = conversations[0];
    if (first) navigate({ name: 'chat', conversationId: first.id });
  }, [route.name, conversationId, conversationsStatus, conversations, navigate]);

  const startConversation = async (): Promise<void> => {
    const id = await createConversation();
    if (id) navigate({ name: 'chat', conversationId: id });
  };

  const selectedModelKey =
    conversation?.providerId && conversation.modelId
      ? `${conversation.providerId}|${conversation.modelId}`
      : '';

  /*
   * The conversation names its model by id; the catalogue row for it is what
   * carries the capabilities. An image attachment is only allowed when that row
   * says the model accepts image input.
   */
  const selectedModel =
    conversation?.providerId && conversation.modelId
      ? (models.find(
          (model) =>
            model.providerId === conversation.providerId &&
            model.modelId === conversation.modelId,
        ) ?? null)
      : null;

  const focusModelPicker = (): void => {
    // The Model select is a button inside this slot; focusing it is the shortest
    // honest path from "this model cannot take images" to picking one that can.
    modelSelectorRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  };

  const modelOptions = models.map((model) => ({
    value: `${model.providerId}|${model.modelId}`,
    label: model.displayName,
    ...(model.source === 'custom' ? { description: 'Custom model' } : {}),
  }));

  const modelHint =
    catalogStatus === 'loading'
      ? 'Loading the model list…'
      : models.length === 0
        ? 'Add a provider and a model in Models & Providers.'
        : undefined;

  const agentOptions = [
    { value: '', label: 'No agent' },
    ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
  ];

  const onModelChange = (value: string): void => {
    if (!value) {
      void setModel(null, null);
      return;
    }
    const separator = value.indexOf('|');
    if (separator <= 0) return;
    void setModel(value.slice(0, separator), value.slice(separator + 1));
  };

  const title = conversation?.title ?? (conversationId ? 'Conversation' : 'Chat');
  const meta = conversation
    ? `${formatCount(conversation.messageCount, 'message')} · updated ${formatConversationStamp(conversation.updatedAt)}`
    : 'Everything stays on this device.';

  const hasConversations = conversations.length > 0;

  return (
    <div className="pds-chat" data-conversations={conversationsVisible ? 'shown' : 'hidden'}>
      <ConversationSidebar
        activeId={conversationId}
        onSelect={(id) => navigate({ name: 'chat', conversationId: id })}
        onDeleted={() => {
          navigate({ name: 'chat', conversationId: null });
          closeChat();
        }}
      />

      <section className="pds-chat__main" aria-label="Conversation">
        <header className="pds-chat__header">
          <div className="pds-chat__heading">
            <IconButton
              label={conversationsVisible ? 'Hide conversations' : 'Show conversations'}
              icon={<PanelIcon />}
              onClick={toggleConversations}
            />
            <div className="pds-chat__titles">
              <h1 ref={headingRef} tabIndex={-1} className="pds-chat__title">
                {title}
              </h1>
              <p className="pds-chat__meta">{meta}</p>
            </div>
          </div>

          <div className="pds-chat__selectors">
            <div className="pds-chat__selector-slot" ref={modelSelectorRef}>
              <Select
                className="pds-chat__selector"
                label="Model"
                size="sm"
                value={selectedModelKey}
                options={modelOptions}
                onChange={onModelChange}
                disabled={!conversation || models.length === 0}
                placeholder={models.length === 0 ? 'No models available' : 'Select a model'}
                hint={modelHint}
              />
            </div>
            <Select
              className="pds-chat__selector"
              label="Agent"
              size="sm"
              value={conversation?.agentId ?? ''}
              options={agentOptions}
              onChange={(value) => {
                void setAgent(value === '' ? null : value);
              }}
              disabled={!conversation}
            />
          </div>
        </header>

        {catalogStatus === 'error' ? (
          <div className="pds-chat__banner">
            <ErrorState
              inline
              title="Models could not be loaded"
              description={catalogError?.message ?? 'The model catalogue is unavailable.'}
              onRetry={() => {
                void loadCatalog();
              }}
            />
          </div>
        ) : null}

        {conversationId ? (
          <MessageList
            entries={entries}
            status={chatStatus}
            loadError={chatError}
            isSending={isSending}
            showTokenUsage={settings.chat.showTokenUsage}
            onRetryLoad={() => {
              void reloadChat();
            }}
            onRetrySend={() => {
              void retryLast();
            }}
          />
        ) : (
          <div className="pds-chat__state">
            <EmptyState
              icon={<ChatIcon />}
              title={hasConversations ? 'Pick a conversation' : 'Start your first conversation'}
              description={
                hasConversations
                  ? 'Choose a conversation from the list, or start a new one.'
                  : 'Start one and it stays on this device. Your API key never leaves the Windows credential store.'
              }
              action={
                <Button
                  variant="primary"
                  onClick={() => {
                    void startConversation();
                  }}
                >
                  Start a conversation
                </Button>
              }
            />
          </div>
        )}

        <Composer
          ready={conversation !== null}
          isSending={isSending}
          sendOnEnter={settings.general.sendOnEnter}
          modelName={selectedModel?.displayName ?? null}
          modelAcceptsImages={selectedModel ? selectedModel.capabilities.imageInput : null}
          onChooseModel={focusModelPicker}
          onSend={(content, attachments) => send(content, attachments)}
          onStop={() => {
            void stop();
          }}
        />
      </section>
    </div>
  );
}
