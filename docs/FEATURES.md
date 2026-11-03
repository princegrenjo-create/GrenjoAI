# Feature status

Last verified: 2026-10-29. Nothing here is marked **DONE** unless a command in
[PLAN_EVIDENCE.md](../PLAN_EVIDENCE.md) produced the result, or the packaged
application was launched and observed.

Legend: **DONE** — implemented and verified. **PARTIAL** — implemented, but some
behaviour could not be verified in this workspace. **UNAVAILABLE** — needs a
credential, account or certificate that does not exist here; the steps to finish it
are recorded. **NOT BUILT** — deliberately out of this release.

---

## Application

| Feature | Status | Evidence / limit |
|---|---|---|
| Electron shell, single instance, hardened window | **DONE** | `npm run build`; packaged smoke: `window.require === undefined`, CSP meta present |
| Renderer sandbox / context isolation / no Node | **DONE** | smoke probe 9/9 checks |
| Restrictive CSP (`default-src 'none'`, `connect-src 'none'`) | **DONE** | header in `src/main/security.ts`, meta tag in the built HTML |
| Permissions, navigation, new windows, webview all denied | **DONE** | `src/main/security.ts`, `src/main/window.ts`; navigation is pinned to the exact renderer directory, not the whole `file://` scheme |
| Electron fuses flipped in the shipped binary | **DONE** | `scripts/after-pack.cjs`; with `ELECTRON_RUN_AS_NODE=1` the packaged exe still starts as an app (probe in `PLAN_EVIDENCE.md`) |
| In-app updates (Settings → About) | **DONE, not yet exercised end to end** | electron-updater 6.8.11 against GitHub Releases. Check → download → confirmed restart. sha512 verified from `latest.yml` before an installer is accepted; nothing downloads or installs without a click. `app-update.yml` is generated into the package and `release/latest.yml` into the build. **No update has been delivered to an installed copy** — that needs a published release (gate condition C7) |
| Windows installer (NSIS, per-user) | **DONE** | `release/Grenjo AI Tool-Setup-0.2.0-x64.exe`, **124,981,723 bytes**, sha256 `AB18B547…D421`, built from the audited tree at version 0.2.0. Carries the Grenjo mark; fuses flipped. The 0.1.0 installer is superseded (same code, pre-audit-fix). Install cycle still owed — gate condition C6 |
| Install / launch / upgrade / uninstall lifecycle | **PASSED on the v0.1.0 artifact only** | the 2026-10-29 cycle (install → 9/9 smoke → reinstall with data intact → uninstall with data preserved) was run on the pre-rename installer. **Not repeated for this candidate** — gate condition C6 |
| Desktop + Start-menu shortcuts | **DONE** | observed after install |
| User data separate from install directory | **DONE** | `%APPDATA%\Grenjo AI Tool` (a `%APPDATA%\Personal AI Desk` profile is migrated forward once on first launch); smoke asserts it is outside the install dir |
| macOS build | **CONFIGURED, NOT RUN** | mac: target (dmg + zip, x64 + arm64), hardened runtime, uild/entitlements.mac.plist, NSMicrophoneUsageDescription, arm64 ad-hoc signature fix. Cannot be built on Windows: electron-builder answers Build for macOS is supported only on macOS. No mac bundle has ever been launched |
| Code signing (Windows and macOS) | **UNAVAILABLE** | no certificate and no Developer ID; signing skipped by electron-builder on both |

## Data

| Feature | Status | Evidence / limit |
|---|---|---|
| SQLite via `node:sqlite` (no native module) | **DONE** | runtime probe: SQLite 3.53.4, WAL, FKs |
| Versioned migrations, idempotent re-run | **DONE** | `tests/main/db/schema.test.ts` |
| Conversations, messages, agents, models, providers, settings, sync outbox | **DONE** | 127 persistence tests |
| Monotonic per-conversation message order | **DONE** | `tests/main/db/messages.test.ts` incl. interleaved appends |
| Conversation search (title + message body) | **DONE** | `tests/main/db/conversations.test.ts` |
| Full-text search | **NOT BUILT** | `LIKE '%term%'`; fine at personal scale, no FTS index |
| Soft delete with tombstones for sync | **DONE** | `tests/main/db/conversations.test.ts` |

