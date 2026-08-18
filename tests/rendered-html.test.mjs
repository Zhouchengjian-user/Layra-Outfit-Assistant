import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Easy Outfit product shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>易搭 · AI 穿搭助手<\/title>/i);
  assert.match(html, /今天想怎么穿/);
  assert.match(html, /我的衣柜/);
  assert.match(html, /从第一件衣服开始建立衣柜/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview/i);
});

test("includes the phase-one wardrobe workflow and durable storage", async () => {
  const [page, processor, api, schema, hosting] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/garment-image.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/wardrobe/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /processGarmentImage/);
  assert.match(page, /加入衣柜/);
  assert.match(page, /标记清洗/);
  assert.match(processor, /createImageBitmap/);
  assert.match(processor, /canvasToBlob/);
  assert.match(api, /WARDROBE_IMAGES\.put/);
  assert.match(api, /CREATE TABLE IF NOT EXISTS wardrobe_items/);
  assert.match(schema, /wardrobeItems/);
  assert.match(hosting, /"d1": "DB"/);
  assert.match(hosting, /"r2": "WARDROBE_IMAGES"/);
});
