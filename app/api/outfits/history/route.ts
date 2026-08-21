import { dbAll, dbRun, ensureSchema } from "../../../lib/db";
import { getOwner, ownerJson } from "../../../lib/owner";
import { apiErrorResponse } from "../../../lib/observability";
import { withProtectedApiRequest } from "../../../lib/protected-route";

type HistoryRow = { id: string; scene: string; prompt: string; resultJson: string; createdAt: number };

async function handleGET(request: Request) {
  const owner = getOwner(request);
  try {
    await ensureSchema();
    const rows = await dbAll<HistoryRow>(
      "SELECT id, scene, prompt, result_json AS resultJson, created_at AS createdAt FROM chat_history WHERE owner_id = ? ORDER BY created_at DESC LIMIT 30",
      [owner.id],
    );
    const history = rows.map(row => {
      let result: unknown = {};
      try {
        result = JSON.parse(row.resultJson);
      } catch {
        result = {};
      }
      return { id: row.id, scene: row.scene, prompt: row.prompt, result, createdAt: row.createdAt };
    });
    return ownerJson({ history }, owner);
  } catch (error) {
    return apiErrorResponse(request, error, "历史加载失败");
  }
}

async function handlePOST(request: Request) {
  const owner = getOwner(request);
  try {
    await ensureSchema();
    const body = await request.json() as { scene?: string; prompt?: string; result?: unknown };
    const id = crypto.randomUUID();
    const scene = String(body.scene || "休闲").slice(0, 20);
    const prompt = String(body.prompt || "").slice(0, 200);
    const resultJson = JSON.stringify(body.result || {});
    await dbRun(
      "INSERT INTO chat_history (id, owner_id, scene, prompt, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, owner.id, scene, prompt, resultJson, Date.now()],
    );
    return ownerJson({ ok: true, id }, owner, 201);
  } catch (error) {
    return apiErrorResponse(request, error, "保存失败");
  }
}

export function GET(request: Request) {
  return withProtectedApiRequest(request, handleGET, "历史加载失败");
}

export function POST(request: Request) {
  return withProtectedApiRequest(request, handlePOST, "保存失败");
}
