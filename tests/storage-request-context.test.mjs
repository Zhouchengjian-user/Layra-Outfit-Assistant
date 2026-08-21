import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  captureStorageRequestContext,
  getStorageRequestContext,
  withStorageRequestContext,
} from "../app/lib/storage-request-context.ts";

function vefaasHeaders(suffix = "a") {
  return new Headers({
    "x-faas-access-key-id": `test-access-${suffix}`,
    "x-faas-secret-access-key": `test-secret-${suffix}`,
    "x-faas-session-token": `test-token-${suffix}`,
  });
}

test("没有 veFaaS STS 请求头时返回空上下文", () => {
  assert.equal(captureStorageRequestContext(new Headers()), null);
  assert.equal(getStorageRequestContext(), null);
});

test("完整 STS 三元组只在当前异步调用链中可见", async () => {
  const context = captureStorageRequestContext(vefaasHeaders());
  assert.ok(context);
  assert.ok(Object.isFrozen(context));

  const result = await withStorageRequestContext(context, async () => {
    await Promise.resolve();
    assert.equal(getStorageRequestContext(), context);
    assert.equal(getStorageRequestContext()?.sessionToken, "test-token-a");
    return 42;
  });

  assert.equal(result, 42);
  assert.equal(getStorageRequestContext(), null);
});

test("部分 STS 请求头会报错，不会静默回退长期凭据", () => {
  assert.throws(
    () =>
      captureStorageRequestContext(
        new Headers({
          "x-faas-access-key-id": "test-access",
          "x-faas-secret-access-key": "test-secret",
        }),
      ),
    /STS 临时凭据不完整/,
  );
});

test("并发请求的 STS 凭据相互隔离", async () => {
  const first = captureStorageRequestContext(vefaasHeaders("first"));
  const second = captureStorageRequestContext(vefaasHeaders("second"));
  assert.ok(first && second);

  await Promise.all([
    withStorageRequestContext(first, async () => {
      await delay(10);
      assert.equal(getStorageRequestContext()?.accessKeyId, "test-access-first");
    }),
    withStorageRequestContext(second, async () => {
      await delay(1);
      assert.equal(getStorageRequestContext()?.accessKeyId, "test-access-second");
    }),
  ]);

  assert.equal(getStorageRequestContext(), null);
});