## Providers and models

| Feature | Status | Evidence / limit |
|---|---|---|
| Five adapters behind one interface | **DONE** | 164 provider tests, request shapes asserted field by field |
| Key in exactly one header, never in a URL or body | **DONE** | `tests/main/providers/security.test.ts` |
| No redirect following | **DONE** | `redirect: 'error'`; transport tests |
| SSE streaming incl. chunk-boundary robustness | **DONE** | `tests/main/providers/sse.test.ts` (1-byte chunking) |
| Error mapping (401/404/400/413/429/5xx) | **DONE** | `tests/main/providers/*.test.ts` |
| Cancellation | **DONE** | abort tests; chat service `stop()` test |
| Automatic model discovery | **DONE** for parsing; **PARTIAL** live | discover request/parse tested per provider; first page only, no live call |
| Manual custom models ("Others / Custom Models") | **DONE** | custom model persistence tests |
| Capability flags | **PARTIAL** | every flag is a *hint* (`catalog-hint` or name heuristic), never a verified fact — stated in the UI |
| `Live provider call end-to-end` | **UNAVAILABLE** | no API key in this workspace; use *Test connection* + one message after adding your key |

## Generation controls

| Feature | Status | Evidence / limit |
|---|---|---|
| temperature, top-p, top-k, frequency/presence penalty, max tokens, stop, seed, reasoning effort | **DONE** | `tests/node/shared.test.ts` precedence + suppression |
| Provider-specific parameter mapping | **DONE** | each adapter's body asserted |
| Unsupported parameters disabled with a reason, never silently sent | **DONE** | `resolveGenerationParams` suppressed map |
| Max output tokens capped at the model's documented limit | **DONE** | clamping test |
| Weirdness forwarded only where the model declares support | **DONE** | native vs suppressed tests |
| Labelled application-level creativity bias | **DONE** | bias test asserts temperature/top-p shift and the explanation text |
| Precedence: model default → app → agent → conversation | **DONE** | precedence test |

## Chat

| Feature | Status | Evidence / limit |
|---|---|---|
| Streaming display, stop, retry | **DONE** | chat service + renderer streaming tests |
| Errors never rendered as a successful reply | **DONE** | error-path test asserts `status:'error'` and no normal bubble |
| Markdown + highlighted code, raw HTML disabled | **DONE** | renderer markdown tests; `javascript:` link not followed |
| Copy message / copy code | **DONE** | renderer copy test |
| Auto-title from first message | **DONE** | chat service test |
| History trimming to a token budget | **DONE** | trim + max-history tests |
| Duplicate submission prevention | **DONE** | concurrent-send test |
| Offline detection | **DONE** | `blockRequestsWhenOffline` path; renderer offline state |

## Agents

| Feature | Status | Evidence / limit |
|---|---|---|
| Create / edit / duplicate / delete | **DONE** | agent CRUD tests |
| Agent model, system prompt, parameters applied to a request | **DONE** | chat precedence test |
| Start a conversation bound to an agent | **DONE** | renderer test |
| Tool execution / autonomy | **NOT BUILT** | deliberate: agents are personas, no shell or tool access |

## Settings

| Feature | Status | Evidence / limit |
|---|---|---|
| Readable settings + advanced editor with per-key reset | **DONE** | renderer settings tests |
| Range validation with the range in the message | **DONE** | normalisation + renderer tests |
| Export non-secret configuration | **DONE** | `credentials: "excluded"`, refuses a key-shaped document |
| Import with applied/skipped/warnings | **DONE** | import tests |
| Restart-required indicators | **PARTIAL** | no setting currently requires a restart; the hook exists but is unproven |
| Unrestricted raw environment editor | **NOT BUILT** | deliberately absent: settings are typed app configuration, not OS env |

