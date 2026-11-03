/**
 * Video Studio.
 *
 * The same shape as the Image Studio, and three differences that come from video
 * being a long job rather than a fast one:
 *
 *  - **state lives in the shared store**, so navigating away and back does not
 *    lose a job that is still running;
 *  - **progress is often indeterminate** — neither provider reports a percentage —
 *    so the bar says "Working…" instead of inventing a number;
 *  - **the player is explicit**: `<video controls>` fed by a `media://` URL, never
 *    autoplaying, with `preload="metadata"` so a large file is not fetched to show
 *    a poster.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { GenerationJob, GenerationMedia } from '@shared/media';
import { supportsTask } from '@shared/capabilities';
import { getApi } from '@renderer/lib/api';
import { useMediaStore } from '@renderer/lib/media-store';
import { asAppError } from '@shared/errors';
import { toast } from '@renderer/lib/toast';
import { Page } from '@renderer/components/layout/Page';
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Select,
  Skeleton,
  Textarea,
} from '@renderer/components/ui';
import { JobList } from '@renderer/components/media/JobList';
import { MediaGrid, MediaPreviewBody } from '@renderer/components/media/MediaCard';
import { VideoIcon } from '@renderer/components/icons';
import type { ModelDescriptor, ProviderConfig } from '@shared/types';
import './video.css';

const ASPECT_OPTIONS = [
  { value: '16:9', label: '16:9 (landscape)' },
  { value: '9:16', label: '9:16 (portrait)' },
];

const GEMINI_RESOLUTIONS = [
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
  { value: '4k', label: '4K' },
];

export function VideoPage(): ReactElement {
  const items = useMediaStore((store) => store.items);
  const jobs = useMediaStore((store) => store.jobs);
  const status = useMediaStore((store) => store.status);
  const loadError = useMediaStore((store) => store.error);
  const load = useMediaStore((store) => store.load);

  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [modelId, setModelId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [resolution, setResolution] = useState('720p');
  const [referenceIds, setReferenceIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [preview, setPreview] = useState<GenerationMedia | null>(null);
  const [pendingDelete, setPendingDelete] = useState<GenerationMedia | null>(null);

  const loadCatalog = useCallback(async () => {
    setCatalogError(null);
    try {
      const [modelList, providerList] = await Promise.all([
        getApi().models.list(),
        getApi().providers.list(),
      ]);
      setModels(modelList);
      setProviders(providerList);
    } catch (error) {
      setCatalogError(asAppError(error).message);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
    void load();
    return useMediaStore.getState().attach();
  }, [load, loadCatalog]);

  const videoModels = useMemo(
    () => models.filter((model) => supportsTask(model.capabilities, 'video')),
    [models],
  );

  const selected = useMemo(
    () => videoModels.find((model) => model.modelId === modelId) ?? videoModels[0] ?? null,
    [videoModels, modelId],
  );

  const providerKind = useMemo(
    () => providers.find((provider) => provider.id === selected?.providerId)?.kind ?? '',
    [providers, selected],
  );

  const isGemini = providerKind === 'gemini';
  const acceptsReferences = selected?.capabilities.imageInput === true;

  const videoItems = useMemo(() => items.filter((item) => item.kind === 'video'), [items]);
  const imageReferences = useMemo(() => items.filter((item) => item.kind === 'image'), [items]);
  const activeJobs = jobs.filter(
    (job) => job.task === 'video' && (job.status === 'queued' || job.status === 'running'),
  );

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
        ? { aspect_ratio: aspectRatio, resolution }
        : { aspect_ratio: aspectRatio };
      await getApi().media.generate({
        task: 'video',
        prompt: prompt.trim(),
        params,
        providerId: selected.providerId,
        modelId: selected.modelId,
        ...(acceptsReferences && referenceIds.length > 0 ? { referenceMediaIds: referenceIds } : {}),
      });
      toast.success('Video generation queued. It can take several minutes.');
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
      useMediaStore.getState().forgetItem(target.id);
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

  return (
    <Page
      title="Video Studio"
      description="Generate video with a model you have configured. Jobs run in the background; you can leave this page and come back."
      actions={
        <Button variant="secondary" onClick={() => void load(true)} loading={status === 'loading'}>
          Refresh
        </Button>
      }
    >
      {status === 'loading' ? <Skeleton lines={6} label="Loading the Video Studio" /> : null}

      {status === 'error' || catalogError !== null ? (
        <ErrorState
          title="The Video Studio could not load"
          description={catalogError ?? loadError ?? 'Something went wrong reading your models and library.'}
          onRetry={() => {
            void load(true);
            void loadCatalog();
          }}
        />
      ) : null}

      {status === 'ready' && catalogError === null ? (
        <div className="pds-studio">
          <form
            className="pds-studio__form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {videoModels.length === 0 ? (
              <EmptyState
                icon={<VideoIcon />}
                title="No video model is registered"
                description="Add a Google Gemini or Black Forest Labs provider, then declare a video model for it on the Models & Providers page."
              />
            ) : (
              <>
                <Select
                  label="Model"
                  hint="Only models that declare video generation are listed."
                  value={selected?.modelId ?? ''}
                  options={videoModels.map((model) => ({
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
                  hint="Describe the shot: subject, camera movement, light."
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  rows={5}
                  placeholder="Slow pan across a misty harbour at dawn, gulls overhead"
                />

                <fieldset className="pds-studio__fieldset">
                  <legend className="pds-studio__legend">Generation settings</legend>
                  <div className={isGemini ? 'pds-studio__row' : undefined}>
                    <Select
                      label="Aspect ratio"
                      value={aspectRatio}
                      options={ASPECT_OPTIONS}
                      onChange={setAspectRatio}
                    />
                    {isGemini ? (
                      <Select
                        label="Resolution"
                        value={resolution}
                        options={GEMINI_RESOLUTIONS}
                        onChange={setResolution}
                      />
                    ) : null}
                  </div>
                  <p className="pds-studio__hint">
                    A duration is not offered: Gemini Omni extends a clip in ten-second steps and
                    documents no duration field, and Black Forest Labs documents none for this mode.
                  </p>
                </fieldset>

                {acceptsReferences ? (
                  <fieldset className="pds-studio__fieldset">
                    <legend className="pds-studio__legend">Start image (optional)</legend>
                    <p className="pds-studio__hint">
                      Pick an image from the library to drive the first frame.
                    </p>
                    <div className="pds-studio__references">
                      {imageReferences.length === 0 ? (
                        <span className="pds-studio__hint">No images in the library yet.</span>
                      ) : (
                        imageReferences.slice(0, 8).map((image) => (
                          <button
                            key={image.id}
                            type="button"
                            className="pds-studio__reference"
                            aria-pressed={referenceIds.includes(image.id)}
                            onClick={() => toggleReference(image)}
                          >
                            {referenceIds.includes(image.id) ? 'Selected: ' : 'Use: '}
                            {image.prompt.slice(0, 40)}
                          </button>
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
                    Generate video
                  </Button>
                  {activeJobs.length > 0 ? (
                    <span className="pds-studio__hint">
                      {activeJobs.length === 1
                        ? 'One video is generating.'
                        : `${activeJobs.length} videos are generating.`}
                    </span>
                  ) : null}
                </div>
              </>
            )}
          </form>

          <section aria-label="Video library">
            <h2 className="pds-studio__legend">Videos</h2>

            <JobList jobs={activeJobs} onCancel={(job) => void cancel(job)} />

            {videoItems.length === 0 ? (
              <EmptyState
                icon={<VideoIcon />}
                title="No videos yet"
                description="Generated videos appear here. They are stored on this machine and never uploaded."
              />
            ) : (
              <MediaGrid
                items={videoItems}
                onOpen={setPreview}
                onExport={(item) => void exportItem(item)}
                onRemove={setPendingDelete}
              />
            )}
          </section>
        </div>
      ) : null}

      <Dialog open={preview !== null} onClose={() => setPreview(null)} title="Generated video" size="md">
        <MediaPreviewBody
          item={preview}
          onClose={() => setPreview(null)}
          onExport={(item) => void exportItem(item)}
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
}
