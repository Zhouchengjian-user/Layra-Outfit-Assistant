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

const completeness = compileCommonJs("../app/lib/garment-completeness.ts");

test("穿着照即使轮廓可见也必须生成式补全", () => {
  const evidence = {
    category: "上衣",
    bbox: [120, 100, 860, 900],
    depictionType: "worn",
    partiallyOccluded: false,
    visibleRatio: 0.98,
  };
  assert.equal(completeness.requiresGarmentReconstruction(evidence), true);
  assert.ok(completeness.garmentReconstructionReasons(evidence).some(reason => reason.includes("穿着照")));
});

test("完整、无遮挡且不触边的商品照保留快速白底路径", () => {
  assert.equal(completeness.requiresGarmentReconstruction({
    category: "上衣",
    bbox: [100, 80, 900, 920],
    depictionType: "product",
    partiallyOccluded: false,
    visibleRatio: 0.96,
  }), false);
});

test("遮挡、低可见率或触边任一命中都不得将分割残片当商品图", () => {
  const base = { category: "裤子", bbox: [100, 80, 900, 920], depictionType: "product", visibleRatio: 0.96 };
  assert.equal(completeness.requiresGarmentReconstruction({ ...base, partiallyOccluded: true }), true);
  assert.equal(completeness.requiresGarmentReconstruction({ ...base, visibleRatio: 0.72 }), true);
  assert.equal(completeness.requiresGarmentReconstruction({ ...base, bbox: [10, 80, 900, 920] }), true);
});

test("无法确认为商品照的普通服装默认补全", () => {
  assert.equal(completeness.requiresGarmentReconstruction({
    category: "连衣裙",
    bbox: [100, 80, 900, 920],
    depictionType: "unknown",
    partiallyOccluded: false,
    visibleRatio: 0.96,
  }), true);
});