## Credentials

| Feature | Status | Evidence / limit |
|---|---|---|
| OS credential store (DPAPI via `safeStorage`) | **DONE** | `secureStorageAvailable: true` in the packaged app; 9 credential tests |
| Key never in SQLite, export, logs, renderer, installer | **DONE** | schema has no key column; redaction tests; export allowlist; gate rule |
| A key is only sent to the origin it was entered for | **DONE** | `src/main/models/endpoint-policy.ts`: the key is bound to the provider base URL and is deleted when that URL changes; a model endpoint override on another origin is refused. 12 endpoint-policy tests |
| Refuses to write plaintext when the store is unavailable | **DONE** | unavailable-backend test |
| Fingerprint instead of display | **DONE** | sha256 prefix test |
| Session JWT storage | **DONE** | credential-store-backed adapter; no localStorage |
| Structured error codes reach the renderer | **DONE** | `contextBridge` keeps only a thrown value's `message` (proved by a probe), so the code travels as a `code: sentence` prefix and `asAppError` decodes it; retryability is derived from the code. 5 encoding tests + a bridge probe |

## Cloud sync

| Feature | Status | Evidence / limit |
|---|---|---|
| Local-first pull/push engine with a durable outbox | **DONE** | 80 sync tests |
| Version conflict detection, never a silent overwrite | **DONE** | conflict tests |
| Bounded retry with exponential backoff + jitter | **DONE** | retry tests |
| Serialized `syncNow`, offline mode, sign-out keeps local data | **DONE** | offline / serialization tests |
| Cloud schema + RLS (6 tables, 24 owner policies, enable+force) | **DONE** (SQL only) | `tests/main/sync/rls-sql.test.ts` parses the SQL |
| No credential in any pushed payload | **DONE** | every pushed payload scanned for `/sk-|AIza|eyJ/` |
| `service_role` absent from the tree | **DONE** | security-scan test + gate rule |
| **Sync against a real Supabase project** | **UNAVAILABLE** | no project exists here; steps in [supabase/README.md](../supabase/README.md) |
| Conflict UI shows both revisions | **PARTIAL** | the UI can show revisions and the summary; the remote *body* is not exposed by `SyncConflict`, so it cannot be previewed side by side |
| Cross-cycle backoff growth | **PARTIAL** | `SyncPendingRow` does not expose `attempts`, so a retry after a cycle restarts at the base delay instead of escalating |

## Testing

| Area | Suites | Tests |
|---|---|---|
| Persistence + migrations | 11 | 132 |
| Providers | 12 | 164 |
| Chat orchestration + SQLite integration | 2 | 14 |
| Credentials | 1 | 9 |
| Settings / provider / model services + endpoint policy | 4 | 44 |
| IPC message runner | 1 | 10 |
| Sync + RLS + timeouts | 12 | 86 |
| Shared contract (params, URL policy, errors, settings, encoding) | 1 | 28 |
| **Node total** | **52 files** | **611** |
| Renderer (primitives, dialog, chat, shell, four feature pages) | **16 files** | **175** |

Both suites run with `npm test`. The node suite needs no network and no credentials;
the renderer suite runs under jsdom against a fake `DesktopApi`.

### Bundle size

| Artifact | Raw | Gzip |
|---|---|---|
| `dist/renderer` JS | 718.12 kB | 218.29 kB |
| `dist/renderer` CSS | 67.19 kB | 9.92 kB |
| `dist/main/index.cjs` | 1,251.33 kB | 255.19 kB |
| `dist/preload/index.cjs` | 6.06 kB | 1.65 kB |

