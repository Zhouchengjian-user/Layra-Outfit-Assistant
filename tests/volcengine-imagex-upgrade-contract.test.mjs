import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("ImageX productv2 只在多单品检测后逐件抠图，且使用短时 TOS 地址", async () => {
  const [imagex, segmenter, storage, client, env] = await Promise.all([
    read("../app/lib/volcengine-imagex.ts"),
    read("../app/lib/aliyun-segmentation.ts"),
    read("../app/lib/storage.ts"),
    read("../app/lib/garment-image.ts"),
    read("../.env.example"),
  ]);

  assert.match(imagex, /IMAGEX_API_VERSION = "2018-08-01"/);
  assert.match(imagex, /Class: "productv2"/);
  assert.match(imagex, /Refine: true/);
  assert.match(imagex, /TransBg: true/);
  assert.match(imagex, /OutFormat: "png"/);
  assert.match(imagex, /Tpl: template/);
  assert.match(imagex, /`tplv-\$\{serviceId\}-image`/);
  assert.match(imagex, /storageCreateSignedGetUrl\(temporaryKey, 300\)/);
  assert.match(imagex, /storageDelete\(temporaryKey\)/);
  assert.match(storage, /getSignedUrl/);
  assert.match(segmenter, /"volcengine-imagex-productv2"/);
  assert.match(segmenter, /cutoutMode === "volcengine" \|\| cutoutMode === "volcengine-hybrid"/);
  assert.match(segmenter, /background: \{ r: 255, g: 255, b: 255, alpha: 1 \}/);
  assert.match(client, /const analysisImageMaxSide = 896/);
  assert.match(client, /createUploadBlobTasks\(file\)/);
  assert.match(client, /normalizedBlobPromise: createScaledJpegBlobFromBitmap/);
  assert.match(client, /analysisBlobPromise: createScaledJpegBlobFromBitmap/);
  assert.match(client, /analysisBlobPromise\.then\(analyzeGarments\)/);
  assert.match(client, /const itemProductizeTimeoutMs = 8_800/);
  assert.match(client, /Math\.min\(itemProductizeTimeoutMs, fallbackBudget\)/);
  assert.match(client, /mapWithConcurrency\(uniqueDetections, 6/);
  assert.match(client, /volcengine-imagex-productv2/);
  assert.match(env, /^CUTOUT_PROVIDER=volcengine-hybrid$/m);
  assert.match(env, /^VOLC_IMAGEX_SERVICE_ID=$/m);
  assert.match(env, /^VOLC_IMAGEX_DOMAIN=$/m);
  assert.match(env, /^VOLC_IMAGEX_TEMPLATE=$/m);
});

test("Seedream 换装锁定原人物与原画幅，并把最终文件还原到原图像素尺寸", async () => {
  const [visualize, reconstruction, starter, env] = await Promise.all([
    read("../app/api/outfits/visualize/route.ts"),
    read("../app/api/wardrobe/reconstruct/route.ts"),
    read("../app/api/wardrobe/starter/route.ts"),
    read("../.env.example"),
  ]);

  assert.match(visualize, /DEFAULT_ARK_SIZE = "1728x2304"/);
  assert.match(visualize, /image: images/);
  assert.match(visualize, /storedImageDimensions\(profile\.imageKey\)/);
  assert.match(visualize, /resolveArkSize\(sourceDimensions\)/);
  assert.match(visualize, /人物一致性为最高优先级/);
  assert.match(visualize, /保持图1原始背景、相机角度、镜头距离、透视、人物位置、裁切范围、光线和阴影/);
  assert.match(visualize, /最终文件由系统还原为/);
  assert.match(visualize, /finalizeToSourceDimensions\(generated, sourceDimensions\)/);
  assert.match(visualize, /\.resize\(source\.width, source\.height, \{ fit: "fill"/);
  assert.match(visualize, /X-Layra-Output-Size/);
  assert.doesNotMatch(visualize, /纵向 3:4 构图/);
  assert.doesNotMatch(visualize, /浅灰影棚/);
  assert.doesNotMatch(visualize, /\bseed\s*:/);
  assert.doesNotMatch(visualize, /guidance_scale/);
  assert.match(env, /^ARK_IMAGE_SIZE=1728x2304$/m);
  assert.match(env, /^ARK_GARMENT_RECONSTRUCTION_SIZE=1920x1920$/m);
  assert.match(env, /^ARK_PRODUCT_IMAGE_SIZE=1920x1920$/m);
  assert.doesNotMatch(reconstruction, /getServerEnv\("ARK_GARMENT_RECONSTRUCTION_SIZE"\) \|\| getServerEnv\("ARK_IMAGE_SIZE"\)/);
  assert.doesNotMatch(starter, /getServerEnv\("ARK_PRODUCT_IMAGE_SIZE"\) \|\| getServerEnv\("ARK_IMAGE_SIZE"\)/);
});
