export type GarmentDepictionType = "worn" | "product" | "unknown";

export type GarmentCompletenessEvidence = {
  category: string;
  bbox: [number, number, number, number];
  depictionType?: GarmentDepictionType;
  partiallyOccluded?: boolean;
  visibleRatio?: number;
};

const apparelCategories = new Set(["上衣", "外套", "裤子", "裙子", "连衣裙"]);

/**
 * Segmentation can only preserve pixels that are visible in the source photo.
 * Any worn, occluded, low-visibility, or frame-clipped item therefore needs a
 * generative reconstruction before it can be presented as a complete product
 * image.
 */
export function garmentReconstructionReasons(evidence: GarmentCompletenessEvidence) {
  const reasons: string[] = [];
  const depictionType = evidence.depictionType || "unknown";
  const visibleRatio = Number.isFinite(evidence.visibleRatio) ? evidence.visibleRatio! : 0.7;
  const [x1, y1, x2, y2] = evidence.bbox;
  const edgeMargin = 20;

  if (depictionType === "worn") reasons.push("穿着照需要补全人体遮挡区域");
  if (evidence.partiallyOccluded) reasons.push("衣物存在遮挡");
  if (visibleRatio < (apparelCategories.has(evidence.category) ? 0.9 : 0.85)) {
    reasons.push("原图中衣物可见部分不足");
  }
  if (x1 <= edgeMargin || y1 <= edgeMargin || x2 >= 1000 - edgeMargin || y2 >= 1000 - edgeMargin) {
    reasons.push("衣物轮廓靠近原图边缘");
  }
  if (depictionType === "unknown" && apparelCategories.has(evidence.category)) {
    reasons.push("无法确认原图是完整商品照");
  }
  return Array.from(new Set(reasons));
}

export function requiresGarmentReconstruction(evidence: GarmentCompletenessEvidence) {
  return garmentReconstructionReasons(evidence).length > 0;
}
