import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

function read(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

function sectionBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `缺少源码标记：${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `缺少源码标记：${endMarker}`);
  return source.slice(start, end);
}

function inspirationEntries(source) {
  const definition = sectionBetween(source, "const inspirationThemes:", "\n};");
  const femaleSource = sectionBetween(definition, "female: [", "\n  ],\n  male: [");
  const maleStart = definition.indexOf("\n  male: [");
  assert.notEqual(maleStart, -1, "缺少男生灵感数据");
  const maleEnd = definition.lastIndexOf("\n  ],");
  assert.ok(maleEnd > maleStart, "男生灵感数据没有正常结束");
  const maleSource = definition.slice(maleStart, maleEnd);
  const parse = block => [...block.matchAll(/\{\s*id:\s*"([^"]+)"[^{}]*imageUrl:\s*"([^"]+)"\s*\}/g)]
    .map(([, id, imageUrl]) => ({ id, imageUrl }));
  return { female: parse(femaleSource), male: parse(maleSource) };
}

test("灵感图库按资料性别提供男女各 12 套真实图片", async () => {
  const page = await read("../app/page.tsx");
  const themes = inspirationEntries(page);

  assert.equal(themes.female.length, 12, "女生灵感应有 12 套");
  assert.equal(themes.male.length, 12, "男生灵感应有 12 套");

  const allThemes = [...themes.female, ...themes.male];
  assert.equal(new Set(allThemes.map(theme => theme.id)).size, 24, "灵感 id 必须唯一");
  assert.equal(new Set(allThemes.map(theme => theme.imageUrl)).size, 24, "每套灵感必须使用独立图片");

  for (const [gender, entries] of Object.entries(themes)) {
    for (const entry of entries) {
      assert.match(entry.imageUrl, new RegExp(`^/inspiration/${gender}/look-\\d{2}\\.webp$`));
      const imageFile = new URL(`../public${entry.imageUrl}`, import.meta.url);
      const imageStat = await stat(imageFile).catch(() => null);
      assert.ok(imageStat?.isFile(), `${entry.imageUrl} 应为实际图片文件`);
      assert.ok(imageStat.size > 1024, `${entry.imageUrl} 不应是空白占位文件`);

      const signature = await readFile(imageFile);
      assert.equal(signature.subarray(0, 4).toString("ascii"), "RIFF", `${entry.imageUrl} 应为有效 WebP`);
      assert.equal(signature.subarray(8, 12).toString("ascii"), "WEBP", `${entry.imageUrl} 应为有效 WebP`);
    }
  }
});

test("灵感图库每批展示 6 套，并能循环切换另一批", async () => {
  const page = await read("../app/page.tsx");
  const themes = inspirationEntries(page);

  assert.match(page, /const INSPIRATION_BATCH_SIZE = 6;/);
  assert.match(page, /profile\.gender === "男" \? "male" : "female"/);
  assert.match(page, /currentInspirationThemes\.slice\(inspirationBatchStart, inspirationBatchStart \+ INSPIRATION_BATCH_SIZE\)/);
  assert.match(page, /\(inspirationBatch \+ 1\) % inspirationBatchCount/);
  assert.match(page, /visibleInspirationThemes\.map/);
  assert.match(page, /这批都不喜欢，换一批/);
  assert.match(page, /role="status" aria-live="polite"/);

  for (const entries of Object.values(themes)) {
    const batches = [entries.slice(0, 6), entries.slice(6, 12)];
    assert.deepEqual(batches.map(batch => batch.length), [6, 6]);
    assert.equal(new Set(batches.flat().map(theme => theme.id)).size, 12);
  }
});

test("灵感卡片渲染真人图片，不再使用旧 GarmentArt 占位图", async () => {
  const page = await read("../app/page.tsx");
  const inspirationSection = sectionBetween(
    page,
    '{tab === "inspiration" && <div className="screen inspiration-screen"',
    '{tab === "saved" && <div className="screen saved-screen"',
  );

  assert.match(inspirationSection, /visibleInspirationThemes\.map/);
  assert.match(inspirationSection, /<img src=\{theme\.imageUrl\}/);
  assert.match(inspirationSection, /className="inspiration-card-actions"/);
  assert.match(inspirationSection, /className="inspiration-batch-bar"/);
  assert.doesNotMatch(inspirationSection, /<GarmentArt\b/);
});
