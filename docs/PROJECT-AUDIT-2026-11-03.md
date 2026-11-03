# Grenjo AI Tool — Phase 1 project audit (2026-11-03)

**Scope:** the whole repository at `D:\MyAI` (branch `master`, HEAD `76ad3e7`), plus a research pass over the
official image- and video-generation provider documentation.
**Mode:** the audit workstream itself was **read-only** — no file was deleted, moved or renamed, and the
read-only auditors changed nothing in the tree. This run did write, as separate deliverables: two replaced icon
binaries (`build/icon.png`, `build/icon.ico`), a rewritten `scripts/make-icon.mjs`, two new assets
(`build/icon-source.png`, `build/icon.icns`), a one-line `README.md` alt-text change, and these documents
(this report, `MASTER_PLAN.md`, `PLAN_EVIDENCE.md`, `docs/history/MASTER_PLAN-v0.1.md`). §9 describes the icon
work. The pre-existing 63 `mobile/` deletions were **not** made by this run.
**Verdict:** the desktop application is **one clean implementation, not a pile of versions**. There is no
duplicated provider layer, no stale second desktop codebase, and no dead build file. The real duplication is one
**mobile** tree — 63 files, of which **11 (2,526 lines) are byte-identical to `src/`** — and the real risk is
not duplication at all: it is that the capability model is chat-only, so image and video models are **actively
filtered out of discovery** and cannot be represented anywhere in the app.

---

## 1. How this audit was produced (evidence status)

| Workstream | Method | Status |
|---|---|---|
| Main process, shared contracts, DB, sync | File-by-file read, `file:line` citations | **CONFIRMED** (read-only) |
| Renderer, design tokens, media UX | 44 renderer files read; scripted diff of 137 token definitions against every `var(--…)` use | **CONFIRMED** (read-only) |
| Build, packaging, dependencies, leftovers | `git`, `npm ls`, `npm audit`, `npm audit --omit=dev`, lockfile parse, `app.asar` listing, byte measurements | **CONFIRMED** (read-only) |
| Provider image/video APIs | Official documentation only (fetch date 2026-11-03), 15-row UNVERIFIED register | **CONFIRMED vs documented**; **zero live API calls** |
| OpenAI image API (independent re-check by the Lead) | Fetched `developers.openai.com/api/reference/resources/images` | **CONFIRMED** — model list, retired `/images/variations`, `gpt-image-1` shutdown date, 16 reference images, mask/markup, arbitrary `WxH`, b64-only output, `n` 1–10 |
| Runtime behaviour (chat, providers, builds) | **Baseline battery executed** by the engineering workstream — `typecheck`, both suites, `audit:gate` and `build` all exit 0, recorded in `PLAN_EVIDENCE.md` §"PART-001 pre-check". **Not** exercised: live provider calls, a packaged launch, a macOS build | **PASSED** (baseline) / **UNAVAILABLE** (live calls, mac, packaged launch) |

Everything below is either a reading with a `file:line`, a measured number with the command that produced it,
or explicitly labelled `UNVERIFIED`. Nothing is inferred from a filename.

---

## 2. What the project actually is

| Fact | Value |
|---|---|
| Product | **Grenjo AI Tool** 0.1.0 (renamed from "Personal AI Desk"; one-time profile migration) |
| Shape | Electron 44 desktop app, React 19 renderer, TypeScript 5.9, Vite 7, zustand, zod, `node:sqlite` |
| Tracked files | **326** — `src/` 157, `tests/` 78, `mobile/` 63, `scripts/` 5, `supabase/` 3, `docs/` 2, `build/` 2, root configs |
| Git history | 5 commits: initial build → rename → attachments/voice → mobile app → audit verdict |
| Working tree | **not clean**: 63 unstaged deletions (all `mobile/`), plus the icon/README changes from this run |
| Providers today | DeepSeek, OpenAI, Google Gemini, Anthropic, custom OpenAI-compatible — **chat only** |
| Capabilities today | `chat, streaming, imageInput, toolCalling` — no output modality |
| Web application | **There is no separate web app.** The renderer is a Chromium page loaded from `file://`; "web" in the brief maps to that renderer plus the optional Supabase sync. This matters for the deliverables phase's "build instructions for Windows, macOS and web": the web instruction is *how to build and serve the renderer*, not a second service. |
| macOS | **No `mac:` target, no `.icns`, no entitlements, no microphone usage string.** §8 |
| Platform code duplication | **None in `src/`.** The only Windows-specific code is packaging config and two scripts. |

---

## 3. Answers to the six questions Phase 1 asks

### 3.1 Files that are actively used

Every one of the 326 tracked files is reachable except the ones named in §3.3. The load-bearing spine:

