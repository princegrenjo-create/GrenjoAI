/**
 * Main window creation.
 *
 * The window is deliberately minimal in capability: no Node, no webview, no
 * preload-supplied filesystem access, sandboxed renderer. Everything privileged
 * happens behind the validated IPC surface.
 */
import path from 'node:path';
import { BrowserWindow, nativeTheme } from 'electron';
import type { Logger } from './logger';

export interface CreateWindowOptions {
  preloadPath: string;
  /** Dev server URL, or null for the packaged `file://` entry. */
  devServerUrl: string | null;
  rendererEntry: string;
  isDev: boolean;
  logger: Logger;
  onRendererGone: () => void;
}

export function createMainWindow(options: CreateWindowOptions): BrowserWindow {
  const { preloadPath, devServerUrl, rendererEntry, isDev, logger, onRendererGone } = options;

  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e0e11' : '#f7f7f8',
    autoHideMenuBar: true,
    title: 'Personal AI Desk',
    webPreferences: {
      preload: preloadPath,
      // The four settings that matter. Do not relax one without an ADR.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: true,
      devTools: isDev,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    logger.error('Renderer process gone', { reason: details.reason, exitCode: details.exitCode });
    onRendererGone();
  });

  window.webContents.on('preload-error', (_event, preloadFile, error) => {
    logger.error('Preload script failed', { preloadFile, message: error.message });
  });

  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    logger.error('Renderer failed to load', { code, description, url });
  });

  window.on('closed', () => {
    logger.info('Main window closed');
  });

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
    if (isDev) window.webContents.openDevTools({ mode: 'detach' });
  } else {
    void window.loadFile(rendererEntry);
  }

  return window;
}

export function resolveRendererEntry(distDir: string): string {
  return path.join(distDir, 'renderer', 'index.html');
}
