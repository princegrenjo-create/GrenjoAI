# Threat model — Grenjo AI Tool

Version 2 · 2026-10-29 · scope: the desktop application as built in this repository.

This model exists to drive decisions, not to be filed. Each threat below names a
scenario, the control that answers it, and where that control lives in the code.

**Version 2 adds a boundary that did not exist in version 1: the user's own files
and voice now leave this machine.** Documents are read locally and their text is
sent to the model provider; a recording is uploaded to OpenAI when the user presses
Transcribe; the renderer is now allowed one OS permission (the microphone). Those
changes are modelled in §9.

## 1. Scope

**In scope**

- The Electron main process, its IPC surface, the preload bridge and the React renderer.
- The SQLite database and the encrypted credential file in the user profile.
- Outbound requests to AI providers (DeepSeek, OpenAI, Gemini, Anthropic, custom
  OpenAI-compatible endpoints) using a key the owner supplies.
- The optional Supabase sync path and the cloud tables it writes.
- The Windows installer and the update path.

**Out of scope (stated, not ignored)**

- The providers' own infrastructure and their handling of submitted data.
- Supabase's platform controls, and the security of the owner's Supabase project
  configuration beyond the SQL and client behaviour this repo defines.
- The owner's Windows account security, disk encryption and physical access. DPAPI
  protection is only as strong as the logged-in user session.
- Code signing of the installer (not implemented; documented as a limitation).

## 2. Assets and required properties

| Asset | Why it matters | Required properties |
|---|---|---|
| Provider API keys | Direct financial loss; full access to the owner's provider account | Confidentiality; never leaves the device except to its own provider |
| Chat transcripts and prompts | Personal content, often sensitive | Confidentiality locally; integrity; availability |
| Custom models, agents, settings | The owner's configuration effort; not reconstructible | Integrity; availability; portability |
| Supabase anon key and session JWT | Read/write access to the owner's cloud rows | Confidentiality of the session; least authority |
| The local database file | Single source of truth for history | Integrity; availability; durability across upgrades |
| Rendering surface | Displays text authored by a remote model | Integrity of the UI; no script execution |

Availability here is a reliability property, not a security one. It is listed so
"the app still opens offline" is never recorded as a security control.

## 3. Actors

- **Owner** — a single authenticated local user. Trusted to configure the app,
  untrusted to be immune to prompt injection in model output.
- **Remote model output** — attacker-controlled text. Treated as hostile input:
  it is the primary injection vector into any UI.
- **Provider endpoints** — semi-trusted. A compromised or malicious custom
  endpoint is assumed possible.
- **Supabase** — semi-trusted backend holding the owner's synced rows.
- **Local attacker with the same Windows account** — outside the boundary DPAPI
  defends; recorded as residual risk, not solved here.
- **Malicious npm dependency or build step** — supply chain; bounded by pinning and
  the absence of install scripts in the direct dependency set.

## 4. Trust boundaries

```
┌─────────────────────────────── Electron main (trusted) ───────────────────────────────┐
│  SQLite (no secrets) ──── services ──── provider adapters ──┐                          │
│        ▲                     ▲                              │                          │
│  credentials.bin  ← DPAPI ───┘                              │                          │
│        ▲                                                    ▼                          │
│        │                                          HTTPS to provider (key in header)    │
│  ┌─────┴────────────── IPC boundary (validated) ───────────┐                            │
│  │  preload contextBridge — DesktopApi only                │                            │
│  └─────┬───────────────────────────────────────────────────┘                            │
│        ▼                                                                                │
│  Renderer (sandboxed, contextIsolated, no Node, CSP connect-src 'none')                 │
│        ▲                                                                                │
│        └── renders remote model output (untrusted) as Markdown                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                              │
                              └── optional: Supabase REST over HTTPS (anon key, RLS)
```

Boundaries that matter: renderer→main (B1), main→provider (B2), main→Supabase (B3),
renderer→rendered model output (B4), build→shipped artefact (B5), install dir→user
data (B6).