| Area | Authoritative files |
|---|---|
| Contracts | `src/shared/{types,schemas,defaults,params,errors,api,provider-contract,repository-contract,url-policy,attachments,settings}.ts` |
| Provider wire layer | `src/main/providers/openaiFamily.ts` (shared Chat-Completions shape) + thin adapters `openai.ts`, `deepseek.ts`, `openaiCompatible.ts`, + native `gemini.ts`, `anthropic.ts`; `transport.ts` is the only place HTTP happens |
| Orchestration | `src/main/chat/service.ts`, `src/main/providers/executor.ts` (dead — see §3.3) |
| Persistence | `src/main/db/{connection,migrations,repositories}` — schema version **2**, additive migration runner |
| Privileged surface | `src/main/ipc/{handler,register}.ts` (zod-validated, sender-asserted), `src/preload/index.ts` |
| UI | `src/renderer/App.tsx` + 5 real pages (Chat, Agents, Models, Settings, Sync) + `components/ui` primitives |

### 3.2 Files that are duplicated or overlapping

| Duplication | Measurement | Verdict |
|---|---|---|
| `mobile/**` vs `src/**` | **11 files byte-identical** by `git ls-tree` blob SHA: `types.ts` (463), `defaults.ts` (480), `schemas.ts` (310), `errors.ts` (255), `params.ts` (219), `provider-contract.ts` (232), `settings.ts` (165), `attachments.ts` (151), `sse.ts` (103), `url-policy.ts` (88), `multipart.ts` (60) = **2,526 lines = 28.6 % of mobile's 8,829 TS/TSX lines** | **The owner's actual complaint, measured.** Two copies of one contract, already copied-and-diverged. |
| `mobile/src/ai/providers/*` vs `src/main/providers/*` | A second, independent provider implementation (deepseek, gemini, anthropic, json, multipart, capabilities…) | Removed from disk but still in HEAD. This is what makes "is the provider layer duplicated?" answer **not yet settled** — see §3.3. |
| `openai.ts` / `deepseek.ts` / `openaiCompatible.ts` | 152 / 48 / 56 lines over one 385-line shared module, differing only by a 5-field profile | **Not duplication.** This is the pattern to copy for a new modality. |
| Destructive-confirm UI | Four hand-rolled copies (`ConversationSidebar`, `ProviderCard`, `ModelsSection`, `AgentsPage`), no `ConfirmDialog` primitive | Real duplication; a delete-asset flow would add a fifth. |
| Async-resource hooks | Four near-identical hooks (`useCatalog`, `useAgentResources`, `useSettingsResources`, `useSyncState`) | Real duplication; a generation page would add a fifth. |
| Model-catalog scans | Three independent scans of the one `MODEL_HINTS` array | Data is single-source; the *scans* are duplicated. |
| Sync entity set | Enumerated in three places + two switches + a SQL `CHECK` | Compiler-gated (`Record<SyncEntityKind,…>`), so omission is a type error. |

### 3.3 Files that are obsolete

| Item | Evidence it is unused | Safety class |
|---|---|---|
| `src/main/providers/executor.ts` + its barrel export in `src/main/providers/index.ts` | **No production module imports the barrel.** Only `tests/main/providers/executor.test.ts` does. It also builds its **own** transport per call (`executor.ts:51`), breaking the "one transport" invariant. | **Disposable after an import check** (test updated in the same commit) |
| `mobile/**` (63 files, 1,162,074 B) | Present in HEAD, **absent from disk**, not ignored. Not referenced by `package.json`, `electron-builder.yml`'s `files` allowlist, any `tsconfig`, either `vitest` config, or `scripts/quality-gate.mjs`. **0** `mobile/` paths inside `app.asar`. | **Tracked** → needs a decision and an archive tag, not a delete (§3.4) |
| `MASTER_PLAN.md` (24,343 B) + `PLAN_EVIDENCE.md` (12,081 B) as they stood at HEAD | Tracked; they described the **previous** version ("Personal AI Desk"), PART-001…016, no mobile part. No script reads them. They are also the only record of the prior audit cycle. | **Keep as history**, mark superseded. Do not delete. **Done in this run:** the v0.1 plan is archived byte-identically at `docs/history/MASTER_PLAN-v0.1.md`, and the two live files are rewritten for v0.2 (the v0.1 evidence rows are preserved above the new section). |
| `highlight.js@11.12.0` (direct dependency) | **Zero imports** in 239 source/test/script/config files; only `.hljs-*` class names in CSS; `rehype-highlight → lowlight` already ships `11.11.2`. Duplicate version + 5.2 MB / 1,569 files in `app.asar`. | **Disposable** after a renderer-suite re-run |
| `test:coverage` npm script | `@vitest/coverage-v8` / `istanbul` are **not installed** and there is no root `vitest.config`, so the script cannot run | **Disposable** (or install the provider) |
| `include: ["scripts/**/*.mjs"]` in `tsconfig.node.json:16` | No `allowJs`/`checkJs` anywhere, so the build scripts are **not** typechecked despite the config | **Disposable line** |
| `.env.example` variables `PERSONAL_AI_DESK_LOG_LEVEL`, `PERSONAL_AI_DESK_DEV_PORT`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Grep of `process.env.*` in `src/` + `scripts/` finds only `VITE_DEV_SERVER_URL`, `ICON_PREVIEW_DIR`, `APPDATA`. The file's own comment admits the Supabase values are not read. | **Obsolete content**, keep the file |
| `dist/` (1.9 MB), `release/` (644.1 MB), `node_modules/` (568.6 MB) | Ignored, regenerable | **S2** (generated). `release/` also holds a **two-copy backup family** — see §3.5 |

