import { dbFirst, dbRun, ensureSchema } from "./db";

export type AiTaskKind = "outfit-recommendation" | "outfit-visualization";
export type AiTaskStatus = "pending" | "running" | "succeeded" | "failed";

export type AiTask = {
  id: string;
  ownerId: string;
  kind: AiTaskKind;
  idempotencyKey: string;
  status: AiTaskStatus;
  requestJson: string;
  resultJson: string | null;
  resultKey: string | null;
  resultContentType: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
};

type TaskRow = {
  id: string;
  ownerId: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  requestJson: string;
  resultJson: string | null;
  resultKey: string | null;
  resultContentType: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
};

const TASK_SELECT = `
  SELECT id, owner_id AS ownerId, kind, idempotency_key AS idempotencyKey,
    status, request_json AS requestJson, result_json AS resultJson, result_key AS resultKey,
    result_content_type AS resultContentType, error_message AS errorMessage,
    created_at AS createdAt, updated_at AS updatedAt
  FROM ai_tasks`;

function normalizeTask(row: TaskRow | null): AiTask | null {
  if (!row) return null;
  return {
    ...row,
    kind: row.kind as AiTaskKind,
    status: row.status as AiTaskStatus,
  };
}

export async function ensureAiTaskSchema() {
  await ensureSchema();
}

export async function getAiTask(ownerId: string, kind: AiTaskKind, id: string) {
  const row = await dbFirst<TaskRow>(
    `${TASK_SELECT} WHERE id = ? AND owner_id = ? AND kind = ?`,
    [id, ownerId, kind],
  );
  return normalizeTask(row);
}

export async function startAiTask(ownerId: string, kind: AiTaskKind, idempotencyKey: string, requestJson: string) {
  const existing = await getAiTask(ownerId, kind, idempotencyKey);
  if (existing) return { task: existing, created: false };
  const now = Date.now();
  await dbRun(
    `INSERT IGNORE INTO ai_tasks
      (id, owner_id, kind, idempotency_key, status, request_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
    [idempotencyKey, ownerId, kind, idempotencyKey, requestJson, now, now],
  );
  const task = await getAiTask(ownerId, kind, idempotencyKey);
  if (!task) throw new Error("无法创建 AI 任务");
  return { task, created: task.createdAt === now };
}

export async function completeAiTask(id: string, values: { resultJson?: string; resultKey?: string; resultContentType?: string }) {
  await dbRun(
    `UPDATE ai_tasks SET status = 'succeeded', result_json = ?, result_key = ?,
      result_content_type = ?, error_message = NULL, updated_at = ? WHERE id = ?`,
    [values.resultJson ?? null, values.resultKey ?? null, values.resultContentType ?? null, Date.now(), id],
  );
}

export async function failAiTask(id: string, message: string) {
  await dbRun(
    "UPDATE ai_tasks SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?",
    [message.slice(0, 500), Date.now(), id],
  );
}

export function readIdempotencyKey(request: Request) {
  const value = request.headers.get("Idempotency-Key")?.trim() || "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

export function taskPayload(task: AiTask) {
  return { id: task.id, kind: task.kind, status: task.status, error: task.errorMessage, updatedAt: task.updatedAt };
}
