# Final independent audit — v0.2 candidate (PART-014)


> **Status note (added when this report was promoted out of the run sink).**
> This is the audit exactly as the reviewer wrote it, against commit `0965c30`.
> After it was delivered, the Lead fixed M-01, M-02, M-03, M-04, M-05, M-06, M-08, M-12 and M-14 and
> rebuilt the artefact at version **0.2.0** (`788c343`), with regression tests for the three media defects.
> M-07, M-09 and M-11 are accepted and stated in `docs/RELEASE-GATE-2026-11-03.md` §4. The findings are left
> unedited on purpose: an audit that is rewritten after the fact is not evidence.
**Auditor:** `auditor` — wrote none of this code.
**Candidate:** `0965c304e1ddd03374854f71dc91a80368f7d261` (branch `master`), working tree **clean** (0 porcelain entries).
**Baseline:** annotated tag `v0.1.0-baseline` → commit `76ad3e79bb7b05e3249759d4f26076e5aa2334fc` (`v0.1.0-baseline^{commit}` verified).
**Diff:** 48 commits, **211 files, +13,984 / −19,367** (the deletions are the archived `mobile/` tree; 38 of the 211 are `mobile/src`).
**Environment:** Windows 10.0.26300 x64, Node v24.18.0, npm 11.16.0, Electron 44.10.0, electron-builder 26.18.0.

## Verdict: **SHIP WITH CONDITIONS**

Three real defects sit in the new media engine (a cancel that reports success, a repeat-generation that
cannot be stored, a retry budget consumed by successful polls), the version was not bumped for a schema-4
candidate, and the four gate conditions remain genuinely unproven — but the existing chat/web application is
green on everything this host can run, the migration is additive and proven on a copy of the owner's **real
profile with zero row loss**, and none of the defects destroys data or crosses a security boundary.

Conditions: fix or explicitly accept M-01/M-02/M-03; bump the version (M-04); keep C1/C2/C3/C5 written as
unproven. None of the four hard rules is violated.

---

## A/B — Findings

`Severity`: **blocker** = must not ship · **should-fix** = real defect, bounded · **nit** = precision/robustness.
`Status`: **confirmed** = reproduced or read the exact path · **suspected** = named check would settle it.