### 3.4 Files required for backward compatibility

These must not be touched without a migration:

- `src/main/db/migrations/001-*`, `002-*` and the runner in `migrations/index.ts` — the runner **refuses to open a database newer than the build** (`index.ts:74-81`). Once schema 3 ships, the previous build will not start against that profile. That is a real, permanent consequence: **no downgrade path.**
- `src/main/profile.ts:12-16` — `USER_DATA_FOLDER = 'Grenjo AI Tool'` + one-time migration from `%APPDATA%\Personal AI Desk`. Existing users' chats, keys and settings live there.
- `src/main/db/domain-codec.ts` — tolerant reads of stored capability flags; any new capability field must keep the old four readable.
- `src/shared/schemas.ts` — `.strict()` objects. Adding a field to `ModelCapabilities` **without** widening these schemas breaks config import and custom-model upsert.
- `supabase/migrations/0001_init.sql`, `0002_rls.sql` — the RLS control that a test parses.
- `src/main/providers/*` wire shapes — existing conversations and stored model rows depend on them.

### 3.5 Features that exist in more than one implementation

| Feature | Implementations | Action |
|---|---|---|
| Provider adapters | `src/main/providers/*` and `mobile/src/ai/providers/*` | One survives: **`src/main`**. §3.3 |
| Shared contracts | `src/shared/*` and `mobile/src/core/*` | Keep `src/shared`; mobile's copy is the duplication to remove |
| Destructive confirmation UI | Four page-local copies | Extract one `ConfirmDialog` |
| Async resource loading | Four page-local hooks | One `useResource` |
| Model-probe | `services/models.ts` (chat-shaped) vs the discovery path | Not duplicated, but the probe cannot test a non-chat model — see **B-04** |
| Chat execution | `chat/service.ts` (live) vs `providers/executor.ts` (dead) | Delete the dead one |

### 3.6 Dependencies that are no longer necessary

**Exactly one: `highlight.js@11.12.0`.** Everything else is used, and the apparently unused ones were each
verified through the mechanism that consumes them (`@types/*` via tsconfig/JSX, `jsdom` and
`@vitejs/plugin-react` via configs, `@testing-library/dom` as a **required peer** of `@testing-library/react`
16, `electron-builder`/`typescript` via CLI). `npm ls --depth=0` → **26 direct dependencies** (27 rows, the
27th being the project itself), `problems: []`.
All 27 direct deps are pinned exact; lockfile has 615 entries, **0** missing `integrity`, **0** non-registry
sources; **0** install scripts in the direct set.
`npm audit` → 18 advisories, **all dev-only** (`npm audit --omit=dev` → 0). The two criticals (`tinypool`,
`@vitest/mocker`) require attacker-controlled input *inside a test run*; npm's suggested fix is a
**downgrade** to `electron-builder@20.23.1` — do not take it.

---

## 4. Findings, ranked (E4: exploitability and blast radius first)

`B` = blocks image/video support · `D` = real defect, costs someone a day · `H` = hygiene.

### 4.1 Blockers for the new capabilities

