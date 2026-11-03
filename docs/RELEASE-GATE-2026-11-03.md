# Release gate — v0.2.0 (2026-11-03)

**Decision: GO WITH CONDITIONS.** Every gate this host can run passed, the installer is produced from the
audited commit, the owner's real profile upgrades from schema 2 to 4 with **zero row loss**, and an
independent audit that wrote none of this code reproduced three real defects — all three are now fixed and
each has a regression test. Four items remain unprovable here, and one of them (C2) had a **wrong reason in
the first version of this document**; that is corrected below rather than quietly softened.

---

## 1. Candidate identity

| Field | Value |
|---|---|
| Commit | `HEAD` of `master` at the time of the rebuild (see §7) |
| Version | **0.2.0** |
| Installer | `release/Grenjo AI Tool-Setup-0.2.0-x64.exe` |
| Size | 124,981,723 bytes |
| SHA-256 | `AB18B547B37A04A0B3083076C4C272DF4FA8402507D6740C3A78CB92C3B9D421` |
| Built | 2026-11-03T23:46:49+08:00 by `npm run dist` (gates → build → browser suite → NSIS) |
| Version resource | `FileVersion 0.2.0`, `ProductVersion 0.2.0`, `ProductName Grenjo AI Tool` |
| Superseded artefact | `Grenjo AI Tool-Setup-0.1.0-x64.exe` (124,981,226 B, `F6992BE6…EA48C2`) — same code, pre-audit-fix, pre-version-bump |

Built once and promoted: `npm run dist` runs every gate before it packages, and nothing is rebuilt per
environment.

## 2. Verification gates (re-run after the audit fixes)

| # | Gate | Result | Evidence |
|---|---|---|---|
| 1 | `npm run audit:gate` | **PASS** | 276 files scanned, 3 findings, **0 blocking** |
| 2 | `npm run typecheck` | **PASS** | exit 0, both projects |
| 3 | node suite | **PASS** | 63 files, **741 tests** (1 skipped: the drill, needs `DRILL_DB`) |
| 4 | renderer suite | **PASS** | 22 files, **217 tests** |
| 5 | browser suite | **PASS** | **10 Playwright tests** on the built bundle, axe 0 serious / 0 critical |
| 6 | `npm run build` | **PASS** | exit 0 |
| 7 | `npm run dist` | **PASS** | gates → installer, hash above |
| 8 | Migration drill (real profile) | **PASS** | §3 |
| 9 | Icon in the shipped exe | **PASS** | extracted by two people independently: the Grenjo mark |
| 10 | Fuses in the shipped exe | **PASS** | read out of the binary: `48,49,48,48,49,49,48,49,49` |
| 11 | Fixes present in the shipped bundle | **PASS** | `app.asar → dist/main/index.cjs`: `TERMINAL_JOB_STATUSES` ×2, `pollCounts` ×3, `getByRelativePath` ×2 |

**Scope limits stated rather than implied:** the axe scans run on each studio's **populated** state only for
the controls they assert; the reference grid and the error banners of the studios are not scanned, and the
suite scans with a stubbed bridge. "0 serious/critical" is true and narrower than it reads.

## 3. Migration drill — a real profile, not a fixture

The owner's live profile (`%APPDATA%\Grenjo AI Tool\data\app.db`, 356,352 bytes, **still at schema 2**) was
copied into the run sink; the copy was opened by this build. Run twice independently — by the Lead and by the
auditor — with identical results. The source was never touched.

| | Before | After |
|---|---|---|
| Schema version | **2** | **4** |
| Conversations | 7 (6 visible) | 7 (6 visible) |
| Messages | 68 | 68 |
| Agents / providers / models / settings | 3 / 4 / 128 / 1 | identical |
| `media`, `generation_jobs` | absent | present, 0 rows |

Repeat:
```powershell
Copy-Item "$env:APPDATA\Grenjo AI Tool\data\app.db" ".work\drill\app.db" -Force
$env:DRILL_DB='.work/drill/app.db'
npx vitest run --config vitest.node.config.ts tests/main/db/profile-migration.drill.test.ts
```
**Release note consequence:** once this build opens a profile, the previous build refuses it (the runner will
not open a newer schema). There is no downgrade path; that guard is deliberate.

## 4. The independent audit (PART-014) and what changed

Two reviewers who wrote none of this code: a code/security auditor and an evidence verifier. Verdicts:
**SHIP WITH CONDITIONS** and **HONEST, with one misleading condition (C2)**. The audit is not summarised away
— three of its findings were real defects, and they are fixed here.