Measured at `1c6cc21` (PART-002). The renderer exceeds the 200 kB gzip guideline by ~18 kB, still
almost entirely the Markdown syntax highlighter pulled in by `rehype-highlight`. It is a local-file
load, not a network fetch, so it does not affect start time on this platform; if it matters, restrict
the highlighter to a language subset or lazy-load it. Recorded rather than hidden.

## Attachments and voice (added after the first release)

| Feature | Status | Evidence / limit |
|---|---|---|
| Native file picker through IPC | **DONE** | `dialog.showOpenDialog` in the main process; the renderer never sees a path (`attachments.pick`) |
| Drag-and-drop ingestion | **DONE** | renderer reads `File.arrayBuffer()` → `attachments.ingestBytes` (no `file.path` exists in this Electron version) |
| Filename / type / size chips with removal before sending | **DONE** | renderer tests: add, remove, rejected-file reason kept apart from accepted files |
| TXT, Markdown, CSV/TSV, JSON, YAML, XML, source code extraction | **DONE** | 33 extensions classified; extracted text is fenced with a header naming the file |
| PDF text extraction | **DONE** | `unpdf` 2.0.0; encrypted PDF → `failed` with "password-protected", never an empty document; verified inside the Electron runtime against a generated PDF (`chars=29`) |
| DOCX text extraction | **DONE** | `mammoth` 1.13.0; corrupt file → `failed` with a readable note; verified inside the Electron runtime (`chars=30`) |
| Oversize / empty / binary-renamed-to-.txt | **DONE** | each returns `failed` with a sentence; limits enforced in main, not only in the UI |
| Truncation of very long documents | **DONE** | 60,000 characters plus a visible `[truncated]` marker |
| "Never silently attach" | **DONE** | every attachment carries `contentStatus`; an unread file is named with its reason in the prompt and shown in the chip |
| Image selection, validation, preview | **DONE** | PNG/JPEG/WebP/GIF headers parsed with no dependency; MIME/content mismatch refused; preview inline only ≤512 KB |
| Multimodal requests for all providers | **DONE** | OpenAI `image_url` data URL, Anthropic `image` base64 block, Gemini `inlineData`; text-only turns still send a plain string (regression-tested) |
| Capability gate | **DONE** | an image on a model without `imageInput` is refused before any write, naming the model; no silent downgrade |
| Voice recording | **DONE** | `getUserMedia` + `MediaRecorder` (webm/opus with fallbacks), live timer, stop, cancel, preview, discard |
| Microphone permission | **DONE** | the only permission granted is `media`, audio-only, own origin; `video` and every other permission stay denied; CSP gains `media-src 'self' blob:` for the preview only |
| Transcription | **DONE** | OpenAI `POST /v1/audio/transcriptions` (`whisper-1`) through the same hardened transport; no OpenAI key → a sentence saying exactly what to configure |
| Recording failures surfaced | **DONE** | permission denied, no device, no supported codec, empty recording, oversize, over-length, API error — each mapped, never a fabricated transcript |
| Live provider transcription | **UNAVAILABLE** | no OpenAI key in this workspace; the request shape, multipart body and error mapping are covered by 12 offline tests |
| Recording with a real microphone | **UNAVAILABLE (automated)** | the recorder is tested with mocked `getUserMedia`/`MediaRecorder`; a real device check is manual |

## Audit status

An independent auditor (a teammate that wrote none of this code) ran two passes.

| Pass | Verdict | Report |
|---|---|---|
| 1 | `REGRESSION FOUND` — 2 blockers, 3 majors, 5 minors | `.work/2026-10-29-personal-ai-desk/out/audit-2026-10-29.md` |
| 2 (final) | `VERIFIED WITH CAVEATS` — **GO for owner hand-off, with conditions**. No blocker, no major | `.work/2026-10-29-personal-ai-desk/out/audit-2026-10-29-pass2.md` |

