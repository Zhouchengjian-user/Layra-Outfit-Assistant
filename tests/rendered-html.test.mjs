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

test("生产可观测性：Sentry 仅在配置 DSN 后启用且默认保护隐私", async () => {
  const [instrumentation, clientConfig, serverConfig, edgeConfig, globalError, options, nextConfig, env, pkg] = await Promise.all([
    read("../instrumentation.ts"),
    read("../instrumentation-client.ts"),
    read("../sentry.server.config.ts"),
    read("../sentry.edge.config.ts"),
    read("../app/global-error.tsx"),
    read("../sentry.options.ts"),
    read("../next.config.ts"),
    read("../.env.example"),
    read("../package.json"),
  ]);

  assert.match(instrumentation, /process\.env\.SENTRY_DSN\?\.trim\(\)/);
  assert.match(instrumentation, /captureRequestError/);
  assert.match(clientConfig, /if \(dsn\) Sentry\.init/);
  assert.match(serverConfig, /if \(dsn\) Sentry\.init/);
  assert.match(edgeConfig, /if \(dsn\) Sentry\.init/);
  assert.match(globalError, /NEXT_PUBLIC_SENTRY_DSN/);
  assert.match(globalError, /Sentry\.captureException\(error\)/);
  assert.match(options, /sendDefaultPii: false/);
  assert.match(options, /tracesSampleRate: 0\.01/);
  assert.match(options, /httpBodies: \[\]/);
  assert.match(options, /genAI: \{ inputs: false, outputs: false \}/);
  assert.match(nextConfig, /sourcemaps: \{ disable: true \}/);
  assert.match(nextConfig, /telemetry: false/);
  assert.match(env, /^SENTRY_DSN=$/m);
  assert.equal(JSON.parse(pkg).dependencies["@sentry/nextjs"], "10.70.0");
});

test("首页输入提示条保持动态，并尊重减少动态效果设置", async () => {
  const styles = await read("../app/globals.css");

  assert.match(styles, /@media \(prefers-reduced-motion: no-preference\)/);
  assert.match(styles, /animation: inputSignal var\(--signal-speed\)/);
  assert.match(styles, /@keyframes inputSignal/);
  assert.match(styles, /animation: none !important; transform: scaleY\(\.45\)/);
});

