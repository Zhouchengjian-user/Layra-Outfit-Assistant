import mysql from "mysql2/promise";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { storageGet, storagePut } from "./storage";
import {
  resolveSqlitePath,
  restoreSqliteBackupIfMissing,
  uploadSqliteSnapshot,
} from "./sqlite-persistence";
import { logServerEvent } from "./observability";
import {
  getStorageRequestContext,
  type StorageRequestContext,
  withStorageRequestContext,
} from "./storage-request-context";

export type DbRow = Record<string, unknown>;

/**
 * 双模式数据库访问层：
 * - 配置了 MYSQL_HOST 时使用 MySQL（生产 / 火山引擎）；
 * - 未配置时使用 Node 内置 SQLite（本地开发，或 veFaaS + TOS 轻量持久化）。
 */
function isMySQL(): boolean {
  return Boolean(process.env.MYSQL_HOST);
}

// ---------- MySQL ----------
let poolPromise: Promise<mysql.Pool> | null = null;

async function getPool(): Promise<mysql.Pool> {
  if (!poolPromise) {
    poolPromise = Promise.resolve(
      mysql.createPool({
        host: process.env.MYSQL_HOST || "127.0.0.1",
        port: Number(process.env.MYSQL_PORT || 3306),
        user: process.env.MYSQL_USER || "root",
        password: process.env.MYSQL_PASSWORD || "",
        database: process.env.MYSQL_DATABASE || "yida",
        waitForConnections: true,
        connectionLimit: Number(process.env.MYSQL_POOL_SIZE || 10),
        charset: "utf8mb4",
        timezone: "Z",
        enableKeepAlive: true,
        keepAliveInitialDelay: 10_000,
      }),
    );
  }
  return poolPromise;
}

// ---------- SQLite（本地开发 / veFaaS 轻量持久化）----------
const DEFAULT_BACKUP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_BACKUP_DEBOUNCE_MS = 10 * 1000;

let sqliteDbPromise: Promise<DatabaseSync> | null = null;
let sqliteBackupTimer: NodeJS.Timeout | null = null;
let sqlitePeriodicTimer: NodeJS.Timeout | null = null;
let sqliteBackupPromise: Promise<void> | null = null;
let sqliteRevision = 0;
let sqliteBackedUpRevision = 0;
let latestStorageRequestContext: StorageRequestContext | null = null;

function sqliteCloudBackupEnabled(): boolean {
  return Boolean(process.env.TOS_BUCKET);
}

function durationFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 1_000 ? Math.floor(value) : fallback;
}

function assertProductionBackupConfigured(): void {
  const production = process.env.NODE_ENV === "production" || process.env.ENV?.trim().toLowerCase() === "prod";
  if (production && !sqliteCloudBackupEnabled()) {
    throw new Error("生产环境使用 SQLite 时必须配置 TOS 持久化");
  }
}

function startPeriodicSqliteBackup(): void {
  if (!sqliteCloudBackupEnabled() || sqlitePeriodicTimer) return;
  const intervalMs = durationFromEnv("SQLITE_BACKUP_INTERVAL_MS", DEFAULT_BACKUP_INTERVAL_MS);
  sqlitePeriodicTimer = setInterval(() => {
    runSqliteBackupInBackground("periodic");
  }, intervalMs);
  sqlitePeriodicTimer.unref();
}

async function createSqlite(): Promise<DatabaseSync> {
  const databasePath = resolveSqlitePath();
  assertProductionBackupConfigured();
  await mkdir(dirname(databasePath), { recursive: true });

  if (sqliteCloudBackupEnabled()) {
    await restoreSqliteBackupIfMissing(databasePath, storageGet);
  }

  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA busy_timeout = 5000;");
  startPeriodicSqliteBackup();
  return database;
}

