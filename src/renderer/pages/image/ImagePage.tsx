/**
 * Image Studio.
 *
 * A dedicated surface for image generation, deliberately outside the chat
 * composer: the chat is for conversation, this is for controlling a generation.
 *
 * Three rules shape the form:
 *  - only models that declare `imageOutput` are offered, and the picker says so
 *    when there are none rather than showing an empty control;
 *  - a control appears only when the selected provider documents the parameter —
 *    OpenAI takes a pixel size, quality and a count, Gemini takes an aspect ratio
 *    and a resolution preset, and neither takes a negative prompt;
 *  - references are chosen from images already in the library, because that is the
 *    one flow where the bytes are already local, validated and attributable.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { GenerationJob, GenerationMedia } from '@shared/media';
import { supportsTask } from '@shared/capabilities';
import { getApi } from '@renderer/lib/api';
import { asAppError } from '@shared/errors';
import { toast } from '@renderer/lib/toast';
import { Page } from '@renderer/components/layout/Page';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  IconButton,
  Progress,
  Select,
  Skeleton,
  Textarea,
} from '@renderer/components/ui';
import { MediaGrid, MediaPreviewBody } from '@renderer/components/media/MediaCard';
import { CloseIcon, ImageIcon } from '@renderer/components/icons';
import type { ModelDescriptor, ProviderConfig } from '@shared/types';
import './image.css';

const SIZE_OPTIONS = [
  { value: '1024x1024', label: '1024 × 1024 (square)' },
  { value: '1536x1024', label: '1536 × 1024 (landscape)' },
  { value: '1024x1536', label: '1024 × 1536 (portrait)' },
];

const QUALITY_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low — fastest' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const ASPECT_OPTIONS = [
  { value: '1:1', label: '1:1 (square)' },
  { value: '16:9', label: '16:9 (landscape)' },
  { value: '9:16', label: '9:16 (portrait)' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
];

const RESOLUTION_OPTIONS = [
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
  { value: '4K', label: '4K' },
];

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface StudioState {
  status: LoadStatus;
  error: string | null;
  models: ModelDescriptor[];
  providers: ProviderConfig[];
  items: GenerationMedia[];
  jobs: GenerationJob[];
}

const INITIAL: StudioState = {
  status: 'loading',
  error: null,
  models: [],
  providers: [],
  items: [],
  jobs: [],
};

export function ImagePage(): ReactElement {
  const [state, setState] = useState<StudioState>(INITIAL);
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('1024x1024');
  const [quality, setQuality] = useState('auto');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [resolution, setResolution] = useState('1K');
  const [count, setCount] = useState(1);
  const [referenceIds, setReferenceIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [preview, setPreview] = useState<GenerationMedia | null>(null);
  const [pendingDelete, setPendingDelete] = useState<GenerationMedia | null>(null);

  const load = useCallback(async () => {
    setState((current) => ({ ...current, status: 'loading', error: null }));
    try {
      const [models, providers, items, jobs] = await Promise.all([
        getApi().models.list(),
        getApi().providers.list(),
        getApi().media.list(),
        getApi().media.jobs(20),
      ]);
      setState({ status: 'ready', error: null, models, providers, items, jobs });
    } catch (error) {
      setState((current) => ({
        ...current,
        status: 'error',
        error: asAppError(error).message,
      }));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Progress arrives as events; a job that changes updates the list in place.
  useEffect(() => {
    const unsubscribe = getApi().media.onEvent((job) => {
      setState((current) => {
        const jobs = current.jobs.some((entry) => entry.id === job.id)
          ? current.jobs.map((entry) => (entry.id === job.id ? job : entry))
          : [job, ...current.jobs];
        return { ...current, jobs: jobs.slice(0, 20) };
      });
      if (job.status === 'succeeded') {
        // The bytes exist now, so refresh the library rather than guessing its shape.
        void getApi()
          .media.list()
          .then((items) => setState((current) => ({ ...current, items })))
          .catch(() => undefined);
      }
    });
    return unsubscribe;
  }, []);

  const imageModels = useMemo(
    () => state.models.filter((model) => supportsTask(model.capabilities, 'image')),
    [state.models],
  );

  const selected = useMemo(
    () => imageModels.find((model) => model.modelId === modelId) ?? imageModels[0] ?? null,
    [imageModels, modelId],
  );

  /** The provider's *kind* decides which controls it documents. */
  const providerKind = useMemo(
    () => state.providers.find((provider) => provider.id === selected?.providerId)?.kind ?? '',
    [state.providers, selected],
  );

  const isGemini = providerKind === 'gemini';

  const acceptsReferences = selected?.capabilities.imageInput === true;

  const activeJobs = state.jobs.filter((job) => job.status === 'queued' || job.status === 'running');

  const submit = async (): Promise<void> => {
    if (!selected) return;
    setFormError(null);
    if (prompt.trim().length === 0) {
      setFormError('A prompt is required.');
      return;
    }
    setBusy(true);
    try {
      const params: Record<string, string | number | boolean | null> = isGemini
        ? { aspect_ratio: aspectRatio, image_size: resolution }
        : { size, quality, n: count };
      await getApi().media.generate({
        task: 'image',
        prompt: prompt.trim(),
        params,
        providerId: selected.providerId,
        modelId: selected.modelId,
        ...(acceptsReferences && referenceIds.length > 0 ? { referenceMediaIds: referenceIds } : {}),
      });
      toast.success('Generation queued. It will appear here when it finishes.');
    } catch (error) {
      setFormError(asAppError(error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (job: GenerationJob): Promise<void> => {
    try {
      await getApi().media.cancel(job.id);
      toast.info('Generation cancelled.');
    } catch (error) {
      toast.danger(asAppError(error).message);
    }
  };

  const exportItem = async (item: GenerationMedia): Promise<void> => {
    try {
      const saved = await getApi().media.export(item.id);
      if (saved) toast.success('Saved a copy.');
    } catch (error) {
      toast.danger(asAppError(error).message);
    }
  };

  const remove = async (): Promise<void> => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    try {
      await getApi().media.remove(target.id);
      setState((current) => ({ ...current, items: current.items.filter((item) => item.id !== target.id) }));
      setReferenceIds((ids) => ids.filter((id) => id !== target.id));
      toast.success('Deleted from the library.');
    } catch (error) {
      toast.danger(asAppError(error).message);
    }
  };

  const toggleReference = (item: GenerationMedia): void => {
    setReferenceIds((ids) =>
      ids.includes(item.id) ? ids.filter((id) => id !== item.id) : [...ids, item.id].slice(0, 16),
    );
  };

  const header = (
    <Page
      title="Image Studio"
      description="Generate images with a model you have configured. Results stay on this machine and appear in the library below."
      actions={
        <Button variant="secondary" onClick={() => void load()} loading={state.status === 'loading'}>
          Refresh
        </Button>
      }
    >
      {state.status === 'loading' ? <Skeleton lines={6} label="Loading the Image Studio" /> : null}

      {state.status === 'error' ? (
        <ErrorState
          title="The Image Studio could not load"
          description={state.error ?? 'Something went wrong reading your models and library.'}
          onRetry={() => void load()}
        />
      ) : null}

      {state.status === 'ready' ? (
        <div className="pds-studio">
          <form
            className="pds-studio__form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {imageModels.length === 0 ? (
              <EmptyState
                icon={<ImageIcon />}
                title="No image model is registered"
                description="Add an OpenAI or Google Gemini provider, then declare an image model for it on the Models & Providers page."
              />
            ) : (
              <>
                <Select
                  label="Model"
                  hint="Only models that declare image generation are listed."
                  value={selected?.modelId ?? ''}
                  options={imageModels.map((model) => ({
                    value: model.modelId,
                    label: model.displayName,
                    description: model.modelId,
                  }))}
                  onChange={(value) => {
                    setModelId(value);
                    setReferenceIds([]);
                  }}
                />

                <Textarea
                  label="Prompt"
                  hint="Describe the image. Longer, concrete prompts work better."
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  rows={5}
                  placeholder="A heron standing in shallow water at dawn, soft mist, low angle"
                />

                <fieldset className="pds-studio__fieldset">
                  <legend className="pds-studio__legend">Generation settings</legend>
                  {isGemini ? (
                    <div className="pds-studio__row">
                      <Select
                        label="Aspect ratio"
                        value={aspectRatio}
                        options={ASPECT_OPTIONS}
                        onChange={setAspectRatio}
                      />
                      <Select
                        label="Resolution"
                        value={resolution}
                        options={RESOLUTION_OPTIONS}
                        onChange={setResolution}
                      />
                    </div>
                  ) : (
                    <>
                      <div className="pds-studio__row">
                        <Select label="Size" value={size} options={SIZE_OPTIONS} onChange={setSize} />
                        <Select label="Quality" value={quality} options={QUALITY_OPTIONS} onChange={setQuality} />
                      </div>
                      <Select
                        label="Images per request"
                        value={String(count)}
                        options={Array.from({ length: 4 }, (_, index) => ({
                          value: String(index + 1),
                          label: String(index + 1),
                        }))}
                        onChange={(value) => setCount(Number(value))}
                        hint="OpenAI documents up to 10; this screen offers 1–4 to keep a request predictable."
                      />
                    </>
                  )}
                  <p className="pds-studio__hint">
                    A negative prompt is not offered because neither provider documents one for these
                    models.
                  </p>
                </fieldset>

                {acceptsReferences ? (
                  <fieldset className="pds-studio__fieldset">
                    <legend className="pds-studio__legend">Reference images</legend>
                    <p className="pds-studio__hint">
                      Select images from the library below to edit or to steer the result.
                    </p>
                    <div className="pds-studio__references">
                      {referenceIds.length === 0 ? (
                        <span className="pds-studio__hint">None selected.</span>
                      ) : (
                        referenceIds.map((id) => (
                          <span key={id} className="pds-studio__reference">
                            {id.slice(0, 8)}
                            <IconButton
                              label={`Remove reference ${id.slice(0, 8)}`}
                              icon={<CloseIcon />}
                              size="sm"
                              tone="ghost"
                              onClick={() => setReferenceIds((ids) => ids.filter((entry) => entry !== id))}
                            />
                          </span>
                        ))
                      )}
                    </div>
                  </fieldset>
                ) : null}

                {formError ? (
                  <p className="pds-studio__error" role="alert">
                    {formError}
                  </p>
                ) : null}

                <div className="pds-studio__submit">
                  <Button type="submit" variant="primary" loading={busy} disabled={!selected}>
                    Generate
                  </Button>
                  {activeJobs.length > 0 ? (
                    <span className="pds-studio__hint">
                      {activeJobs.length === 1 ? 'One generation running.' : `${activeJobs.length} generations running.`}
                    </span>
                  ) : null}
                </div>
              </>
            )}
          </form>

          <section aria-label="Generation history">
            <h2 className="pds-studio__legend">Library</h2>

            {activeJobs.length > 0 ? (
              <ul className="pds-studio__jobs">
                {activeJobs.map((job) => (
                  <li key={job.id} className="pds-studio__job">
                    <Badge tone="info" dot>
                      {job.status === 'queued' ? 'Queued' : 'Generating'}
                    </Badge>
                    <span className="pds-studio__job-text">{job.prompt}</span>
                    <Progress
                      label={`Progress for: ${job.prompt}`}
                      value={job.progress}
                      valueText={job.progress === null ? 'Working…' : `${job.progress}%`}
                    />
                    <Button variant="ghost" size="sm" onClick={() => void cancel(job)}>
                      Cancel
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}

            {state.items.length === 0 ? (
              <EmptyState
                icon={<ImageIcon />}
                title="Nothing generated yet"
                description="Images you generate appear here, newest first. They are stored on this machine and never uploaded."
              />
            ) : (
              <MediaGrid
                items={state.items}
                onOpen={setPreview}
                onExport={(item) => void exportItem(item)}
                onRemove={setPendingDelete}
                {...(acceptsReferences ? { onUseAsReference: toggleReference } : {})}
                referenceIds={referenceIds}
              />
            )}
          </section>
        </div>
      ) : null}

      <Dialog open={preview !== null} onClose={() => setPreview(null)} title="Generated image" size="md">
        <MediaPreviewBody
          item={preview}
          onClose={() => setPreview(null)}
          onExport={(item) => void exportItem(item)}
          {...(acceptsReferences ? { onUseAsReference: toggleReference } : {})}
        />
      </Dialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this from the library?"
        description={
          pendingDelete
            ? `The file for “${pendingDelete.prompt.slice(0, 80)}” will be removed from this machine.`
            : ''
        }
        confirmLabel="Delete"
        busy={false}
        onConfirm={() => void remove()}
        onClose={() => setPendingDelete(null)}
      />
    </Page>
  );

  return header;
}