| ID | Finding | `file:line` | Impact | Smallest fix |
|---|---|---|---|---|
| **B-01** | `ModelCapabilities` is a closed 4-boolean **chat** record: `{chat, streaming, imageInput, toolCalling}`. No output modality exists, and `.strict()` zod schemas mean adding a field breaks import + custom-model upsert unless four sites change together. | `shared/types.ts:104-109`; `shared/schemas.ts:63-70`; `domain-codec.ts:114-122`; `capabilities.ts:79`; `defaults.ts:279-291` | "This model generates images" is not representable. | Add the capability keys **additively** to the type, the strict schema, the codec and the hint table in one change. |
| **B-02** | Model discovery **deletes** image/video model ids from the list. | `openaiFamily.ts:77-78` (`/(^|[-_/])(…\|dall-e\|image\|images\|sora\|…)([-_/]\|$)/i`); `gemini.ts:294-296` (`generateContent`-only) | An image or video model can never appear in the picker. | Filter by **task**, not by existence: keep the row, tag it, exclude it from the chat selector only. |
| **B-03** | No durable store for generated bytes. The only disk writer mirror only writes **images**, and `release()` **deletes** the file on every successful turn and on quit. `MessageAttachment` carries no path. | `attachments/store.ts:100,121-124`; `chat/service.ts:441-447`; `index.ts:459`; `shared/attachments.ts:80-94` | Any generated image placed here is deleted moments later; a video is never mirrored. | New content-addressed media store whose lifetime is owned by the media row. |
| **B-04** | The IPC surface is strictly request/response. There is no job handle, no progress, no cancel-by-id; the only push channels are `chat:event` and `sync:status-event`. | `ipc/handler.ts:28-83`; `shared/api.ts:114-119,179-189`; `preload/index.ts:34-42` | A minutes-long video job has nowhere to report progress and nothing to poll. | Add a `media` namespace + one `media:event` channel (5 lines, same shape as `sync.onStatus`). |
| **B-05** | Video cannot reach the renderer at all: `media-src 'self' blob:` with `connect-src 'none'`, a sandboxed `loadFile` page, and **no `protocol.handle` anywhere in `src/main`**. Base64 over the JSON IPC envelope would be ~66 MB of string per fetch. | `main/security.ts:19-34`; `window.ts:34-43,76` | No video playback is possible, even if the bytes existed. | Register a `media://` protocol (or a streaming read) and allow it in `media-src`. |
| **B-06** | A chat turn **fails hard** on an empty text payload: `provider_error` "The provider returned an empty response. Nothing was generated, so no reply was saved." | `chat/service.ts:408-415` | An image-only reply is reported as an error and persisted nowhere. | Do not route media through `execute()`; a sibling media path persists an artifact row. |
| **B-07** | The "test this model" probe always builds a **chat** request. | `services/models.ts:181-188` | An image model can never be validated; the probe would POST `chat/completions` at an images endpoint. | Branch the probe on the model's capability. |
| **B-08** | Sync has a table allowlist; a new table is excluded until 7 files and a SQL `CHECK` change. | `sync/tables.ts:10-17`; `types.ts:339-345`; `repository-contract.ts:234-241`; `sync/repositories/sync.ts:54-70,468-556`; `migrations/001:149` | Generated media cannot sync. | The `Record<>` typing makes each omission a **compile error** — the seam is safe; decide whether media syncs at all (recommended: opt-in, off by default). |

### 4.2 Defects worth fixing while the files are open

| ID | Finding | `file:line` | Evidence | Fix |
|---|---|---|---|---|
| **D-01** | `--size-prose` is referenced **6×** and defined **0×**. An undefined `var()` without fallback is invalid at computed-value time, so `max-width` resolves to `none`. | `global.css:171`, `controls.css:731,832`, `overlays.css:53`, `markdown.css:25`, `shell.css:210` | Scripted diff of all 137 token definitions against every `var(--…)` reference; the only other two hits are correctly page-local composite vars. | Add `--size-prose: 65ch;` to `tokens.css`. One line, fixes six sites. |
| **D-02** | The **dev** CSP has no `media-src`, so it falls back to `default-src 'none'` — the voice-memo `<audio>` preview is blocked under `npm run dev` and only works packaged. | `security.ts:27` (prod) vs `:45-56` (dev); `VoiceRecorder.tsx:562-567` | CSP arrays read directly. | Add `"media-src 'self' blob:"` to `devCsp`. |
| **D-03** | Four hand-rolled destructive confirms; `Dialog` renders `role="dialog"` only, never `alertdialog`. | `ConversationSidebar.tsx:253-257`; `ProviderCard.tsx:382-412`; `ModelsSection.tsx:265-303`; `AgentsPage.tsx:284-314`; `Dialog.tsx:139` | Read at each site; warning copy has already drifted four ways. | Extract `ConfirmDialog` on top of the existing `Dialog`. |
| **D-04** | `npm run dist` runs **no** typecheck, no test and no `audit:gate`; there is no CI at all. | `package.json:27`; `Test-Path .github` → `False` | — | Chain the gates into `dist`, or add CI. |
| **D-05** | Two **tracked** files hardcode a dated, previous run sink: a script and the test harness. Every `npm test` and every smoke run writes into `.work/2026-10-29-personal-ai-desk/`. | `scripts/smoke-packaged.mjs:57`; `tests/main/db/helpers.ts:27-33` | Path literals read. | Compute today's run dir / take it from an env var. |
| **D-06** | `scripts/quality-gate.mjs` scans **`src/` only** — not `scripts/`, not `tests/`, so its `TODO`/`FIXME` and key-literal rules never see them. | `quality-gate.mjs:19,117` | `const SRC = path.join(root,'src')` | Extend `walk`. |
| **D-07** | Markdown's image renderer blocks **every** image, including `data:` URLs, contradicting its own doc comment. | `Markdown.tsx:120-128` vs comment `:88-93` | Code returns a "blocked" chip unconditionally. | Keep remote images blocked; render generated results through a media component, **not** Markdown. |
| **D-08** | "Attach image" and "Attach file" are the same control; the OS picker passes **no filters**. | `Composer.tsx:235-250`; `main/index.ts:253-265` | `pick()` takes no arguments. | `pick({kinds})` → dialog filters, or delete the second button. |
| **D-09** | `after-pack.cjs` flips Electron fuses without `resetAdHocDarwinSignature`, which invalidates the ad-hoc signature on **arm64** macs — the app would not launch. | `scripts/after-pack.cjs:38-46` | `@electron/fuses` README + `dist/index.js:190` gate the re-sign on that option. | Pass it for `arm64`. |