| ID | Area | Sev | Status | Where | What I observed (command / code path) | Impact | Smallest fix |
|---|---|---|---|---|---|---|---|
| **M-01** | Job engine / UI honesty | should-fix | **confirmed** | `src/main/media/jobs.ts:206-222,348-429,431-458`; `src/main/db/repositories/media.ts:221-247`; `src/main/media/service.ts:321-323` | Probe on the real modules + real SQLite: submit → pending; poll held open; `cancel()` marks `canceled`; poll then resolves `done` → engine **persists the media row and sets the job back to `succeeded`**. Output: `FAIL cancel during an in-flight poll … status=succeeded persistCalls=1`. `SqliteGenerationJobRepository.update()` is an unconditional `UPDATE … WHERE id = ?` (`media.ts:245`) with no status precondition, and `finish()` never re-reads the row. | The user cancels a generation and it completes anyway: a billed job, a media row the UI says was canceled, and the opposite of the PART-005 AC "cancel marks canceled and writes no media row". Window = one provider poll. | Re-read the job before `apply()`/`finish()`, or make the repository update conditional: `… WHERE id = ? AND status IN ('queued','running')` and skip when 0 rows change. |
| **M-02** | Media store / schema | should-fix | **confirmed** | `src/main/db/migrations/003-media.ts:45`; `src/main/media/service.ts:109-125`; `src/main/media/jobs.ts:394-409`; `src/main/db/connection.ts:96-97` | `store.save()` is idempotent (one file per byte sequence — probe PASS), but `media.relative_path` carries a **UNIQUE index**. Probe inserting the same content-addressed path twice → `FAIL … second insert of the same bytes failed: A SQL write failed.` The engine turns any persist throw into a terminal `failed` job (`jobs.ts:398-408`). | Two reachable paths: (1) a crash/quit between `store.save()` and `finish()` — the documented crash-recovery path re-polls, gets the same result, re-persists → the job is reported failed while the image is in the library; (2) two identical outputs (same model/prompt; seeds are deliberately not sent, so rarer). The user sees "The provider returned a result but it could not be saved: **A SQL write failed**" — `DbError` hides the `UNIQUE constraint failed: media.relative_path` behind `cause`. | On a unique conflict, look up the existing row by `relative_path` and return its id (content-addressed dedupe), or drop the unique index and dedupe on read. Include `cause.message` in the job's error message. |
| **M-03** | Job engine / reliability | should-fix | **confirmed** | `src/main/media/jobs.ts:352-366` (`attempts: job.attempts + 1` on every `pending`), `:321-346`, `:97-102` | Probe: submit + 6 successful `pending` polls, then one thrown poll → `FAIL retry budget … status=failed attempts=8 retryable=false`. Every **successful** poll consumes an attempt; `maxAttempts` is 6. | A long video job that has polled 6+ times fails permanently on the first transient network error — `retryable:false`, so the user must regenerate (billable). The `attempts` column also stops meaning "retries". | Keep a separate `polls` counter, or increment `attempts` only when a poll/submit actually fails. |
| **M-04** | Release hygiene | should-fix | **confirmed** | `package.json:4`; `docs/RELEASE-GATE-2026-11-03.md:16,74`; shipped exe `VersionInfo` | `package.json` says `0.1.0`; the installed artefact reports `FileVersion 0.1.0`, `ProductVersion 0.1.0`, `ProductName Grenjo AI Tool`. The gate itself lists this as condition **C4**. | Two different artefacts (pre-`media` and schema-4) ship under the same version string and installer name; support cannot tell them apart, and an upgrade check cannot. | Bump to `0.2.0` and rebuild (the installer name follows), or ship with the version explicitly accepted as an exception. |
| **M-05** | Supply chain | should-fix | **confirmed** | `package.json` devDependencies; `package-lock.json` | The two new dev deps are **caret-ranged**: `"@axe-core/playwright": "^4.11.0"`, `"@playwright/test": "^1.56.1"` (resolved 4.11.0 / 1.56.1). Every other dependency in the tree is exact-pinned (the project's own stated rule). `npm ls --depth=0` → 26 direct deps. | `npm install` can silently move the browser-automation toolchain that `npm run dist` executes; `npm ci` (lockfile-exact) is not used anywhere because there is no CI. Dev-only and **not shipped** — verified: `app.asar` has 0 paths matching `playwright`, `axe-core`, `vitest`, `jsdom`, `@testing-library`. | Pin both exactly (`"4.11.0"`, `"1.56.1"`). |
| **M-06** | `media://` handler | nit | **confirmed** | `src/main/media/protocol.ts:57` (call site `:94`, outside the try/catch), docblock `:44-47` | Probe: `relativePathFromMediaUrl('media://local/%E0%A4%A')` → `THREW URIError: URI malformed`. The function documents "or null when the URL is not one this app would produce"; `decodeURIComponent` runs outside any guard, and `installMediaProtocol` passes the result straight into `store.resolve` inside its own try. | A malformed percent escape in a `media://` URL (corrupt row, hand-edited state, compromised renderer) rejects the protocol handler's promise instead of returning the documented 404 — an unhandled rejection in the main process, not a crash. | Wrap `decodeURIComponent` in try/catch and return `null`. |
| **M-07** | Job engine | nit | **confirmed** | `src/main/media/jobs.ts:150-226`; guard `src/main/media/service.ts:164-193` | Probe: two `engine.tick()` calls started together → `submit called 2 times for one queued job`. The engine has no re-entrancy guard of its own. | **Latent** — production only calls it through `tickSafely()`, whose `ticking` flag serialises ticks (read and verified). A future direct call, a second window, or a second instance would double-submit (billable). | Add the same `ticking` guard inside `JobEngine.tick()`, or document that the engine requires a single caller. |
| **M-08** | Code honesty | nit | **confirmed** | `src/main/media/jobs.ts:19-20`, `:112`, `:204`, `:221` | Header says "A provider's concurrency limit is respected across ticks"; `inFlight` is written at `:204` and decremented at `:221` and **never read**. The limit is enforced by the per-tick `perProvider` map only. | Dead state and a comment that overstates the implementation; a reader believes a cross-tick budget exists. | Delete `inFlight`, or use it (`used = perProvider… + inFlight…`) and correct the header. |
| **M-09** | `media://` streaming | nit | **suspected** | `src/main/media/protocol.ts:93-112` | The handler ignores `request.headers.range` and always answers `200` with the full body (headers copied from `net.fetch(file://…)`). No 206 path exists. | Seeking a large video may re-fetch from byte 0 each time (UX latency/bandwidth on a 40 MB clip), not incorrectness. | Honour `Range` and return `206` + `Content-Range`; check: packaged launch, generate a >20 MB clip, drag the scrubber and watch bytes served. |
| **M-10** | Evidence precision | nit | **confirmed** | `docs/RELEASE-GATE-2026-11-03.md:14,28` | Gate records `audit:gate` as "**275 files** scanned"; I ran the same command at HEAD → **276 files, 3 findings, 0 blocking, exit 0**. Cause: `da585de` added `tests/main/db/profile-migration.drill.test.ts` after the number was recorded, and the gate names commit `0b62192` while HEAD is `0965c30` (diff `0b62192..HEAD` = that test + three documents, no production source). | A reader re-running the documented command gets a different number; the "audited SHA" is two commits behind the shipped tree (identical production code). | Restate the gate as "HEAD `0965c30`; the only post-build commits are this document and the drill test", and re-run `audit:gate` to record 276. |
| **M-11** | Evidence precision | nit | **confirmed** | `tests/e2e/image-studio.spec.ts:21,64-78`; `tests/e2e/bridge-stub.ts:21` | The axe tests are real (`withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa'])`, no rules disabled — colour contrast included) and both pass. But `installBridgeStub(page, { imageModels: 1, imageItems: 0 })` means both studios are scanned in their **empty** state with a stubbed bridge: no result card, no history grid, no error state. | "axe 0 serious/critical on both studios" is true as written and weaker than it reads. Result cards, history grids and error banners are unscanned. | Add one axe pass per studio with `imageItems: 3` and one with a failing generate, or say "on the empty state" in the gate. |
| **M-12** | Comment/code | nit | **confirmed** | `src/main/media/service.ts:325-339` | The comment says "Row first so a failed file delete cannot leave a row pointing at a missing file"; the code deletes the **file** first (`store.remove`) and the row second. | A failed row delete leaves exactly the dangling row the comment claims to prevent (the UI has a missing-file state, so it degrades, but the comment teaches the opposite of the code). | Delete the file, then the row — and say that, or reverse both. |
| **M-13** | Test honesty | nit | **confirmed** | `tests/main/db/profile-migration.drill.test.ts:53`; gate `:30` | The default node suite reports **62 passed, 1 skipped** (63 files / 737 passed, 1 skipped of 738). The skipped test is the migration drill, gated on `DRILL_DB`. The gate states this separately and gives the command — honest, but plain `npm test` never proves the drill. | A future green `npm test` does not include the strongest data-safety evidence this release has. | Make CI (or `npm run dist`) run the drill when a profile copy is available, or add the skip reason to the gate table. |
| **M-14** | Test fixture server | nit | **confirmed** | `scripts/serve-renderer.mjs:34-39` | `path.resolve(root, relative)` then `if (!target.startsWith(root)) 403` — a sibling directory sharing the prefix (`…\renderer-evil`) passes. Test-only script, not in `app.asar`. | None in production; a fixture that could serve a sibling directory if one existed. | Compare against `root + path.sep` (or `path.relative`). |

### The four hard rules, checked against the diff

| Rule | Verdict | Evidence |
|---|---|---|
| **(a) Never break the Windows or web app** | **PASS on everything runnable** | `npm run typecheck` exit 0; node suite 737 passed; renderer suite 217 passed; `npm run build` exit 0; Playwright **10/10** on the built bundle; installer produced and matching the gate; `src/main/chat/service.ts` is **not in the diff** — the media path is a sibling, not a rewrite of chat. The one gap is the packaged launch (C1, below). |
| **(b) Never delete user data or credentials** | **PASS** | Migrations 003/004 are additive: two new tables, four added columns, FK `ON DELETE SET NULL` instead of `CASCADE` (`003-media.ts:38-39`). No production `DROP`/`DELETE` of an existing table appears in the diff (the `DELETE FROM media/generation_jobs` statements are new-table row deletes). I copied the owner's live profile (356,352 B) into the sink, ran the committed drill test on the copy: schema **2 → 4**, conversations 7 (6 visible), messages 68, agents 3, providers 4, models 128, settings 1 — **all unchanged**, `media`/`generation_jobs` added at 0 rows. Credential files untouched. |
| **(c) No invented provider endpoints or model capabilities** | **PASS (OpenAI verified live; Gemini/BFL not re-fetched)** | I fetched `developers.openai.com/api/reference/resources/images.md` (HTTP 200) and confirmed `POST /images/generations`, `POST /images/edits`, `ImageModel` contains `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare`, `gpt-image-2`; `/images/variations` retired; `gpt-image-1` shut down 2026-10-23 — all match the adapters and `MODEL_HINTS`. Structurally, no capability is inferred from a model-id substring: `shared/capabilities.ts:9-20` and `providers/capabilities.ts:75-95` route a non-chat-looking id to `unclassified` (all flags false), never to `imageOutput`. A BFL chat call **throws by design** (`providers/bfl.ts:30-35`), and `media-adapters.ts` maps bfl → video only. Gemini/BFL model ids and wire formats remain documentation-only (C2). |
| **(d) No replacing working implementations for architectural neatness** | **PASS** | `executor.ts` was removed only after both my import check and the repo's agree it is dead (barrel re-export + its own test); the chat transport is untouched. The ConfirmDialog extraction keeps the four sites' copy and `initialFocus="cancel"`, with tests. `highlight.js` was a genuinely unused **direct** dep (0 imports) — and the packaged app still carries the one copy `rehype-highlight → lowlight` needs (asar: one `highlight.js` tree, 4,483 entries total vs 6,057 before). |

---

## C — The security surfaces, attacked

19 checks against the **real modules** (bundled with esbuild; probe at `.work/…/tmp/probe/run.ts`):
**14 passed, 5 not clean**. The five are M-01, M-02, M-03, M-06, M-07 above.

| Attack | Result |
|---|---|
| Path escape via `MediaStore.resolve` — `../`, `..\..\`, absolute, drive-letter, UNC, leading dot, double slash, uppercase digest, 63-hex, trailing dot/space, `%00`, bare filename, empty (19 shapes) | **All 19 refused** (`store.resolve refuses 19 escape shapes`). The accepted name shape is exactly `[0-9a-f]{2}/[0-9a-f]{64}.[a-z0-9]{1,8}`, so no provider/prompt/renderer string can choose a path. |
| Hostile MIME steering the stored extension (`../../evil/png`, `image/png;x=.exe`, `text/html`) | **Refused**: `extensionForMime` maps to a closed set and falls back to `bin`; every stored path matched the content-addressed pattern. |
| `file://` / other-host / port / userinfo confusion on `media://` (`file:///`, `media://evil/…`, `media://LOCAL/…`, `media://local:8080/…`, `http://`, `not a url`, `MEDIA://` — case normalisation accepted, same scheme) | **Refused** except uppercase-scheme, which is correct URL semantics. |
| Percent-encoded traversal `media://local/%2e%2e%2f…` | Decodes to `../../etc/passwd`, then **the store refuses it** (defence in depth works). |
| Provider URL allowlist — `http://`, `evilbfl.ai`, `bfl.ai.evil.com`, `evil.com/bfl.ai`, `evil.com#@bfl.ai`, `javascript:`, `data:`, trailing-dot host, `ftp:` | **All refused**; `https://sub.bfl.ai/…` allowed. |
| Redirect following | `downloadBytes` passes **`redirect: 'error'`** (asserted on the `RequestInit` handed to fetch) and refuses a foreign host **before** any fetch call. |
| Size cap — declared `content-length` over cap, and a chunked body with no content-length | **Both refused** with `DownloadError`; the stream is cancelled. |
| `Content-Type` spoofing (`.html`, `.svg` in the media root) | Served as `application/octet-stream` — no live HTML/SVG type is reachable from the extension map. |
| CSP | `img-src`/`media-src` add `media:` only; `connect-src 'none'` in production, and `media:` is **not** in `connect-src`, so the renderer cannot `fetch()` a media URL. The dev CSP gained `media-src` (fixes the voice-memo dev bug) and still keeps `connect-src` scoped to the dev server. Vite's inline meta CSP and `security.ts` were changed identically. |
| Store atomicity | Temp file + rename, mode `0o600`, temp removed on a refused write (repo test + my save probe). |
| IPC schemas | `mediaGenerateSchema` is `.strict()`, prompt ≤ 32,000, params are scalar-only (`z.record` of string/number/boolean/null), reference ids capped at 16, and every channel goes through the existing `assertSender` invoker. No media channel accepts bytes or a path. |

---

## D — Supply chain

- `npm audit --omit=dev` → **0 vulnerabilities** (exit 0). `npm audit` → **18 (16 moderate, 2 critical), all dev-only** — matches the gate.
- `npm ls --depth=0` → 26 direct deps, all exact-pinned **except** the two new ones (M-05).
- `app.asar` (4,483 entries): **0** `playwright`, `axe-core`, `vitest`, `jsdom`, `@testing-library` paths; **0** `src/`, `tests/`, `.env`, `.map`, `.db`; 9 `dist/` entries. The browser toolchain is dev-only and does not ship.
- One `highlight.js` tree remains (transitive, required by `rehype-highlight`); the **duplicate** direct copy is gone — 6,057 → 4,483 asar entries, consistent with PART-003.

---

## E — Release-gate honesty (are the four conditions genuinely unprovable?)

| Condition | Auditor's verdict |
|---|---|
| **C1 packaged launch** | **Genuinely unprovable here — verified, not hidden.** The gate blames the environment; I tested it. `.\node_modules\electron\dist\electron.exe --version` exits **`-2147483645` (0x80000003)** with **no output** — the Electron binary dies before any JS, exactly as the gate says. Note for the owner: this environment sets **`ELECTRON_RUN_AS_NODE=1`**, which makes `npx electron <script>` silently run as plain Node (`require('electron')` returns a path string) — that is a trap for anyone re-running the smoke command, but it is not the reason C1 fails. |
| **C2 live provider** | **Not provable without the owner** — the key lives in the OS credential store, and a live call spends the owner's money. I deliberately did not attempt it. The OpenAI request shapes are verified against live docs; the wire behaviour is fixture-proven only. |
| **C3 macOS** | Not provable: no macOS host (`electron-builder` refuses cross-builds). The `mac:` block is configuration, stated as such. |
| **C5 signing** | No certificate in the environment (no `CSC_LINK`); the earlier build log records signing skipped. |
| **C4 version** | **Real and open** — M-04. |

So the gate is **not** hiding behind the label: the one condition I could attack (C1) is exactly as unprovable as claimed, and the gate names its own version condition.

---

## Evidence claims re-verified (16 of 16 checked hold, 2 with precision nits)

| Claim (gate/evidence) | My check | Result |
|---|---|---|
| Installer `124,981,226 B`, SHA-256 `F6992BE6…48C2` | `Get-FileHash release/Grenjo AI Tool-Setup-0.1.0-x64.exe` | **Exact match**, mtime 2026-11-03T23:28:10 |
| Gate 3: "62 files, 737 tests" | `vitest run --config vitest.node.config.ts` | 62 passed / **1 skipped**; 737 passed / **1 skipped** — counts match, the skip is disclosed separately (M-13) |
| Gate 4: "22 files, 217 tests" | renderer suite | **Exact** |
| Gate 5: "10 Playwright tests … axe 0 serious/0 critical" | `npx playwright test` after `npm run build` | **10/10 passed**, both axe tests included (M-11 on scope) |
| Gate 1: "275 files scanned, 3 findings, 0 blocking" | `node scripts/quality-gate.mjs` | **3 findings, 0 blocking**; **276** files at HEAD (M-10) |
| Gate 6: build PASS | `npm run build` | exit 0, three bundles |
| Gate 8 / §3 migration drill table | copied the owner's profile, ran the committed drill test | **schema 2→4, 7/68/3/4/128/1 unchanged, media+generation_jobs 0 rows** — every row of the table matches |
| Gate 9: installer carries the new icon | extracted the icon from `release/win-unpacked/Grenjo AI Tool.exe` with `System.Drawing.Icon` | 32×32, sha256 `c553354a…` — **identical to the Lead's `raw/shipped-icon.png`**, and visually the Grenjo circuit-C mark with "Grenjo" wordmark |
| Gate 11: version resource | `(Get-Item exe).VersionInfo` | `FileVersion 0.1.0`, `ProductVersion 0.1.0`, `ProductName Grenjo AI Tool` — **exact** |
| Gate 2: typecheck PASS | `npm run typecheck` | exit 0 |
| "18 dev-only advisories, 0 runtime" | `npm audit`, `--omit=dev` | 18 (2 critical) / **0** |
| "0 mobile/ paths in app.asar", "no src/tests/.env/.map" | asar listing | 0 / 0 |
| "highlight.js duplicate removed" | `package.json` + asar | direct dep gone; one transitive copy remains (correct) |
| Gate 7 `npm run dist` runs every gate first | `package.json:27` | `audit:gate && typecheck && test && build && test:e2e && electron-builder` — **exact** |
| Badge/PART claims of 737/217 | suites | exact |

**Not independently verified (stated, not assumed):** gate 10 (fuses) — `getCurrentFuseWire()` on the shipped exe returned an empty wire, so I can neither confirm nor refute the recorded byte arrays from the log; and the Gemini/BFL provider documentation (no fetch this run; no key).

---

## What I checked and how (commands, exit codes)

| # | Command | Result |
|---|---|---|
| 1 | `git rev-parse HEAD`, `git rev-parse v0.1.0-baseline^{commit}`, `git status --porcelain` | `0965c30…`; `76ad3e7…`; 0 entries |
| 2 | `git log --oneline v0.1.0-baseline..HEAD`; `git diff --stat` | 48 commits; 211 files, +13,984/−19,367 |
| 3 | `git diff --name-status` (src, tests, configs) | 32 main, 8 shared, 25 main-tests, 16 renderer-tests, 3 e2e; `executor.ts` D |
| 4 | read: `jobs.ts`, `service.ts`, `store.ts`, `protocol.ts`, `media-download.ts`, `003/004`, `repositories/media.ts`, `schemas.ts`, `capabilities.ts`, `media-adapters.ts`, `bfl.ts`, `security.ts` diff, `vite.renderer.config.ts` diff | findings M-01…M-12 |
| 5 | `npm run typecheck` | **exit 0** |
| 6 | `npx vitest run --config vitest.node.config.ts` | **exit 0** — 62 passed / 1 skipped; 737 passed / 1 skipped |
| 7 | `npx vitest run --config vitest.renderer.config.ts` | **exit 0** — 22 files, 217 tests |
| 8 | `node scripts/quality-gate.mjs` | **exit 0** — 276 files, 3 findings, 0 blocking |
| 9 | `npm run build` | **exit 0** |
| 10 | `npx playwright test` | **exit 0** — 10/10 |
| 11 | copy owner profile → `DRILL_DB` → `vitest … profile-migration.drill.test.ts` | **exit 0** — `[drill] before/after` quoted above |
| 12 | `Get-FileHash` / `VersionInfo` / `Icon::ExtractAssociatedIcon` on the shipped exe | hash exact; version exact; icon = Grenjo mark |
| 13 | asar listing via `@electron/asar` | 4,483 entries; dev toolchain absent |
| 14 | `npm ls --depth=0`; `npm audit`; `npm audit --omit=dev` | 26 deps; 18 dev-only; **0 runtime** |
| 15 | my probe (`esbuild` bundle → `node run.mjs`): store/protocol/download/job-engine/schema | **19 checks, 14 pass** — M-01, M-02, M-03, M-06, M-07 reproduced |
| 16 | `web_fetch` OpenAI Images reference (`.md`, HTTP 200) | endpoints + model ids confirmed |
| 17 | `electron.exe --version` without the forced-node var | `-2147483645` (0x80000003), no output — C1 confirmed unprovable |
| 18 | `getCurrentFuseWire(shipped exe)` | empty result — gate 10 **not checked** |

**Not run, deliberately:** `npm run dist` (forbidden — rewrites `release/`), `npm install` (would rewrite the lockfile), a live provider call (owner's key and money), mac build (no host).

---

## Residual risk

| Risk | Likelihood | Impact | What detects/handles it |
|---|---|---|---|
| Canceled job completes and stores media (M-01) | medium | medium (a billed job the user canceled) | fix M-01, or a UI note; a job-status log would show `canceled → succeeded` |
| Crash-resume of a stored generation fails the job (M-02) | low-medium | medium (confusing failure, orphan row) | fix M-02; the media row is recoverable by `sha256` |
| Long video fails on a transient error (M-03) | medium | medium (regenerate = money) | fix M-03 |
| Two artefacts share version 0.1.0 (M-04) | certain | medium (support/upgrade ambiguity) | bump version |
| Packaged launch never observed (C1) | — | high if the app fails to start | owner runs `npm run smoke:packaged` from a desktop session — the only unrun check that could turn this into a NO-GO |
| No live provider call (C2) | — | medium | owner generates one image and one video with a real key |
| macOS config unrun (C3), signing absent (C5) | — | medium | mac host + certificate |
| `media://` seek inefficiency (M-09) | medium | low | packaged seek test |

---

*Written by `auditor` to `.work/2026-11-03-audit-consolidation/out/final-audit.md`. No tracked file was
modified; `git status --porcelain` returned 0 entries before and after this audit. The only writes outside the
sink were the ignored build output from the authorised `npm run build`, and Playwright produced no report
because every test passed.*
