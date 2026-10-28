import { useState, type KeyboardEvent, type ReactElement } from 'react';
import { MAX_MESSAGE_CHARS } from '@shared/defaults';
import { SendIcon, StopIcon } from '@renderer/components/icons';
import { IconButton, Textarea } from '@renderer/components/ui';

export interface ComposerProps {
  ready: boolean;
  isSending: boolean;
  sendOnEnter: boolean;
  onSend(content: string): void;
  onStop(): void;
}

/**
 * The composer. Enter sends and Shift+Enter adds a line when the setting says
 * so; with that setting off, Enter adds a line and Ctrl/Cmd+Enter sends. The
 * Send control stays mounted and disabled while a request is in flight, so a
 * duplicate send has nowhere to come from, and Stop sits beside it.
 */
export function Composer({
  ready,
  isSending,
  sendOnEnter,
  onSend,
  onStop,
}: ComposerProps): ReactElement {
  const [text, setText] = useState('');
  const trimmed = text.trim();
  const tooLong = text.length > MAX_MESSAGE_CHARS;
  const canSend = ready && !isSending && trimmed.length > 0 && !tooLong;

  const submit = (): void => {
    if (!canSend) return;
    onSend(trimmed);
    setText('');
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

  const hint = sendOnEnter
    ? 'Enter sends · Shift+Enter adds a line'
    : 'Enter adds a line · Ctrl+Enter sends';

  return (
    <form
      className="pds-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="pds-composer__inner">
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
        <div className="pds-composer__hint">
          <span>{hint}</span>
          {text.length > 0 ? (
            <span className={tooLong ? 'pds-composer__count pds-composer__count--over' : 'pds-composer__count'}>
              {text.length.toLocaleString()} / {MAX_MESSAGE_CHARS.toLocaleString()}
            </span>
          ) : null}
        </div>
      </div>
    </form>
  );
}