### 4.3 Hygiene / documentation drift

| ID | Finding | Fix |
|---|---|---|
| **H-01** | Docs still name `%APPDATA%\Personal AI Desk` and `PERSONAL_AI_DESK_*` in 6 places while the code uses `Grenjo AI Tool`. | One sweep; note the legacy migration. |
| **H-02** | `docs/FEATURES.md` says "a web or mobile client — not built" while `mobile/` is committed with 18,349 insertions. Same file states two different installer sizes (124,081,924 and 124,229,063; on disk 124,229,063). | Correct both. |
| **H-03** | The only **hashed, certified** installer is the pre-rename `Personal AI Desk` one (`7223DEC3…`); the current product-name exe (`55818C47…`) has no recorded install/launch/uninstall cycle. | Re-run the packaged cycle and re-record. |
| **H-04** | Bundle-size table in `FEATURES.md` predates the last build and understates every artifact. | Re-measure after the next build. |
| **H-05** | `PlaceholderPage.tsx` is unreachable from the app (all five routes are real screens). | Decide: delete it, or hold it as the honest scaffold for the two new pages. |
| **H-06** | `.page__body` has no `margin-inline: auto` while the chat column centres itself. | One line. |
| **H-07** | No Playwright / axe / Lighthouse / ESLint anywhere, so layout, contrast and a11y-tree claims cannot be verified automatically. | Decide whether to add `@playwright/test` + `@axe-core/playwright` (recommended before the media UI ships). |

---

## 5. Provider reality (this changes Phase 3 and 4)

Researched from official documentation on 2026-11-03. The Lead independently re-checked the OpenAI Images
reference and confirmed the model list, the retired `/images/variations`, the `gpt-image-1` shutdown date
(2026-10-23), 16 reference images, `mask`/`markup`, arbitrary `WxH` divisible by 16, base64-only output and
`n` 1–10.