| ID | Finding | Status after this release |
|---|---|---|
| **M-01** | A cancel landing while a provider poll was in flight was overwritten: the awaited result persisted media and set `succeeded` | **FIXED** — the repository refuses any status change out of a terminal state, and the engine re-reads the job after the call returns, before persisting. Regression test: *"does not store media for a job cancelled while its poll was open"* |
| **M-02** | Identical bytes twice hit the unique index on `relative_path` and failed the job ("A SQL write failed") on the documented crash-resume path | **FIXED** — `getByRelativePath` reuses the existing row instead of inserting a duplicate. Regression test: *"reuses the media row instead of failing a job whose file already exists"* |
| **M-03** | Every *successful* poll spent the retry budget, so a long video died permanently on the first network blip | **FIXED** — polling now drives backoff from its own counter; `attempts` counts failures only. Regression tests: *"keeps polling past maxAttempts and survives a transient failure afterwards"*, *"spends the retry budget only on failures"* |
| **M-04** | Version stayed `0.1.0` while carrying schema 4 | **FIXED** — 0.2.0, rebuilt, re-hashed |
| **M-05** | The two new devDependencies were caret-ranged in an otherwise exact-pinned tree | **FIXED** — `1.56.1` and `4.11.0` exactly |
| **M-06** | A malformed percent escape made `media://` parsing throw instead of returning null | **FIXED** + test |
| **M-07** | The job engine has no re-entrancy guard of its own (only `tickSafely` serialises) | **ACCEPTED** — documented at the engine; the single caller is the service, and a second caller would be a code change this release does not make |
| **M-08** | Dead `inFlight` map with a comment implying a cross-tick budget | **FIXED** — removed; the poll counter is the real mechanism |
| **M-09** | `media://` ignores `Range` and always answers 200 | **ACCEPTED as a known limitation** — seeking a large clip may re-fetch; needs a packaged run to measure, and the protocol handler is unchanged otherwise |
| **M-10/M-13** | Evidence precision: 275 vs 276 files; the drill is skipped by default | **FIXED in this document** — 276 recorded, and the skip is stated in §2 |
| **M-11** | axe scans a narrower page state than "0 violations on both studios" implies | **STATED in §2** rather than fixed: scanning result grids needs a local `media://` server the fixture does not have |
| **M-12** | A comment claimed the row is deleted before the file; the code does the reverse | **FIXED** — the comment now explains why file-first is correct |
| **M-14** | The test-only static server's prefix check could admit a sibling directory | **FIXED** — compares against `root + path.sep` |

**What the audit confirmed as genuinely sound** (not merely un-refuted): 19 adversarial checks on the media
surfaces, of which the store refused **all 19** path-escape shapes, the download allowlist refused every
host-confusion shape including `bfl.ai.evil.com` and `evil.com#@bfl.ai`, redirects are refused before any
fetch, and no media channel accepts bytes or a path. `npm audit --omit=dev` → **0**. The four hard rules hold:
the chat service is untouched by the media work, migrations are additive, no capability is inferred from a
model id, and no working implementation was replaced for tidiness.

## 5. Conditions — what this gate cannot prove here

| # | Item | Why | Owner | How to close it |
|---|---|---|---|---|
| **C1** | A packaged launch | **UNAVAILABLE — the Electron binary cannot start in this environment.** Verified twice, including by the auditor: `electron.exe --version` exits `0x80000003` with **no output**, with the file sandbox on and off, and a stock Electron with no app fails identically. *The first version of this document blamed the file sandbox; that explanation is withdrawn — it fails with the sandbox disabled too.* | **Owner** | From a desktop session: `npm run smoke:packaged`. Note this shell sets `ELECTRON_RUN_AS_NODE=1`, which makes `npx electron <script>` silently run as Node; unset it before re-testing |
| **C2** | A live provider call | **NOT ATTEMPTED — and this is a correction.** The first version said "no API key exists"; that was **wrong**. The profile has `key_fingerprint` + `key_updated_at` for DeepSeek, Gemini and OpenAI, and `credentials.bin` holds three encrypted entries. A call was not made because it spends the owner's credit and sends their data to a third party without being asked. Validity of those keys is unknown | **Owner** | Generate one image and one video with a real key; confirm the job reaches `succeeded` with a file on disk |
| **C3** | A macOS build | **UNAVAILABLE — no mac host.** `electron-builder --mac` answers *"Build for macOS is supported only on macOS"* after loading the config | **Owner** / mac CI | On a mac: `npm run pack:mac`, launch, confirm the microphone prompt, then `npm run smoke:packaged` |
| **C5** | Code signing | **UNAVAILABLE — no certificate.** Authenticode on both installers: `NotSigned` | **Owner** | Buy a certificate / Developer ID; set `CSC_LINK` + `CSC_KEY_PASSWORD` or a Developer ID identity and rebuild |
| **C6** | Install → launch → uninstall | Not run: installing writes outside the workspace | **Owner** | Run the 0.2.0 installer once, launch, uninstall, confirm `%APPDATA%` survives |

C4 (version) is **closed**.

## 6. Residual risk accepted

| Risk | Why accepted |
|---|---|
| No packaged launch observed | The bundle, preload contract and CSP are proven by the browser suite and unit tests; the gap is packaging-specific and is exactly what C1 closes |
| No live provider call | Request shapes, parsers, status mapping and the download path are proven against fixtures and live documentation; the wire is not |
| `media://` does not support Range (M-09) | Seeking may re-fetch bytes; correctness is unaffected. Needs a packaged run to measure |
| The engine trusts its single caller (M-07) | `tickSafely` serialises in the service; a second caller is a future code change |
| Media is local-only and never syncs | The owner's decision; a synced media feature is a separate change with its own migration |
| 18 dev-only advisories, 0 runtime | `npm audit --omit=dev` is zero; npm's fix for the criticals is a downgrade to an ancient electron-builder |
| No CI | Every gate is one chain (`npm run dist`); adding CI is a separate decision |

## 7. Note on the audited commit

The audit ran against `0965c30`. The fixes in §4 landed after it, in the commit that carries this document,
and the installer was rebuilt from **that** commit. The shipped bundle was verified to contain all three
media fixes by reading `dist/main/index.cjs` out of `app.asar` (§2 gate 11) — the artefact and the audited,
fixed source are the same code.

---

**Prepared by:** the Lead, from the recorded output of every command above and the two audit reports in
`.work/2026-11-03-audit-consolidation/out/` (`final-audit.md`, `claims-audit.md`).
