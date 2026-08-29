import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function compileCommonJs(path) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiledModule = { exports: {} };
  new Function("require", "module", "exports", output)(() => undefined, compiledModule, compiledModule.exports);
  return compiledModule.exports;
}

const quality = compileCommonJs("../app/lib/garment-component-quality.ts");

function mask(width, height, rectangles, noise = []) {
  const result = new Uint8Array(width * height);
  for (const [left, top, right, bottom] of rectangles) {
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) result[y * width + x] = 1;
    }
  }
  for (const [x, y] of noise) result[y * width + x] = 1;
  return result;
}

test("单件衣物只有一个显著连通组件时通过", () => {
  const result = quality.inspectGarmentComponents(mask(192, 192, [[50, 35, 142, 165]]), 192, 192, "上衣");
  assert.equal(result.status, "pass");
  assert.equal(result.componentCount, 1);
  assert.equal(result.allowedComponents, 1);
});

test("衣身旁出现两个分离袖片时拒绝", () => {
  const result = quality.inspectGarmentComponents(mask(192, 192, [
    [62, 35, 130, 165],
    [24, 65, 49, 120],
    [143, 65, 168, 120],
  ]), 192, 192, "上衣");
  assert.equal(result.status, "review");
  assert.equal(result.componentCount, 3);
  assert.equal(result.allowedComponents, 1);
});

test("一双鞋允许两个显著组件，但普通衣物不允许", () => {
  const shoePair = mask(192, 192, [[25, 75, 85, 125], [107, 75, 167, 125]]);
  assert.equal(quality.inspectGarmentComponents(shoePair, 192, 192, "鞋履").status, "pass");
  assert.equal(quality.inspectGarmentComponents(shoePair, 192, 192, "上衣").status, "review");
});

test("一对耳饰作为一件首饰允许两个显著组件", () => {
  const earrings = mask(192, 192, [[55, 72, 78, 118], [114, 72, 137, 118]]);
  const result = quality.inspectGarmentComponents(earrings, 192, 192, "首饰");
  assert.equal(result.status, "pass");
  assert.equal(result.componentCount, 2);
  assert.equal(result.allowedComponents, 2);
});

test("零散小噪点不会被误判成独立衣物部件", () => {
  const result = quality.inspectGarmentComponents(mask(
    192,
    192,
    [[50, 35, 142, 165]],
    [[8, 8], [181, 12], [14, 178], [176, 180]],
  ), 192, 192, "裤子");
  assert.equal(result.status, "pass");
  assert.equal(result.componentCount, 1);
  assert.deepEqual(result.significantBounds, [50, 35, 141, 164]);
});

test("小于主体百分之十二的独立阴影不会误杀完整裤装", () => {
  const result = quality.inspectGarmentComponents(mask(192, 192, [
    [48, 28, 145, 150],
    [150, 145, 165, 170],
  ]), 192, 192, "裤子");
  assert.equal(result.status, "pass");
  assert.equal(result.componentCount, 1);
});

test("即使分离部件间距很小也不会被错误合并", () => {
  const garment = mask(192, 192, [[50, 35, 95, 165], [97, 35, 142, 165]]);
  const result = quality.inspectGarmentComponents(garment, 192, 192, "外套");
  assert.equal(result.status, "review");
  assert.equal(result.componentCount, 2);
});