| Surface | Status | Consequence for the plan |
|---|---|---|
| **OpenAI Images** `/v1/images/generations`, `/v1/images/edits` | **Confirmed live.** Ship models: `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare`, `gpt-image-2`. `gpt-image-1` already dead; `gpt-image-1.5`, `gpt-image-1-mini`, `chatgpt-image-latest` shut down **2026-12-01** (28 days out). | Build the image adapter first — it is the cheapest win: same base URL and Bearer key as the existing chat adapter. Model ids **must** live in a config table with a `shutdown_date`. |
| **OpenAI video** | **Does not exist.** Videos API + Sora 2 shut down 2026-09-24; "no one-to-one replacement API is available". | OpenAI is **not** selectable in the video picker. Any older doc or blog describing `/v1/videos` is stale. |
| **Google Imagen** | **Shut down** in the Gemini API. | Do not build an Imagen adapter. |
| **Google Gemini images** | Confirmed on **`POST /v1beta/interactions`** (`x-goog-api-key`), models `gemini-nano-banana-2.1`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gemini-2.5-flash-image`. New request builder, **not** a tweak of the chat adapter. No `negative_prompt`, no `seed`, `n` not documented. | Second image adapter. Every generated image carries a SynthID watermark. |
| **Google Veo** | Veo 3.1 **Preview in the Gemini API shut down 2026-10-22**. Video on a BYO-key Gemini client is `gemini-omni-1.1-flash` via Interactions (t2v, i2v, first/last frame, reference images, extend +10 s to 40 s, 9:16/16:9, 360p–4k, **no duration field, negative prompts explicitly unsupported**). Veo 3.1 **GA** exists only on the Gemini Enterprise Agent Platform, which needs project + ADC auth — **wrong shape for a bring-your-own-key desktop app**, and its wire format is **UNVERIFIED**. | Use Gemini Omni for video. **Drop Veo GA from the first ship.** |
| **Black Forest Labs** `api.bfl.ai` | Confirmed async poll: `POST /v1/<model>` → `{id, polling_url}` → `GET polling_url` → `Ready`/`Error`/`Failed`; output is a **signed URL valid 10 minutes**. Auth header is `x-key`. Image endpoints + `/v1/flux-3-video` (`mode: t2v`). Per-endpoint params **UNVERIFIED**. | Good second video provider: a genuinely asynchronous, well-documented contract. |
| **Replicate** `api.replicate.com/v1` | Confirmed async predictions with `starting/processing/succeeded/failed/canceled`, `Prefer: wait`, cancel endpoint, webhooks. Output URLs need the auth header and **are purged after ~1 hour**. Input schema is **per model**. | Optional generic fallback; its per-model schema means it cannot be a uniform control set. |

**The one rule all of this implies:** three of five providers hand back **expiring URLs**, so the app must
**download and persist bytes at completion** and never store only a URL — which is exactly the store B-03
does not have yet.

**Normalised job contract** (one shape, synchronous providers resolve immediately):
`id · provider · model · capability · status(queued|running|succeeded|failed|canceled|expired) · progress ·
remote_id · poll_url · outputs[{url|b64, mime, width, height, duration}] · error{code,message,retryable} ·
created_at · updated_at · expires_at`.
Cancel is **not** universal (Replicate yes, BFL not documented, Gemini `delete` ≠ cancel) — so the UI's
cancel must be capability-gated, exactly like the existing chat controls.

---

## 6. The architecture as it stands, and where the new capabilities attach

```
renderer (React, no network, no Node)  ── window.api ──▶  preload (typed bridge)
                                                            │  IPC: zod-validated, sender-asserted
                                                            ▼
                                                    main process
   ┌──────────────┬───────────────┬──────────────────┬────────────────────┐
   │ chat/service │ attachments   │ sync engine      │ providers/         │
   │ (turn state) │ (extract,     │ (Supabase, RLS)  │  transport.ts      │
   │              │  pending mirr)│                  │  ├ openaiFamily    │
   └──────┬───────┴───────┬───────┴────────┬─────────┤  ├ gemini/anthropic│
          │               │                │         │  └ registry        │
          ▼               ▼                ▼         └─────────┬──────────┘
      node:sqlite     userData/        Supabase                 │ HTTP
   (migrations 001-002) attachments/   (optional)                ▼
                                                          provider APIs
```

**Seams that already fit** (no change needed): the optional-adapter pattern (`transcription?:
TranscriptionAdapter`), the single transport with timeouts/retries/abort, the main→renderer event pattern,
the atomic content-addressed write, `MessageAttachment` per-message media metadata, the migration runner,
the entity-agnostic sync sanitizer.

**What the plan adds, and nothing else:**
```
shared/      capability keys · media types · job contract · api surface
main/        media/{store,service,jobs,polling} · providers/{openaiImages,geminiInteractions,bfl,replicate}
             db/migrations/003-media · ipc/media handlers · protocol handler for media://
renderer/    pages/image · pages/video · components/media/{card,grid,preview} · ui/{Progress,ConfirmDialog}
```
`chat/service.ts`, the chat provider paths and the model-resolution precedence stay **untouched** — the media
path is a sibling, not a rewrite. That is the "do not replace working implementations" constraint satisfied
structurally rather than by promise.

---

## 7. Recommended actions, in order

| # | Action | Why now | Gate |
|---|---|---|---|
| 1 | Archive-tag `76ad3e7`, then commit the 63 `mobile/` deletions as their own commit | The tree is in the worst state: present in HEAD, absent on disk. Nothing is lost either way, but every later diff is polluted. | **Owner decision** (§10 Q1) |
| 2 | Fix D-01…D-09, delete `executor.ts`, drop `highlight.js`, fix `test:coverage` and the `tsconfig` include | Small, independent, each with a test | Baseline test run first |
| 3 | Add the capability model (B-01, B-02, B-07) | Everything else depends on it | Typecheck + tests |
| 4 | Add media store + job engine + IPC + `media://` (B-03, B-04, B-05) | The load-bearing backend for both phases | Migration test + job unit tests |
| 5 | OpenAI + Gemini image adapters, mocked; one live smoke test per provider if a key exists | Cheapest confirmed wins | Mocked tests; live = `UNAVAILABLE` without a key |
| 6 | Image page + media components | First user-visible deliverable | Renderer tests + a screenshot pass |
| 7 | Gemini Omni + BFL video adapters and the video page | Async, expiring URLs, no blocking of the UI | Job/poll/timeout/retry tests |
| 8 | Media in conversations | Turns the feature into part of the product, not a separate tool | — |
| 9 | macOS packaging config | Config-only; needs a mac host to prove | **UNAVAILABLE** off-mac, stated as such |
| 10 | Full verification + re-certified installer | Closes H-03 | `npm test`, `typecheck`, `build`, `dist`, `smoke:packaged` |

