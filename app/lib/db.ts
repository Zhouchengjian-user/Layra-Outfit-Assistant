import mysql from "mysql2/promise";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type DbRow = Record<string, unknown>;

/**
 * 双模式数据库访问层：
 * - 配置了 MYSQL_HOST 时使用 MySQL（生产 / 火山引擎）；
 * - 未配置时使用 Node 内置 SQLite（本地开发，零依赖）。
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

// ---------- SQLite（本地开发）----------
let sqliteDb: DatabaseSync | null = null;

function getSqlite(): DatabaseSync {
  if (!sqliteDb) {
    const dir = join(process.cwd(), ".data");
    mkdirSync(dir, { recursive: true });
    sqliteDb = new DatabaseSync(join(dir, "yida.sqlite"));
    sqliteDb.exec("PRAGMA journal_mode = WAL;");
  }
  return sqliteDb;
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
  getSqlite().prepare(toSqlite(sql)).run(...(params as SQLInputValue[]));
}

export async function dbAll<T extends DbRow = DbRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (isMySQL()) {
    const pool = await getPool();
    const [rows] = await pool.query(sql, params);
    return rows as T[];
  }
  return getSqlite().prepare(toSqlite(sql)).all(...(params as SQLInputValue[])) as T[];
}

export async function dbFirst<T extends DbRow = DbRow>(sql: string, params: unknown[] = []): Promise<T | null> {
  if (isMySQL()) {
    const pool = await getPool();
    const [rows] = await pool.query(sql, params);
    return (rows as T[])[0] ?? null;
  }
  const row = getSqlite().prepare(toSqlite(sql)).get(...(params as SQLInputValue[])) as T | undefined;
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
        const db = getSqlite();
        for (const table of TABLES) db.exec(table);
        for (const index of INDEXES) db.exec(index);
      }
    })().catch((error: unknown) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}
