import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactElement } from 'react';
import type { AttachmentMeta } from '@shared/attachments';
import { MAX_MESSAGE_CHARS } from '@shared/defaults';
import {
  AlertCircleIcon,
  ImageIcon,
  MicIcon,
  PaperclipIcon,
  SendIcon,
  StopIcon,
} from '@renderer/components/icons';
import { Button, IconButton, Textarea } from '@renderer/components/ui';
import { AttachmentList } from './AttachmentList';
import { VoiceRecorder } from './VoiceRecorder';
import { useComposerAttachments } from './useComposerAttachments';

export interface ComposerProps {
  ready: boolean;
  isSending: boolean;
  sendOnEnter: boolean;
  /** Display name of the model this conversation will use; null when none is chosen. */
  modelName: string | null;
  /** That model's `capabilities.imageInput`; null when no model is selected. */
  modelAcceptsImages: boolean | null;
  /** Moves focus to the model picker — the fix for the image-capability warning. */
  onChooseModel(): void;
  /** Resolves true once the turn was accepted by the main process. */
  onSend(content: string, attachments: AttachmentMeta[]): Promise<boolean>;
  onStop(): void;
}

/**
 * The composer.
 *
 * Send is allowed with text, with attachments, or with both: an image on its own
 * is a complete turn. The one thing it refuses to do is pretend — an image with a
 * model that cannot read images is explained in place and the send is blocked,
 * rather than being sent and failing at the provider.
 *
 * Enter/Shift+Enter behaviour is unchanged: Enter sends and Shift+Enter adds a
 * line when the setting says so; with it off, Enter adds a line and Ctrl/Cmd+Enter
 * sends.
 */