Nothing is deleted before step 1's tag and step 2's per-file reference check.

---

## 8. macOS: exactly what is missing

A mac target needs **zero new application code**. `node:sqlite` (bundled in Electron 44's Node 24.22 — not a
native module), `safeStorage` (Keychain), the userData-derived paths, the extractors and the entire renderer
are already cross-platform. What is missing is packaging:

1. **A macOS host or CI runner.** A DMG needs `hdiutil`; signing needs `codesign` + `notarytool`.
   electron-builder cannot sign or notarize from Windows. This is the real blocker, not a config line.
2. **A `mac:` block** — `target: [dmg, zip]`, `category`, `icon: build/icon.icns`, `hardenedRuntime`,
   `gatekeeperAssess: false`, `entitlements` + `entitlementsInherit`, and
   **`extendInfo.NSMicrophoneUsageDescription`** — without it macOS **terminates** the app on the first
   `getUserMedia({audio:true})`, i.e. the voice feature becomes a crash.
3. **An entitlements plist** — `com.apple.security.cs.allow-jit` (Chromium under hardened runtime) and
   `com.apple.security.device.audio-input`. This widens what the signed binary claims; the threat model must
   be re-visited, not copied.
4. **`build/icon.icns`** — delivered in this run (§9).
5. **`resetAdHocDarwinSignature: true` for arm64** — D-09.
6. **`dist:mac` / `pack:mac` scripts**; keep `--win` for Windows.
7. **Signing material** (Developer ID + notarization credential) — the `UNAVAILABLE` item, the same shape as
   the Windows signing gap.
8. **A mac-capable `smoke:packaged`** — it hardcodes `release/win-unpacked/*.exe` and asserts userData under
   `~/AppData|%APPDATA%`, so it fails twice on mac.

`dmg-builder` and `@electron/universal` are already present as electron-builder transitives.

---

## 9. Brand asset delivered (the separate request)

The supplied artwork is now the product's single source of truth for the logo and the installed app icon.

| Path | What | Status |
|---|---|---|
| `build/icon-source.png` | the supplied 1024×1024 art, verbatim (sha256 `2c42c30b…cb08df`) | new, **must be tracked** — the generator reads it |
| `build/icon.png` | 1024×1024 RGBA, electron-builder source for mac/linux, README image | regenerated (8,756 → 740,673 B) |
| `build/icon.ico` | **7 sizes** 16/24/32/48/64/128/256, 32 bpp DIB entries | regenerated (8,778 → 372,526 B) |
| `build/icon.icns` | 7 entries `icp4…ic10` (16→1024) as PNG payloads | new |
| `scripts/make-icon.mjs` | rewritten: decodes and area-resamples the master instead of drawing a procedural spark | 191 → 387 lines, zero new dependencies |

Both binaries were **structurally validated** (every ICO entry's DIB header, length and offset; every ICNS
entry walked end-to-end) — see `PLAN_EVIDENCE.md`. Small-size rendering was inspected at 16/32/48 px: the
mark reads as a glowing circuit "C"; the "Grenjo AI" wordmark becomes a smudge below 48 px. That is inherent
to art that includes a wordmark. **Optional follow-up:** a mark-only crop for the 16–32 px entries, if the
owner prefers a tighter taskbar read. Not done unasked, because it changes the supplied composition.

---

## 10. Decisions this audit needs from the owner

