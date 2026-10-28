/**
 * Public surface of the main-process sync module.
 *
 * Wiring in the main process (once the credential store and settings are available):
 *
 *   const storage = createCredentialSessionStorage({
 *     read: (account) => credentials.read(account),
 *     write: (account, value) => credentials.write(account, value),
 *     remove: (account) => credentials.remove(account),
 *   });
 *   const engine = createSyncEngine({
 *     db,
 *     clientFactory: createSupabaseClientFactory({ storage }),
 *     credentialProvider: async () => {
 *       const url = settings.get().sync.supabaseUrl;
 *       const anonKey = await credentials.read(SUPABASE_KEY_ACCOUNT);
 *       return url && anonKey ? { url, anonKey } : null;
 *     },
 *     onStatus: (status) => broadcast('sync:status', status),
 *     isOnline: () => net.isOnline(),
 *   });
 */
export {
  createClientFactory,
  createCloudClient,
  createCredentialSessionStorage,
  createSupabaseClientFactory,
  isSecretKey,
  parseRemoteRow,
  readJwtRole,
  validateClientConfig,
  type CreateClientImpl,
  type SessionStorageBackend,
  type SupabaseClientFactoryDeps,
  type SyncAuthApi,
  type SyncAuthEvent,
  type SyncClientConfig,
  type SyncClientFactory,
  type SyncCloudClient,
  type SyncCloudError,
  type SyncCloudResult,
  type SyncPullInput,
  type SyncRemoteRow,
  type SyncSession,
  type SyncSessionStorage,
  type SyncTableApi,
} from './client';
export {
  BACKOFF_BASE_MS,
  BACKOFF_FACTOR,
  BACKOFF_JITTER_RATIO,
  BACKOFF_MAX_MS,
  createSyncEngine,
  computeBackoffMs,
  MAX_PUSH_ATTEMPTS_DEFAULT,
  PULL_PAGE_LIMIT_DEFAULT,
  PUSH_BATCH_LIMIT_DEFAULT,
  type SyncCredentials,
  type SyncEngine,
  type SyncEngineDatabase,
  type SyncEngineOptions,
  type SyncSignInOutcome,
  type SyncSummary,
} from './engine';
export { isRetryableSyncError, mapSyncError, redactKnownSecrets } from './errors';
export {
  containsCredentialShapedValue,
  isCredentialShaped,
  isPlainJsonObject,
  sanitizeForSync,
  type SanitizeResult,
} from './payload';
export {
  createInitialSyncStatus,
  createSyncStatusStore,
  STATUS_EMIT_MIN_INTERVAL_MS,
  type StatusScheduler,
  type SyncStatusStore,
  type SyncStatusStoreOptions,
} from './status';
export {
  ENTITY_NOUN,
  SYNC_ENTITY_ORDER,
  SYNC_REMOTE_COLUMNS,
  SYNC_TABLE_BY_ENTITY,
  SYNC_TABLES,
  type SyncTableName,
} from './tables';
export {
  REQUEST_TIMEOUT_MS_DEFAULT,
  SYNC_TIMEOUT_CODE,
  SyncTimeoutError,
  withTimeout,
  type SyncRequestOperation,
  type TimeoutOptions,
  type TimerScheduler,
} from './timeout';
