import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function read(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

test("迁移到火山引擎：移除 Cloudflare 依赖，接入 MySQL 与 TOS", async () => {
  const [page, wardrobeApi, modelApi, dbLib, storageLib, pkg] = await Promise.all([
    read("../app/page.tsx"),
    read("../app/api/wardrobe/route.ts"),
    read("../app/api/model-profile/route.ts"),
    read("../app/lib/db.ts"),
    read("../app/lib/storage.ts"),
    read("../package.json"),
  ]);

  // 数据层：mysql2 + MySQL DDL
  assert.match(dbLib, /mysql2\/promise/);
  assert.match(dbLib, /CREATE TABLE IF NOT EXISTS wardrobe_items/);
  assert.match(dbLib, /CREATE TABLE IF NOT EXISTS model_profiles/);
  assert.match(dbLib, /CREATE TABLE IF NOT EXISTS ai_tasks/);
  assert.match(dbLib, /idx_ai_tasks_owner_kind_key/);

  // 存储层：S3 兼容客户端（TOS）
  assert.match(storageLib, /@aws-sdk\/client-s3/);
  assert.match(storageLib, /PutObjectCommand/);
  assert.match(storageLib, /GetObjectCommand/);
  assert.match(storageLib, /DeleteObjectCommand/);

  // SQLite 方言已转换为 MySQL 方言
  assert.match(modelApi, /UPDATE model_profiles SET image_key/);

  // 不再残留 Cloudflare 绑定
  assert.doesNotMatch(wardrobeApi, /cloudflare:workers|D1Database|R2Bucket/);
  assert.doesNotMatch(modelApi, /cloudflare:workers|D1Database|R2Bucket/);
  assert.doesNotMatch(page, /cloudflare:workers/);

  // 依赖清单
  const json = JSON.parse(pkg);
  assert.ok(json.dependencies.mysql2, "应依赖 mysql2");
  assert.ok(json.dependencies.next, "应依赖 next");
  assert.ok(json.dependencies["@aws-sdk/client-s3"], "应依赖 @aws-sdk/client-s3");
  assert.ok(!json.dependencies.vinext, "应移除 vinext");
  assert.ok(!json.devDependencies?.wrangler, "应移除 wrangler");
  assert.ok(!json.devDependencies?.drizzle, "应移除 drizzle");
});

test("业务逻辑保留：第一阶段衣柜工作流", async () => {
  const [page, processor, tagger, api, analyzer, cutout, productizer] = await Promise.all([
    read("../app/page.tsx"),
    read("../app/lib/garment-image.ts"),
    read("../app/lib/garment-tags.ts"),
    read("../app/api/wardrobe/route.ts"),
    read("../app/api/wardrobe/analyze/route.ts"),
    read("../app/api/wardrobe/cutout/route.ts"),
    read("../app/api/wardrobe/productize/route.ts"),
  ]);

  assert.match(page, /processGarmentUpload/);
  assert.match(page, /加入衣柜/);
  assert.match(page, /标记清洗/);
  assert.match(processor, /createImageBitmap/);
  assert.match(processor, /canvasToBlob/);
  assert.match(api, /storagePut/);
  assert.match(api, /ai_tags/);
  assert.match(analyzer, /qwen3-vl-flash/);
  assert.match(analyzer, /mergePairs/);
  assert.match(analyzer, /removeItemsHiddenByOuterwear/);
  assert.match(analyzer, /focusedAccessoryPrompt/);
  assert.match(analyzer, /addMissingFocusedItems/);
  assert.match(analyzer, /deduplicateShoes/);
  assert.match(analyzer, /deduplicateDetections/);
  assert.match(analyzer, /deduplicateIdentityGroups/);
  assert.match(analyzer, /identity_key/);
  assert.match(analyzer, /source_evidence/);
  assert.match(analyzer, /overlapOfSmaller/);
  assert.match(analyzer, /centerYDistance/);
  assert.match(analyzer, /腰带/);
  assert.match(cutout, /SegmentCloth/);
  assert.match(cutout, /SegmentCommodity/);
  assert.match(productizer, /qwen-image-2\.0/);
  assert.match(productizer, /validateProductImage/);
  assert.match(productizer, /same_item/);
  assert.match(productizer, /has_extraneous_object/);
  assert.match(productizer, /X-Yida-Tags/);
  assert.match(productizer, /product-cache\/v10/);
  assert.match(productizer, /X-Yida-Cache/);
  assert.match(tagger, /formality/);
  assert.match(tagger, /occasions/);
  assert.match(page, /AI搭配标签/);
  assert.match(page, /删除失败，衣物已恢复/);
  assert.match(page, /Math\.min\(4, selected\.length\)/);
  assert.match(page, /uploadBatchRef/);
  assert.match(page, /uploadJobActiveRef/);
  assert.match(page, /openUploadPicker\("replace"\)/);
  assert.match(page, /openUploadPicker\("append"\)/);
  assert.match(processor, /deduplicateBeforeGeneration/);
  assert.match(processor, /mapWithConcurrency\(uniqueDetections, 2/);
  assert.match(page, /点击整张卡片即可切换是否加入衣柜/);
});

test("业务逻辑保留：第二阶段个人模特与可恢复穿搭工作流", async () => {
  const [page, modelApi, recommendApi, outfitEngine, outfitClient, visualizeApi, weatherApi, taskStore, modal] = await Promise.all([
    read("../app/page.tsx"),
    read("../app/api/model-profile/route.ts"),
    read("../app/api/outfits/recommend/route.ts"),
    read("../app/lib/outfit-engine.ts"),
    read("../app/lib/outfit-client.ts"),
    read("../app/api/outfits/visualize/route.ts"),
    read("../app/api/weather/route.ts"),
    read("../app/lib/ai-tasks.ts"),
    read("../app/components/modal-frame.tsx"),
  ]);

  assert.match(page, /上传全身照/);
  assert.match(outfitClient, /\/api\/outfits\/recommend/);
  assert.match(outfitClient, /\/api\/outfits\/visualize/);
  assert.match(outfitClient, /pollRecommendationTask/);
  assert.match(outfitClient, /pollVisualizationTask/);
  assert.match(page, /三套衣柜方案/);
  assert.match(modelApi, /model-profiles/);
  assert.match(recommendApi, /status = 'available'/);
  assert.match(recommendApi, /sanitizeDisplayText/);
  assert.match(recommendApi, /候选搭配/);
  assert.match(recommendApi, /candidateId/);
  assert.match(recommendApi, /不得新增、删除或替换候选里的单品/);
  assert.match(outfitEngine, /scoreBreakdown/);
  assert.match(outfitEngine, /breakdown\.color \* \.25/);
  assert.match(outfitEngine, /breakdown\.silhouette \* \.25/);
  assert.match(outfitEngine, /selectDiverseCandidates/);
  assert.match(outfitEngine, /maximumOverlap/);
  assert.match(page, /styleIntensity/);
  assert.match(page, /outfitJobActiveRef/);
  assert.match(visualizeApi, /doubao-seedream-5-0-lite/);
  assert.match(outfitClient, /buildOutfitReferenceBoard/);
  assert.match(page, /tryOnJobActiveRef/);
  assert.match(page, /tryOnCacheRef/);
  assert.match(visualizeApi, /generateTryOnImage/);
  assert.match(visualizeApi, /ARK_API_KEY/);
  assert.match(visualizeApi, /images = \[modelImage/);
  assert.match(weatherApi, /open-meteo/);
  assert.match(taskStore, /Idempotency-Key/);
  assert.match(taskStore, /INSERT IGNORE/);
  assert.match(recommendApi, /readIdempotencyKey/);
  assert.match(visualizeApi, /readIdempotencyKey/);
  assert.match(page, /sessionStorage/);
  assert.match(modal, /aria-modal="true"/);
  assert.match(modal, /event\.key === "Escape"/);
});