| # | Decision | Options | Recommendation |
|---|---|---|---|
| 1 | `mobile/` — what does the Expo app become? | (a) archive it: tag + commit the deletion, keep it in history only; (b) keep it as a maintained client and **share** the 11 contract files instead of copying; (c) restore it as-is | **(a) now**, and record (b) as future work — it is unreferenced by every build path and is the source of the 2,526 duplicated lines |
| 2 | Image providers for the first ship | OpenAI only · OpenAI + Gemini · all four | **OpenAI + Gemini** (both confirmed, both already have a key in the app's provider model); BFL/Replicate as a later adapter |
| 3 | Video providers | Gemini Omni + BFL · Omni only · add Veo GA later | **Omni + BFL**; Veo GA needs Google Cloud auth and its wire format is unverified |
| 4 | Should generated media sync to Supabase? | never · opt-in per item · automatic | **Never automatically** (the brief says so); expose it as an explicit per-item action later |
| 5 | Add Playwright + axe before the media UI? | yes / no | **yes** — D-07/D-11-class defects are invisible to jsdom |

---

## 11. What this audit did not check

- **No live runtime evidence**: the baseline battery (typecheck, 601 node tests, 157 renderer tests, the quality
  gate and the three bundles) was executed and is green — `PLAN_EVIDENCE.md` §"PART-001 pre-check". What is
  **not** verified: any call to a real provider, a packaged launch, a macOS build, or a signed installer. Those
  are Phase-8 gates and are reported as `UNAVAILABLE` until run.
- **No macOS execution** (no host). The macOS section is configuration analysis, not a proven build.
- **`supabase/migrations/*.sql` bodies** were not read line by line; the RLS claims rest on the test that
  parses them and on `supabase/README.md`.
- **Never-built artefacts**: `mobile/` runtime behaviour (Expo/native toolchains absent).
- **Contrast ratios and layout** are unmeasured (no axe, no Lighthouse, no browser pass).
- **The `.work/` sink's 8 credential-shaped string matches** were located but not read or reproduced. The one
  capture written into today's sink by a teammate was removed by that teammate before this report; the
  absolute path no longer exists (`Test-Path` → `False`). The two remaining matches are test fixtures under
  the 2026-10-29 sink. **No repository exposure** — `.work/` is gitignored.

---

## 12. Independent audit of this report

These deliverables were audited by a member of the team who wrote none of them
(`.work/2026-11-03-audit-consolidation/out/lead-audit.md`, 13 findings). Its verdict was **yes with fixes** —
no blocker, no fabricated evidence, 23 of 24 re-derived numbers exact, and all four baseline rows reproduced
independently (typecheck exit 0; 51 files / 601 node tests; 14 files / 157 renderer tests; quality gate 144
files, 0 blocking). Its icon checks were run against its **own** ICO/ICNS parser, and it decoded the ICO DIB
and the equivalent ICNS PNG independently to confirm the pixels match at 16/32/64/128/256 — which is what
catches a flipped row or a BGR/RGB swap.

Every finding it raised has been applied to the final text:

| Finding | What was wrong | Fixed by |
|---|---|---|
| SA-01 | The scope sentence claimed only `README.md` changed; six tracked files were modified and four paths added | Rewritten to name every path this run touched |
| SA-02 | The evidence log's tree census said 69 entries; the delivered tree reads 73 | Both censuses recorded with the moment each was true |
| SA-03 | This report called builds/tests `UNAVAILABLE` while the evidence log recorded them `PASSED` — it understated its own verification | §1 and §11 now separate the executed baseline battery from the still-unverified live calls, mac build and packaged launch |
| SA-04 | Phase 7's "optional cloud sync" half had no part and no deferral | `MASTER_PLAN.md` Q4 now states that the v0.1 sync engine already covers it and that **media sync is explicitly deferred**, with the files it would touch |
| SA-05 | Q5 defaulted to "yes" for Playwright/axe with no work item | PART-008 T.8 installs and wires it, and its AC now requires the viewport and axe results |
| SA-06 | §3.3 told the owner to "keep as history" the two files this same run replaces | §3.3 now records what was actually done: v0.1 archived byte-identically under `docs/history/`, live files rewritten |
| SA-07 | "27 packages" for 26 direct dependencies | Corrected to 26 (27 rows include the project) |
| SA-08 | The verdict implied all 63 `mobile/` files are byte-identical | Corrected: 63 files, of which 11 (2,526 lines) are identical |
| SA-09 | The plan cited `UI-xx` / `F-xx` ids that live only in the gitignored sink | The plan's CTX now says where they come from |
| SA-10 | A dangling "Phase 9 item 11" | Replaced with the requirement it meant |
| SA-11 | The icon decoder did not verify input chunk CRCs, so a corrupt master could ship a wrong icon silently | CRC check + write-then-rename added; verified by corrupting a copy (fails loudly, writes nothing) |
| SA-12 | The shipped master is fully opaque, so the alpha path was never exercised by the artifact | Recorded in the evidence log, with the independent alpha-ramp result that does exercise it |
| SA-13 | The plan's one tracked-file deletion did not name the owner gate its own rule requires | PART-002 T.1 now requires owner confirmation and gives the one-command revert |