## 5. Threats and decisions

Severity is ranked by exploitability and blast radius, not novelty.

| ID | Boundary | STRIDE | Scenario | Decision | Control (where) | Verification |
|---|---|---|---|---|---|---|
| T1 | B1 | Elevation | A crafted message convinces the renderer to call a privileged channel with hostile arguments (a `file://` base URL, a 10 GB limit, an arbitrary id). | Mitigate | Every handler validates with a zod schema before any side effect; sender identity is checked against the app window. `src/main/ipc/register.ts` | `rejects an unexpected sender`, schema tests |
| T2 | B4 | Tampering | Model output contains `<img onerror=…>` or `javascript:` and executes in the renderer. | Mitigate | `react-markdown` with raw HTML disabled (no `rehype-raw`, no `dangerouslySetInnerHTML`); links filtered by `isExternalLinkAllowed`; strict CSP `script-src 'self'`. | renderer test injecting `javascript:` and raw HTML; `scripts/quality-gate.mjs` `unsafe-html` rule |
| T3 | B2 | Information disclosure | A provider or a compromised compatible endpoint echoes the `Authorization` header into an error body, and the app shows or logs it. | Mitigate | Errors pass through `redactSecrets` before rendering or logging; request headers and bodies are never logged; error text is truncated. `src/shared/errors.ts`, `src/main/logger.ts` | redaction tests; `secret-literal` gate rule |
| T4 | B2 | Tampering | A provider endpoint redirects to an attacker host, forwarding the key in the `Authorization` header. | Mitigate | `redirect: 'error'` on every request. `src/main/providers/transport.ts` | transport test asserting a redirect response is refused |
| T5 | B2 | Information disclosure | A key ends up in SQLite, an exported config, a log or the installer. | Mitigate | Keys exist only in the DPAPI-protected credential file; the providers table has no key column; export is built from an allowlist and asserts `credentials:'excluded'`; the export refuses to emit a key-shaped string. | credentials + settings-export tests; `git grep` gate |
| T6 | B1 | Information disclosure | The renderer can read a stored key (for example through a debug endpoint or a returned object). | Mitigate | No API method returns a key; the UI receives `hasKey` and a sha256 prefix only; `keyFingerprint` is one-way. | `DesktopApi` has no key-returning method; provider service tests |
| T7 | B3 | Elevation | A signed-in user (or a stolen session) reads another user's rows in Supabase. | Mitigate | RLS enabled and forced on every synced table with four owner policies keyed on `auth.uid() = user_id`; the client uses only the anon key. | `tests/main/sync/rls-sql.test.ts` parses the SQL and fails if a policy is missing |
| T8 | B3 | Information disclosure | Sync payloads carry a credential to the cloud. | Mitigate | Provider payloads contain name/kind/base_url/enabled only; a test scans every pushed payload for key-shaped strings. | sync tests |
| T9 | B3 | Tampering | A second device's newer edit is silently overwritten by this device's stale row (or vice versa). | Mitigate | Version compare on apply: newer remote over a *dirty* local row becomes a conflict, never an overwrite; the user resolves it explicitly. | sync conflict tests |
| T10 | B6 | Tampering | An uninstall or an upgrade deletes the owner's history. | Mitigate | `userData` is pinned to `%APPDATA%\Grenjo AI Tool` (a legacy `%APPDATA%\Personal AI Desk` profile is migrated forward once), outside the install tree; `deleteAppDataOnUninstall: false`. | packaged smoke test asserts `userData` is outside the install directory; upgrade test |
| T11 | B5 | Tampering | A compromised transitive dependency executes at install or at runtime with the app's privileges. | Mitigate (partial) | Exact version pins, committed lockfile, no `postinstall` in the direct set, a small dependency surface, and no network code in the renderer. | `npm audit` result; dependency inventory in the README |
| T12 | B1 | Denial of service | A huge or malicious provider response exhausts memory or hangs the UI. | Mitigate | Streaming is incremental (not buffered wholesale), an idle-stream timeout aborts a stalled stream, output is persisted incrementally, and the renderer never re-renders a whole transcript per token. | transport idle-timeout test; chat service partial-persist test |
| T13 | B1 | Spoofing | A second window or a webview loads a page that then talks to the IPC surface. | Mitigate | A single-instance lock, `webviewTag: false`, `will-attach-webview` denied, all new windows denied, navigation restricted to the app origin, and IPC sender identity checked. | `src/main/security.ts`; encoded in the smoke probe (`window.require === undefined`) |
| T14 | B2 | Repudiation | The owner cannot tell which key or model produced a reply. | Mitigate | Each assistant message stores its `modelRef`, usage and status; errors are stored on the message. | chat service tests |
| T15 | B4 | Information disclosure | A prompt-injected model asks the app to exfiltrate the transcript. | Mitigate | The renderer has `connect-src 'none'` and no network API; there is no tool-execution path in this release. | CSP in the built HTML (smoke probe) |
| T16 | — | Elevation | The app is asked to run a shell command or open an arbitrary URL. | Mitigate / eliminate | No shell execution path exists; `app:open-external` accepts HTTPS only and the main process re-validates. | URL policy tests |
| T17 | B5 | Information disclosure | A real key is committed to the repository during development. | Mitigate | `.gitignore` excludes `.env*`, key/cert files and the credential file; the quality gate fails on a key-shaped literal; `.env.example` holds placeholders only. | `scripts/quality-gate.mjs` `secret-literal` rule |

