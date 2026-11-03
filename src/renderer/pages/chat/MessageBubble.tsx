import { memo, type ReactElement } from 'react';
import { Badge, Button } from '@renderer/components/ui';
import { Markdown } from '@renderer/components/markdown/Markdown';
import { formatTime, formatTokenUsage } from '@renderer/lib/format';
import type { ChatEntry } from '@renderer/lib/store';
import { AttachmentList } from './AttachmentList';
import { ChatErrorCard } from './ChatErrorCard';
import { CopyButton } from './CopyButton';

export interface MessageBubbleProps {
  entry: ChatEntry;
  showTokenUsage: boolean;
  onRetry(): void;
  /**
   * Hands this message to the Image Studio as a starting prompt.
   *
   * The chat does not generate images: it opens the studio pre-filled, because the
   * controls, the model choice and the progress belong there.
   */
  onGenerateImage?(prompt: string): void;
}

function roleLabel(role: ChatEntry['role']): string {
  if (role === 'user') return 'You';
  if (role === 'system') return 'System';
  return 'Assistant';
}

/**
 * One message: user turns are a bubble, assistant turns are prose on the page,
 * and a failed turn is an error card. The streaming caret is CSS-only and
 * appended to the last rendered paragraph, so it never creates an extra block.
 */
function MessageBubbleComponent({ entry, showTokenUsage, onRetry, onGenerateImage }: MessageBubbleProps): ReactElement {
  const isUser = entry.role === 'user';
  const isError = entry.status === 'error' && entry.error !== null;
  const streaming = entry.status === 'streaming';
  const totalTokens = entry.usage?.totalTokens ?? 0;
  const canCopy = !isUser && !isError && entry.content.length > 0;

  return (
    <article
      className={['pds-message', `pds-message--${entry.role}`, streaming ? 'pds-message--streaming' : '']
        .filter(Boolean)
        .join(' ')}
      data-status={entry.status}
    >
      <header className="pds-message__meta">
        <span className="pds-message__role">{roleLabel(entry.role)}</span>
        <time className="pds-message__time" dateTime={entry.createdAt}>
          {formatTime(entry.createdAt)}
        </time>
        {entry.status === 'stopped' ? <Badge tone="warning">Stopped</Badge> : null}
        {showTokenUsage && totalTokens > 0 ? (
          <Badge tone="neutral">{formatTokenUsage(totalTokens)}</Badge>
        ) : null}
      </header>

      <div className={isUser ? 'pds-message__body pds-message__body--user' : 'pds-message__body'}>
        {isError && entry.error ? (
          <ChatErrorCard error={entry.error} onRetry={onRetry} />
        ) : isUser ? (
          entry.content.length > 0 ? (
            <p className="pds-message__text">{entry.content}</p>
          ) : null
        ) : (
          <Markdown content={entry.content} />
        )}
        {entry.attachments.length > 0 ? (
          <AttachmentList
            className="pds-message__attachments"
            attachments={entry.attachments}
          />
        ) : null}
        {streaming && entry.content.length === 0 ? (
          <span className="pds-caret pds-caret--alone" aria-hidden="true" />
        ) : null}
      </div>

      {canCopy || (onGenerateImage && entry.content.trim().length > 0 && !isError && !streaming) ? (
        <div className="pds-message__actions">
          {canCopy ? <CopyButton text={entry.content} label="Copy message" /> : null}
          {onGenerateImage && entry.content.trim().length > 0 && !isError && !streaming ? (
            <Button variant="ghost" size="sm" onClick={() => onGenerateImage(entry.content)}>
              Generate an image from this message
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export const MessageBubble = memo(MessageBubbleComponent);
