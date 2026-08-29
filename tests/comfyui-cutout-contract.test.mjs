import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("ComfyUI BiRefNet 工作流使用官方节点并由衣物上传链路显示实际提供方", async () => {
  const [adapter, workflow, segmenter, productizer, client, page, env] = await Promise.all([
    read("../app/lib/comfyui-cutout.ts"),
    read("../workflows/comfyui/layra-birefnet-cutout.api.json"),
    read("../app/lib/aliyun-segmentation.ts"),
    read("../app/api/wardrobe/productize/route.ts"),
    read("../app/lib/garment-image.ts"),
    read("../app/page.tsx"),
    read("../.env.example"),
  ]);

  const prompt = JSON.parse(workflow);
  assert.equal(prompt["2"].class_type, "LoadBackgroundRemovalModel");
  assert.equal(prompt["3"].class_type, "RemoveBackground");
  assert.equal(prompt["4"].class_type, "InvertMask");
  assert.equal(prompt["5"].class_type, "JoinImageWithAlpha");
  assert.equal(prompt["6"].class_type, "SaveImage");
  assert.match(adapter, /\/upload\/image/);
  assert.match(adapter, /\/history\//);
  assert.match(adapter, /\/view\?/);
  assert.match(adapter, /AbortSignal\.timeout/);
  assert.match(segmenter, /quality !== "good"/);
  assert.match(productizer, /"X-Layra-Provider": meta\.provider/);
  assert.match(client, /response\.headers\.get\("X-Layra-Provider"\)/);
  assert.match(page, /本地 ComfyUI/);
  assert.match(env, /CUTOUT_PROVIDER=aliyun/);
  assert.match(env, /COMFYUI_BASE_URL=/);
});
