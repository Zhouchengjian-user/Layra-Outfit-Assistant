import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const SQLITE_BACKUP_KEY = "db_backup/yida.sqlite";
export const SQLITE_BACKUP_CONTENT_TYPE = "application/vnd.sqlite3";

export type SqliteBackupObject = { body: Uint8Array };
export type LoadSqliteBackup = (key: string) => Promise<SqliteBackupObject | null>;
export type SaveSqliteBackup = (key: string, body: Uint8Array, contentType: string) => Promise<void>;

/**
 * SQLite stays in the repository during local development, but veFaaS only
 * guarantees that /tmp is writable. SQLITE_PATH is the explicit override;
 * sqlite: DATABASE_URL values are accepted for compatibility with the
 * deployment handbook.
 */
export function resolveSqlitePath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const explicitPath = env.SQLITE_PATH?.trim();
  if (explicitPath) return resolve(cwd, explicitPath);

  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl?.startsWith("sqlite:")) {
    const pathname = decodeURIComponent(new URL(databaseUrl).pathname);
    if (!pathname) throw new Error("DATABASE_URL 中缺少 SQLite 文件路径");
    return resolve(cwd, pathname);
  }

  return env.NODE_ENV === "production"
    ? "/tmp/data/yida.sqlite"
    : join(cwd, ".data", "yida.sqlite");
}

function temporaryPath(databasePath: string, purpose: "restore" | "snapshot"): string {
  return `${databasePath}.${purpose}-${process.pid}-${randomUUID()}`;
}

function assertSqliteHeader(body: Uint8Array): void {
  const expected = "SQLite format 3\0";
  const actual = new TextDecoder().decode(body.subarray(0, expected.length));
  if (actual !== expected) throw new Error("TOS 备份不是有效的 SQLite 数据库文件");
}

function validateSqliteFile(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const result = database.prepare("PRAGMA quick_check").get();
    if (!result || Object.values(result)[0] !== "ok") {
      throw new Error("SQLite quick_check 未通过");
    }
  } finally {
    database.close();
  }
}

/** Restore a valid cloud snapshot atomically, but never overwrite a local DB. */
export async function restoreSqliteBackupIfMissing(
  databasePath: string,
  loadBackup: LoadSqliteBackup,
): Promise<boolean> {
  if (existsSync(databasePath)) return false;

  const backupObject = await loadBackup(SQLITE_BACKUP_KEY);
  if (!backupObject) return false;
  assertSqliteHeader(backupObject.body);

  await mkdir(dirname(databasePath), { recursive: true });
  const restorePath = temporaryPath(databasePath, "restore");
  try {
    await writeFile(restorePath, backupObject.body, { flag: "wx", mode: 0o600 });
    validateSqliteFile(restorePath);
    await rename(restorePath, databasePath);
    return true;
  } finally {
    await rm(restorePath, { force: true });
  }
}

/**
 * Create a transactionally consistent single-file snapshot with Node's
 * sqlite backup API, then upload that snapshot. This deliberately avoids
 * copying a live WAL database file directly.
 */
export async function uploadSqliteSnapshot(
  database: DatabaseSync,
  databasePath: string,
  saveBackup: SaveSqliteBackup,
): Promise<void> {
  const snapshotPath = temporaryPath(databasePath, "snapshot");
  try {
    const sqlite = await import("node:sqlite");
    if (typeof sqlite.backup !== "function") {
      throw new Error("当前 Node.js 不支持 node:sqlite backup；请使用 Node.js 22.16 或更高版本");
    }
    await sqlite.backup(database, snapshotPath);
    validateSqliteFile(snapshotPath);
    const snapshot = await readFile(snapshotPath);
    assertSqliteHeader(snapshot);
    await saveBackup(SQLITE_BACKUP_KEY, snapshot, SQLITE_BACKUP_CONTENT_TYPE);
  } finally {
    await rm(snapshotPath, { force: true });
  }
}
