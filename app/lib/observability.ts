type LogLevel = "info" | "warn" | "error";

const SENSITIVE_KEY = /(?:authorization|cookie|password|secret|session|token|api[_-]?key|access[_-]?key)/i;
const SAFE_TRACE_ID = /^[a-zA-Z0-9._:-]{8,128}$/;

function redactString(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/((?:password|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

function sanitize(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitize(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey)]),
    );
  }
  return String(value).slice(0, 200);
}

export function traceIdFromRequest(request: Request) {
  const candidate = request.headers.get("x-faas-request-id")
    || request.headers.get("x-request-id")
    || request.headers.get("x-b3-traceid");
  return candidate && SAFE_TRACE_ID.test(candidate) ? candidate : crypto.randomUUID();
}

export function logServerEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  const safeFields = sanitize(fields) as Record<string, unknown>;
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: "yida-ai-outfit",
    event,
    ...safeFields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export function apiErrorResponse(request: Request, error: unknown, fallback: string, status = 500) {
  const traceId = traceIdFromRequest(request);
  const typed = error as { name?: string; code?: string | number; $metadata?: { requestId?: string; httpStatusCode?: number } };
  logServerEvent("error", "api_request_failed", {
    trace_id: traceId,
    method: request.method,
    path: new URL(request.url).pathname,
    error_name: typed?.name || typeof error,
    error_code: typed?.code,
    provider_request_id: typed?.$metadata?.requestId,
    provider_status: typed?.$metadata?.httpStatusCode,
  });
  return Response.json(
    { error: fallback, code: "INTERNAL_ERROR", traceId },
    { status, headers: { "X-Trace-Id": traceId, "Cache-Control": "no-store" } },
  );
}
