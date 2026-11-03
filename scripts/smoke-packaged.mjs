#!/usr/bin/env node
/**
 * Packaged-application smoke test.
 *
 * Launches the real installed (or unpacked) executable, waits for it to write a
 * probe file, and asserts that inside the shipped runtime:
 *   - `window.api` exists and the chat bridge is callable,
 *   - `window.require` and `window.process` do NOT exist (Node is unreachable),
 *   - React actually mounted children into #root,
 *   - the CSP meta tag is present in the built HTML,
 *   - userData lives outside the install directory.
 *
 * Usage:
 *   node scripts/smoke-packaged.mjs [--exe=<path to .exe>] [--out=<result.json>]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

/**
 * Electron switches to plain-Node mode when ELECTRON_RUN_AS_NODE is set in the
 * environment (a common leftover from a probe or another tool). Inheriting it
 * would make the packaged app start without app/window APIs, so it is stripped.
 */
function cleanElectronEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

const candidates = [
  argValue('exe'),
  path.join(root, 'release', 'win-unpacked', 'Grenjo AI Tool.exe'),
  path.join(root, 'release', 'win-unpacked', 'grenjo-ai-tool.exe'),
].filter(Boolean);

const exePath = candidates.find((candidate) => fs.existsSync(candidate));
if (!exePath) {
  process.stderr.write(
    `[smoke] no packaged executable found. Looked for:\n${candidates.map((c) => `  - ${c}`).join('\n')}\n` +
      `[smoke] run "npm run pack" first, or pass --exe=<path>.\n`,
  );
  process.exit(2);
}

const runId = new Date().toISOString().replace(/[:.]/g, '-');
/** Local ISO-8601 date, so runs from different days never share one sink. */
function localDate() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
const outPath =
  argValue('out') ??
  path.join(root, '.work', `${localDate()}-packaged-smoke`, 'out', `smoke-${runId}.json`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
if (fs.existsSync(outPath)) fs.rmSync(outPath, { force: true });

process.stdout.write(`[smoke] launching ${exePath}\n`);

const child = spawn(exePath, ['--smoke-test', `--smoke-out=${outPath}`], {
  cwd: path.dirname(exePath),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: cleanElectronEnv(),
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

const hardTimeout = setTimeout(() => {
  process.stderr.write('[smoke] timeout after 60s; killing the app\n');
  child.kill();
}, 60000);

child.on('exit', (code, signal) => {
  clearTimeout(hardTimeout);
  const waited = Date.now();
  void waited;

  if (!fs.existsSync(outPath)) {
    process.stderr.write(
      `[smoke] FAIL: the app exited (code=${code} signal=${signal}) without writing a result.\n`,
    );
    if (stdout.trim()) process.stderr.write(`[smoke] stdout:\n${stdout}\n`);
    if (stderr.trim()) process.stderr.write(`[smoke] stderr:\n${stderr}\n`);
    process.exit(1);
  }

  const result = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const probe = result.probe ?? {};
  const installDir = path.dirname(exePath);
  const userData = String(result.app?.userDataPath ?? '');
  const outsideInstall = userData.length > 0 && !userData.startsWith(installDir);
  const inAppData =
    userData.toLowerCase().startsWith(path.join(os.homedir(), 'AppData').toLowerCase()) ||
    userData.toLowerCase().startsWith((process.env.APPDATA ?? 'C:\\__none__').toLowerCase());

  const checks = [
    ['preload bridge exposed (window.api is an object)', probe.apiType === 'object'],
    ['chat.send is callable', probe.hasChatSend === true],
    ['window.require is undefined (no Node in renderer)', probe.requireType === 'undefined'],
    ['window.process is undefined', probe.processType === 'undefined'],
    ['React mounted into #root', Number(probe.rootChildren) > 0],
    ['CSP meta tag present in the built HTML', probe.cspPresent === true],
    ['userData is outside the install directory', outsideInstall],
    ['userData is under the user profile AppData', inAppData],
    ['process exit code is 0', code === 0],
  ];

  process.stdout.write(`\n[smoke] result file: ${outPath}\n`);
  process.stdout.write(`[smoke] userData: ${userData}\n`);
  process.stdout.write(`[smoke] database: ${result.app?.databasePath}\n`);
  process.stdout.write(`[smoke] packaged: ${result.app?.packaged}\n`);
  process.stdout.write(`[smoke] secure storage available: ${result.app?.secureStorageAvailable}\n\n`);

  let failed = 0;
  for (const [label, pass] of checks) {
    if (!pass) failed += 1;
    process.stdout.write(`  ${pass ? 'PASS' : 'FAIL'}  ${label}\n`);
  }

  if (result.error) process.stdout.write(`\n[smoke] probe error: ${result.error}\n`);
  process.stdout.write(
    `\n[smoke] ${checks.length - failed}/${checks.length} checks passed\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
});
