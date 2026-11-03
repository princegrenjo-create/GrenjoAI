# MASTER PLAN — Grenjo AI Tool v0.2

@PlannablePlan v0.1

> **Supersedes the v0.1 plan.** The previous plan (*"MASTER PLAN — Personal AI Desk"*, PART-001…016) described
> the now-shipped 0.1.0 chat application. It is preserved verbatim at
> [`docs/history/MASTER_PLAN-v0.1.md`](docs/history/MASTER_PLAN-v0.1.md) and in git history; its evidence log
> is `PLAN_EVIDENCE.md`. This file is the active plan from **PART-001** onward. **Nothing in it is executed
> until the owner approves it.**
>
> **Tooling note (honest status):** the `plannable` CLI is **not installed** in this environment
> (`Get-Command plannable` → nothing; global npm packages: `pm2` only). The plan, the evidence log and the
> part state are therefore maintained **by hand** in the documented `@PlannablePlan v0.1` structure. Every
> other Plannable rule still applies: one part at a time, evidence before completion, no unrelated edits, stop
> on a stop condition, and a derived state that is never hand-edited to look complete.

---

## CTX

- **Owner goal:** one clean, consistent application with a single authoritative implementation per feature;
  image-generation and video-generation support across providers that actually document such APIs; a
  capability-based model registry (no model is assumed to be a chat model); local-first storage of generated
  media; the existing chat, web renderer and Windows build preserved.
- **Workspace:** `D:\MyAI`, branch `master`, HEAD `76ad3e7`, **326 tracked files**. The working tree is **not
  clean** at the start of this plan: 63 unstaged `mobile/` deletions plus the brand-asset changes from the
  Phase-1 audit run.
- **Audit basis:** [`docs/PROJECT-AUDIT-2026-11-03.md`](docs/PROJECT-AUDIT-2026-11-03.md). Finding IDs `B-xx`
  (blocker), `D-xx` (defect) and `H-xx` (hygiene) below refer to that document. A part that also cites `UI-xx`
  or `F-xx` is referring to the detailed workstream notes kept in the run sink
  (`.work/2026-11-03-audit-consolidation/out/ui-audit.md`, `…/platform-audit.md`), which are gitignored; the
  report's own tables carry the same substance for every `B`/`D`/`H` item.
- **Runtime:** Windows 10.0.26300 x64, Node v24.18.0, npm 11.16.0, git 2.55.0, Electron 44.10.0 (Node
  24.22.1, Chromium 152), `node:sqlite` 3.53.4 (no native module, no rebuild toolchain), TypeScript 5.9.3.
