import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";

const TARGET_OWNER_PATTERN = /^usr-[a-f0-9]{40}$/;
const OWNER_TABLES = [
  "wardrobe_items",
  "model_profiles",
  "ai_tasks",
  "saved_outfits",
  "chat_history",
  "user_profiles",
];

function assertQuickCheck(database) {
  const result = database.prepare("PRAGMA quick_check").get();
  if (!result || Object.values(result)[0] !== "ok") throw new Error("SQLite quick_check failed");
}

function tableExists(database, table) {
  return Boolean(
    database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

function selectSourceOwner(database, sourceOwner, source) {
  if (Boolean(sourceOwner) === (source === "largest")) {
    throw new Error("Choose exactly one source owner strategy");
  }
  if (sourceOwner) {
    const found = OWNER_TABLES.some(table =>
      database.prepare(`SELECT 1 AS present FROM ${table} WHERE owner_id = ? LIMIT 1`).get(sourceOwner));
    if (!found) throw new Error("Source owner has no data");
    return sourceOwner;
  }
  if (source !== "largest") throw new Error("Unsupported source strategy");
  const row = database
    .prepare(
      `SELECT owner_id AS ownerId
       FROM wardrobe_items
       GROUP BY owner_id
       ORDER BY COUNT(*) DESC, owner_id ASC
       LIMIT 1`,
    )
    .get();
  if (!row?.ownerId) throw new Error("No wardrobe owner found");
  return row.ownerId;
}

function safeExtension(key) {
  const suffix = extname(key).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(suffix) ? suffix : "";
}

function objectPath(objectsDirectory, key) {
  if (!key || isAbsolute(key) || key.includes("\\")) throw new Error("Unsafe object key");
  const root = resolve(objectsDirectory);
  const path = resolve(root, key);
  const inside = relative(root, path);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error("Unsafe object key");
  }
  return path;
}

function fallbackContentType(key) {
  const suffix = safeExtension(key);
  if (suffix === ".png") return "image/png";
  if (suffix === ".jpg" || suffix === ".jpeg") return "image/jpeg";
  if (suffix === ".webp") return "image/webp";
  if (suffix === ".gif") return "image/gif";
  return "application/octet-stream";
}

async function readLocalObject(objectsDirectory, key, contentTypeHint) {
  const path = objectPath(objectsDirectory, key);
  const info = await lstat(path);
  if (!info.isFile()) throw new Error("Referenced object is not a file");
  const metaPath = `${path}.meta`;
  let contentType = contentTypeHint;
  if (!contentType && existsSync(metaPath)) contentType = (await readFile(metaPath, "utf8")).trim();
  if (!contentType || contentType.length > 128 || /[\r\n]/.test(contentType)) {
    contentType = fallbackContentType(key);
  }
  return { body: await readFile(path), contentType };
}

function rewrittenKey(kind, targetOwnerId, id, sourceKey) {
  const suffix = safeExtension(sourceKey);
  if (kind === "wardrobe") return `wardrobe-items/${targetOwnerId}/${id}${suffix}`;
  if (kind === "model") return `model-profiles/${targetOwnerId}/profile${suffix}`;
  return `outfit-results/${targetOwnerId}/${id}${suffix}`;
}

function assertSavedOutfitReferences(database) {
  const wardrobeIds = new Set(database.prepare("SELECT id FROM wardrobe_items").all().map(row => row.id));
  for (const row of database.prepare("SELECT item_ids AS itemIds FROM saved_outfits").all()) {
    let itemIds;
    try {
      itemIds = JSON.parse(row.itemIds);
    } catch {
      throw new Error("Saved outfit contains invalid item IDs");
    }
    if (!Array.isArray(itemIds) || itemIds.some(id => typeof id !== "string" || !wardrobeIds.has(id))) {
      throw new Error("Saved outfit references missing wardrobe items");
    }
  }
}

async function embedObjects(database, objectsDirectory, targetOwnerId) {
  database.exec(
    `CREATE TABLE yida_migration_objects (
      object_key TEXT NOT NULL PRIMARY KEY,
      content_type TEXT NOT NULL,
      body BLOB NOT NULL
    )`,
  );
  const insert = database.prepare(
    "INSERT INTO yida_migration_objects (object_key, content_type, body) VALUES (?, ?, ?)",
  );
  let objectCount = 0;
  let objectBytes = 0;

  const references = [
    ...database.prepare("SELECT id, image_key AS sourceKey FROM wardrobe_items ORDER BY id").all()
      .map(row => ({ ...row, kind: "wardrobe", contentType: "" })),
    ...database.prepare("SELECT owner_id AS id, image_key AS sourceKey, content_type AS contentType FROM model_profiles").all()
      .map(row => ({ ...row, kind: "model" })),
    ...database.prepare(
      "SELECT id, result_key AS sourceKey, result_content_type AS contentType FROM ai_tasks WHERE result_key IS NOT NULL ORDER BY id",
    ).all().map(row => ({ ...row, kind: "result" })),
  ];

  for (const reference of references) {
    const object = await readLocalObject(objectsDirectory, reference.sourceKey, reference.contentType || "");
    const targetKey = rewrittenKey(reference.kind, targetOwnerId, reference.id, reference.sourceKey);
    insert.run(targetKey, object.contentType, object.body);
    if (reference.kind === "wardrobe") {
      database.prepare("UPDATE wardrobe_items SET image_key = ? WHERE id = ?").run(targetKey, reference.id);
    } else if (reference.kind === "model") {
      database.prepare("UPDATE model_profiles SET image_key = ? WHERE owner_id = ?").run(targetKey, targetOwnerId);
    } else {
      database.prepare("UPDATE ai_tasks SET result_key = ? WHERE id = ?").run(targetKey, reference.id);
    }
    objectCount += 1;
    objectBytes += object.body.byteLength;
  }
  return { objectCount, objectBytes };
}

function pruneAndRemap(database, sourceOwner, targetOwnerId) {
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const table of OWNER_TABLES) {
      database.prepare(`DELETE FROM ${table} WHERE owner_id <> ?`).run(sourceOwner);
      database.prepare(`UPDATE ${table} SET owner_id = ? WHERE owner_id = ?`).run(targetOwnerId, sourceOwner);
    }
    database.prepare(
      "UPDATE ai_tasks SET status = 'failed', error_message = NULL WHERE status IN ('pending', 'running')",
    ).run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function migrationCounts(database) {
  const count = table => Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  return {
    wardrobeItems: count("wardrobe_items"),
    modelProfiles: count("model_profiles"),
    savedOutfits: count("saved_outfits"),
    chatHistory: count("chat_history"),
    aiTasks: count("ai_tasks"),
  };
}

export async function prepareProductionMigration({
  sourceDatabasePath,
  objectsDirectory,
  sourceOwner,
  source,
  targetOwnerId,
  outputPath,
}) {
  if (!TARGET_OWNER_PATTERN.test(targetOwnerId || "")) throw new Error("Invalid target owner");
  const sourcePath = resolve(sourceDatabasePath);
  const destinationPath = resolve(outputPath);
  if (sourcePath === destinationPath || existsSync(destinationPath)) throw new Error("Output must be new");
  await mkdir(dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.preparing-${process.pid}-${randomUUID()}`;
  let sourceDatabase;
  let outputDatabase;
  try {
    sourceDatabase = new DatabaseSync(sourcePath, { readOnly: true });
    assertQuickCheck(sourceDatabase);
    for (const table of OWNER_TABLES) {
      if (!tableExists(sourceDatabase, table)) throw new Error("Source database schema is incomplete");
    }
    const selectedOwner = selectSourceOwner(sourceDatabase, sourceOwner, source);
    await backup(sourceDatabase, temporaryPath);
    sourceDatabase.close();
    sourceDatabase = undefined;

    outputDatabase = new DatabaseSync(temporaryPath);
    outputDatabase.exec("PRAGMA journal_mode = DELETE");
    pruneAndRemap(outputDatabase, selectedOwner, targetOwnerId);
    assertSavedOutfitReferences(outputDatabase);
    const embedded = await embedObjects(outputDatabase, objectsDirectory, targetOwnerId);
    assertQuickCheck(outputDatabase);
    const counts = migrationCounts(outputDatabase);
    outputDatabase.exec("VACUUM");
    assertQuickCheck(outputDatabase);
    outputDatabase.close();
    outputDatabase = undefined;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, destinationPath);
    return { ...counts, objects: embedded.objectCount, objectBytes: embedded.objectBytes };
  } finally {
    sourceDatabase?.close();
    outputDatabase?.close();
    await rm(temporaryPath, { force: true });
  }
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value == null || value.startsWith("--")) throw new Error("Invalid arguments");
    if (Object.hasOwn(values, flag)) throw new Error("Duplicate argument");
    values[flag] = value;
  }
  const allowed = new Set(["--source-db", "--objects-dir", "--source-owner", "--source", "--target-owner", "--output"]);
  if (Object.keys(values).some(flag => !allowed.has(flag))) throw new Error("Unknown argument");
  return values;
}

async function main() {
  try {
    const args = parseArguments(process.argv.slice(2));
    const result = await prepareProductionMigration({
      sourceDatabasePath: args["--source-db"] || join(process.cwd(), ".data", "yida.sqlite"),
      objectsDirectory: args["--objects-dir"] || join(process.cwd(), ".data", "objects"),
      sourceOwner: args["--source-owner"],
      source: args["--source"],
      targetOwnerId: args["--target-owner"],
      outputPath: args["--output"],
    });
    console.log(JSON.stringify(result));
  } catch {
    console.error("Migration preparation failed");
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
