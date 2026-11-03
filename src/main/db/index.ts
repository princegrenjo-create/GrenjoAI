/**
 * Persistence entry point.
 *
 * `openDatabase()` is the only way the rest of the main process obtains a
 * `Database`: it opens the SQLite file, applies the pragmas, runs the migration
 * runner and wires the repositories. The returned object implements the frozen
 * `Database` interface from `src/shared/repository-contract.ts` with no cast, so
 * the chat service and the IPC layer can depend on the contract alone.
 *
 * `node:sqlite` prints an ExperimentalWarning to stderr on first use. That
 * warning is expected and is deliberately not suppressed.
 */
import type {
  AgentRepository,
  ConversationRepository,
  CustomModelRepository,
  Database,
  GenerationJobRepository,
  MediaRepository,
  MessageRepository,
  MigrationRecord,
  ProviderRepository,
  SettingsRepository,
  SqlRunner,
  SyncRepository,
} from '../../shared/repository-contract';
import { SqliteConnection } from './connection';
import { createDbLogger, type DbLogger } from './log';
import { MigrationState, runMigrations } from './migrations';
import { SqliteAgentRepository } from './repositories/agents';
import { SqliteConversationRepository } from './repositories/conversations';
import { SqliteGenerationJobRepository, SqliteMediaRepository } from './repositories/media';
import { SqliteMessageRepository } from './repositories/messages';
import { SqliteModelRepository } from './repositories/models';
import { SqliteProviderRepository } from './repositories/providers';
import { SqliteSettingsRepository } from './repositories/settings';
import { SqliteSyncRepository } from './repositories/sync';

export { DbError, isDbError } from './errors';
export { DEFAULT_CONVERSATION_TITLE, SETTINGS_ROW_ID } from './constants';
export { createDbLogger, createSilentDbLogger } from './log';
export type { DbLogEntry, DbLogLevel, DbLogRing, DbLogger } from './log';

export interface OpenDatabaseOptions {
  /**
   * Any object with error/warn/info/debug. The main-process `Logger` from
   * `src/main/logger.ts` satisfies this structurally; without one the layer uses
   * a bounded in-memory ring so a plain Node test needs no file handle.
   */
  logger?: DbLogger;
}

class SqliteDatabase implements Database {
  readonly filePath: string;
  readonly sql: SqlRunner;
  readonly migrations: { version(): number; history(): MigrationRecord[] };
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly agents: AgentRepository;
  readonly models: CustomModelRepository;
  readonly providers: ProviderRepository;
  readonly settings: SettingsRepository;
  readonly sync: SyncRepository;
  readonly media: MediaRepository;
  readonly generationJobs: GenerationJobRepository;

  private readonly connection: SqliteConnection;

  constructor(filePath: string, connection: SqliteConnection) {
    this.filePath = filePath;
    this.connection = connection;
    this.sql = connection;
    this.migrations = new MigrationState(connection);
    this.conversations = new SqliteConversationRepository(connection);
    this.messages = new SqliteMessageRepository(connection);
    this.agents = new SqliteAgentRepository(connection);
    this.models = new SqliteModelRepository(connection);
    this.providers = new SqliteProviderRepository(connection);
    this.settings = new SqliteSettingsRepository(connection);
    this.sync = new SqliteSyncRepository(connection);
    this.media = new SqliteMediaRepository(connection);
    this.generationJobs = new SqliteGenerationJobRepository(connection);
  }

  transaction<T>(fn: () => T): T {
    return this.connection.transaction(fn);
  }

  checkpoint(): void {
    this.connection.checkpoint();
  }

  close(): void {
    this.connection.close();
  }
}

/**
 * Opens (and migrates) the database at `filePath`. The parent directory is
 * created when missing. A migration failure closes the connection before the
 * error is rethrown, so a failed open never leaks a half-initialised handle.
 */
export function openDatabase(filePath: string, options: OpenDatabaseOptions = {}): Database {
  const logger = options.logger ?? createDbLogger();
  const connection = new SqliteConnection(filePath, { logger });
  try {
    runMigrations(connection, logger);
  } catch (error) {
    connection.close();
    throw error;
  }
  return new SqliteDatabase(filePath, connection);
}
