/**
 * Attachment chips.
 *
 * One component serves both surfaces: the composer, where a chip can be
 * removed, and the message list, where it is a record of what was sent. The
 * chip always states what the app actually did with the file:
 *
 *  - `extracted`  — the bytes were read, so the model has them;
 *  - `metadata-only` — the file is attached but its contents were not used;
 *  - `failed`     — reading was attempted and did not work.
 *
 * That is why a chip whose contents were not read says so in words instead of
 * showing a filename and letting the user assume the model read it.
 */
import { useEffect, useState, type ReactElement } from 'react';
import {
  formatBytes,
  type AttachmentKind,
} from '@shared/attachments';
import {
  AudioIcon,
  CloseIcon,
  FileIcon,
  ImageIcon,
} from '@renderer/components/icons';
import { Badge, IconButton } from '@renderer/components/ui';
import { getApi } from '@renderer/lib/api';
import {
  attachmentTypeLabel,
  previewOf,
  type AttachmentLike,
} from './attachments';

export interface AttachmentListProps {
  attachments: ReadonlyArray<AttachmentLike>;
  /** When given, each chip carries a remove control. */
  onRemove?(id: string): void;
  className?: string;
}

function kindGlyph(kind: AttachmentKind): ReactElement {
  if (kind === 'image') return <ImageIcon />;
  if (kind === 'audio') return <AudioIcon />;
  return <FileIcon />;
}

/** `0:07` — the length of a recording, not a wall-clock time. */
function formatClipDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The chip's square preview. The composer already holds a small inline preview;
 * a message from history does not, so it is re-read from the main process. A
 * failed read degrades to the file glyph — the chip still names the file, so
 * nothing is hidden and nothing crashes.
 */
function AttachmentThumb({ attachment }: { attachment: AttachmentLike }): ReactElement {
  const inline = previewOf(attachment);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const isImage = attachment.kind === 'image';

  useEffect(() => {
    if (inline || !isImage || failed) return undefined;
    let alive = true;
    getApi()
      .attachments.readImage(attachment.id)
      .then((result) => {
        if (alive) setLoaded(result.dataUrl);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [attachment.id, inline, isImage, failed]);

  const source = inline ?? loaded;
  return (
    <span className="pds-attachment__thumb">
      {isImage && source && !failed ? (
        <img className="pds-attachment__image" src={source} alt="" />
      ) : (
        <span aria-hidden="true">{kindGlyph(attachment.kind)}</span>
      )}
    </span>
  );
}

export function AttachmentList({
  attachments,
  onRemove,
  className,
}: AttachmentListProps): ReactElement {
  return (
    <ul className={className ? `pds-attachments ${className}` : 'pds-attachments'} aria-label="Attachments">
      {attachments.map((attachment) => {
        const extracted = attachment.contentStatus === 'extracted';
        const meta = [attachmentTypeLabel(attachment), formatBytes(attachment.sizeBytes)];
        if (attachment.durationMs !== null) meta.push(formatClipDuration(attachment.durationMs));
        return (
          <li key={attachment.id} className="pds-attachment">
            <AttachmentThumb attachment={attachment} />
            <span className="pds-attachment__text">
              <span className="pds-attachment__name">{attachment.name}</span>
              <span className="pds-attachment__meta">{meta.join(' · ')}</span>
              {extracted ? null : (
                <span className="pds-attachment__status">
                  <Badge tone={attachment.contentStatus === 'failed' ? 'danger' : 'warning'}>
                    {attachment.contentStatus === 'failed' ? 'Contents could not be read' : 'Contents not read'}
                  </Badge>
                  {attachment.contentNote ? (
                    <span className="pds-attachment__note">{attachment.contentNote}</span>
                  ) : null}
                </span>
              )}
            </span>
            {onRemove ? (
              <IconButton
                label={`Remove ${attachment.name}`}
                icon={<CloseIcon />}
                size="sm"
                onClick={() => onRemove(attachment.id)}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
