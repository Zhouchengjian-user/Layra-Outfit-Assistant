export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type RequestOptions = RequestInit & { timeoutMs?: number };

async function fetchWithTimeout(input: RequestInfo | URL, options: RequestOptions = {}) {
  const { timeoutMs = 30_000, signal, ...init } = options;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = window.setTimeout(() => controller.abort(new DOMException("请求超时", "TimeoutError")), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal, credentials: init.credentials || "same-origin", cache: init.cache || "no-store" });
  } catch (error) {
    if (controller.signal.aborted) throw new ApiError(signal?.aborted ? "请求已取消" : "网络等待超时，任务可能仍在后台进行");
    throw new ApiError(error instanceof Error ? error.message : "网络暂时不可用");
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function errorFromResponse(response: Response, fallback: string) {
  const payload = await response.clone().json().catch(() => null) as { error?: string; code?: string } | null;
  return new ApiError(payload?.error || fallback, response.status, payload?.code);
}

export async function requestResponse(input: RequestInfo | URL, options: RequestOptions = {}) {
  const response = await fetchWithTimeout(input, options);
  if (response.status === 401 && !String(input).startsWith("/api/auth/")) {
    window.dispatchEvent(new Event("yida:auth-required"));
  }
  if (!response.ok) throw await errorFromResponse(response, "请求失败，请稍后重试");
  return response;
}

export async function requestJson<T>(input: RequestInfo | URL, options: RequestOptions = {}) {
  const response = await requestResponse(input, options);
  return { data: await response.json() as T, response };
}

export async function requestBlob(input: RequestInfo | URL, options: RequestOptions = {}) {
  const response = await requestResponse(input, options);
  return { data: await response.blob(), response };
}

export function createIdempotencyKey() {
  return crypto.randomUUID();
}

export async function wait(ms: number, signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new ApiError("请求已取消"));
    }, { once: true });
  });
}
