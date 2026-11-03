/**
 * Agents: a reusable persona — a system prompt, a model and its parameter
 * overrides — listed on the left and edited on the right.
 *
 * The page owns the draft. Nothing is written until Save, and a failed write
 * leaves every typed value in place.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { asAppError } from '@shared/errors';
import type { Agent, AgentInput } from '@shared/types';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Skeleton,
} from '@renderer/components/ui';
import { Page } from '@renderer/components/layout/Page';
import { getApi } from '@renderer/lib/api';
import { errorSummary } from '@renderer/lib/error-copy';
import { formatCount } from '@renderer/lib/format';
import { ROUTE_META } from '@renderer/lib/router';
import { useShellStore } from '@renderer/lib/store';
import { toast } from '@renderer/lib/toast';
import { AgentEditor, type AgentDraft } from './AgentEditor';
import { useAgentResources } from './useAgentResources';
import './agents.css';

function toDraft(agent: Agent): AgentDraft {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    providerId: agent.providerId ?? '',
    modelId: agent.modelId ?? '',
    systemPrompt: agent.systemPrompt,
    params: { ...agent.params },
    updatedAt: agent.updatedAt,
  };
}

function emptyDraft(): AgentDraft {
  return {
    id: null,
    name: '',
    description: '',
    providerId: '',
    modelId: '',
    systemPrompt: '',
    params: {},
    updatedAt: null,
  };
}

export function AgentsPage(): ReactElement {
  const resources = useAgentResources();
  const navigate = useShellStore((state) => state.navigate);

  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Agent | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  /* Keep exactly one agent open, and drop a draft whose agent disappeared. */
  useEffect(() => {
    if (resources.status !== 'ready') return;
    setDraft((current) => {
      if (current) {
        if (current.id === null) return current;
        const live = resources.agents.find((agent) => agent.id === current.id);
        if (live) return current;
      }
      const first = resources.agents[0];
      return first ? toDraft(first) : null;
    });
  }, [resources.status, resources.agents]);

  const onChange = (patch: Partial<AgentDraft>): void => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const input: AgentInput = {
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name.trim(),
        description: draft.description.trim(),
        providerId: draft.providerId.length > 0 ? draft.providerId : null,
        modelId: draft.modelId.length > 0 ? draft.modelId : null,
        systemPrompt: draft.systemPrompt,
        params: draft.params,
      };
      const saved = draft.id
        ? await getApi().agents.update(draft.id, input)
        : await getApi().agents.create(input);
      resources.replaceAgent(saved);
      setDraft(toDraft(saved));
      toast.success(draft.id ? 'Agent saved' : 'Agent created');
    } catch (thrown) {
      setError(errorSummary(asAppError(thrown)));
    } finally {
      setSaving(false);
    }
  };

  const duplicate = async (): Promise<void> => {
    const id = draft?.id;
    if (!id) return;
    setSaving(true);
    setError(null);
    try {
      const copy = await getApi().agents.duplicate(id);
      resources.replaceAgent(copy);
      setDraft(toDraft(copy));
      toast.success('Agent duplicated');
    } catch (thrown) {
      setError(errorSummary(asAppError(thrown)));
    } finally {
      setSaving(false);
    }
  };

  const startChat = async (): Promise<void> => {
    const id = draft?.id;
    if (!id) return;
    try {
      const conversation = await getApi().conversations.create({ agentId: id });
      navigate({ name: 'chat', conversationId: conversation.id });
    } catch (thrown) {
      toast.danger('A chat with this agent could not be started', errorSummary(asAppError(thrown)));
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await getApi().agents.remove(deleting.id);
      resources.removeAgent(deleting.id);
      setDraft((current) => (current && current.id === deleting.id ? null : current));
      setDeleting(null);
      toast.success('Agent deleted');
    } catch (thrown) {
      toast.danger('The agent was not deleted', errorSummary(asAppError(thrown)));
    } finally {
      setDeleteBusy(false);
    }
  };

  const agentName = (providerId: string, modelId: string): string => {
    if (providerId.length === 0) return 'App default model';
    const model = resources.models.find(
      (entry) => entry.providerId === providerId && entry.modelId === modelId,
    );
    return model ? model.displayName : 'Model no longer listed';
  };

  return (
    <Page
      className="pds-agents"
      title={ROUTE_META.agents.title}
      description={ROUTE_META.agents.description}
      actions={
        <Button
          variant="primary"
          onClick={() => {
            setError(null);
            setDraft(emptyDraft());
          }}
        >
          New agent
        </Button>
      }
    >
      {resources.status === 'loading' ? <Skeleton lines={6} label="Loading agents" /> : null}

      {resources.status === 'error' ? (
        <ErrorState
          title="Agents could not be loaded"
          description={resources.error?.message ?? 'The local database did not answer.'}
          /* 'unknown' is what a rejection looks like when the code did not survive
             the bridge; printing it would be noise rather than information. */
          detail={
            resources.error && resources.error.code !== 'unknown'
              ? `Error code: ${resources.error.code}`
              : undefined
          }
          onRetry={() => {
            void resources.reload();
          }}
        />
      ) : null}

      {resources.status === 'ready' ? (
        <div className="pds-agents__layout">
          <aside className="pds-agents__list" aria-label="Agents">
            <div className="pds-agents__list-head">
              <h2 className="pds-agents__list-title">Agents</h2>
              <Badge tone="neutral">{formatCount(resources.agents.length, 'agent')}</Badge>
            </div>

            {resources.agents.length === 0 ? (
              <p className="pds-agents__list-empty">
                Agents you save appear here.
              </p>
            ) : (
              <ul className="pds-agents__rows" aria-label="Saved agents">
                {resources.agents.map((agent) => (
                  <li key={agent.id}>
                    <button
                      type="button"
                      className="pds-agents__row"
                      aria-current={draft?.id === agent.id ? 'true' : undefined}
                      onClick={() => {
                        setError(null);
                        setDraft(toDraft(agent));
                      }}
                    >
                      <span className="pds-agents__row-name">{agent.name}</span>
                      <span className="pds-agents__row-meta">
                        {agent.description.trim().length > 0
                          ? agent.description
                          : 'No description'}
                      </span>
                      <span className="pds-agents__row-model">
                        {agentName(agent.providerId ?? '', agent.modelId ?? '')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section className="pds-agents__editor" aria-label="Agent editor">
            {draft ? (
              <AgentEditor
                draft={draft}
                providers={resources.providers}
                models={resources.models}
                saving={saving}
                error={error}
                onChange={onChange}
                onSave={() => {
                  void save();
                }}
                onDuplicate={() => {
                  void duplicate();
                }}
                onDelete={() => {
                  const id = draft.id;
                  if (!id) return;
                  const target = resources.agents.find((agent) => agent.id === id);
                  if (target) setDeleting(target);
                }}
                onNewChat={() => {
                  void startChat();
                }}
              />
            ) : (
              <EmptyState
                title={resources.agents.length === 0 ? 'No agents yet' : 'No agent selected'}
                description={
                  resources.agents.length === 0
                    ? 'Create one to keep a system prompt, a model and its parameter overrides together.'
                    : 'Choose an agent from the list, or create a new one.'
                }
                action={
                  <Button variant="secondary" onClick={() => setDraft(emptyDraft())}>
                    New agent
                  </Button>
                }
              />
            )}
          </section>
        </div>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this agent?"
        description={
          deleting
            ? `“${deleting.name}” will be removed from this device. Conversations that used it keep their history.`
            : undefined
        }
        confirmLabel="Delete agent"
        busy={deleteBusy}
        onConfirm={() => {
          void confirmDelete();
        }}
      />
    </Page>
  );
}
