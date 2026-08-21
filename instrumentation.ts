import type { Instrumentation } from "next";
import { logServerEvent } from "./app/lib/observability";

export async function register() {
  if (!process.env.SENTRY_DSN?.trim()) return;
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
  if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const candidate = request.headers["x-faas-request-id"] || request.headers["x-request-id"];
  const traceId = Array.isArray(candidate) ? candidate[0] : candidate;
  const typed = error as { name?: string; digest?: string };
  logServerEvent("error", "next_request_error", {
    trace_id: traceId || "unavailable",
    method: request.method,
    path: request.path.split("?", 1)[0],
    route_path: context.routePath,
    route_type: context.routeType,
    error_name: typed?.name || typeof error,
    digest: typed?.digest,
  });

  if (!process.env.SENTRY_DSN?.trim()) return;
  try {
    const Sentry = await import("@sentry/nextjs");
    await Sentry.captureRequestError(error, request, context);
  } catch {
    logServerEvent("warn", "sentry_capture_failed", { trace_id: traceId || "unavailable" });
  }
};
