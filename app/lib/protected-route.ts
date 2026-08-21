import { responseForAuthError } from "./auth";
import { apiErrorResponse, logServerEvent, traceIdFromRequest } from "./observability";
import {
  captureStorageRequestContext,
  withStorageRequestContext,
} from "./storage-request-context";

type ProtectedRouteHandler = (request: Request) => Response | Promise<Response>;

function withTraceHeader(response: Response, traceId: string): Response {
  if (!response.headers.has("X-Trace-Id")) response.headers.set("X-Trace-Id", traceId);
  return response;
}

/**
 * Route-local security boundary for authenticated APIs.
 *
 * Proxy is only a fast pre-check. Every protected Route Handler still performs
 * authentication itself, while this wrapper binds the veFaaS request STS
 * credentials before the first database restore or object-storage operation.
 */
export async function withProtectedApiRequest(
  request: Request,
  handler: ProtectedRouteHandler,
  fallback: string,
): Promise<Response> {
  const traceId = traceIdFromRequest(request);
  const startedAt = Date.now();
  try {
    const storageContext = captureStorageRequestContext(request.headers);
    const response = await withStorageRequestContext(storageContext, () => handler(request));
    logServerEvent(response.status >= 400 ? "warn" : "info", "api_request_completed", {
      trace_id: traceId,
      method: request.method,
      path: new URL(request.url).pathname,
      status: response.status,
      duration_ms: Date.now() - startedAt,
    });
    return withTraceHeader(response, traceId);
  } catch (error) {
    const authResponse = responseForAuthError(error);
    if (authResponse) return withTraceHeader(authResponse, traceId);
    return apiErrorResponse(request, error, fallback);
  }
}
