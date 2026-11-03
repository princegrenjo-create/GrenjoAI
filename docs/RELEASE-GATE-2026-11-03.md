# Release gate — v0.2.0 candidate (2026-11-03)

**Decision: GO WITH CONDITIONS.** The application builds, its suites pass, its installer is produced, and the
database of a real existing profile upgrades with **zero row loss**. Four items cannot be proven in this
environment — a packaged launch, a live provider call, a macOS build, and code signing — and every one of them
is named below with the command that closes it.

---

## 1. Candidate identity

| Field | Value |
|---|---|
| Commit | `0b62192` (+ this document) |
| Branch | `master` |
| Version | `0.1.0` in `package.json` — **the version was not bumped for this candidate**; see condition C4 |
| Installer | `release/Grenjo AI Tool-Setup-0.1.0-x64.exe` |
| Size | 124,981,226 bytes |
| SHA-256 | `F6992BE632F5C2769C84AE6EF3624716FC6868EF78EBC77ED248B06A14EA48C2` |
| Built | 2026-11-03T23:28:10+08:00, by `npm run dist` on Windows 10.0.26300, electron-builder 26.18.0 |
| Electron | 44.10.0 (Node 24.22.1, Chromium 152) |
| Build once, promote | the installer is produced by one command that runs every gate first; nothing is rebuilt per environment |

## 2. Verification gates

| # | Gate | Result | Evidence |
|---|---|---|---|
| 1 | `npm run audit:gate` | **PASS** | 275 files scanned, 3 findings, **0 blocking** (the 3 are `service_role` named inside its own refusal guard) |
| 2 | `npm run typecheck` | **PASS** | exit 0, both projects (`tsconfig.node.json`, `tsconfig.web.json`) |
| 3 | node suite | **PASS** | 62 files, **737 tests**, exit 0 |
| 4 | renderer suite | **PASS** | 22 files, **217 tests**, exit 0 |
| 5 | browser suite (`npm run test:e2e`) | **PASS** | **10 Playwright tests**, Chromium, against the built bundle: layout at 940×600 and 1280×860, provider-specific controls, no chat model in the image picker, video player not autoplaying on `media://`, and **axe with 0 serious / 0 critical** on both studios |
| 6 | `npm run build` | **PASS** | three bundles, exit 0 |
| 7 | `npm run dist` | **PASS** | gates → build → browser suite → NSIS installer; installer hash above |
| 8 | Migration drill on a **real profile** | **PASS** | see §3 |
| 9 | Installer carries the new icon | **PASS** | the icon extracted from `release/win-unpacked/Grenjo AI Tool.exe` is the Grenjo mark (recorded in the run sink as `raw/shipped-icon.png`) |
| 10 | Fuses flipped in the shipped binary | **PASS** | `afterPack` log: `before={…49,48,49,49,48,48,48,49,49} after={…48,49,48,48,49,49,48,49,49}` |
| 11 | Version resource in the executable | **PASS** | `FileVersion 0.1.0`, `ProductVersion 0.1.0`, `ProductName Grenjo AI Tool` |

## 3. Migration drill — a real profile, not a fixture

The owner's live profile (`%APPDATA%\Grenjo AI Tool\data\app.db`, 356,352 bytes) was **copied** into the run
sink and opened by the build under test. The original was never touched.

| | Before | After |
|---|---|---|
| Schema version | **2** | **4** |
| Conversations | 7 (6 visible) | 7 (6 visible) |
| Messages | 68 | 68 |
| Agents | 3 | 3 |
| Providers | 4 | 4 |
| Models | 128 | 128 |
| Settings rows | 1 | 1 |
| `media` / `generation_jobs` | absent | present, 0 rows |

Repeatable with:

```powershell
npm run build
Copy-Item "$env:APPDATA\Grenjo AI Tool\data\app.db" ".work\drill\app.db" -Force
$env:DRILL_DB='.work/drill/app.db'; npx vitest run --config vitest.main... tests/main/db/profile-migration.drill.test.ts
```

**Consequence to state in release notes:** after this build opens a profile, the previous build refuses it (the
runner will not open a newer schema). There is no downgrade path; that guard is deliberate.

## 4. Conditions — the four things this gate cannot prove here

| # | Item | Why it is not proven | Owner | How to close it |
|---|---|---|---|---|
| **C1** | **A packaged launch** (`npm run smoke:packaged`) | **UNAVAILABLE — environment.** The app exits before any JavaScript runs: this shell's file sandbox denies the writes Chromium needs at process init. A *pristine* Electron probe with no application code fails identically (`0x80000003`), and the one run that surfaced stderr showed `Lock file can not be created: Access is denied (0x5)`. Not an app defect, and not this change | **Owner** | From a normal desktop session: `npm run smoke:packaged` (9 checks: preload bridge, CSP, Node isolation, userData outside the install dir) |
| **C2** | **A live provider call** — one image, one video, one edit | **UNAVAILABLE — no API key.** Request bodies, parsers, status mapping, retries and the download path are proven against fixtures; the network is not | **Owner** | Add a key, generate one image and one video, and check the job reaches `succeeded` with a file on disk |
| **C3** | **A macOS build** | **UNAVAILABLE — no mac host.** `electron-builder --mac` answers *"Build for macOS is supported only on macOS"* after loading the config, so the configuration is valid and unrun | **Owner** (or a mac CI runner) | On a mac: `npm run pack:mac`, launch, confirm the microphone prompt, then `npm run smoke:packaged` |
| **C4** | **Version number** | `package.json` still says `0.1.0`, and this candidate contains schema 4 and two new features. Shipping it under the 0.1.0 installer name would make two different artefacts share a version | **Lead, on approval** | Bump to `0.2.0` and rebuild; the installer name follows automatically |
| **C5** | **Code signing** | **UNAVAILABLE — no certificate.** Both platforms skip signing, so Gatekeeper and SmartScreen warn | **Owner** | Buy a certificate / Developer ID; set `CSC_LINK` + `CSC_KEY_PASSWORD` (Windows) or a Developer ID identity (macOS) and rebuild |
| **C6** | **Install → launch → uninstall cycle** | Not run: installing writes outside the workspace, which this session may not do | **Owner** | Run the installer once, launch, uninstall, confirm `%APPDATA%` survives |

## 5. What would make this a NO-GO

- Any gate in §2 failing.
- The migration drill losing a row, or the profile refusing to upgrade.
- An installer that launches the previous build's code (rebuilt per environment) rather than the audited one.

None of those happened.

## 6. Residual risks accepted for this candidate

| Risk | Why accepted |
|---|---|
| No packaged launch has been observed | The bundle, the preload contract and the CSP are proven by the browser suite and by unit tests; the remaining risk is packaging-specific and is exactly what C1 closes |
| No provider has been called | Fixtures cover the documented shapes; a live call is the only proof, and it needs a key |
| Media is local-only and never syncs | The owner's decision (Q4); a synced media feature would be a separate change with its own migration |
| `npm audit` reports 18 dev-only advisories, 0 runtime | `npm audit --omit=dev` is zero; the criticals are in the vitest toolchain and npm's fix is a downgrade to an ancient electron-builder |
| No CI: the gate is a script, not a server | Every gate is a command that runs locally in one chain (`npm run dist`); adding CI is a separate decision |

---

**Prepared by:** the Lead, from the recorded output of every command above.
**Independent audit of this candidate:** PART-014, by a reviewer who did not write the code.
