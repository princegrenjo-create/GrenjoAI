import type { ReactElement } from 'react';
import type { AppErrorShape } from '@shared/types';
import { Button, ErrorState } from '@renderer/components/ui';
import { presentChatError } from '@renderer/lib/error-copy';
import { useShellStore } from '@renderer/lib/store';

export interface ChatErrorCardProps {
  error: AppErrorShape;
  onRetry?: () => void;
}

/**
 * A failed assistant turn. It is an error card, never a normal bubble: the
 * message is not rendered as if the model had answered, and the one action that
 * can clear the failure is offered next to the sentence describing it.
 */
export function ChatErrorCard({ error, onRetry }: ChatErrorCardProps): ReactElement {
  const presentation = presentChatError(error);
  const navigate = useShellStore((state) => state.navigate);

  let action: ReactElement | null = null;
  if (presentation.action === 'retry' && onRetry) {
    action = (
      <Button size="sm" variant="secondary" onClick={onRetry}>
        {presentation.actionLabel}
      </Button>
    );
  } else if (presentation.action === 'configure') {
    action = (
      <Button
        size="sm"
        variant="secondary"
        onClick={() => navigate({ name: 'models', conversationId: null })}
      >
        {presentation.actionLabel}
      </Button>
    );
  }

  return (
    <ErrorState
      inline
      title={presentation.title}
      description={presentation.description}
      detail={`Error code: ${error.code}`}
    >
      {action}
    </ErrorState>
  );
}
