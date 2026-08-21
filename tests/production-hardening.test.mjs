import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { apiErrorResponse } from "../app/lib/observability.ts";

function read(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

function captureConsole(method, operation) {
  const original = console[method];
  const lines = [];
  console[method] = (...values) => lines.push(values.map(String).join(" "));
  return Promise.resolve()
    .then(operation)
    .then(result => ({ result, lines }))
    .finally(() => {
      console[method] = original;
    });
}

test("production storage and SQLite are configured to fail closed without TOS", async () => {
  const [storage, database] = await Promise.all([
    read("../app/lib/storage.ts"),
    read("../app/lib/db.ts"),
  ]);
  assert.match(storage, /生产环境必须配置 TOS_BUCKET，禁止使用实例本地文件系统/);
  assert.match(database, /生产环境使用 SQLite 时必须配置 TOS 持久化/);
});

test("API failures return a traceable generic response without leaking provider errors", async () => {
  const request = new Request("https://example.test/api/profile", {
    headers: { "x-request-id": "trace-safe-1234" },
  });
  const { result: response, lines } = await captureConsole("error", () =>
    apiErrorResponse(request, new Error("provider secret=do-not-leak"), "个人资料加载失败"),
  );
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.equal(response.headers.get("X-Trace-Id"), "trace-safe-1234");
  assert.deepEqual(payload, {
    error: "个人资料加载失败",
    code: "INTERNAL_ERROR",
    traceId: "trace-safe-1234",
  });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /do-not-leak/);
  assert.match(lines[0], /"trace_id":"trace-safe-1234"/);
});

test("protected routes bind complete request STS before executing handlers", async () => {
  const [boundary, context] = await Promise.all([
    read("../app/lib/protected-route.ts"),
    read("../app/lib/storage-request-context.ts"),
  ]);
  const captureIndex = boundary.indexOf("captureStorageRequestContext(request.headers)");
  const handlerIndex = boundary.indexOf("handler(request)");
  assert.ok(captureIndex >= 0 && handlerIndex > captureIndex);
  assert.match(boundary, /apiErrorResponse\(request, error, fallback\)/);
  assert.match(context, /values\.some\(\(value\) => value\.length === 0\)/);
  assert.match(context, /STS 临时凭据不完整/);
});