The audited artifact is commit `06142c3` and installer
`sha256 7223DEC3…81DA38`. The auditor verified the build is not older than the
source, read the fuse wire back out of the shipped exe, confirmed `app.asar`
contains no source, test, sink, `.env`, credential or SQLite file, and re-ran every
suite (including under a shifted timezone) with identical results.

### Conditions on the hand-off (owner actions, not defects)

1. No live provider call has ever been made. Your first real acceptance is: add a
   key → *Test connection* → send one message.
2. No live Supabase project exists. Keep sync off until `0001_init.sql` and
   `0002_rls.sql` have run in your project, then watch the first two-device sync.
3. The installer is unsigned, so SmartScreen warns on first run.
4. Any further edit needs a rebuild and a new hash; the certification covers
   `06142c3` and that installer hash only.

### Accepted residual risks (auditor pass 2)

| Residual | Impact | Why accepted |
|---|---|---|
| The sync engine's test double still compares `version` only, while production also compares `updated_at` | Test-adequacy smell; the real rule is guarded by 5 cases in `tests/main/db/sync.test.ts`, and the auditor re-proved it 9/9 against the real repository | Test-only; changing it would move the certified commit for no shipped benefit |
| The startup repair of a `streaming` message does not bump `version`/`dirty`, and a `streaming` status pulled from another device is applied verbatim | A repaired or remotely-streaming message shows as stopped locally until the next launch / is not re-uploaded | Cosmetic; no data loss |
| A per-error `retryable: false` is lost across the IPC bridge (the code survives, retryability is re-derived from the code table) | Only the Retry affordance can be offered where it would fail again | The code table is right for every built-in code |
| `npm audit` reports dev-only advisories (vitest/tinypool) | None shipped: `npm audit --omit=dev` is 0 | Dev toolchain only; upgrade when convenient |
| A key is bound to the exact base URL including its path, so editing the path requires re-entering the key | Deliberate friction on a config edit | Safer than inferring which path changes are "the same destination" |

## Deliberately not in this release
- Subscriptions, payments, a public marketplace, multi-tenant SaaS.
- Local model execution (llama.cpp / Ollama hosting inside the app).
- Agent tool execution, shell access, multi-agent orchestration.
- A **web** client: the renderer is already a browser page, but nothing serves it over HTTP; there is no
  server build, no session model and no hosted deployment.
- A **mobile** client in this repository: one existed (an Expo app, 63 files) and was archived at tag
  `mobile-archive-2026-11-03` by owner decision, because 11 of its files duplicated `src/` byte for byte.
  The owner maintains the Android application separately.
- Code signing.

---

## Installer details

The table below describes the **v0.1.0** installer, the only one whose full lifecycle has been exercised.
It was built from `06142c3`; it predates the v0.2 consolidation, so its hash will change when PART-013
re-certifies the current tree. Recorded honestly rather than silently re-pointed at an unverified file.

| Field | Value |
|---|---|
| File | `release/Grenjo AI Tool-Setup-0.1.0-x64.exe` |
| Size | 125,299,894 bytes |
| SHA-256 | `55818C47…632349` (full value in `PLAN_EVIDENCE.md`) |
| Target | NSIS, x64, per-user, non-one-click |
| Install dir | `%LOCALAPPDATA%\Programs\Grenjo AI Tool` (changeable during setup) |
| Electron fuses | Run-As-Node off, NODE_OPTIONS off, CLI inspect off, only-load-from-asar, asar integrity, cookie encryption |
| Signed | No — SmartScreen will warn |
| Verified cycle | **on the pre-rename artifact** (`Personal AI Desk-Setup-0.1.0-x64.exe`, 124,229,063 bytes, sha256 `7223DEC3…81DA38`): install (exit 0, shortcuts created) → installed-exe smoke 9/9 → data preserved → uninstall (exit 0, program gone, `%APPDATA%` intact). **Not yet repeated for the v0.2 tree.** |
