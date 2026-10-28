# Threat model — Personal AI Desk

Version 1 · 2026-10-29 · scope: the desktop application as built in this repository.

This model exists to drive decisions, not to be filed. Each threat below names a
scenario, the control that answers it, and where that control lives in the code.

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
| T10 | B6 | Tampering | An uninstall or an upgrade deletes the owner's history. | Mitigate | `userData` is pinned to `%APPDATA%\Personal AI Desk`, outside the install tree; `deleteAppDataOnUninstall: false`. | packaged smoke test asserts `userData` is outside the install directory; upgrade test |
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
