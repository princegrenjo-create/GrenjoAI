import { useEffect, useRef, useState, type ReactElement } from 'react';
import { CheckIcon, CopyIcon } from '@renderer/components/icons';
import { IconButton } from '@renderer/components/ui';
import { copyToClipboard } from '@renderer/lib/clipboard';
import { toast } from '@renderer/lib/toast';

export interface CopyButtonProps {
  /** The exact string written to the clipboard. */
  text: string;
  /** Accessible name, e.g. "Copy message". */
  label: string;
  size?: 'sm' | 'md';
}

const COPY_RESET_MS = 2000;

/** Copies `text` verbatim and reports the outcome; never copies rendered HTML. */
export function CopyButton({ text, label, size = 'sm' }: CopyButtonProps): ReactElement {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = async (): Promise<void> => {
    const ok = await copyToClipboard(text);
    if (!ok) {
      toast.danger('Nothing was copied', 'This window cannot reach the clipboard.');
      return;
    }
    setCopied(true);
    toast.success('Copied to the clipboard');
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), COPY_RESET_MS);
  };

  return (
    <IconButton
      label={copied ? 'Copied' : label}
      icon={copied ? <CheckIcon /> : <CopyIcon />}
      size={size}
      onClick={() => {
        void copy();
      }}
    />
  );
}