- **Non-negotiable constraints (the owner's brief):** no destructive cleanup without verification; no user
  data, keys or migration history deleted; the existing chat / web renderer / Windows build never broken; no
  second codebase for macOS; no hardcoded API keys; no invented endpoints or model capabilities; unsupported
  features clearly marked; no dependency added without a reason; working implementations not replaced for
  architectural neatness.
- **Provider facts that gate the scope** (official docs, 2026-11-03; OpenAI re-checked independently by the
  Lead):
  - **OpenAI Images** live: `/v1/images/generations`, `/v1/images/edits`; base64 output only; `n` 1–10;
    arbitrary `WxH` ÷16; up to 16 reference images; `mask`/`markup`; ship `gpt-image-2.5-sunburst`,
    `gpt-image-2.5-flare`, `gpt-image-2`.
  - **OpenAI video: does not exist** (Videos API + Sora 2 shut down 2026-09-24). Never offered.
  - **Imagen** shut down in the Gemini API; **Veo 3.1 Preview** shut down 2026-10-22.
  - **Gemini images:** `POST /v1beta/interactions` (`x-goog-api-key`), `gemini-*image*` / `nano-banana-*`.
  - **Gemini video:** `gemini-omni-1.1-flash` via Interactions (`background=true` for long jobs).
  - **Black Forest Labs:** `api.bfl.ai`, header `x-key`, `POST /v1/<model>` → `polling_url` →
    `Ready|Error|Failed`; output is a **signed URL valid 10 minutes**; `/v1/flux-3-video` with `mode: t2v`.
  - Three of five surfaces hand back **expiring URLs** ⇒ bytes are downloaded and persisted at completion,
    never only a URL.
  - Model ids live in a **config table with a `shutdownDate`**, never inline in adapter logic.
- **Hard external dependencies (become `UNAVAILABLE`, never `PASSED`):** live provider calls need the owner's
  keys; a macOS build needs a macOS host; code signing needs a certificate.
- **Safeguard basis:**
  - `basis[baseline.secrets]` — the app stores provider credentials; keys must never reach SQLite, the
    renderer, an export, a log, or a generated-media record. A signed provider URL is credential-shaped and is
    never persisted as the only copy.
  - `basis[baseline.dependencies]` — every addition needs a named reason and an exact pin (the tree is 100 %
    exact-pinned today).
  - `basis[access.owner]` — single local user; Supabase rows are owner-scoped by RLS. No multi-tenant model.
  - `basis[data.recovery]` — chats/settings are the only copy of the owner's work. Migrations are additive;
    the runner refuses a newer schema, so **downgrade is impossible** and must be stated in release notes.
  - `basis[input.boundary]` — the renderer is an untrusted boundary crossing into privileged IPC; every new
    channel validates with zod and asserts the sender.
  - `basis[input.files]` — reference images and generated outputs are user-controlled files: canonicalise,
    confine to the media root, cap size and count, validate magic bytes.
  - `basis[input.urls]` — provider base URLs and returned output URLs are untrusted input: HTTPS only (loopback
    excepted), `redirect: 'error'`, and an output URL is fetched by the main process, never the renderer.
  - `basis[quality.change]` — every part re-verifiable by the next reader; evidence before completion.
  - `basis[quality.ui]` — the deliverable is a desktop UI: states, focus, contrast and keyboard reachability
    are part of "working", not decoration.
  - `basis[services.resources]` — video jobs are long, concurrent and billable: a per-provider concurrency
    budget, bounded polling, cancellation, and no blocking of the main interface.

---

## Contract surface (frozen — do not edit without telling the Lead)

| File | Owns |
|---|---|
| `src/shared/types.ts` | domain types, capability keys, media/job types |
| `src/shared/defaults.ts` | provider presets, parameter metadata, model hints (dated), default settings |
| `src/shared/params.ts` | precedence resolution, capability filtering, history trimming |
| `src/shared/schemas.ts` | zod schemas for every IPC payload and stored record |
| `src/shared/provider-contract.ts` | `ProviderAdapter`, the optional media adapters, request specs, parsers |
| `src/shared/api.ts` | the typed `DesktopApi` surface + channel constants |
| `src/shared/repository-contract.ts` | `Database`, repository and sync-repository interfaces |
| `src/shared/media.ts` *(new, PART-004)* | capability→task routing, media types, normalised params, job states |
| `src/main/providers/transport.ts` | the only place provider I/O happens |
| `src/main/db/migrations/index.ts` | the migration registry |
| `scripts/quality-gate.mjs` | the static rules the build enforces |

---

## Part table

| Part | Title | Depends on | Owner-visible outcome |
|---|---|---|---|
| PART-001 | Baseline checkpoint and evidence run | — | ✅ A tagged, tested starting point nobody has to guess about |
| PART-002 | Consolidation: dead code and real defects | 001 | ✅ One chat execution path; nine small defects closed |
| PART-003 | Workspace truth: leftovers, docs, dependencies | 002 | ✅ Tree matches intent; docs stop lying; one dependency gone |
| PART-004 | Capability-based model registry | 002 | ✅ A model can be an image or video model, and the picker knows |
| PART-005 | Media store, job engine, IPC, `media://` | 004 | ✅ The backend a generation can actually run on |
| PART-006 | Image adapters: OpenAI + Gemini | 005 | Two confirmed image providers, mocked-tested |
| PART-007 | Image service and persistence (schema 003) | 006 | Generated images survive a restart and belong to a conversation |
| PART-008 | Image Studio UI | 007 | A dedicated, on-brand image workflow |
| PART-009 | Video adapters and async job lifecycle | 005 | Gemini Omni + BFL, non-blocking, cancellable, resumable |
| PART-010 | Video Studio UI and player | 009 | A video workflow that does not freeze the app |
| PART-011 | Media in conversations | 008, 010 | Generated media lives in the chat, not beside it |
| PART-012 | macOS packaging configuration | 002 | A mac target correct on paper, provable on a mac |
| PART-013 | Verification battery and release gate | all | Evidence, not claims |
| PART-014 | Independent audit of the final state | 013 | Findings from someone who did not write the code |

---

## PART-001 — Baseline checkpoint and evidence run — **COMPLETE 2026-11-03**

**State:** complete. `v0.1.0-baseline` and `mobile-archive-2026-11-03` both point at `76ad3e7`; three commits
(`03341b7` brand, `e4c3d60` mobile archive, `0438336` documents); tree clean; the full battery re-run and green at
`0438336`. Evidence: `PLAN_EVIDENCE.md` §"PART-001 — Baseline checkpoint and evidence run". **PART-002 has not
started.**

- **G:** Establish a tagged, verified starting point, so every later change is a diff against something known
  to be green and "unused"/"dead" claims have a baseline.
- **T:**
  1. Record `git status --porcelain`, `git rev-parse HEAD` and the exact dirty-path list into the run sink.
  2. Run and capture verbatim output **with exit codes**: `npm run typecheck`, `npm test`, `npm run audit:gate`,
     `npm run build` (record the emitted bundle sizes).
  3. Create `git tag -a v0.1.0-baseline 76ad3e7` before any working-tree change is committed.
  4. Take the owner's `mobile/` decision (audit §10 Q1) and commit **exactly** that decision as its own commit.
  5. Commit the brand-asset change (`build/icon*`, `scripts/make-icon.mjs`, `README.md`) as its own commit.
  6. Append every command, exit code and resulting SHA to `PLAN_EVIDENCE.md`.
- **AC:** `v0.1.0-baseline` exists and points at `76ad3e7`; each command has a recorded exit code and none is
  reported passing without one; a **failing suite is recorded as failing and blocks PART-002** (the failure
  case is a red baseline that is reported, not papered over); after the two commits `git status --porcelain`
  shows only ignored paths or nothing; `mobile/` is never again both tracked and absent.
- **V:** `git tag -n | Select-String v0.1.0-baseline`; `git status --porcelain`; the four commands above.
- **Stop condition:** a red baseline on an untouched tree stops the plan and is reported.

---

## PART-002 — Consolidation: dead code and real defects — **COMPLETE 2026-11-03**

**State:** complete, with four items recorded `UNAVAILABLE` rather than claimed: the packaged launch
(environmental — a pristine Electron probe fails identically), the arm64 mac signature (no mac host), and the
two rendered-browser checks that belong to the Playwright pass. Evidence: `PLAN_EVIDENCE.md` §"PART-002".

Ten commits, one concern each: `49228bf` D-01 · `27ae692` D-02 · `c22f1b9` D-03 · `519934c` D-04 · `1379c28`
D-05 · `4454089` D-06 · `5cc2f24` D-07 · `10800f0` D-09 · `a3446b6` dead executor removed · `1c6cc21` D-08.
Gates at `1c6cc21`: typecheck 0, node 611 tests, renderer 175 tests, gate 230 files / 0 blocking, build 0,
`npm run pack` 0.

**Deferred, not silently folded in:** the broken `test:coverage` script and the dead `scripts/**/*.mjs` include
in `tsconfig.node.json`. The owner's scope named the nine audit defects; these two are configuration hygiene
and move to PART-003.

**New finding for the record (not fixed — out of scope):** the CSP is defined twice, once in
`vite.renderer.config.ts` (the `<meta>` tag) and once in `src/main/security.ts` (the response header). They had
already drifted, which is what caused D-02. The parity test now catches divergence, but the duplication itself
deserves a single source of truth; that is a build-config refactor and belongs in PART-003 or later.

---

## PART-002 (original brief)

- **G:** One authoritative implementation per concern, and the audit's proven defects closed, without touching
  anything that already works.
- **T:**
  1. Prove `src/main/providers/executor.ts` is unreferenced, then — **after the owner confirms this single
     tracked-file deletion** — delete it, its barrel export (`src/main/providers/index.ts`) and its test, or
     make it a thin wrapper over the shared transport if a consumer appears. **Never delete the transport.**
     Revert is one command: `git checkout v0.1.0-baseline -- src/main/providers/executor.ts src/main/providers/index.ts tests/main/providers/executor.test.ts`.
  2. `tokens.css`: add `--size-prose: 65ch;` (D-01).
  3. `security.ts`: add `"media-src 'self' blob:"` to `devCsp` (D-02).
  4. Extract `components/ui/ConfirmDialog.tsx` on the existing `Dialog`; migrate the four call sites; keep
     `initialFocus="cancel"` and each site's existing copy (editing the copy is a separate change) (D-03).
  5. `package.json`: make `dist` depend on `audit:gate`, `typecheck`, `test` (D-04); fix or remove
     `test:coverage`; drop the dead `scripts/**/*.mjs` include from `tsconfig.node.json` (D-06).
  6. `quality-gate.mjs`: scan `scripts/` and `tests/` as well as `src/` (D-06).
  7. `smoke-packaged.mjs` and `tests/main/db/helpers.ts`: stop hardcoding `.work/2026-10-29-personal-ai-desk`;
     compute the run directory (D-05).
  8. `Markdown.tsx`: keep remote images blocked, correct the doc comment to match the code (D-07); add
     `margin-inline: auto` to `.pds-page__body` (H-06); give the two attach buttons real distinct behaviour via
     `pick({ kinds })` + dialog filters (D-08).
- **AC:** `grep -rn "executor" src/` shows no import outside the deleted test and `npm run typecheck` exits 0;
  a test asserts `--size-prose` is defined as `65ch`; a test asserts the dev CSP contains `media-src`;
  `ConfirmDialog` is imported by all four former sites and the sidebar delete test still passes;
  `npm run dist` fails fast when a gate rule is broken (assert by breaking one — the failure case);
  `npm test` exits 0 with **no assertion weakened**.
- **V:** `npm run typecheck`; `npm test`; `npm run audit:gate`; `npm run build`.

---

## PART-003 — Workspace truth: leftovers, docs, dependencies — **COMPLETE 2026-11-03**

**State:** complete. Evidence: `PLAN_EVIDENCE.md` §"PART-003". Commits `bd19006` (dependency), `0d642c1`
(docs truth), `a3fafb7` (backup register), `c952840` (config hygiene). The leftover sweep is **planned and
deliberately not executed** — no batch approval exists, so nothing was removed:
`.work/…/out/leftover-plan-2026-11-03.md`.

---

## PART-003 (original brief)

- **G:** Make the repository say what it is: remove only what is proven unreferenced, under a gate, and correct
  the documentation that contradicts the code.
- **T:**
  1. Remove the direct `highlight.js` dependency; re-run the renderer suite; verify highlighted code blocks
     still render (the pinned copy is what resolved first today).
  2. `MASTER_PLAN.md` / `PLAN_EVIDENCE.md`: v0.1 is archived at `docs/history/MASTER_PLAN-v0.1.md` — **keep
     both files**, they are the record of the previous audit cycle.
  3. Sweep `Personal AI Desk` → `Grenjo AI Tool` in `docs/FEATURES.md`, `docs/THREAT-MODEL.md`,
     `electron-builder.yml`, `.env.example`, `README.md`; keep one explicit legacy-migration note (H-01).
  4. Correct `docs/FEATURES.md`: the mobile row (H-02), the two installer sizes (H-02), the bundle-size table
     (H-04), the "web or mobile client — not built" claim.
  5. `release/`: a **backup family, not a sweep target**. Record both installers in `backups/BACKUPS.md` with
     disposition, bytes and sha256; keep both until a restore drill exists.
  6. `.work/`: apply the organizer's classification. `2026-10-29-ui-screenshot` and the audits it backs stay;
     `2026-10-29-personal-ai-desk` stays until D-05 runs once and nothing cites it; `2026-10-30-mobile` is held
     until the `mobile/` decision lands. **No deletion without a shown plan.**
  7. `.env.example`: reduce to the variables the code reads, or delete it and state that `.env` is not used.
- **AC:** `npm ls --depth=0` shows **25** direct dependencies (26 today, one removed) and `npm ls highlight.js`
  shows only the transitive copy, with the markdown suite green and `.hljs-*` classes still emitted;
  `grep -rn "Personal AI Desk"` over the named files returns only the deliberate migration note; `.work/` and
  `release/` are untouched except the `BACKUPS.md` record — **a deletion that was not shown first is a failure
  case**; no tracked file is removed here except `executor.ts` from PART-002.
- **V:** `npm test`; `npm ls --depth=0`; the greps above; `git status --porcelain`.

---

## PART-004 — Capability-based model registry — **COMPLETE 2026-11-03**

**State:** complete. Commits `a77175c` (contract), `7f8181d` (discovery + hints + probe), `c7cb927` (routing
tests + legacy import), `9b1d41c` (UI). Evidence: `PLAN_EVIDENCE.md` §"PART-004". Gates at `9b1d41c`:
typecheck 0, node **624**, renderer **195**, gate 235 files / 0 blocking, build 0.

---

## PART-004 (original brief)

- **G:** Stop treating every model as a chat model. A model declares one or more capabilities; a task selects
  only models that have it; a provider that cannot do the task is visibly unavailable rather than attempted.
- **T:**
  1. `src/shared/media.ts` (new): the capability vocabulary — `textGeneration · imageUnderstanding ·
     imageGeneration · imageEditing · videoUnderstanding · videoGeneration · audioInput · audioOutput ·
     embeddings` — plus the task→capability map (`chat → textGeneration`, `image → imageGeneration |
     imageEditing`, `video → videoGeneration`) and one `supports(model, capability)` helper. One source,
     imported everywhere.
  2. `ModelCapabilities`: extend **additively**, keeping `chat`, `streaming`, `imageInput`, `toolCalling`
     readable so stored rows and exported configs still parse. Document that `chat` means text generation.
  3. `shared/schemas.ts`: widen the `.strict()` capability schema to accept the new keys **and** the legacy
     ones; test that an old exported config still imports.
  4. `db/domain-codec.ts`: tolerant read; missing flags default to `false`; `chat` remains text generation.
  5. `providers/capabilities.ts`: keep provenance honesty — output modality is **never** inferred from a
     model-id substring; it comes from a curated hint or an explicit user declaration, labelled as such.
  6. `defaults.ts` `MODEL_HINTS`: dated hints for the confirmed image/video models, with `shutdownDate` where
     published; the picker filters `shutdownDate > today`.
  7. Discovery (B-02): stop deleting non-chat ids; store them with a labelled capability and exclude them from
     the chat selector only.
  8. `services/models.ts` probe (B-07): branch on capability; a model with no probe path reports "cannot be
     tested here" instead of a false failure.
  9. Custom model registration: capability checkboxes write the new keys; the UI shows which task each model
     serves.
- **AC:** typecheck passes; `modelsForTask('image')` returns an image-only model and `modelsForTask('chat')`
  does **not** (the negative case is asserted); a fixture config written with the old four-flag object still
  parses and behaves as a text model; a model with no declared capability is not offered for an image task and
  the copy says so; no model-id substring can set `imageGeneration`/`videoGeneration` (assert with a
  chat-only model whose id contains "image").
- **V:** `npm run typecheck`; `npm test -- --run tests/main/models tests/renderer/pages/models`.

---

## PART-005 — Media store, job engine, IPC surface, `media://` — **COMPLETE 2026-11-03**

**State:** complete. Commits `c663408` (schema 3 + store), `3ef1d2a` (engine), `e85958e` (service), `af8ff40`
(IPC + protocol + CSP). Evidence: `PLAN_EVIDENCE.md` §"PART-005". Gates at `9e67925`: typecheck 0, node **692**
tests, renderer 195, gate 250 files / 0 blocking, build 0.

**Deliberately not claimed:** no media adapter is registered yet, so `media.generate` answers "no adapter in
this build". PART-006 registers the first two and turns that into a working feature — verified against mocks,
with live provider calls reported `UNAVAILABLE` without keys.

---

## PART-005 (original brief)

- **G:** Give generation somewhere to live: durable bytes, a job that survives a restart, progress that reaches
  the renderer, and a way to display a 40 MB video without base64-ing it through IPC.
- **T:**
  1. `src/main/media/store.ts`: content-addressed writes (`userData/media/<sha256>.<ext>`), atomic
     write-then-rename (reuse `attachments/store.ts`'s mechanism, **not** its lifetime), sidecar metadata,
     per-kind size caps, and a `delete` that only ever touches the media root.
  2. `src/main/db/migrations/003-media.ts`: a `media` table (id, kind, provider, model, prompt, params JSON,
     width, height, duration_ms, bytes, sha256, mime, relative path, conversation_id, message_id, job_id,
     created_at) and a `generation_jobs` table (id, capability, provider, model, status, progress, remote_id,
     poll_url, error code/message, attempts, next_attempt_at, created_at, updated_at, finished_at). Sync header
     columns only if the owner decides media syncs (Q4) — default: local only.
  3. `src/main/media/jobs.ts`: the job state machine, a **bounded** poll loop with backoff and jitter, a
     per-provider concurrency budget, cancellation, and crash recovery (unfinished jobs resume; a job whose
     provider handle is gone becomes `expired`, never retried forever).
  4. `src/main/media/service.ts`: capability → eligible providers/models resolution (fixing the
     provider/adapter mismatch the transcription path has), submit, poll, download-and-persist, cancel.
  5. `src/shared/api.ts` + `src/preload/index.ts` + `src/main/ipc/register.ts`: a `media` namespace —
     `list`, `get`, `generate`, `cancel`, `remove`, `reveal`, `export`, `onEvent` — each with a zod schema and
     the sender assertion.
  6. A `media://` protocol handler in main restricted to the media root, with `media-src`/`img-src` extended to
     it. **`connect-src` stays `'none'`.**
  7. Settings: default image/video provider+model, media folder cap, explicit retention policy.
- **AC:** migration 003 applies to a v2 database and to a fresh one, and the runner's newer-schema refusal
  still fires (failure case: a v4 database against a v3 build); a job submitted and then resumed by a new
  service instance over the same DB completes **exactly once**; cancel marks `canceled` and writes no media
  row; an over-deadline poll becomes `failed` with a retryable flag and a bounded retry budget; `media://`
  refuses `../../` and absolute paths; no generated byte crosses IPC as a JSON string.
- **V:** `npm test -- --run tests/main/media tests/main/db`; `npm run typecheck`.

---

## PART-006 — Image adapters: OpenAI + Gemini

- **G:** Two confirmed image providers behind one contract, following the existing build-request/parse-response
  split so both are testable offline.
- **T:**
  1. `shared/provider-contract.ts`: optional `imageGeneration?: ImageGenerationAdapter` — build request, parse
     response, parse error, declare supported parameters and limits. An absent capability is a UI fact, never
     a silent no-op (same shape as `TranscriptionAdapter`).
  2. `main/providers/openaiImages.ts`: `/v1/images/generations` and `/v1/images/edits` (JSON body, `images[]` of
     `image_url` data URLs). Reuse the provider row's base URL + Bearer key. Support `model`, `prompt`, `n`
     1–10, `size` (presets + arbitrary `WxH` ÷16 within documented bounds), `quality`, `background`,
     `output_format`, `output_compression`, `moderation`, reference images (≤16), `mask`, `markup`,
     `input_fidelity`, `safety_identifier`. **No `negative_prompt`, no `seed`, no `aspect_ratio`** — those
     controls are absent for this provider with a note saying the API has no such field.
  3. `main/providers/geminiInteractions.ts`: `POST /v1beta/interactions` with `input` blocks and
     `response_format: [{type:'image', mime_type, aspect_ratio, image_size}]`. Parse by iterating
     `steps[] → model_output → content[type==='image'].data` — **not** the SDK-only `output_image` convenience.
     Reference images as `image` blocks. No `negative_prompt`/`seed`/`n`.
  4. Model-id table with `shutdownDate`; the adapter refuses an unknown or expired id with a clear message
     instead of posting it.
  5. Error mapping: `moderation_blocked` / `image_generation_user_error` are **non-retryable** and surface the
     documented reason; 429/5xx retry with backoff and honour `Retry-After`.
- **AC:** offline fixture tests per provider: request body for a text-only and a reference-image call,
  response parse for one and for three images, error parse for moderation and for a 500; a test proves a
  negative-prompt control is not offered for either provider (sending an unknown field must be impossible by
  construction, not by memory); a test proves a shutdown-listed model id is rejected before any HTTP call;
  one **live** generation per provider is recorded `UNAVAILABLE` without the owner's key, never `PASSED`.
- **V:** `npm test -- --run tests/main/providers`; `npm run typecheck`.

---

## PART-007 — Image service and persistence

- **G:** A generation produces an image that is still there tomorrow, belongs to a conversation when asked,
  and can be exported.
- **T:**
  1. Wire `media/service.ts` to the image adapters: resolve an eligible provider/model for `imageGeneration` /
     `imageEditing`, submit, persist bytes + a `media` row, emit progress.
  2. Conversation association: `generate` accepts an optional `conversationId`; when present the media row is
     linked and an attachment is attached to the assistant reply — **outside** `chat/service.execute()`, so
     B-06 is not touched.
  3. Export/save through a main-process `media.export` using the native save dialog (never a renderer-supplied
     path); `reveal` in the OS file manager, guarded to the media root.
- **AC:** a mocked generation writes one file under `userData/media/`, one `media` row, and the stored sha256
  matches the file; deleting the row deletes exactly one file and a sibling survives; a failed generation
  writes **no** media row (failure case); export outside the user's chosen location is impossible by
  construction; a generated image linked to a conversation appears in that conversation after a reload.
- **V:** `npm test -- --run tests/main/media tests/main/chat`.

---

## PART-008 — Image Studio UI

- **G:** A dedicated image workflow that looks like this product, does not clutter the chat, and never offers a
  control the selected model cannot honour.
- **T:**
  1. Route + nav: `image` in `RouteName`, `ROUTE_META`, `ROUTE_ORDER`, `NAV_ICONS` (`ImageIcon` exists),
     `RouteView`; update `app-shell.test.tsx`'s hardcoded nav list.
  2. `pages/image/ImagePage.tsx` + `image.css` using `Page`, `Button`, `IconButton`, `Textarea`+`Field`,
     `Select`, `Skeleton`, `EmptyState`, `ErrorState`, `Badge`, `Card`. Tokens only.
  3. Prompt + optional negative prompt (only when the model declares it), size/aspect, quality, output count,
     reference-image upload (reusing the chat chip pattern and `limitRejection`), and an edit mode when the
     model declares `imageEditing`.
  4. Progress: the new `Progress` primitive (`role="progressbar"`, `aria-valuenow`) plus a polite status
     region for indeterminate states; **cancel appears only when the adapter declares it**.
  5. History: a `MediaGrid` of past generations (provider, model, prompt, dimensions, date), filtered by task.
  6. Preview: `MediaPreview` on the existing `Dialog` (zoom, save, copy prompt, "use as reference").
  7. Card actions visible, not hover-only (audit UI-10).
  8. **Evidence tooling (Q5):** add `@playwright/test` and `@axe-core/playwright` as exact-pinned dev
     dependencies, a `playwright.config.ts` pointing at the built renderer, one viewport test at the 940×600
     minimum and one axe scan of the Image page. This is the only part that adds test dependencies; if the
     owner declines Q5, this item is dropped and the AC's viewport/contrast checks become a recorded manual pass.
- **AC:** jsdom tests cover loading/empty/error/success; a model without `imageGeneration` is not listed; a
  model without `imageEditing` hides the edit tab; progress is announced through a live region; cancel calls
  `media.cancel` with the right job id and is absent for a provider that cannot cancel; no raw colour or
  radius in `image.css`; the nav has 7 entries asserted by the shell test; **no horizontal scroll at 940×600**,
  proven by the Playwright viewport test (or a recorded manual pass if Q5 is declined); **the axe scan reports
  zero serious or critical violations**, with any accepted exception named.
- **V:** `npm test -- --run tests/renderer`; `npm run typecheck`.

---

## PART-009 — Video adapters and the async job lifecycle

- **G:** Video generation that behaves like a background job, not a frozen window: submit, poll, resume,
  cancel, expire, retry within bounds.
- **T:**
  1. `shared/provider-contract.ts`: optional `videoGeneration?: VideoGenerationAdapter` — submit, poll, parse
     status, parse error, declare inputs (`text`, `image`, `referenceImages`) and controls.
  2. Gemini video: submit to `interactions` with `model: 'gemini-omni-1.1-flash'` and
     `response_format: {type:'video', aspect_ratio, resolution}`; `background=true` for long jobs; poll
     `GET /v1beta/interactions/{id}`; read `steps[] → content[type==='video'].data`; request `delivery:'uri'`
     for >4 MB and download immediately. **No duration field, no negative prompt** — say so in the UI.
  3. `main/providers/bfl.ts`: `POST https://api.bfl.ai/v1/flux-3-video` with `x-key`, `mode:'t2v'`; poll
     `polling_url`; `Ready` → `result.sample` (signed URL, 10-minute life) → **download now**;
     `Error`/`Failed` → terminal; any other status → keep polling. Respect the documented 24-task budget;
     surface 429/402 as distinct and non-looping.
  4. Job lifecycle: bounded polling with jitter, per-provider semaphore, deadline, crash recovery, and
     `expired` for a handle that no longer resolves.
  5. Image-to-video where declared (`image` input block / reference image); hidden otherwise.
- **AC:** fixture tests per provider cover submit body, status mapping, "expiring URL is downloaded before the
  row is written", and a 10-minute-expired URL producing a clear "the provider's link expired; regenerate"
  error instead of a broken file; a restart mid-job resumes polling and writes exactly one media row; the
  semaphore never exceeds the documented limit; one live generation per provider is `UNAVAILABLE` without a
  key.
- **V:** `npm test -- --run tests/main/media tests/main/providers`.

---

## PART-010 — Video Studio UI and player

- **G:** A video workflow with honest progress and a player that works from disk under the app's CSP.
- **T:**
  1. Route + nav (`video`, new `VideoIcon` in the existing icon family), page frame, loading/empty/error
     states.
  2. Prompt, image-to-video reference (only when declared), aspect ratio (9:16 / 16:9), resolution, model.
  3. Job list with status, elapsed time, cancel where supported, and resume-after-restart.
  4. Player: `<video controls>` fed by a `media://` URL; **no autoplay** (respect `prefers-reduced-motion`);
     poster frame; intrinsic dimensions to avoid layout shift.
  5. Preview/export via the shared `MediaPreview` + native save dialog.
- **AC:** the page shows the job's real state after navigating away and back (store, not component state); a
  canceled job stops polling and shows `canceled`; the `<video>` `src` is a `media://` URL and the renderer
  never receives base64 video; no autoplay attribute exists in the tree.
- **V:** `npm test -- --run tests/renderer`; `npm run typecheck`.

---

## PART-011 — Media in conversations

- **G:** Generated media belongs to the conversation that asked for it, without turning the chat into a studio.
- **T:**
  1. `MessageAttachment` gains the `video` kind; `AttachmentList` gains a video chip with duration; the message
     view renders a `MediaCard` for generated assets (**never** through Markdown — D-07/B-06).
  2. A compact "Generate an image from this message" action that opens the Image page pre-filled; **no**
     generation controls inside the normal composer.
  3. Reopening a conversation re-reads media from disk by id; a missing file renders a clear "file was removed"
     state, not a broken image.
- **AC:** a generated image appears inline in its conversation and survives a restart; deleting the file out
  from under the app produces the missing-file state, not a crash (failure case); the composer's control count
  is unchanged (asserted).
- **V:** `npm test -- --run tests/renderer`; `npm test -- --run tests/main/chat`.

---

## PART-012 — macOS packaging configuration

- **G:** A mac target correct on paper, provable on a mac, and without duplicating a line of application code.
- **T:**
  1. `electron-builder.yml`: add a `mac:` block — `dmg` + `zip`, `category`, `icon: build/icon.icns`,
     `hardenedRuntime: true`, `gatekeeperAssess: false`, `entitlements` + `entitlementsInherit`,
     `artifactName`, and `extendInfo.NSMicrophoneUsageDescription`.
  2. `build/entitlements.mac.plist`: `com.apple.security.cs.allow-jit`, `com.apple.security.device.audio-input`.
  3. `after-pack.cjs`: `resetAdHocDarwinSignature: true` for `arm64` (D-09).
  4. `dist:mac` / `pack:mac` scripts; Windows scripts unchanged.
  5. `smoke-packaged.mjs`: per-platform bundle candidates and a per-platform appData root (audit F-25).
  6. `docs/THREAT-MODEL.md`: record the entitlement widening as a new assumption, not a copy of the Windows one.
  7. Build instructions for Windows, macOS and the web renderer.
- **AC:** `electron-builder --mac --dir` on a mac produces a launchable `.app` whose microphone prompt appears —
  **impossible on this host and recorded `UNAVAILABLE` with the exact command for the owner**; the Windows
  build is unchanged (`npm run dist` + `npm run smoke:packaged` still pass); no source file exists solely for
  macOS.
- **V:** `npm run dist` (Windows) + the recorded mac command; `npm run smoke:packaged`.

---

## PART-013 — Verification battery and release gate

- **G:** Prove it, then ship it.
- **T:**
  1. Full battery with recorded exit codes: `npm run audit:gate`, `npm run typecheck`, `npm test`,
     `npm run build`, `npm run dist`, `npm run smoke:packaged`.
  2. Re-certify the installer: hash the produced exe, record it in `docs/FEATURES.md`, and record an
     install → launch → generate an image → generate a video → uninstall → **data survives reinstall** cycle.
  3. Migration drill: open a copy of a real v2 database with the new build; confirm chats/settings/keys
     survive, and state the documented no-downgrade consequence.
  4. Performance sanity: renderer bundle size before/after; the largest media file tolerated.
  5. Release gate: go / go-with-conditions / no-go, each item PASS, FAIL or WAIVED-with-owner.
  6. Updated build instructions for Windows, macOS and the web renderer.
- **AC:** every command has a recorded exit code and nothing is `PASSED` without one; the user-data survival
  test records actual before/after row counts; the gate names every `UNAVAILABLE` item and its owner.
- **V:** the recorded command log itself.

---

## PART-014 — Independent audit of the final state

- **G:** A second pair of eyes on the finished work, by someone who did not write it.
- **T:**
  1. A non-author auditor reads the final diff against `v0.1.0-baseline` and applies `senior-work-audit` +
     `senior-code-review` + `senior-supply-chain-audit` + `senior-release-gate`.
  2. Findings are reported **as they come back**, including ones the Lead disagrees with.
  3. Fix-only pass for blocking findings, then re-verify.
- **AC:** the audit states the audited SHA, the commands run with exit codes, and a proven/claimed split; no
  blocking finding is open at close or it is explicitly accepted with an owner and a date; "the author checked
  it" is never offered as the audit.
- **V:** the audit report + `git rev-parse HEAD`.

---

## Execution rules for this plan

1. **One part at a time.** Do not start a part whose dependency is incomplete.
2. **Evidence before completion.** `plannable evidence` is unavailable (CLI absent), so each part appends a
   row to `PLAN_EVIDENCE.md` with the command, its real output and a verdict
   (`PLANNED` / `IMPLEMENTED` / `PASSED` / `UNAVAILABLE`).
3. **No unrelated edits.** A part that needs a file outside its scope says so first.
4. **Stop conditions are honoured:** a red baseline, an ambiguous deletion, a provider claim without a
   documented source, or a test that only passes after its assertions were weakened.
5. **Never automated:** deleting tracked files, moving backups, a schema change that forbids downgrade, and
   anything touching credentials.
6. **Two hard `UNAVAILABLE`s** (live provider calls, macOS execution) are reported as such at every subsequent
   gate — never quietly upgraded to `PASSED`.

---

## Open decisions (blocking PART-001 / PART-004 scope)

| # | Decision | Default if unanswered |
|---|---|---|
| Q1 | `mobile/`: archive it (tag + commit the deletion), keep and share the 11 contract files, or restore it | **archive** — it is unreferenced by every build path |
| Q2 | Image providers for the first ship | **OpenAI + Gemini** |
| Q3 | Video providers | **Gemini Omni + BFL**; Veo GA deferred (needs Google Cloud auth, wire format unverified) |
| Q4 | Should generated media sync to Supabase? | **No, and never automatically.** The already-shipped v0.1 sync engine continues to sync conversations, agents, custom models and settings — that is the "optional cloud sync" half of the owner's phase 7 and needs **no new work**, only regression coverage in PART-013. **Media sync is explicitly deferred**: PART-005 ships the table without sync header columns, and enabling it later is a separate, owner-approved change covering `sync/tables.ts`, the entity union, the RPC switches and the `sync_conflicts` constraint (audit B-08) |
| Q5 | Add Playwright + axe before the media UI? | **Yes.** It is a work item, not a preference: PART-008 T.1 installs `@playwright/test` and `@axe-core/playwright` (exact-pinned), adds the config and one viewport + one axe check, and PART-013 runs them. If the owner declines, PART-008's viewport and contrast checks downgrade to a recorded manual pass and the gate says so |
