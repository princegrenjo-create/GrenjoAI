/**
 * The media that belongs to the open conversation.
 *
 * Deliberately a strip, not message bubbles: a generated image is not a chat turn,
 * and synthesising an assistant message for one would put a phantom reply in the
 * transcript every time someone generated something. The media row already carries
 * the conversation id, so the chat can show what belongs to it without touching the
 * message stream.
 *
 * The strip is horizontal and small; the full card, preview and export live in the
 * studios, which is one click away through "Open in the studio".
 */
import type { ReactElement } from 'react';
import type { GenerationMedia } from '@shared/media';
import { mediaUrl } from '@shared/media';
import { formatBytes } from '@shared/attachments';
import { Badge, IconButton } from '@renderer/components/ui';
import { CloseIcon, ImageIcon, VideoIcon } from '@renderer/components/icons';

export interface ConversationMediaProps {
  items: GenerationMedia[];
  onOpen(item: GenerationMedia): void;
  /** Removes the item from this conversation's view (not from the library). */
  onDismiss?(item: GenerationMedia): void;
  className?: string;
}

export function ConversationMedia({
  items,
  onOpen,
  onDismiss,
  className,
}: ConversationMediaProps): ReactElement | null {
  if (items.length === 0) return null;

  return (
    <section
      className={className ? `pds-conversation-media ${className}` : 'pds-conversation-media'}
      aria-label="Media generated in this conversation"
    >
      <div className="pds-conversation-media__head">
        <h2 className="pds-conversation-media__title">
          Generated in this conversation ({items.length})
        </h2>
        <Badge tone="neutral">Stored on this machine</Badge>
      </div>

      <div className="pds-conversation-media__strip">
        {items.map((item) => {
          const source = mediaUrl(item.relativePath);
          return (
            <div key={item.id} className="pds-conversation-media__item-wrap">
              <button
                type="button"
                className="pds-conversation-media__item"
                onClick={() => onOpen(item)}
                aria-label={`${item.kind === 'video' ? 'Video' : 'Image'} generated here: ${item.prompt.slice(0, 60)}`}
              >
                {item.kind === 'image' ? (
                  <img src={source} alt="" loading="lazy" decoding="async" />
                ) : (
                  <video src={source} preload="metadata" muted />
                )}
                <span className="pds-sr-only">
                  {item.kind} · {formatBytes(item.bytes)} · {item.modelId}
                </span>
              </button>
              {onDismiss ? (
                <IconButton
                  label={`Stop showing ${item.kind} in this conversation`}
                  icon={<CloseIcon />}
                  size="sm"
                  tone="ghost"
                  onClick={() => onDismiss(item)}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The icon for a media kind, for places that need one inline. */
export function mediaKindIcon(kind: GenerationMedia['kind']): ReactElement {
  return kind === 'image' ? <ImageIcon /> : <VideoIcon />;
}
