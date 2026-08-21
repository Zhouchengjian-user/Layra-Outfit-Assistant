import { DatabaseSync } from "node:sqlite";

export const MIGRATION_OBJECTS_TABLE = "yida_migration_objects";

const TARGET_OWNER_PATTERN = /^usr-[a-f0-9]{40}$/;
const OWNER_TABLES = [
  "wardrobe_items",
  "model_profiles",
  "ai_tasks",
  "saved_outfits",
  "chat_history",
  "user_profiles",
] as const;

type MigrationObjectRow = {
  objectKey: string;
  contentType: string;
  body: Uint8Array;
};

export type SaveMigrationObject = (
  key: string,
  body: Uint8Array,
  contentType: string,
) => Promise<void>;

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

function targetOwner(database: DatabaseSync): string {
  const owners = new Set<string>();
  for (const table of OWNER_TABLES) {
    if (!tableExists(database, table)) throw new Error("迁移包数据库结构不完整");
    const rows = database.prepare(`SELECT DISTINCT owner_id AS ownerId FROM ${table}`).all() as Array<{
      ownerId: string;
    }>;
    for (const row of rows) owners.add(row.ownerId);
  }
  if (owners.size !== 1) throw new Error("迁移包未实现单用户隔离");
  const [ownerId] = owners;
  if (!ownerId || !TARGET_OWNER_PATTERN.test(ownerId)) throw new Error("迁移包目标用户无效");
  return ownerId;
}

function assertSafeObjectKey(key: string, targetOwnerId: string): void {
  const segments = key.split("/");
  if (
    !key
    || key.length > 1024
    || key.startsWith("/")
    || key.includes("\\")
    || segments.some(segment => !segment || segment === "." || segment === "..")
    || !segments.includes(targetOwnerId)
  ) {
    throw new Error("迁移包对象键无效");
  }
}

function referencedObjectKeys(database: DatabaseSync): Set<string> {
  const rows = database
    .prepare(
      `SELECT image_key AS objectKey FROM wardrobe_items
       UNION
       SELECT image_key AS objectKey FROM model_profiles
       UNION
       SELECT result_key AS objectKey FROM ai_tasks WHERE result_key IS NOT NULL`,
    )
    .all() as Array<{ objectKey: string }>;
  return new Set(rows.map(row => row.objectKey));
}

/**
 * Idempotently upload an embedded one-time migration payload. A failed upload
 * leaves the table untouched so the next request can retry the complete set.
 */
export async function extractEmbeddedMigrationObjects(
  database: DatabaseSync,
  saveObject: SaveMigrationObject,
): Promise<boolean> {
  if (!tableExists(database, MIGRATION_OBJECTS_TABLE)) return false;

  const ownerId = targetOwner(database);
  const objects = database
    .prepare(
      `SELECT object_key AS objectKey, content_type AS contentType, body
       FROM ${MIGRATION_OBJECTS_TABLE} ORDER BY object_key`,
    )
    .all() as MigrationObjectRow[];

  const embeddedKeys = new Set<string>();
  for (const object of objects) {
    assertSafeObjectKey(object.objectKey, ownerId);
    if (!object.contentType || object.contentType.length > 128 || !(object.body instanceof Uint8Array)) {
      throw new Error("迁移包对象内容无效");
    }
    embeddedKeys.add(object.objectKey);
  }

  const referencedKeys = referencedObjectKeys(database);
  if (
    embeddedKeys.size !== referencedKeys.size
    || [...referencedKeys].some(key => !embeddedKeys.has(key))
  ) {
    throw new Error("迁移包对象引用不完整");
  }

  for (const object of objects) {
    await saveObject(object.objectKey, object.body, object.contentType);
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const current = database
      .prepare(`SELECT COUNT(*) AS count FROM ${MIGRATION_OBJECTS_TABLE}`)
      .get() as { count: number | bigint };
    if (Number(current.count) !== objects.length) throw new Error("迁移对象在上传期间发生变化");
    database.exec(`DROP TABLE ${MIGRATION_OBJECTS_TABLE}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return true;
}
