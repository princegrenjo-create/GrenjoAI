#!/usr/bin/env node
/**
 * Development launcher.
 *
 * Builds the main and preload bundles, starts the Vite dev server for the
 * renderer, then starts Electron pointed at that server. Main/preload changes are
 * watched and trigger a rebuild plus an Electron restart; renderer changes are
 * handled by Vite HMR.
 *
 * Written by hand (no concurrently/wait-on dependency) so the dev path has no
 * extra packages to trust.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';
import electron from 'electron';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distMain = path.join(root, 'dist', 'main', 'index.cjs');
const distPreload = path.join(root, 'dist', 'preload', 'index.cjs');

/** @type {import('node:child_process').ChildProcess | null} */
let electronProcess = null;
let shuttingDown = false;
let building = false;
let rebuildQueued = false;

function log(message) {
  process.stdout.write(`[dev] ${message}\n`);
}

async function buildBundles() {
  if (building) {
    rebuildQueued = true;
    return;
  }
  building = true;
  try {
    await build({ configFile: path.join(root, 'vite.main.config.ts'), mode: 'development' });
    await build({ configFile: path.join(root, 'vite.preload.config.ts'), mode: 'development' });
    log('main + preload bundles built');
  } finally {
    building = false;
    if (rebuildQueued) {
      rebuildQueued = false;
      void buildBundles();
    }
  }
}

function startElectron(devServerUrl) {
  if (electronProcess) {
    electronProcess.removeAllListeners('exit');
    electronProcess.kill();
  }
  // ELECTRON_RUN_AS_NODE would start the bundle as plain Node, where
  // `require('electron')` is a path string, not the API. Never inherit it.
  const env = { ...process.env, VITE_DEV_SERVER_URL: devServerUrl, NODE_ENV: 'development' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;

  electronProcess = spawn(electron, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env,
  });
  electronProcess.on('exit', (code) => {
    if (shuttingDown) return;
    log(`electron exited with code ${code}; stopping dev server`);
    shutdown(code ?? 0);
  });
}

function watchBundles(onChange) {
  let timer = null;
  const targets = [path.join(root, 'dist', 'main'), path.join(root, 'dist', 'preload')];
  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    fs.watch(target, { persistent: true }, () => {
      if (building) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onChange();
      }, 220);
    });
  }
}

let devServer = null;

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (electronProcess) {
      electronProcess.removeAllListeners('exit');
      electronProcess.kill();
    }
  } catch {
    /* already gone */
  }
  try {
    if (devServer) await devServer.close();
  } catch {
    /* already closed */
  }
  process.exit(code);
}

async function main() {
  if (!fs.existsSync(path.join(root, 'src', 'renderer', 'main.tsx'))) {
    log('src/renderer/main.tsx is missing — the renderer workstream has not landed yet.');
    log('Starting anyway so the Electron shell can be exercised.');
  }

  await buildBundles();

  devServer = await createServer({ configFile: path.join(root, 'vite.renderer.config.ts') });
  await devServer.listen();
  const url = devServer.resolvedUrls?.local?.[0];
  if (!url) throw new Error('Vite did not report a dev server URL');
  log(`renderer dev server at ${url}`);

  startElectron(url);

  watchBundles(async () => {
    log('change detected in dist/; rebuilding and restarting Electron');
    await buildBundles();
    if (!shuttingDown) startElectron(url);
  });

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
}

main().catch(async (error) => {
  process.stderr.write(`[dev] failed: ${error?.stack ?? error}\n`);
  await shutdown(1);
});

// Keep the module graph alive; the watchers and the child process own the loop.
void distMain;
void distPreload;
