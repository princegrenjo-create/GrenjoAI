/**
 * Page-test support.
 *
 * The bridge double is the shared `createFakeApi`; this file only adds the value
 * factories the four settings-shaped pages need, plus a bridge-shaped error so a
 * rejection carries the same `appError` the preload attaches.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { appError } from '@shared/errors';
import type {
  AppErrorShape,
  AppInfo,
  AppPaths,
  ErrorCode,
  ProviderConfig,
  SyncConflict,
  SyncStatus,
} from '@shared/types';
import { __setApiForTest } from '@renderer/lib/api';
import { createFakeApi, type FakeApi, type FakeApiOptions } from '../helpers/fake-api';

export function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'provider-1',
    kind: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    enabled: true,
    hasKey: true,
    keyFingerprint: '1a2b3c4d',
    keyUpdatedAt: '2026-10-28T10:00:00.000Z',
    supportsModelDiscovery: true,
    supportedParams: ['temperature', 'topP', 'maxOutputTokens', 'stop'],
    createdAt: '2026-10-28T10:00:00.000Z',
    updatedAt: '2026-10-28T10:05:00.000Z',
    ...overrides,
  };
}

export function makeSyncStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    enabled: true,
    signedIn: true,
    email: 'owner@example.com',
    userId: 'user-1',
    phase: 'idle',
    pendingCount: 0,
    conflictCount: 0,
    lastSyncedAt: '2026-10-28T10:05:00.000Z',
    lastError: null,
    online: true,
    ...overrides,
  };
}

export function makeConflict(overrides: Partial<SyncConflict> = {}): SyncConflict {
  return {
    id: 1,
    entity: 'conversation',
    entityId: 'conv-1',
    localRevision: 3,
    remoteRevision: 5,
    detectedAt: '2026-10-28T10:05:00.000Z',
    resolution: 'unresolved',
    summary: 'The title and the message count changed on both machines.',
    ...overrides,
  };
}

export function makeAppInfo(overrides: Partial<AppInfo> = {}): AppInfo {
  return {
    name: 'Personal AI Desk',
    version: '0.1.0',
    electronVersion: '38.0.0',
    nodeVersion: '24.18.0',
    chromeVersion: '142.0.0',
    platform: 'win32',
    userDataPath: 'C:\\Users\\Owner\\AppData\\Roaming\\Personal AI Desk',
    databasePath: 'C:\\Users\\Owner\\AppData\\Roaming\\Personal AI Desk\\desk.sqlite',
    logPath: 'C:\\Users\\Owner\\AppData\\Roaming\\Personal AI Desk\\logs\\app.log',
    packaged: false,
    secureStorageAvailable: true,
    ...overrides,
  };
}

export function makePaths(overrides: Partial<AppPaths> = {}): AppPaths {
  return {
    userData: 'C:\\Users\\Owner\\AppData\\Roaming\\Personal AI Desk',
    database: 'C:\\Users\\Owner\\AppData\\Roaming\\Personal AI Desk\\desk.sqlite',
    logs: 'C:\\Users\\Owner\\AppData\\Roaming\\Personal AI Desk\\logs',
    credentials: 'Windows Credential Manager',
    ...overrides,
  };
}

/**
 * A rejection shaped like the preload bridge's: an Error carrying `appError`, so
 * `asAppError` recovers the code and the user-facing sentence rather than the
 * generic "Unexpected error".
 */
export function bridgeError(code: ErrorCode, message: string): Error {
  const error = new Error(message) as Error & { appError: AppErrorShape };
  error.appError = appError(code, message);
  return error;
}

/** A promise that never settles, for asserting a loading state. */
export function never<T>(): Promise<T> {
  return new Promise<T>(() => {
    /* intentionally pending */
  });
}

export function installApi(options: FakeApiOptions = {}): FakeApi {
  const fake = createFakeApi(options);
  __setApiForTest(fake.api);
  return fake;
}

export interface PageHarness {
  fake: FakeApi;
  user: ReturnType<typeof userEvent.setup>;
}

export function renderPage(fake: FakeApi, node: ReactElement): PageHarness {
  const user = userEvent.setup();
  render(node);
  return { fake, user };
}

/** The project's modal, by its accessible name. */
export function dialog(name: string | RegExp): HTMLElement {
  return screen.getByRole('dialog', { name });
}

export function withinDialog(name: string | RegExp): ReturnType<typeof within> {
  return within(dialog(name));
}
