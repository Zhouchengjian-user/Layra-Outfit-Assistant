import assert from "node:assert/strict";
import test from "node:test";
import { buildTryOnPrompt } from "../app/lib/tryon-prompt.ts";

const items = [
  { name: "白衬衫", category: "上衣" },
  { name: "黑西裤", category: "下装" },
];

test("无本人照片时只引用衣物图并生成不露脸假人", () => {
  const prompt = buildTryOnPrompt(items, "通勤", "利落", false, "女");
  assert.match(prompt, /图1是白衬衫/);
  assert.match(prompt, /图2是黑西裤/);
  assert.match(prompt, /女性不露脸的成年假人模特/);
  assert.doesNotMatch(prompt, /图1是用户全身照/);
});

test("有本人照片时保留原有个人试穿参考图顺序", () => {
  const prompt = buildTryOnPrompt(items, "通勤", "利落", true, "女");
  assert.match(prompt, /图1是用户全身照/);
  assert.match(prompt, /图2是白衬衫/);
  assert.match(prompt, /图3是黑西裤/);
});