## 6. Accepted residuals

| Residual | Why it is accepted | Detection | Review trigger |
|---|---|---|---|
| A same-account local attacker can read the decrypted key from a running app's memory | DPAPI protects data at rest, not a process the owner already controls; defending it needs a hardware-backed key the app cannot assume | OS-level audit, out of app scope | If the threat model expands to a shared machine |
| The owner's Supabase project could be misconfigured (RLS disabled in the dashboard) | The app cannot verify the remote policy from the client | The RLS guard test proves the shipped SQL; the docs require the owner to run it in the SQL editor | Every schema change |
| An installer without code signing can be tampered with in transit | Signing requires a purchased certificate | Documented as a limitation; the SHA-256 of the installer is recorded when built | When a certificate is available |
| Provider-side model behaviour (harmful output, hallucination) | Not a security boundary the client can enforce | n/a | n/a |

## 7. Re-model triggers

Re-run this model when: a tool-execution or agent-autonomy feature is added; a new
entry point or listener appears; a new data class is synced; the renderer gains any
network capability; the credential backend changes (for example to a Keychain on a
future mobile build); or a shared code path starts accepting model-authored
instructions as commands.

## 8. Version 1 residual decisions carried forward

Nothing in §9 relaxes §5: the key handling, IPC validation, CSP, RLS and
redirect-refusal controls all still apply, and the attachment path uses the same
transport as chat, so it inherits them.

## 9. Version 2 — attachments and voice

**New assets:** the contents of the owner's documents, their images, and their
voice. **New entry points:** the native file picker, drag-and-drop bytes from the
renderer, and the microphone. **New outflow:** document text and audio to a
provider.