function getSqlite(): Promise<DatabaseSync> {
  if (!sqliteDbPromise) {
    sqliteDbPromise = createSqlite().catch((error: unknown) => {
      sqliteDbPromise = null;
      throw error;
    });
  }
  return sqliteDbPromise;
}

async function backupDirtySqlite(): Promise<void> {
  if (!sqliteCloudBackupEnabled() || sqliteRevision <= sqliteBackedUpRevision) return;

  if (!sqliteBackupPromise) {
    const storageContext = getStorageRequestContext();
    sqliteBackupPromise = (async () => {
      const revision = sqliteRevision;
      const database = await getSqlite();
      await uploadSqliteSnapshot(database, resolveSqlitePath(), (key, body, contentType) =>
        storagePut(key, body, contentType),
      );
      sqliteBackedUpRevision = Math.max(sqliteBackedUpRevision, revision);
      // 临时角色凭据只保留到待写快照成功；若期间又发生写入，则保留更新后的上下文。
      if (sqliteRevision <= sqliteBackedUpRevision && latestStorageRequestContext === storageContext) {
        latestStorageRequestContext = null;
      }
    })().finally(() => {
      sqliteBackupPromise = null;
    });
  }

  await sqliteBackupPromise;
}

function scheduleDebouncedSqliteBackup(): void {
  if (!sqliteCloudBackupEnabled()) return;
  if (sqliteBackupTimer) clearTimeout(sqliteBackupTimer);
  const delayMs = durationFromEnv("SQLITE_BACKUP_DEBOUNCE_MS", DEFAULT_BACKUP_DEBOUNCE_MS);
  sqliteBackupTimer = setTimeout(() => {
    sqliteBackupTimer = null;
    runSqliteBackupInBackground("debounced");
  }, delayMs);
  sqliteBackupTimer.unref();
}

function runSqliteBackupInBackground(reason: "debounced" | "periodic"): void {
  const storageContext = latestStorageRequestContext;
  void withStorageRequestContext(storageContext, () => backupDirtySqlite())
    .then(() => {
      // A write may have landed while the snapshot was in flight.
      if (sqliteRevision > sqliteBackedUpRevision) scheduleDebouncedSqliteBackup();
    })
    .catch((error: unknown) => {
      const typed = error as { name?: string; code?: string | number };
      logServerEvent("error", "sqlite_backup_failed", {
        reason,
        error_name: typed?.name || typeof error,
        error_code: typed?.code,
      });
    });
}

function markSqliteDirty(): void {
  const requestStorageContext = getStorageRequestContext();
  if (requestStorageContext) latestStorageRequestContext = requestStorageContext;
  sqliteRevision += 1;
  scheduleDebouncedSqliteBackup();
}

/** Force the latest dirty SQLite revision to TOS (a no-op in MySQL mode). */
export async function flushSqliteBackup(): Promise<void> {
  if (isMySQL() || !sqliteCloudBackupEnabled()) return;
  if (sqliteBackupTimer) {
    clearTimeout(sqliteBackupTimer);
    sqliteBackupTimer = null;
  }
  const storageContext = getStorageRequestContext() ?? latestStorageRequestContext;
  await withStorageRequestContext(storageContext, async () => {
    await backupDirtySqlite();
    if (sqliteRevision > sqliteBackedUpRevision) await backupDirtySqlite();
  });
}

/** MySQL 方言 → SQLite 方言的少量转换。 */
function toSqlite(sql: string): string {
  return sql.replace(/\bINSERT IGNORE\b/gi, "INSERT OR IGNORE");
}

export async function dbRun(sql: string, params: unknown[] = []): Promise<void> {
  if (isMySQL()) {
    const pool = await getPool();
    await pool.query(sql, params);
    return;
  }
  const database = await getSqlite();
  database.prepare(toSqlite(sql)).run(...(params as SQLInputValue[]));
  markSqliteDirty();
}

