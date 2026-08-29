import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function read(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

function functionBlock(source, startName, nextName) {
  const start = source.indexOf(`function ${startName}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  assert.ok(start >= 0, `missing function ${startName}`);
  assert.ok(end > start, `missing function boundary ${nextName}`);
  return source.slice(start, end);
}

test("全身照识别纠正具体品类、保留被外套遮挡的内搭并过滤服装附属带", async () => {
  const analyzer = await read("../app/api/wardrobe/analyze/route.ts");
  const categoryRepair = functionBlock(analyzer, "categoryFromSemantics", "isAttachedGarmentTie");
  const attachedTieFilter = functionBlock(analyzer, "isAttachedGarmentTie", "requestDetections");
  const outerwearCoverage = functionBlock(analyzer, "removeItemsHiddenByOuterwear", "boxIou");

  // 模型偶尔返回“衬衫”等细分类；进入阈值判断与重建前必须纠正为衣柜大类。
  assert.match(categoryRepair, /衬衫\|T恤[\s\S]*return "上衣"/);
  assert.match(analyzer, /const category = categoryFromSemantics\(item\.category, identityKey \|\| sourceEvidence \|\| garmentDescription\)/);
  assert.match(analyzer, /衬衫、T恤、背心等必须归为上衣/);

  // 外套覆盖代表需要补全，不能把已经识别到的内搭从结果里删除。
  assert.match(outerwearCoverage, /return items\.map\(item =>/);
  assert.doesNotMatch(outerwearCoverage, /return items\.filter\(item =>/);
  assert.match(outerwearCoverage, /partially_occluded: true/);
  assert.match(outerwearCoverage, /visible_ratio: Math\.min/);

  // 只收可独立取下的腰带；外套系带、装饰带、抽绳及非独立扣带不得建成单品。
  assert.match(attachedTieFilter, /category === "腰带"/);
  assert.match(attachedTieFilter, /非独立/);
  assert.match(attachedTieFilter, /外套\.\{0,8\}[\s\S]*系带/);
  assert.match(analyzer, /if \(isAttachedGarmentTie\(category, semanticText\)\) return \[\]/);
  assert.match(analyzer, /腰带必须是可独立取下的带身与扣头/);
  assert.match(analyzer, /外套自带系带、衣服装饰带和衬衫打结都不是独立腰带/);
  assert.match(analyzer, /扣带/);
  assert.match(analyzer, /category === "腰带" && depictionType !== "product" && x2 - x1 < \(y2 - y1\) \* 1\.3/);

  // 第二次查漏必须显式检查领带、领结与围巾，而非只复查大件服装。
  assert.match(analyzer, /领带、领结、围巾归为其他配饰/);
  assert.match(analyzer, /颈部领带\/领结\/围巾/);
  // 两路都在短时间内被限流时，用一次延时综合扫描恢复；欠费错误不得重复请求 DashScope。
  assert.match(analyzer, /const scanStartedAt = performance\.now\(\)/);
  assert.match(analyzer, /const hasBillingFailure = detectionRuns\.some\(result => result\.status === "rejected" && isProviderBillingFailure\(result\.reason\)\)/);
  assert.match(analyzer, /if \(elapsedMs < 2_000 && !hasBillingFailure\)/);
  assert.match(analyzer, /setTimeout\(resolve, 700\)/);
  assert.match(analyzer, /requestDetectionsWithFallback\(primaryProvider, arkFallback, imageData, outfitPrompt, fallbackBudget\)/);
});

test("视觉识别在 DashScope 欠费或不可用时可降级到显式配置的火山方舟", async () => {
  const analyzer = await read("../app/api/wardrobe/analyze/route.ts");
  const envExample = await read("../.env.example");

  assert.match(analyzer, /class DetectionProviderError extends Error/);
  assert.match(analyzer, /arrearage\|insufficient[\s\S]*?欠费\|余额不足/i);
  assert.match(analyzer, /getServerEnv\("ARK_VISION_MODEL"\)\.trim\(\)/);
  assert.match(analyzer, /arkApiKey && arkVisionModel/);
  assert.match(analyzer, /defaultArkBaseUrl = "https:\/\/ark\.cn-beijing\.volces\.com\/api\/v3"/);
  assert.match(analyzer, /requestDetectionsWithFallback\(primaryProvider, arkFallback/);
  assert.match(analyzer, /if \(provider\.name === "dashscope"\) requestBody\.enable_thinking = false/);
  assert.match(analyzer, /!hasBillingFailure/);
  assert.match(envExample, /^ARK_VISION_MODEL=$/m);
  assert.match(envExample, /^ARK_BASE_URL=https:\/\/ark\.cn-beijing\.volces\.com\/api\/v3$/m);
});

test("客户端逐件隔离预处理失败，整套失败不会伪装成上衣", async () => {
  const processor = await read("../app/lib/garment-image.ts");
  const page = await read("../app/page.tsx");
  const failedOutfit = functionBlock(processor, "quickFailedDraft", "processGarmentUpload");

  // 长耗时重建必须串行，避免每个请求的超时都耗在等待另一件衣物上。
  assert.match(processor, /const maxClientReconstructionRequests = 1/);
  assert.match(processor, /activeReconstructionRequests >= maxClientReconstructionRequests/);

  // discovery 中一件裁剪失败要落成该单品的失败卡，不能拒绝整张照片的映射任务。
  assert.match(
    processor,
    /mapWithConcurrency\(uniqueDetections, 6,[\s\S]*?catch \{[\s\S]*?failedDetectionDraft\(normalizedBlob, detection, draftKey\)/,
  );
  // refined 中一件高清预处理失败同样只更新该 draft，其他单品继续完成。
  assert.match(
    processor,
    /const refinedDraftsPromise = mapWithConcurrency\(discovered, 4,[\s\S]*?catch \{[\s\S]*?reconstructionReasons: \["该单品高清图预处理失败，请换清晰照片重试"\]/,
  );

  // 整套识别失败必须呈现“待识别”诊断卡，不能再凭文件名或长宽猜成一件上衣。
  assert.match(failedOutfit, /category: "待识别"/);
  assert.match(failedOutfit, /name: "整套穿搭识别不完整"/);
  assert.match(failedOutfit, /衣服、鞋帽、包和配饰/);
  assert.doesNotMatch(failedOutfit, /category: "上衣"/);
  assert.doesNotMatch(failedOutfit, /inferCategory/);
  assert.match(processor, /catch \{[\s\S]*?const failed = quickFailedDraft\(normalizedBlob, sourceKey\);[\s\S]*?return \[failed\]/);
  assert.match(page, /\["待识别", "上衣", "外套", "下装"/);
});

test("服务端重建共享九十秒总时限且只重试瞬态错误", async () => {
  const reconstructor = await read("../app/api/wardrobe/reconstruct/route.ts");
  const transientClassifier = functionBlock(reconstructor, "isTransientProviderError", "inspectCompleteness");

  assert.match(reconstructor, /const reconstructionDeadlineMs = 90_000/);
  assert.match(reconstructor, /const deadlineAt = startedAt \+ reconstructionDeadlineMs/);
  assert.match(reconstructor, /const remainingMs = \(\) => Math\.max\(0, Math\.floor\(deadlineAt - performance\.now\(\)\)\)/);
  assert.match(reconstructor, /AbortSignal\.timeout\(Math\.min\(providerRequestTimeoutMs, requestBudget\)\)/);
  assert.match(reconstructor, /AbortSignal\.timeout\(Math\.min\(12_000, downloadBudget\)\)/);
  // 未配置候选数时 getServerEnv 返回空字符串；不能把 Number\(\"\"\)=0 夹成 1，
  // 否则质量失败时永远不会生成第二张候选图。
  assert.match(reconstructor, /configuredCandidateValue = getServerEnv\("DASHSCOPE_GARMENT_RECONSTRUCTION_CANDIDATES"\)\.trim\(\)/);
  assert.match(reconstructor, /configuredCandidateValue \? Number\(configuredCandidateValue\) : Number\.NaN/);
  assert.match(reconstructor, /Number\.isInteger\(configuredCandidates\) \? configuredCandidates : DEFAULT_CANDIDATES/);

  // 429、5xx、节流/繁忙/超时类供应商错误可重试；明确的非瞬态错误立即抛出。
  assert.match(reconstructor, /response\.status === 429[\s\S]*response\.status >= 500/);
  assert.match(reconstructor, /thrott\|rate\|quota\|busy\|timeout\|internal\|unavailable/);
  assert.match(transientClassifier, /ProviderRequestError\) return error\.retryable/);
  assert.match(transientClassifier, /ReconstructionDeadlineError\) return false/);
  assert.match(transientClassifier, /error instanceof TypeError \|\| name === "AbortError" \|\| name === "TimeoutError"/);
  assert.match(reconstructor, /!isTransientProviderError\(error\)[\s\S]*throw error/);
  assert.match(reconstructor, /if \(error instanceof ProviderRequestError && !error\.retryable\) throw error/);
});

test("阿里欠费或鉴权失败时仅降级一次到支持双参考图的 Seedream", async () => {
  const reconstructor = await read("../app/api/wardrobe/reconstruct/route.ts");
  const envExample = await read("../.env.example");
  const accountClassifier = functionBlock(reconstructor, "isAliyunAccountFailure", "inspectCompleteness");
  const arkRequest = functionBlock(reconstructor, "requestArkReconstruction", "requestReconstruction");
  const fallback = functionBlock(reconstructor, "requestReconstruction", "cacheKey");

  // Arrearage、401/403 和明确的鉴权错误直接切换，不能先按瞬态错误重复请求阿里。
  assert.match(reconstructor, /const accountFailure = response\.status === 401[\s\S]*response\.status === 403[\s\S]*aliyunAccountFailurePattern\.test\(providerCode\)/);
  assert.match(reconstructor, /const retryable = !accountFailure &&/);
  assert.match(accountClassifier, /error\.status === 401 \|\| error\.status === 403/);
  assert.match(reconstructor, /arrearage\|invalid\.\?api\.\?key/);
  assert.match(fallback, /!isAliyunAccountFailure\(error\) \|\| !getServerEnv\("ARK_API_KEY"\)/);

  // 方舟使用同一请求的 90 秒总时限；第一张通过即返回，仅质量不合格时允许一张纠错候选。
  assert.match(fallback, /const deadlineAt = startedAt \+ reconstructionDeadlineMs/);
  assert.match(fallback, /requestAliyunReconstruction\(input, deadlineAt\)/);
  assert.match(fallback, /requestArkReconstruction\(input, deadlineAt\)/);
  assert.match(arkRequest, /const candidateCount = input\.arkCandidates/);
  assert.match(arkRequest, /!isTransientProviderError\(error\)[\s\S]*throw error/);
  assert.match(arkRequest, /await retryDelay\(delayMs\)/);
  assert.match(reconstructor, /const DEFAULT_ARK_CANDIDATES = 2/);
  assert.match(reconstructor, /ARK_GARMENT_RECONSTRUCTION_CANDIDATES/);
  assert.match(reconstructor, /Math\.min\(2, Number\.isInteger\(configuredArkCandidates\)/);

  // source 与 visible 分别作为图1、图2传给 Seedream，多图编辑模式强制只返回一张图。
  assert.match(arkRequest, /arkInputDataUrl\(input\.source, 1_536\)/);
  assert.match(arkRequest, /input\.visible \? \[arkInputDataUrl\(input\.visible, 1_024\)\] : \[\]/);
  assert.match(arkRequest, /image: correctionReference \? \[\.\.\.inputImages, correctionReference\] : inputImages/);
  assert.match(arkRequest, /correctionReference = await arkInputDataUrl\(rawBytes, 1_536\)/);
  assert.match(reconstructor, /最后一张参考图是上一次未通过完整性检查的候选/);
  assert.match(reconstructor, /components\.significantBounds/);
  assert.match(reconstructor, /normalizeProductImage\(rawBytes, quality\.components\.significantBounds\)/);
  assert.match(arkRequest, /sequential_image_generation: "disabled"/);
  assert.match(arkRequest, /response_format: "url"/);

  // 缓存、日志和响应头必须反映实际命中的供应商与模型。
  assert.match(reconstructor, /hash\.update\(input\.arkModel\)/);
  assert.match(reconstructor, /hash\.update\(input\.arkSize\)/);
  assert.match(reconstructor, /hash\.update\(String\(input\.arkCandidates\)\)/);
  assert.match(reconstructor, /"X-Layra-Provider": result\.provider/);
  assert.match(reconstructor, /provider: result\.provider/);
  assert.match(envExample, /ARK_GARMENT_RECONSTRUCTION_MODEL=/);
  assert.match(envExample, /ARK_GARMENT_RECONSTRUCTION_SIZE=/);
  assert.match(envExample, /ARK_GARMENT_RECONSTRUCTION_CANDIDATES=2/);
});
