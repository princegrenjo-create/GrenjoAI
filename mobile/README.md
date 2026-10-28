# Grenjo AI Tool — mobile

Android and iOS client for [Grenjo AI Tool](../README.md), built with **Expo SDK 58
+ React Native 0.88 + TypeScript**, living entirely in this folder.

This is a separate application, not a port of the desktop shell. It has its own
dependencies, its own screen tree, its own database and its own credential store.
The desktop app under `../src` is not imported, modified or built by anything here.

## What works

| Area | State |
|---|---|
| Chat with streaming, stop, per-conversation model | **implemented** |
| Conversations: list, search, new, rename (long-press delete) | **implemented** |
| Agents: create, edit, delete (name + system prompt) | **implemented** |
| Providers: DeepSeek, OpenAI, Anthropic, Gemini, OpenAI-compatible | **implemented** — the five adapters are the desktop ones, copied |
| API key storage | **implemented** — iOS Keychain / Android Keystore, bound to the provider's base URL |
| Model discovery + "Others / Custom Models" | **implemented** |
| Attachments: documents, images, camera | **implemented** — see the platform note below |
| Voice recording + transcription | **implemented** — OpenAI `whisper-1` |
| Cloud sync | **not in this release**, by design |

## Platform note: documents

The desktop app extracts PDF and DOCX text with `unpdf` and `mammoth`, which need
Node APIs. React Native has no equivalent, so mobile:

- extracts text from **text-shaped files** (txt, md, csv, tsv, json, yaml, xml,
  html, css, and 20+ source-code extensions);
- attaches PDF/DOCX and anything else as **metadata only**, with an explicit
  `contentStatus: 'metadata-only'` and a note that reaches the model saying the
  contents were *not* included.

Nothing on mobile claims a PDF was read. Adding PDF/DOCX extraction would mean
either a native module or a server round-trip; both were deliberately left out of
this release.

## Where your data lives

- SQLite (`expo-sqlite`, `grenjo.db`) in the app's private sandbox: conversations,
  messages, agents, providers, custom models, settings.
- API keys in the OS credential store (`expo-secure-store`), never in SQLite.
- No cloud sync: nothing is uploaded except the text, images and audio you
  explicitly send to a provider you configured.

## Run it

```bash
cd mobile
npm install --legacy-peer-deps      # see note below
npx expo start                      # Expo Go for JS-only work
npx expo run:android                # or: npx expo run:ios  (needs a device/simulator)
```

`npm install` needs `--legacy-peer-deps`: the Expo toolchain pins peer ranges that
conflict with `vitest`'s. It affects only the unit-test runner, which runs under
Node and never ships in the app.

### Checks

```bash
npx tsc --noEmit                                   # typecheck (strict, noUncheckedIndexedAccess)
npm test                                           # 136 unit tests
npx expo export --platform android                 # Metro bundle for Android
npx expo export --platform ios                     # Metro bundle for iOS
```

### Build a real app binary

```bash
npx eas-cli@latest build -p android --profile preview     # AAB/APK in EAS
npx eas-cli@latest build -p ios --profile preview
# or locally:
npx expo prebuild --platform android && cd android && ./gradlew assembleDebug
```

`ios/` and `android/` are generated (Continuous Native Generation) — never edit
them by hand; configure native behaviour in `app.json`.

## Reused code, and how it stays honest

| Copied from desktop | Why it is safe to copy |
|---|---|
| `../src/shared/{types,defaults,params,errors,url-policy,attachments,settings,provider-contract,schemas}.ts` → `src/core/` | Platform-free modules: no `electron`, no `node:` imports. Verified by grep before copying. |
| `../src/main/providers/{sse,json,request,capabilities,openaiFamily,deepseek,openai,gemini,anthropic,openaiCompatible,multipart,registry}.ts` → `src/ai/providers/` | Pure request-building and parsing; they never perform I/O themselves. |
| `../tests/main/providers/*.test.ts` → `tests/` | The same 118 adapter tests now run here, with the aliases rewritten. |

**Not copied, on purpose:** the Electron main process, the IPC layer, the sync
engine, the renderer components, and the SQLite data-access layer (which is built
on `node:sqlite`). The desktop app remains the only consumer of those.

The copies are snapshots. When the desktop core or an adapter changes, re-copy and
re-run `npm test` here — there is no build-time link between the two projects, so
nothing breaks if you forget, you just fall behind.
