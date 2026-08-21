import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  extractEmbeddedMigrationObjects,
  MIGRATION_OBJECTS_TABLE,
} from "../app/lib/embedded-migration.ts";
import { prepareProductionMigration } from "../scripts/prepare-production-migration.mjs";

const TARGET_OWNER = `usr-${"a".repeat(40)}`;
const SOURCE_OWNER = "legacy-owner-primary";
const OTHER_OWNER = "legacy-owner-secondary";

function createSourceDatabase(path) {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE wardrobe_items (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
      color_name TEXT NOT NULL, color_hex TEXT NOT NULL, season TEXT NOT NULL, style TEXT NOT NULL,
      status TEXT NOT NULL, ai_tags TEXT NOT NULL, tag_version INTEGER NOT NULL,
      image_key TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE model_profiles (
      owner_id TEXT PRIMARY KEY, image_key TEXT NOT NULL, content_type TEXT NOT NULL,
      quality TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE ai_tasks (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT, result_key TEXT,
      result_content_type TEXT, error_message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE saved_outfits (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, scene TEXT NOT NULL,
      item_ids TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE chat_history (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, scene TEXT NOT NULL, prompt TEXT NOT NULL,
      result_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE user_profiles (
      owner_id TEXT PRIMARY KEY, nickname TEXT NOT NULL, gender TEXT NOT NULL, height TEXT NOT NULL,
      weight TEXT NOT NULL, body_type TEXT NOT NULL, style_prefs TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  const wardrobe = database.prepare(
    `INSERT INTO wardrobe_items VALUES (?, ?, ?, 'top', 'blue', '#0000ff', 'all', 'casual',
     'available', '[]', 1, ?, 1)`,
  );
  wardrobe.run("item-a", SOURCE_OWNER, "A", "legacy/item-a.png");
  wardrobe.run("item-b", SOURCE_OWNER, "B", "legacy/item-b.jpg");
  wardrobe.run("other-item", OTHER_OWNER, "Other", "legacy/other.png");
  database.prepare("INSERT INTO model_profiles VALUES (?, ?, 'image/webp', 'ready', 1, 1)")
    .run(SOURCE_OWNER, "legacy/model.webp");
  database.prepare("INSERT INTO model_profiles VALUES (?, ?, 'image/png', 'ready', 1, 1)")
    .run(OTHER_OWNER, "legacy/other-model.png");
  database.prepare("INSERT INTO ai_tasks VALUES (?, ?, 'outfit-visualization', ?, ?, '{}', NULL, ?, 'image/png', ?, 1, 1)")
    .run("task-done", SOURCE_OWNER, "idem-done", "succeeded", "legacy/result", null);
  database.prepare("INSERT INTO ai_tasks VALUES (?, ?, 'outfit-recommendation', ?, ?, '{}', NULL, NULL, NULL, ?, 1, 1)")
    .run("task-pending", SOURCE_OWNER, "idem-pending", "pending", "private failure");
  database.prepare("INSERT INTO ai_tasks VALUES (?, ?, 'outfit-recommendation', ?, ?, '{}', NULL, NULL, NULL, NULL, 1, 1)")
    .run("other-task", OTHER_OWNER, "other-idem", "failed");
  database.prepare("INSERT INTO saved_outfits VALUES ('saved-a', ?, 'Look', 'work', ?, 1)")
    .run(SOURCE_OWNER, JSON.stringify(["item-a", "item-b"]));
  database.prepare("INSERT INTO chat_history VALUES ('chat-a', ?, 'work', 'prompt', '{}', 1)")
    .run(SOURCE_OWNER);
  database.prepare("INSERT INTO user_profiles VALUES (?, 'name', 'female', '165', '50', 'normal', '[]', 1)")
    .run(SOURCE_OWNER);
  database.prepare("INSERT INTO user_profiles VALUES (?, 'other', 'male', '175', '70', 'normal', '[]', 1)")
    .run(OTHER_OWNER);
  database.close();
}

async function putObject(root, key, body, contentType) {
  const path = join(root, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  await writeFile(`${path}.meta`, contentType);
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "yida-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceDatabasePath = join(directory, "source.sqlite");
  const objectsDirectory = join(directory, "objects");
  const outputPath = join(directory, "prepared.sqlite");
  createSourceDatabase(sourceDatabasePath);
  await putObject(objectsDirectory, "legacy/item-a.png", "first", "image/png");
  await putObject(objectsDirectory, "legacy/item-b.jpg", "second", "image/jpeg");
  await putObject(objectsDirectory, "legacy/model.webp", "model", "image/webp");
  await putObject(objectsDirectory, "legacy/result", "result", "image/png");
  return { sourceDatabasePath, objectsDirectory, outputPath };
}

test("preparation copies, isolates, remaps and embeds without modifying the source", async (t) => {
  const paths = await fixture(t);
  const before = createHash("sha256").update(await readFile(paths.sourceDatabasePath)).digest("hex");
  const result = await prepareProductionMigration({
    ...paths,
    source: "largest",
    targetOwnerId: TARGET_OWNER,
  });
  const after = createHash("sha256").update(await readFile(paths.sourceDatabasePath)).digest("hex");

  assert.equal(before, after);
  assert.deepEqual(result, {
    wardrobeItems: 2,
    modelProfiles: 1,
    savedOutfits: 1,
    chatHistory: 1,
    aiTasks: 2,
    objects: 4,
    objectBytes: 22,
  });

  const prepared = new DatabaseSync(paths.outputPath, { readOnly: true });
  assert.equal(Object.values(prepared.prepare("PRAGMA quick_check").get())[0], "ok");
  for (const table of ["wardrobe_items", "model_profiles", "ai_tasks", "saved_outfits", "chat_history", "user_profiles"]) {
    assert.deepEqual(prepared.prepare(`SELECT DISTINCT owner_id AS ownerId FROM ${table}`).all().map(row => row.ownerId), [TARGET_OWNER]);
  }
  const keys = prepared.prepare(`SELECT object_key AS objectKey FROM ${MIGRATION_OBJECTS_TABLE}`).all()
    .map(row => row.objectKey);
  assert.equal(keys.length, 4);
  assert.ok(keys.every(key => key.includes(TARGET_OWNER) && !key.includes(SOURCE_OWNER)));
  assert.deepEqual(
    { ...prepared.prepare("SELECT status, error_message AS errorMessage FROM ai_tasks WHERE id = 'task-pending'").get() },
    { status: "failed", errorMessage: null },
  );
  prepared.close();
});

test("runtime extraction retries after failure and only drops the payload after success", async (t) => {
  const paths = await fixture(t);
  await prepareProductionMigration({ ...paths, sourceOwner: SOURCE_OWNER, targetOwnerId: TARGET_OWNER });
  const database = new DatabaseSync(paths.outputPath);
  t.after(() => database.close());

  let attempts = 0;
  await assert.rejects(
    extractEmbeddedMigrationObjects(database, async () => {
      attempts += 1;
      if (attempts === 2) throw new Error("simulated upload failure");
    }),
    /simulated upload failure/,
  );
  assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(MIGRATION_OBJECTS_TABLE));

  const uploaded = new Map();
  assert.equal(await extractEmbeddedMigrationObjects(database, async (key, body, contentType) => {
    uploaded.set(key, { body: Buffer.from(body).toString(), contentType });
  }), true);
  assert.equal(uploaded.size, 4);
  assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(MIGRATION_OBJECTS_TABLE), undefined);
  assert.equal(await extractEmbeddedMigrationObjects(database, async () => assert.fail("must not upload twice")), false);
});

test("preparation rejects a missing referenced object and leaves no output", async (t) => {
  const paths = await fixture(t);
  await rm(join(paths.objectsDirectory, "legacy/result"));
  await assert.rejects(
    prepareProductionMigration({ ...paths, source: "largest", targetOwnerId: TARGET_OWNER }),
  );
  await assert.rejects(readFile(paths.outputPath));
});
