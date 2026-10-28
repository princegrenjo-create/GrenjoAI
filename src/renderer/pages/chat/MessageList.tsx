import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { AppErrorShape } from '@shared/types';
import { ArrowDownIcon, ChatIcon } from '@renderer/components/icons';
import { EmptyState, ErrorState, IconButton, Skeleton } from '@renderer/components/ui';
import type { ChatEntry, LoadStatus } from '@renderer/lib/store';
import { MessageBubble } from './MessageBubble';

/** Distance from the bottom, in CSS pixels, that still counts as "at the bottom". */
const PIN_THRESHOLD = 48;

export interface MessageListProps {
  entries: ChatEntry[];
  status: LoadStatus;
  loadError: AppErrorShape | null;
  isSending: boolean;
  showTokenUsage: boolean;
  onRetryLoad(): void;
  onRetrySend(): void;
}

/**
 * The message column. It keeps the user's scroll position: new tokens only
 * auto-scroll while the user is already at the bottom, and a jump-to-latest
 * control appears once they scroll up.
 */
export function MessageList({
  entries,
  status,
  loadError,
  isSending,
  showTokenUsage,
  onRetryLoad,
  onRetrySend,
}: MessageListProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  const scrollToBottom = useCallback((): void => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, []);

  useEffect(() => {
    if (pinned) scrollToBottom();
  }, [entries, pinned, scrollToBottom]);

  const onScroll = (): void => {
    const node = scrollRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    setPinned(distance < PIN_THRESHOLD);
  };

  if (status === 'loading' || status === 'idle') {
    return (
      <div className="pds-chat__state" aria-busy="true">
        <div className="pds-chat__state-inner">
          <Skeleton lines={6} label="Loading messages" />
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="pds-chat__state">
        <ErrorState
          title="This conversation could not be loaded"
          description={
            loadError?.message ??
            'The local database did not return the messages for this conversation.'
          }
          onRetry={onRetryLoad}
        />
      </div>
    );
  }

  return (
    <div
      className="pds-chat__scroll"
      ref={scrollRef}
      onScroll={onScroll}
      role="region"
      aria-label="Messages"
      data-testid="message-list"
    >
      <div className="pds-chat__stream">
        {entries.length === 0 ? (
          <EmptyState
            icon={<ChatIcon />}
            title="This conversation is empty"
            description="Ask anything below. Nothing leaves this machine except the request to the provider you configured."
          />
        ) : (
          entries.map((entry) => (
            <MessageBubble
              key={entry.id}
              entry={entry}
              showTokenUsage={showTokenUsage}
              onRetry={onRetrySend}
            />
          ))
        )}
        {isSending ? (
          <p className="pds-sr-only" role="status">
            The assistant is responding
          </p>
        ) : null}
      </div>
      {!pinned && entries.length > 0 ? (
        <div className="pds-chat__jump">
          <IconButton
            label="Jump to the latest message"
            icon={<ArrowDownIcon />}
            tone="secondary"
            onClick={() => {
              scrollToBottom();
              setPinned(true);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
