import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  resolveSqlitePath,
  restoreSqliteBackupIfMissing,
  SQLITE_BACKUP_KEY,
  uploadSqliteSnapshot,
} from "../app/lib/sqlite-persistence.ts";

test("production SQLite defaults to veFaaS /tmp and accepts explicit paths", () => {
  assert.equal(resolveSqlitePath({ NODE_ENV: "production" }, "/workspace"), "/tmp/data/yida.sqlite");
  assert.equal(resolveSqlitePath({ SQLITE_PATH: "var/yida.sqlite" }, "/workspace"), "/workspace/var/yida.sqlite");
  assert.equal(
    resolveSqlitePath({ DATABASE_URL: "sqlite:////tmp/custom/yida.sqlite" }, "/workspace"),
    "/tmp/custom/yida.sqlite",
  );
});

test("node:sqlite backup uploads and restores a consistent database", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yida-sqlite-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const sourcePath = join(directory, "source.sqlite");
  const restoredPath = join(directory, "restored.sqlite");
  const source = new DatabaseSync(sourcePath);
  source.exec("CREATE TABLE outfits (id INTEGER PRIMARY KEY, title TEXT NOT NULL)");
  source.prepare("INSERT INTO outfits (title) VALUES (?)").run("通勤穿搭");
  source.exec("PRAGMA journal_mode = WAL");

  let uploadedKey = "";
  let uploadedBody = new Uint8Array();
  await uploadSqliteSnapshot(source, sourcePath, async (key, body) => {
    uploadedKey = key;
    uploadedBody = new Uint8Array(body);
  });
  source.close();

  assert.equal(uploadedKey, SQLITE_BACKUP_KEY);
  assert.ok(uploadedBody.byteLength > 0);

  const restored = await restoreSqliteBackupIfMissing(restoredPath, async (key) => {
    assert.equal(key, SQLITE_BACKUP_KEY);
    return { body: uploadedBody };
  });
  assert.equal(restored, true);

  const database = new DatabaseSync(restoredPath, { readOnly: true });
  assert.deepEqual({ ...database.prepare("SELECT title FROM outfits").get() }, { title: "通勤穿搭" });
  database.close();
});

test("restore never overwrites an existing local database", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yida-sqlite-existing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "yida.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE local_only (id INTEGER PRIMARY KEY)");
  database.close();

  let loadCalled = false;
  const restored = await restoreSqliteBackupIfMissing(databasePath, async () => {
    loadCalled = true;
    return null;
  });

  assert.equal(restored, false);
  assert.equal(loadCalled, false);
  const existing = new DatabaseSync(databasePath, { readOnly: true });
  assert.ok(existing.prepare("SELECT name FROM sqlite_master WHERE name = 'local_only'").get());
  existing.close();
});

test("restore rejects a corrupt cloud object without creating a local DB", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yida-sqlite-corrupt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "yida.sqlite");

  await assert.rejects(
    restoreSqliteBackupIfMissing(databasePath, async () => ({ body: new TextEncoder().encode("not sqlite") })),
    /不是有效的 SQLite/,
  );
  assert.throws(() => new DatabaseSync(databasePath, { readOnly: true }));
});
