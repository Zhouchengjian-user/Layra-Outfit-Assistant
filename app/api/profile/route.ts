import { dbFirst, dbRun, ensureSchema } from "../../lib/db";
import { getOwner, ownerJson } from "../../lib/owner";

const DEFAULTS = { nickname: "阿禾", gender: "女", height: "168", weight: "55", bodyType: "直筒型" };

type ProfileRow = {
  nickname: string;
  gender: string;
  height: string;
  weight: string;
  bodyType: string;
  stylePrefs: string;
};

function normalizeProfile(row: ProfileRow | null) {
  if (!row) return { ...DEFAULTS, stylePrefs: [] as string[] };
  let stylePrefs: string[] = [];
  try {
    stylePrefs = JSON.parse(row.stylePrefs);
  } catch {
    stylePrefs = [];
  }
  return {
    nickname: row.nickname || DEFAULTS.nickname,
    gender: row.gender || DEFAULTS.gender,
    height: row.height || DEFAULTS.height,
    weight: row.weight || DEFAULTS.weight,
    bodyType: row.bodyType || DEFAULTS.bodyType,
    stylePrefs: Array.isArray(stylePrefs) ? stylePrefs : [],
  };
}

export async function GET(request: Request) {
  const owner = getOwner(request);
  try {
    await ensureSchema();
    const row = await dbFirst<ProfileRow>(
      "SELECT nickname, gender, height, weight, body_type AS bodyType, style_prefs AS stylePrefs FROM user_profiles WHERE owner_id = ?",
      [owner.id],
    );
    return ownerJson({ profile: normalizeProfile(row) }, owner);
  } catch (error) {
    return ownerJson({ error: error instanceof Error ? error.message : "个人资料加载失败" }, owner, 500);
  }
}

export async function POST(request: Request) {
  const owner = getOwner(request);
  try {
    await ensureSchema();
    const body = await request.json() as {
      nickname?: unknown;
      gender?: unknown;
      height?: unknown;
      weight?: unknown;
      bodyType?: unknown;
      stylePrefs?: unknown;
    };
    const nickname = String(body.nickname || "阿禾").trim().slice(0, 20);
    const gender = String(body.gender || "女").trim().slice(0, 10);
    const height = String(body.height || "168").trim().slice(0, 10);
    const weight = String(body.weight || "55").trim().slice(0, 10);
    const bodyType = String(body.bodyType || "直筒型").trim().slice(0, 20);
    const stylePrefs = [...new Set((Array.isArray(body.stylePrefs) ? body.stylePrefs : []).map(String))].slice(0, 10);

    const existing = await dbFirst("SELECT owner_id FROM user_profiles WHERE owner_id = ?", [owner.id]);
    const now = Date.now();
    if (existing) {
      await dbRun(
        "UPDATE user_profiles SET nickname = ?, gender = ?, height = ?, weight = ?, body_type = ?, style_prefs = ?, updated_at = ? WHERE owner_id = ?",
        [nickname, gender, height, weight, bodyType, JSON.stringify(stylePrefs), now, owner.id],
      );
    } else {
      await dbRun(
        "INSERT INTO user_profiles (owner_id, nickname, gender, height, weight, body_type, style_prefs, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [owner.id, nickname, gender, height, weight, bodyType, JSON.stringify(stylePrefs), now],
      );
    }
    return ownerJson({ profile: { nickname, gender, height, weight, bodyType, stylePrefs } }, owner);
  } catch (error) {
    return ownerJson({ error: error instanceof Error ? error.message : "个人资料保存失败" }, owner, 500);
  }
}
