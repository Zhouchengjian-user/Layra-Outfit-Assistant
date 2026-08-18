import { env } from "cloudflare:workers";
import { callImageSeg, getImageSegResultUrl } from "../../../lib/alibaba-imageseg";

type CutoutEnv = { WARDROBE_IMAGES: R2Bucket };

export async function POST(request: Request) {
  const storage = env as unknown as CutoutEnv;
  const token = crypto.randomUUID();
  const imageKey = `processing/${token}`;
  try {
    const form = await request.formData();
    const image = form.get("image");
    const requestedApi = form.get("api") === "SegmentCommodity" ? "SegmentCommodity" : "SegmentCloth";
    const refine = form.get("refine") === "1";
    if (!(image instanceof File) || !image.type.startsWith("image/")) {
      return Response.json({ error: "请上传需要抠图的单品" }, { status: 400 });
    }
    if (image.size > 3 * 1024 * 1024) {
      return Response.json({ error: "单品图片不能超过 3MB" }, { status: 400 });
    }
    await storage.WARDROBE_IMAGES.put(imageKey, image.stream(), { httpMetadata: { contentType: image.type || "image/jpeg" } });
    const imageUrl = new URL(`/api/wardrobe/source?token=${token}`, request.url).toString();

    let resultUrl = "";
    let outputKind = "white-background";
    if (refine) {
      const rough = await callImageSeg(requestedApi, { ImageURL: imageUrl, ReturnForm: "mask" });
      const roughMaskUrl = getImageSegResultUrl(rough);
      if (!roughMaskUrl) throw new Error("未获取到初步 Mask");
      const refined = await callImageSeg("RefineMask", { ImageURL: imageUrl, MaskImageURL: roughMaskUrl });
      resultUrl = getImageSegResultUrl(refined);
      outputKind = "refined-mask";
    } else {
      const result = await callImageSeg(requestedApi, { ImageURL: imageUrl, ReturnForm: "whiteBK" });
      resultUrl = getImageSegResultUrl(result);
    }
    if (!resultUrl) throw new Error("抠图服务未返回结果图");
    const resultResponse = await fetch(resultUrl, { signal: AbortSignal.timeout(30_000) });
    if (!resultResponse.ok) throw new Error("抠图结果下载失败");
    const result = await resultResponse.arrayBuffer();
    return new Response(result, {
      headers: {
        "Content-Type": resultResponse.headers.get("Content-Type") || "image/png",
        "Cache-Control": "no-store",
        "X-Yida-Output": outputKind,
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "单品抠图失败" }, { status: 500 });
  } finally {
    await storage.WARDROBE_IMAGES.delete(imageKey).catch(() => undefined);
  }
}
