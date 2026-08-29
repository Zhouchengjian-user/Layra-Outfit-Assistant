import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url);

function compileCommonJs(path, dependencies = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const compiledModule = { exports: {} };
  new Function("require", "module", "exports", output)(id => dependencies[id] ?? nativeRequire(id), compiledModule, compiledModule.exports);
  return compiledModule.exports;
}

const tags = compileCommonJs("../app/lib/garment-tags.ts");
const engine = compileCommonJs("../app/lib/outfit-engine.ts", { "./garment-tags": tags });

function wardrobeItem(id, name, category, colorName, style, warmth, formality) {
  return {
    id, name, category, colorName, season: "四季", style,
    aiTags: tags.normalizeGarmentAITags({
      styles: [style],
      occasions: style === "通勤" ? ["通勤", "正式活动"] : ["休闲"],
      warmth,
      formality,
      fit: category === "下装" ? "直筒" : "合身",
      rise: category === "下装" ? "高腰" : "不适用",
      legShape: category === "下装" ? "直筒" : "不适用",
    }, { category, color: colorName, style }),
  };
}

test("搭配引擎理解具体需求并输出三套结构完整、互有差异的通勤方案", () => {
  const items = [
    wardrobeItem("t1", "白色短袖衬衫", "上衣", "白色", "简约", 2, 4),
    wardrobeItem("t2", "藏青针织Polo", "上衣", "藏青色", "通勤", 3, 4),
    wardrobeItem("t3", "浅蓝牛仔衬衫", "上衣", "蓝色", "休闲", 2, 2),
    wardrobeItem("b1", "黑色直筒西裤", "下装", "黑色", "通勤", 2, 5),
    wardrobeItem("b2", "卡其直筒裤", "下装", "卡其色", "简约", 2, 3),
    wardrobeItem("b3", "深蓝牛仔裤", "下装", "蓝色", "休闲", 2, 2),
    wardrobeItem("s1", "黑色乐福鞋", "鞋履", "黑色", "通勤", 2, 4),
    wardrobeItem("s2", "白色运动鞋", "鞋履", "白色", "休闲", 2, 1),
    wardrobeItem("o1", "灰色轻薄夹克", "外套", "灰色", "简约", 3, 3),
  ];
  const result = engine.buildOutfitCandidates(items, {
    scene: "通勤",
    prompt: "杭州小雨，明天正式通勤，想显高、舒服、不要撞色",
    weather: { temperature: 22, condition: "小雨" },
    profile: { stylePrefs: ["简约", "通勤"] },
    intensity: "稳妥耐看",
  }, 24);
  const selected = engine.selectDiverseCandidates(result.candidates, 3);

  assert.deepEqual(result.intent.requirements, ["显高", "舒服", "不撞色"]);
  assert.equal(result.intent.formality, 5);
  assert.equal(result.intent.warmth, 4);
  assert.equal(selected.length, 3);
  assert.equal(new Set(selected.map(candidate => candidate.itemIds.slice().sort().join("|"))).size, 3);
  for (const candidate of selected) {
    assert.ok(candidate.items.some(item => item.category === "上衣"));
    assert.ok(candidate.items.some(item => item.category === "下装"));
    assert.ok(candidate.items.some(item => item.category === "鞋履"));
    assert.ok(candidate.score >= 60);
  }
});