export function Composer({
  ready,
  isSending,
  sendOnEnter,
  modelName,
  modelAcceptsImages,
  onChooseModel,
  onSend,
  onStop,
}: ComposerProps): ReactElement {
  const [text, setText] = useState('');
  const [recorderOpen, setRecorderOpen] = useState(false);
  const attachmentBox = useComposerAttachments();
  const formRef = useRef<HTMLFormElement>(null);

  const trimmed = text.trim();
  const tooLong = text.length > MAX_MESSAGE_CHARS;
  const hasImage = attachmentBox.attachments.some((attachment) => attachment.kind === 'image');
  const imageBlocked = hasImage && modelAcceptsImages === false;
  const hasSomethingToSend = trimmed.length > 0 || attachmentBox.attachments.length > 0;
  const canSend = ready && !isSending && !tooLong && !imageBlocked && hasSomethingToSend;

  const submit = (): void => {
    if (!canSend) return;
    const outgoing = attachmentBox.attachments;
    // The text clears immediately, as before; the chips clear only once the
    // main process has accepted the turn, so a failed send keeps its files.
    setText('');
    void onSend(trimmed, outgoing).then((sent) => {
      if (sent) attachmentBox.clear();
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      submit();
      return;
    }
    if (!sendOnEnter) return;
    if (event.shiftKey || event.altKey) return;
    event.preventDefault();
    submit();
  };

  /* Drag-and-drop: read the bytes here, because a dropped File has no path. */
  const onDragOver = (event: DragEvent<HTMLFormElement>): void => {
    if (!ready || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    attachmentBox.setDragging(true);
  };

  const onDragLeave = (event: DragEvent<HTMLFormElement>): void => {
    const related: Node | null = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (related && formRef.current?.contains(related)) return;
    attachmentBox.setDragging(false);
  };

  const onDrop = (event: DragEvent<HTMLFormElement>): void => {
    event.preventDefault();
    attachmentBox.setDragging(false);
    if (!ready) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) void attachmentBox.addFiles(files);
  };

  const hint = sendOnEnter
    ? 'Enter sends · Shift+Enter adds a line'
    : 'Enter adds a line · Ctrl+Enter sends';

  return (
    <form
      ref={formRef}
      className={attachmentBox.dragging ? 'pds-composer pds-composer--dragging' : 'pds-composer'}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="pds-composer__inner">
        {attachmentBox.dragging ? (
          <div className="pds-composer__drop">
            <PaperclipIcon />
            <span>Drop files to attach them</span>
          </div>
        ) : null}

        {attachmentBox.attachments.length > 0 ? (
          <AttachmentList
            attachments={attachmentBox.attachments}
            onRemove={(id) => {
              void attachmentBox.remove(id);
            }}
          />
        ) : null}

        {attachmentBox.rejections.length > 0 ? (
          <div className="pds-composer__rejections" role="alert">
            <ul className="pds-composer__rejection-list">
              {attachmentBox.rejections.map((rejection) => (
                <li
                  key={`${rejection.name}-${rejection.reason}`}
                  className="pds-composer__rejection"
                >
                  <span className="pds-composer__rejection-name">{rejection.name}</span>
                  {` — ${rejection.reason}`}
                </li>
              ))}
            </ul>
            <Button size="sm" variant="ghost" onClick={attachmentBox.dismissRejections}>
              Dismiss
            </Button>
          </div>
        ) : null}

        {imageBlocked ? (
          <div className="pds-composer__warning" role="alert">
            <span className="pds-composer__warning-icon" aria-hidden="true">
              <AlertCircleIcon />
            </span>
            <div className="pds-composer__warning-text">
              <p className="pds-composer__warning-title">
                {modelName ?? 'The selected model'} can’t accept images.
              </p>
              <p className="pds-composer__warning-body">
                Remove the image, or choose a model with image input. Text and document
                attachments are always allowed.
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={onChooseModel}>
              Choose a model
            </Button>
          </div>
        ) : null}

        {recorderOpen ? (
          <VoiceRecorder
            onTranscript={(transcript) => {
              setText((current) =>
                current.trim().length > 0 ? `${current}\n${transcript}` : transcript,
              );
            }}
            onAttach={attachmentBox.addAttachment}
            onClose={() => setRecorderOpen(false)}
          />
        ) : null}

        <div className="pds-composer__row">
          <Textarea
            className="pds-composer__textarea"
            label="Message"
            labelHidden
            autoGrow
            rows={1}
            value={text}
            disabled={!ready}
            placeholder={ready ? 'Ask anything…' : 'Start a conversation to write a message'}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            error={
              tooLong
                ? `Messages are limited to ${MAX_MESSAGE_CHARS.toLocaleString()} characters.`
                : undefined
            }
          />
          {isSending ? (
            <IconButton
              label="Stop generating"
              icon={<StopIcon />}
              tone="secondary"
              size="md"
              onClick={onStop}
            />
          ) : null}
          <IconButton
            label="Send message"
            icon={<SendIcon />}
            tone="primary"
            size="md"
            disabled={!canSend}
            onClick={submit}
          />
        </div>

        <div className="pds-composer__toolbar">
          <div className="pds-composer__actions">
            <IconButton
              label="Attach file"
              icon={<PaperclipIcon />}
              disabled={!ready || attachmentBox.busy}
              onClick={() => {
                void attachmentBox.pick({ kinds: 'file' });
              }}
            />
            <IconButton
              label="Attach image"
              icon={<ImageIcon />}
              disabled={!ready || attachmentBox.busy}
              onClick={() => {
                void attachmentBox.pick({ kinds: 'image' });
              }}
            />
            <IconButton
              label="Record voice"
              icon={<MicIcon />}
              disabled={!ready || recorderOpen}
              onClick={() => setRecorderOpen(true)}
            />
          </div>
          <div className="pds-composer__hint">
            <span>{hint}</span>
            {attachmentBox.busy ? (
              <span className="pds-composer__hint-note" role="status">
                Attaching…
              </span>
            ) : null}
            {text.length > 0 ? (
              <span
                className={
                  tooLong ? 'pds-composer__count pds-composer__count--over' : 'pds-composer__count'
                }
              >
                {text.length.toLocaleString()} / {MAX_MESSAGE_CHARS.toLocaleString()}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </form>
  );
}
