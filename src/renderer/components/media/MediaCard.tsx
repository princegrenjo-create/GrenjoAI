/**
 * Media components.
 *
 * One card, one grid and one preview, shared by the Image Studio (and later the
 * Video Studio and the conversation transcript) so a generated asset looks the
 * same wherever it appears. The card is deliberately not hover-only: the actions
 * are always present, because a mouse-less window and a touch-capable laptop both
 * need them.
 */
import { useState, type ReactElement, type ReactNode } from 'react';
import type { GenerationMedia } from '@shared/media';
import { mediaUrl } from '@shared/media';
import { formatBytes } from '@shared/attachments';
import { Button, IconButton, Progress } from '../ui';
import { ImageIcon, TrashIcon, PanelIcon } from '../icons';
import './media.css';

export interface MediaCardProps {
  item: GenerationMedia;
  onOpen(item: GenerationMedia): void;
  onExport(item: GenerationMedia): void;
  onRemove(item: GenerationMedia): void;
  onUseAsReference?(item: GenerationMedia): void;
  /** True while this item is selected as a reference. */
  isReference?: boolean;
  /** Progress for the card's own generation, when it is still running. */
  progress?: number | null;
}

function dimensionsOf(item: GenerationMedia): string {
  if (item.width && item.height) return `${item.width} × ${item.height}`;
  if (item.durationMs) return `${Math.round(item.durationMs / 1000)}s video`;
  return item.kind === 'video' ? 'Video' : 'Image';
}

export function MediaCard({
  item,
  onOpen,
  onExport,
  onRemove,
  onUseAsReference,
  isReference = false,
  progress,
}: MediaCardProps): ReactElement {
  const source = mediaUrl(item.relativePath);
  const [missing, setMissing] = useState(false);
  const promptExcerpt = item.prompt.length > 120 ? `${item.prompt.slice(0, 120)}…` : item.prompt;

  return (
    <article className="pds-media-card" aria-label={`${item.kind}: ${promptExcerpt}`}>
      <button
        type="button"
        className="pds-media-card__preview"
        onClick={() => onOpen(item)}
        aria-label={`Open ${item.kind} preview: ${promptExcerpt}`}
      >
        {missing ? (
          <span className="pds-media-card__missing">
            File removed from disk
          </span>
        ) : item.kind === 'image' ? (
          <img
            className="pds-media-card__image"
            src={source}
            alt=""
            width={item.width ?? undefined}
            height={item.height ?? undefined}
            loading="lazy"
            decoding="async"
            onError={() => setMissing(true)}
          />
        ) : (
          <span className="pds-media-card__video">
            {/* No autoplay: a moving preview in a grid is noise, and it ignores
                the reduced-motion preference. The player lives in the preview. */}
            <video
              className="pds-media-card__video-el"
              src={source}
              preload="metadata"
              muted
              onError={() => setMissing(true)}
            />
            <span className="pds-media-card__play" aria-hidden="true">
              ▶
            </span>
          </span>
        )}
      </button>

      <div className="pds-media-card__body">
        <p className="pds-media-card__prompt">{promptExcerpt}</p>
        <p className="pds-media-card__meta">
          {dimensionsOf(item)} · {formatBytes(item.bytes)} · {item.modelId}
        </p>

        {progress !== undefined ? (
          <Progress
            label={`Generating from: ${promptExcerpt}`}
            value={progress}
            valueText={progress === null ? 'Working…' : `${progress}%`}
          />
        ) : null}

        <div className="pds-media-card__actions">
          <Button variant="secondary" size="sm" onClick={() => onOpen(item)}>
            Open
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onExport(item)}>
            Save a copy
          </Button>
          {onUseAsReference ? (
            <Button
              variant={isReference ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => onUseAsReference(item)}
              aria-pressed={isReference}
            >
              {isReference ? 'Reference selected' : 'Use as reference'}
            </Button>
          ) : null}
          <IconButton
            label={`Delete ${item.kind}: ${promptExcerpt}`}
            icon={<TrashIcon />}
            tone="danger"
            size="sm"
            onClick={() => onRemove(item)}
          />
        </div>
      </div>
    </article>
  );
}

export interface MediaGridProps {
  items: GenerationMedia[];
  onOpen(item: GenerationMedia): void;
  onExport(item: GenerationMedia): void;
  onRemove(item: GenerationMedia): void;
  onUseAsReference?(item: GenerationMedia): void;
  referenceIds?: string[];
  className?: string;
}

export function MediaGrid({
  items,
  onOpen,
  onExport,
  onRemove,
  onUseAsReference,
  referenceIds = [],
  className,
}: MediaGridProps): ReactElement {
  return (
    <ul className={className ? `pds-media-grid ${className}` : 'pds-media-grid'}>
      {items.map((item) => (
        <li key={item.id} className="pds-media-grid__item">
          <MediaCard
            item={item}
            onOpen={onOpen}
            onExport={onExport}
            onRemove={onRemove}
            {...(onUseAsReference ? { onUseAsReference } : {})}
            isReference={referenceIds.includes(item.id)}
          />
        </li>
      ))}
    </ul>
  );
}

export interface MediaPreviewProps {
  item: GenerationMedia | null;
  onClose(): void;
  onExport(item: GenerationMedia): void;
  onUseAsReference?(item: GenerationMedia): void;
  children?: ReactNode;
}

/** Renders the preview body; the page wraps it in the shared Dialog. */
export function MediaPreviewBody({ item, onExport, onUseAsReference }: MediaPreviewProps): ReactElement | null {
  if (!item) return null;
  const source = mediaUrl(item.relativePath);
  return (
    <div className="pds-media-preview">
      {item.kind === 'image' ? (
        <img className="pds-media-preview__image" src={source} alt={item.prompt} />
      ) : (
        <video className="pds-media-preview__video" src={source} controls preload="metadata" />
      )}
      <p className="pds-media-preview__prompt">{item.prompt}</p>
      <dl className="pds-media-preview__facts">
        <div>
          <dt>Model</dt>
          <dd>{item.modelId}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>
            {dimensionsOf(item)} · {formatBytes(item.bytes)}
          </dd>
        </div>
      </dl>
      <div className="pds-media-preview__actions">
        <Button variant="secondary" size="sm" onClick={() => onExport(item)}>
          Save a copy
        </Button>
        {onUseAsReference ? (
          <Button variant="ghost" size="sm" onClick={() => onUseAsReference(item)}>
            Use as reference
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Small icon used where a media type needs to be named in text. */
export function MediaKindIcon({ kind }: { kind: GenerationMedia['kind'] }): ReactElement {
  return kind === 'image' ? <ImageIcon /> : <PanelIcon />;
}