test("业务逻辑保留：第一阶段衣柜工作流", async () => {
  const [page, processor, tagger, api, analyzer, productizer, segmenter, reconstructor, completeness] = await Promise.all([
    read("../app/page.tsx"),
    read("../app/lib/garment-image.ts"),
    read("../app/lib/garment-tags.ts"),
    read("../app/api/wardrobe/route.ts"),
    read("../app/api/wardrobe/analyze/route.ts"),
    read("../app/api/wardrobe/productize/route.ts"),
    read("../app/lib/aliyun-segmentation.ts"),
    read("../app/api/wardrobe/reconstruct/route.ts"),
    read("../app/lib/garment-completeness.ts"),
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
  assert.match(analyzer, /addMissingFocusedItems/);
  assert.match(analyzer, /deduplicateShoes/);
  assert.match(analyzer, /deduplicateDetections/);
  assert.match(analyzer, /deduplicateIdentityGroups/);
  assert.match(analyzer, /deduplicateLowerBodyAlternatives/);
  assert.match(analyzer, /identity_key/);
  assert.match(analyzer, /source_evidence/);
  assert.match(analyzer, /overlapOfSmaller/);
  assert.match(analyzer, /centerYDistance/);
  assert.match(analyzer, /腰带/);
  assert.match(analyzer, /visionDetectionTimeoutMs = 20_000/);
  assert.match(analyzer, /primaryTimeoutMs = fallback \? Math\.min\(timeoutMs, 12_000\) : timeoutMs/);
  assert.match(analyzer, /timeoutMs = visionDetectionTimeoutMs/);
  assert.match(analyzer, /AbortSignal\.timeout\(timeoutMs\)/);
  assert.match(analyzer, /max_tokens: 520/);
  assert.match(analyzer, /error instanceof SyntaxError/);
  assert.match(analyzer, /error instanceof DetectionOutputError/);
  assert.match(analyzer, /expandCompactDetection/);
  assert.match(analyzer, /detectionCacheTtlMs/);
  assert.doesNotMatch(analyzer, /Promise\.allSettled\(\[/);
  assert.match(analyzer, /outfitPrompt/);
  assert.match(analyzer, /从头到脚/);
  assert.match(analyzer, /帽子、每件首饰、外套、内搭上衣、独立腰带/);
  assert.match(analyzer, /sourceEvidence\.length < 2/);
  assert.match(analyzer, /garment_description/);
  assert.match(productizer, /segmentGarmentToWhiteBackground/);
  assert.match(segmenter, /SegmentClothAdvanceRequest/);
  assert.match(segmenter, /SegmentCommodityAdvanceRequest/);
  assert.match(segmenter, /returnForm: "whiteBK"/);
  assert.match(segmenter, /preserveGeometry/);
  assert.match(segmenter, /outMode: 1/);
  assert.match(segmenter, /clothClass: \[atlasClass\]/);
  assert.match(segmenter, /segmentCombinedAtlasUrls/);
  assert.match(segmenter, /providerStartsPerSecond = 2/);
  assert.match(segmenter, /\.flatten\(\{ background: "#ffffff" \}\)/);
  assert.match(productizer, /X-Yida-Tags/);
  assert.match(productizer, /product-cache\/segment-v7/);
  assert.match(productizer, /configuredGarmentCutoutMode/);
  assert.match(segmenter, /runComfyUiBiRefNetCutout/);
  assert.match(segmenter, /cutoutMode === "hybrid"/);
  assert.match(productizer, /X-Yida-Cache/);
  assert.match(productizer, /X-Yida-Geometry/);
  assert.match(productizer, /X-Yida-Atlas-Classes/);
  assert.match(productizer, /X-Yida-Atlas-Foreground-Bounds/);
  assert.match(productizer, /maxCachedProductBytes/);
  assert.match(productizer, /Server-Timing/);
  assert.match(tagger, /formality/);
  assert.match(tagger, /occasions/);
  assert.match(page, /AI搭配标签/);
  assert.match(page, /删除失败，衣物已恢复/);
  assert.match(page, /Math\.min\(4, selected\.length\)/);
  assert.match(page, /uploadBatchRef/);
  assert.match(page, /uploadJobActiveRef/);
  assert.match(page, /uploadBackgroundPending/);
  assert.match(processor, /OffscreenCanvas/);
  assert.match(page, /openUploadPicker\("replace"\)/);
  assert.match(page, /openUploadPicker\("append"\)/);
  assert.match(page, /ownGarmentCount > 0 \? "继续上传" : "上传衣物"/);
  assert.match(page, /wardrobe-mode-switch/);
  assert.match(page, /wardrobe-gender-switch/);
  assert.match(page, /体验虚拟衣柜/);
  assert.match(page, /女装、男装各 \{STARTER_WARDROBE_SIZE_PER_GENDER\} 件白底单品/);
  assert.match(page, /targetStarterKeys\.size === STARTER_WARDROBE_SIZE_PER_GENDER/);
  assert.doesNotMatch(page, /!activeItems\.length && !starterLoading && closetSetup/);
  assert.match(processor, /normalizedImageMaxSide = 1280/);
  assert.match(processor, /atlasSegmentationPromise/);
  assert.match(processor, /atlasClasses: \["tops", "pants"\]/);
  assert.match(processor, /cropAtlasSegmentation/);
  assert.match(processor, /reviewDraftsFromAtlas/);
  assert.match(processor, /source-preview/);
  assert.match(processor, /onPreview/);
  assert.match(processor, /draftKey/);
  assert.match(processor, /maxSide: 420/);
  assert.match(processor, /startGarmentReconstruction/);
  assert.match(processor, /\/api\/wardrobe\/reconstruct/);
  assert.match(reconstructor, /qwen-image-2\.0/);
  assert.match(reconstructor, /ai-reconstructed-complete-garment/);
  assert.match(reconstructor, /完整腰头/);
  assert.match(reconstructor, /两个完整裤脚/);
  assert.match(reconstructor, /prompt_extend = false/);
  assert.match(reconstructor, /wardrobe_reconstruction_incomplete/);
  assert.match(reconstructor, /分离袖片/);
  assert.match(reconstructor, /DEFAULT_CANDIDATES = 2/);
  assert.match(processor, /detection\.garment_description/);
  assert.match(processor, /X-Yida-Completeness/);
  assert.match(completeness, /depictionType === "worn"/);
  assert.match(completeness, /visibleRatio/);
  assert.match(processor, /deduplicateBeforeGeneration/);
  assert.match(processor, /mapWithConcurrency\(uniqueDetections, 6/);
  assert.match(processor, /mapWithConcurrency\(discovered, 4/);
  assert.match(page, /Promise\.allSettled/);
  assert.match(page, /AI 补全的隐藏结构需要你确认/);
  assert.match(page, /mergeGarmentDrafts/);
  assert.match(page, /低清识别预览 · 清晰图生成中/);
  assert.match(page, /blur\(2\.2px\) saturate\(\.82\)/);
  assert.match(page, /已识别为/);
  assert.match(page, /upload-stage-strip/);
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
  assert.match(recommendApi, /AbortSignal\.timeout\(3_800\)/);
  assert.match(recommendApi, /rules-fallback/);
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
  assert.match(page, /tryOnCacheKey/);
  assert.match(page, /startTryOnQuickPreview/);
  assert.match(page, /quick-preview-badge/);
  assert.match(outfitClient, /buildTryOnQuickPreview/);
  assert.match(visualizeApi, /generateTryOnImage/);
  assert.match(visualizeApi, /ARK_API_KEY/);
  assert.match(visualizeApi, /const optimizedImages = await Promise\.all/);
  assert.match(visualizeApi, /optimizedImageDataUrl\(profile\.imageKey, 2048, 92\)/);
  assert.match(visualizeApi, /optimizedImageDataUrl\(item\.imageKey, 640, 84\)/);
  assert.match(visualizeApi, /response_format: "url"/);
  assert.match(visualizeApi, /mode: "fast"/);
  assert.match(visualizeApi, /supportsFastPromptOptimization/);
  assert.match(visualizeApi, /ARK_IMAGE_SIZE/);
  assert.match(visualizeApi, /MIN_SAFE_ARK_PIXELS/);
  assert.match(visualizeApi, /semanticCacheHash/);
  assert.match(visualizeApi, /profileImageVersion/);
  assert.match(visualizeApi, /garmentImageVersions/);
  assert.match(visualizeApi, /sharedSemanticGeneration/);
  assert.match(visualizeApi, /Server-Timing/);
  assert.match(weatherApi, /open-meteo/);
  assert.match(taskStore, /Idempotency-Key/);
  assert.match(taskStore, /INSERT IGNORE/);
  assert.match(taskStore, /error_message = \?/);
  assert.match(taskStore, /error: task\.status === "failed" \? task\.errorMessage : null/);
  assert.match(recommendApi, /readIdempotencyKey/);
  assert.match(visualizeApi, /readIdempotencyKey/);
  assert.match(page, /sessionStorage/);
  assert.match(modal, /aria-modal="true"/);
  assert.match(modal, /event\.key === "Escape"/);
});

test("试穿对话会在同一弹窗左侧展开对应衣柜素材", async () => {
  const [page, styles] = await Promise.all([
    read("../app/page.tsx"),
    read("../app/globals.css"),
  ]);

  assert.match(page, /handleSwapRequest\(value, "tryon"\)/);
  assert.match(page, /showSwapModal && !showTryOn/);
  assert.match(page, /className="tryon-material-panel"/);
  assert.match(page, /tryOnSwapCandidates\.map/);
  assert.match(page, /swapTryOnItem\(item\)/);
  assert.match(page, /generateTryOn\(nextRecommendation, Boolean\(sourceRecommendation\)\)/);
  assert.match(page, /setTryOnContext\(current => current \? \{ \.\.\.current, itemIds \}/);
  assert.match(page, /aria-label="说出想替换的穿搭单品"/);
  assert.ok(page.indexOf("if (/\u8fde\u8863\u88d9|\u8fde\u4f53/.test(text))") < page.indexOf("if (/\u4e0b\u88c5|\u88e4\u5b50|\u88e4|\u88d9子|\u88d9/.test(text))"));

  assert.match(styles, /\.dynamic-results \.outfit-list[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(min-width: 821px\) and \(max-width: 1180px\)/);
  assert.match(styles, /\.personal-tryon-copy[\s\S]*overflow-y: auto/);
  assert.match(styles, /\.personal-tryon-modal[\s\S]*height: min\(760px, calc\(100dvh - 40px\)\)/);
  assert.match(styles, /\.tryon-material-grid[\s\S]*overflow-x: auto/);
});

test("推荐卡片为全部单品预留固定网格空间且不会压住文案", async () => {
  const styles = await read("../app/globals.css");

  assert.match(styles, /\.dynamic-results \.real-outfit-board \{[\s\S]*height: 272px;[\s\S]*grid-template-rows: repeat\(3, 78px\);[\s\S]*overflow: hidden;/);
  assert.match(styles, /\.dynamic-results \.real-outfit-board figure \{[\s\S]*height: 78px;[\s\S]*display: block;[\s\S]*position: relative;[\s\S]*overflow: hidden;/);
  assert.match(styles, /\.dynamic-results \.real-outfit-board figure > img \{[\s\S]*position: absolute;[\s\S]*inset: 5px;[\s\S]*width: calc\(100% - 10px\);[\s\S]*height: calc\(100% - 10px\);[\s\S]*object-fit: contain;/);
  assert.match(styles, /\.dynamic-results \.real-look-copy \{[\s\S]*position: relative;[\s\S]*z-index: 1;[\s\S]*padding-top: 16px;/);
  assert.match(styles, /@media \(max-width: 820px\)[\s\S]*\.dynamic-results \.real-outfit-board \{[\s\S]*height: 215px;[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);[\s\S]*grid-template-rows: repeat\(2, 92px\);/);
});

test("自主搭配素材独立滚动且点评操作保持可见", async () => {
  const [page, styles] = await Promise.all([
    read("../app/page.tsx"),
    read("../app/globals.css"),
  ]);

  assert.match(styles, /\.create-workbench \{[\s\S]*--create-workbench-height: clamp\(500px, calc\(100dvh - 300px\), 580px\);[\s\S]*align-items: start;/);
  assert.match(styles, /\.create-workbench \.canvas-card\.has-items \{[\s\S]*max-height: var\(--create-workbench-height\);/);
  assert.match(styles, /\.create-workbench \.canvas-card\.has-items \.canvas-items \{[\s\S]*max-height: calc\(var\(--create-workbench-height\) - 64px\);[\s\S]*overflow-y: auto;/);
  assert.match(styles, /\.create-picker-panel \{[\s\S]*height: var\(--create-workbench-height\);[\s\S]*overflow: hidden;[\s\S]*grid-template-rows: auto minmax\(0, 1fr\) auto;/);
  assert.match(styles, /\.create-picker-panel \.pick-grid \{[\s\S]*min-height: 0;[\s\S]*overflow-y: auto;[\s\S]*scrollbar-gutter: stable;/);
  assert.match(styles, /@media \(max-width: 1180px\)[\s\S]*\.create-picker-panel \{[\s\S]*height: auto;[\s\S]*overflow: visible;/);
  assert.match(page, /件单品，可上下滑动查看/);
  assert.match(page, /className="pick-grid" role="region" aria-label="可选衣物" tabIndex=\{0\}/);

  const pickerStart = page.indexOf('<aside className="create-picker-panel">');
  const pickerEnd = page.indexOf("</aside>", pickerStart);
  const grid = page.indexOf('className="pick-grid"', pickerStart);
  const reviewBar = page.indexOf('className="create-review-bar"', pickerStart);
  const reviewPanel = page.indexOf('className="review-panel"', pickerEnd);
  assert.ok(pickerStart >= 0 && pickerStart < grid && grid < reviewBar && reviewBar < pickerEnd && pickerEnd < reviewPanel);
});