export async function dbAll<T extends DbRow = DbRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (isMySQL()) {
    const pool = await getPool();
    const [rows] = await pool.query(sql, params);
    return rows as T[];
  }
  const database = await getSqlite();
  return database.prepare(toSqlite(sql)).all(...(params as SQLInputValue[])) as T[];
}

export async function dbFirst<T extends DbRow = DbRow>(sql: string, params: unknown[] = []): Promise<T | null> {
  if (isMySQL()) {
    const pool = await getPool();
    const [rows] = await pool.query(sql, params);
    return (rows as T[])[0] ?? null;
  }
  const database = await getSqlite();
  const row = database.prepare(toSqlite(sql)).get(...(params as SQLInputValue[])) as T | undefined;
  return row ?? null;
}

// ---------- Schema（表与索引分离，两边都兼容）----------
const TABLES = [
  `CREATE TABLE IF NOT EXISTS wardrobe_items (
    id VARCHAR(36) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    name VARCHAR(80) NOT NULL,
    category VARCHAR(40) NOT NULL,
    color_name VARCHAR(40) NOT NULL,
    color_hex VARCHAR(12) NOT NULL,
    season VARCHAR(40) NOT NULL,
    style VARCHAR(40) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'available',
    ai_tags TEXT NOT NULL,
    tag_version INT NOT NULL DEFAULT 0,
    image_key VARCHAR(255) NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (id)
  )`,
  `CREATE TABLE IF NOT EXISTS model_profiles (
    owner_id VARCHAR(64) NOT NULL,
    image_key VARCHAR(255) NOT NULL,
    content_type VARCHAR(64) NOT NULL,
    quality VARCHAR(20) NOT NULL DEFAULT 'ready',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (owner_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ai_tasks (
    id VARCHAR(36) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    kind VARCHAR(40) NOT NULL,
    idempotency_key VARCHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    request_json TEXT NOT NULL,
    result_json TEXT NULL,
    result_key VARCHAR(255) NULL,
    result_content_type VARCHAR(64) NULL,
    error_message VARCHAR(512) NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (id)
  )`,
  `CREATE TABLE IF NOT EXISTS saved_outfits (
    id VARCHAR(36) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    title VARCHAR(80) NOT NULL,
    scene VARCHAR(40) NOT NULL,
    item_ids TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (id)
  )`,
  `CREATE TABLE IF NOT EXISTS chat_history (
    id VARCHAR(36) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    scene VARCHAR(40) NOT NULL,
    prompt VARCHAR(200) NOT NULL,
    result_json TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (id)
  )`,
  `CREATE TABLE IF NOT EXISTS user_profiles (
    owner_id VARCHAR(64) NOT NULL,
    nickname VARCHAR(40) NOT NULL,
    gender VARCHAR(10) NOT NULL,
    height VARCHAR(10) NOT NULL,
    weight VARCHAR(10) NOT NULL,
    body_type VARCHAR(20) NOT NULL,
    style_prefs TEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (owner_id)
  )`,
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_wardrobe_items_owner_created ON wardrobe_items (owner_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_tasks_owner_kind_key ON ai_tasks (owner_id, kind, idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_tasks_owner_kind_updated ON ai_tasks (owner_id, kind, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_saved_outfits_owner_created ON saved_outfits (owner_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_history_owner_created ON chat_history (owner_id, created_at)`,
];

let schemaReady: Promise<void> | null = null;

/** 惰性确保三张表与索引存在（幂等）。 */
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      if (isMySQL()) {
        const pool = await getPool();
        for (const table of TABLES) {
          await pool.query(`${table} ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        }
        for (const index of INDEXES) {
          try {
            await pool.query(index.replace("IF NOT EXISTS ", ""));
          } catch {
            // 索引已存在时忽略
          }
        }
      } else {
        const db = await getSqlite();
        for (const table of TABLES) db.exec(table);
        for (const index of INDEXES) db.exec(index);
        markSqliteDirty();
      }
    })().catch((error: unknown) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}
