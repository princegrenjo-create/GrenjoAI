import { useState, type ReactElement } from 'react';
import type { Conversation } from '@shared/types';
import { PencilIcon, PlusIcon, SearchIcon, TrashIcon, CloseIcon } from '@renderer/components/icons';
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  Skeleton,
} from '@renderer/components/ui';
import { formatConversationStamp, formatCount } from '@renderer/lib/format';
import { useConversationsStore, useShellStore } from '@renderer/lib/store';

export interface ConversationSidebarProps {
  activeId: string | null;
  onSelect(id: string): void;
  /** Called after the active conversation was deleted, so the page can reset. */
  onDeleted(id: string): void;
}

/**
 * History column: search, new conversation, and per-row rename/delete. Both
 * destructive and renaming flows go through the project's Dialog — the browser
 * `confirm()` is never used, and the delete prompt names the conversation it
 * will remove.
 */
export function ConversationSidebar({
  activeId,
  onSelect,
  onDeleted,
}: ConversationSidebarProps): ReactElement {
  const items = useConversationsStore((state) => state.items);
  const status = useConversationsStore((state) => state.status);
  const error = useConversationsStore((state) => state.error);
  const search = useConversationsStore((state) => state.search);
  const load = useConversationsStore((state) => state.load);
  const setSearch = useConversationsStore((state) => state.setSearch);
  const create = useConversationsStore((state) => state.create);
  const rename = useConversationsStore((state) => state.rename);
  const remove = useConversationsStore((state) => state.remove);
  const toggleConversations = useShellStore((state) => state.toggleConversations);

  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState('');
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [busy, setBusy] = useState(false);

  const onCreate = async (): Promise<void> => {
    if (search) await setSearch('');
    const id = await create();
    if (id) onSelect(id);
  };

  const openRename = (conversation: Conversation): void => {
    setRenaming(conversation);
    setDraft(conversation.title);
  };

  const closeRename = (): void => {
    if (busy) return;
    setRenaming(null);
  };

  const submitRename = async (): Promise<void> => {
    if (!renaming) return;
    setBusy(true);
    const ok = await rename(renaming.id, draft);
    setBusy(false);
    if (ok) setRenaming(null);
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return;
    setBusy(true);
    const id = deleting.id;
    const ok = await remove(id);
    setBusy(false);
    if (!ok) return;
    setDeleting(null);
    onDeleted(id);
  };

  const hasSearch = search.trim().length > 0;

  return (
    <aside className="pds-chat__conversations" aria-label="Conversation history">
      <div className="pds-conv__header">
        <div className="pds-conv__heading">
          <h2 className="pds-conv__title">Conversations</h2>
          <span className="pds-conv__heading-actions">
            <IconButton
              label="New conversation"
              icon={<PlusIcon />}
              tone="secondary"
              size="sm"
              onClick={() => {
                void onCreate();
              }}
            />
            <IconButton
              className="pds-conv__close"
              label="Close conversations"
              icon={<CloseIcon />}
              size="sm"
              onClick={toggleConversations}
            />
          </span>
        </div>
        <Input
          label="Search conversations"
          labelHidden
          placeholder="Search conversations"
          leadingIcon={<SearchIcon />}
          value={search}
          onChange={(event) => {
            void setSearch(event.target.value);
          }}
        />
      </div>

      {status === 'error' ? (
        <div className="pds-conv__state">
          <ErrorState
            inline
            title="Conversations could not be loaded"
            description={error?.message ?? 'The local database did not answer.'}
            onRetry={() => {
              void load();
            }}
          />
        </div>
      ) : null}

      {status === 'loading' && items.length === 0 ? (
        <div className="pds-conv__state">
          <Skeleton lines={5} label="Loading conversations" />
        </div>
      ) : null}

      {status !== 'error' && items.length === 0 && status !== 'loading' ? (
        <div className="pds-conv__state">
          <EmptyState
            title={hasSearch ? 'No matches' : 'No conversations yet'}
            description={
              hasSearch
                ? `Nothing matches “${search.trim()}”. Try another word, or clear the search.`
                : 'Start one and it stays on this device.'
            }
            {...(hasSearch
              ? {
                  action: (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        void setSearch('');
                      }}
                    >
                      Clear search
                    </Button>
                  ),
                }
              : {})}
          />
        </div>
      ) : null}

      {items.length > 0 ? (
        <ul className="pds-conv__list" aria-label="Conversations" aria-busy={status === 'loading'}>
          {items.map((conversation) => (
            <li key={conversation.id} className="pds-conv__row">
              <button
                type="button"
                className="pds-conv__select"
                aria-current={conversation.id === activeId ? 'true' : undefined}
                onClick={() => onSelect(conversation.id)}
              >
                <span className="pds-conv__name">{conversation.title}</span>
                <span className="pds-conv__meta">
                  {formatCount(conversation.messageCount, 'message')} ·{' '}
                  {formatConversationStamp(conversation.updatedAt)}
                </span>
              </button>
              <span className="pds-conv__actions">
                <IconButton
                  label={`Rename ${conversation.title}`}
                  icon={<PencilIcon />}
                  size="sm"
                  onClick={() => openRename(conversation)}
                />
                <IconButton
                  label={`Delete ${conversation.title}`}
                  icon={<TrashIcon />}
                  size="sm"
                  tone="danger"
                  onClick={() => setDeleting(conversation)}
                />
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <Dialog
        open={renaming !== null}
        onClose={closeRename}
        title="Rename conversation"
        description="The title is only shown in this app. It is not sent to the provider."
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={closeRename} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!draft.trim() || draft.trim() === renaming?.title}
              onClick={() => {
                void submitRename();
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <Input
          label="Conversation title"
          value={draft}
          maxLength={200}
          hint="Up to 200 characters."
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submitRename();
            }
          }}
        />
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete conversation?"
        description={
          deleting
            ? `“${deleting.title}” and its ${formatCount(deleting.messageCount, 'message')} will be removed from this device.`
            : undefined
        }
        confirmLabel="Delete conversation"
        busy={busy}
        onConfirm={() => {
          void confirmDelete();
        }}
      />
    </aside>
  );
}