| ID | Boundary | STRIDE | Scenario | Decision | Control (where) | Verification |
|---|---|---|---|---|---|---|
| A1 | B1 | Information disclosure | A document's contents are sent to a provider without the owner realising a *file* was read, or a file the model never received is shown as "attached". | Mitigate | Every attachment carries `contentStatus` (`extracted` / `metadata-only` / `failed`); extracted text is fenced with a header naming the file; a file whose contents were not read is named with the reason and never silently dropped. `src/shared/attachments.ts`, `src/main/chat/service.ts` `composeUserText` | `composeUserText` tests; renderer chip test asserting "contents not read" |
| A2 | B1 | Elevation | A buggy or hostile renderer hands the app a 2 GB file, a `..\..\` filename, or a path outside the profile, and the main process trusts it. | Mitigate | The renderer never passes a path. `pick()` opens the dialog in main; `ingestBytes` validates base64 length *before* decoding; the store writes under `userData/attachments` with a generated id, never the user's filename; every limit in `ATTACHMENT_LIMITS` is enforced in main. | attachment service tests (oversize, path traversal name, unknown id) |
| A3 | B1 | Tampering | A `.png` that is really an executable, or a MIME/extension mismatch, is forwarded as an image. | Mitigate | `probeImage` parses the actual magic bytes and refuses a content/MIME mismatch; only PNG/JPEG/WebP/GIF are accepted; images are re-encoded by nothing, so a mismatch is refused rather than laundered. | image probe tests (PNG/JPEG/WebP headers, mismatch rejected) |
| A4 | B1/B2 | Information disclosure | An encrypted or corrupt PDF is reported as read, and the owner believes the model saw it. | Mitigate | PDF/DOCX extraction failure is `contentStatus: 'failed'` with a sentence naming encryption or corruption; the composer shows it, and the model receives the note, not an empty document. | extraction tests (encrypted PDF, corrupt DOCX) |
| A5 | B2 | Information disclosure | Image bytes are attached to a model that cannot read them, so the request fails or the provider stores an image it was never meant to receive. | Mitigate | Capability gate before any write: `capabilities.imageInput === false` refuses the send with the model named. No silent downgrade, no "I cannot see it" reply. | chat service test `refuses an image on a model without image support` |
| A6 | B2 | Tampering | A recorded audio file is transcribed by an endpoint that was not the one the owner configured. | Mitigate | The transcription request is built by the OpenAI adapter, goes through the same transport (`redirect: 'error'`, timeout, bounded retry) and the same base-URL binding as chat, so a repointed provider invalidates its key. | transcription service tests; transport tests |
| A7 | — | Elevation | The microphone carve-out widens into camera or device access. | Mitigate | The permission handler grants `media` **only** for audio on the app's own origin; a `video` media type is denied, as is every other permission and all HID/serial/USB access. | `src/main/security.ts`; manual check that `getUserMedia({video:true})` is denied |
| A8 | B1 | Information disclosure | A recording is uploaded before the owner asks, or a failed transcription is presented as a success. | Mitigate | Nothing is uploaded until Transcribe is pressed; the recorder holds the blob in memory; a failure returns the mapped error and keeps the recording for retry; an empty transcript is an error, never an empty message. | recorder tests; transcription tests (empty, 401, transport failure) |
| A9 | B1/B3 | Information disclosure | Attachment metadata (filenames, sizes) is synced to the cloud and becomes a record of the owner's documents. | Accepted, with the control below | Only metadata is stored on the message (`MessageAttachment`: name, type, size, status) — never bytes, never a path. It therefore syncs with the conversation, which is the same trust level as the message text itself. Document *contents* are not stored separately: they live in the message text the owner already chose to send. | `MessageAttachment` type; migration 002 |
| A10 | B1 | Information disclosure | The attachment folder grows forever with images the owner thought were deleted. | Mitigate | `release(ids)` deletes the on-disk mirror once the message is persisted; `remove(id)` deletes it immediately; `dispose()` clears anything still pending at quit. A failed send keeps the file so the composer can retry. | store tests (remove deletes the file); shutdown path |

**Accepted residuals added in version 2**

| Residual | Why it is accepted | Detection | Review trigger |
|---|---|---|---|
| Document text sent to a provider is then subject to that provider's retention policy | The owner chose the provider and the file; the app cannot enforce a third party's data handling | Provider-side | If a "never send contents" mode is requested |
| An attachment's filename and size reach the cloud when sync is on | It is part of the conversation record the owner asked to sync; bytes are not | n/a | If filenames themselves become sensitive |
| macOS/Linux microphone permission prompts are untested | Only Windows was exercised in this workspace | n/a | Before a macOS/Linux build |

