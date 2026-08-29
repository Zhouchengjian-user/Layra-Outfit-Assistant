import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";

function read(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

const REQUIRED_CATEGORIES = ["上衣", "外套", "下装", "鞋履", "配饰", "帽子"];

function starterEntries(source) {
  const promptTemplate = source.match(/const drawPrompt = `([^`]+)`;/)?.[1];
  assert.ok(promptTemplate, "虚拟单品应定义 drawPrompt 模板");

  return [...source.matchAll(
    /garment\(\s*"(female|male)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)"/g,
  )].map(([, gender, id, name, category, colorName]) => ({
    gender,
    id,
    name,
    category,
    colorName,
    drawPrompt: promptTemplate
      .replaceAll("${name}", name)
      .replaceAll("${category}", category)
      .replaceAll("${colorName}", colorName),
  }));
}

test("虚拟衣柜提供男女各 16 件互不重复的完整基础单品", async () => {
  const starterSource = await read("../app/lib/starter-wardrobe.ts");
  const starterGarments = starterEntries(starterSource);
  const female = starterGarments.filter(item => item.gender === "female");
  const male = starterGarments.filter(item => item.gender === "male");
  const all = [...female, ...male];

  assert.equal(female.length, 16, "女生虚拟衣柜应有 16 件单品");
  assert.equal(male.length, 16, "男生虚拟衣柜应有 16 件单品");
  assert.equal(female.length, male.length, "男女虚拟衣柜数量应一致");
  assert.equal(starterGarments.length, 32, "虚拟衣柜总数应为 32 件");
  assert.equal(all.length, starterGarments.length, "按性别筛选后不应丢失或重复单品");

  for (const field of ["id", "name", "drawPrompt"]) {
    assert.equal(
      new Set(all.map(item => item[field])).size,
      all.length,
      `每件虚拟单品的 ${field} 必须唯一`,
    );
  }

  for (const [gender, prefix, items] of [
    ["female", "female-", female],
    ["male", "male-", male],
  ]) {
    const categories = new Set(items.map(item => item.category));
    for (const category of REQUIRED_CATEGORIES) {
      assert.ok(categories.has(category), `${gender} 虚拟衣柜缺少基础分类：${category}`);
    }

    for (const item of items) {
      assert.equal(item.gender, gender);
      assert.ok(item.id.startsWith(prefix), `${item.id} 应使用 ${prefix} 性别前缀`);
      assert.ok(item.drawPrompt.includes(item.category), `${item.id} 的提示词应包含品类`);
      assert.ok(item.drawPrompt.includes(item.colorName), `${item.id} 的提示词应包含颜色`);
      assert.ok(item.drawPrompt.includes(item.name), `${item.id} 的提示词应包含单品名称`);
    }
  }
});

test("虚拟衣柜商品图使用独立缓存与单件白底生成约束", async () => {
  const [starterSource, route, page] = await Promise.all([
    read("../app/lib/starter-wardrobe.ts"),
    read("../app/api/wardrobe/starter/route.ts"),
    read("../app/page.tsx"),
  ]);

  assert.match(route, /starter-products\/\$\{garmentId\}\.image/);
  assert.match(route, /cachedProductImage\(garment\.id,\s*garment\.drawPrompt\)/);
  assert.match(route, /白底商品图/);
  assert.match(route, /无人物/);
  assert.match(route, /仅一件(?:单品|衣物|商品)/);

  const starterImplementation = `${starterSource}\n${route}`;
  assert.doesNotMatch(starterImplementation, /\/inspiration\//);
  assert.doesNotMatch(starterImplementation, /public\/inspiration/);
  assert.match(page, /imageUrl:\s*"\/inspiration\/female\/look-\d{2}\.webp"/);
  assert.match(page, /imageUrl:\s*"\/inspiration\/male\/look-\d{2}\.webp"/);

  const starterGarments = starterEntries(starterSource);
  const starterCacheKeys = starterGarments.map(item => `starter-products/${item.id}.image`);
  const inspirationPaths = [...page.matchAll(/imageUrl:\s*"(\/inspiration\/(?:female|male)\/look-\d{2}\.webp)"/g)]
    .map(([, imageUrl]) => imageUrl);
  assert.equal(new Set(starterCacheKeys).size, starterGarments.length, "每件虚拟单品应有独立缓存键");
  assert.ok(inspirationPaths.length > 0, "灵感图片路径不应被虚拟衣柜替换");
  assert.deepEqual(
    starterCacheKeys.filter(key => inspirationPaths.includes(key)),
    [],
    "虚拟衣柜商品图不得复用灵感图库资源",
  );
});

test("虚拟衣柜重试只生成缺失单品并把 starterId 写入标签", async () => {
  const route = await read("../app/api/wardrobe/starter/route.ts");

  assert.match(route, /const\s+missingItems\s*=\s*items\.filter\s*\(/);
  assert.match(
    route,
    /for\s*\([^)]*missingItems[^)]*\)|missingItems\.(?:map|forEach)\s*\(/,
    "生成循环应只遍历 missingItems",
  );
  assert.match(
    route,
    /const\s+aiTags\s*=\s*\{(?=[^}]*\.\.\.garment\.aiTags)(?=[^}]*starterId:\s*garment\.id)[^}]*\}/,
    "入库标签应保留 starterId，供下次精确判断缺失项",
  );
  assert.match(route, /JSON\.stringify\(aiTags\)/, "含 starterId 的标签对象应写入数据库");
});

test("虚拟衣柜内置 32 张独立商品图，不复用穿搭灵感图", async () => {
  const [starterSource, page] = await Promise.all([
    read("../app/lib/starter-wardrobe.ts"),
    read("../app/page.tsx"),
  ]);
  const entries = starterEntries(starterSource);
  const starterHashes = new Set();

  for (const entry of entries) {
    const imageUrl = new URL(`../public/starter-wardrobe/${entry.gender}/${entry.id}.webp`, import.meta.url);
    const bytes = await readFile(imageUrl);
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, "webp", `${entry.id} 应使用 WebP`);
    assert.equal(metadata.width, 1024, `${entry.id} 宽度应为 1024`);
    assert.equal(metadata.height, 1024, `${entry.id} 高度应为 1024`);
    starterHashes.add(createHash("sha256").update(bytes).digest("hex"));
  }
  assert.equal(starterHashes.size, entries.length, "32 张虚拟单品图不应彼此复制");

  const inspirationPaths = [...page.matchAll(/imageUrl:\s*"(\/inspiration\/(?:female|male)\/look-\d{2}\.webp)"/g)]
    .map(([, imageUrl]) => imageUrl);
  const inspirationHashes = new Set(await Promise.all(inspirationPaths.map(async imagePath => {
    const bytes = await readFile(new URL(`../public${imagePath}`, import.meta.url));
    return createHash("sha256").update(bytes).digest("hex");
  })));
  assert.equal(
    [...starterHashes].filter(hash => inspirationHashes.has(hash)).length,
    0,
    "虚拟衣柜单品图不得与真人穿搭灵感图复用像素文件",
  );
});
