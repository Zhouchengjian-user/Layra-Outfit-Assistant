import { storageGet } from "../../../lib/storage";

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!/^[0-9a-f-]{36}$/i.test(token)) return new Response("无效图片", { status: 400 });
  const object = await storageGet(`processing/${token}`);
  if (!object) return new Response("图片已失效", { status: 404 });
  const headers = new Headers({ "Content-Type": object.contentType });
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(object.body, { headers });
}
