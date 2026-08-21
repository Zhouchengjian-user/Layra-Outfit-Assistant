import { AsyncLocalStorage } from "node:async_hooks";

const VEFAAS_ACCESS_KEY_HEADER = "x-faas-access-key-id";
const VEFAAS_SECRET_KEY_HEADER = "x-faas-secret-access-key";
const VEFAAS_SESSION_TOKEN_HEADER = "x-faas-session-token";

type HeaderReader = Pick<Headers, "get">;

export type StorageRequestContext = Readonly<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}>;

const requestContext = new AsyncLocalStorage<StorageRequestContext | null>();

/**
 * 从 veFaaS Web 请求头捕获本次调用的 STS 临时凭据。
 *
 * 三个请求头必须同时存在；部分存在通常表示网关或角色配置异常，不能静默
 * 回退到长期凭据，否则既会掩盖部署错误，也可能使用超出预期的身份。
 */
export function captureStorageRequestContext(headers: HeaderReader): StorageRequestContext | null {
  const accessKeyId = headers.get(VEFAAS_ACCESS_KEY_HEADER) || "";
  const secretAccessKey = headers.get(VEFAAS_SECRET_KEY_HEADER) || "";
  const sessionToken = headers.get(VEFAAS_SESSION_TOKEN_HEADER) || "";
  const values = [accessKeyId, secretAccessKey, sessionToken];

  if (values.every((value) => value.length === 0)) return null;
  if (values.some((value) => value.length === 0)) {
    throw new Error("veFaaS 请求中的 STS 临时凭据不完整");
  }

  return Object.freeze({ accessKeyId, secretAccessKey, sessionToken });
}

/** 在当前异步调用链中绑定请求级存储凭据。 */
export function withStorageRequestContext<T>(context: StorageRequestContext | null, operation: () => T): T {
  return requestContext.run(context, operation);
}

/** 仅供存储实现读取；路由不应记录或回传这里的敏感字段。 */
export function getStorageRequestContext(): StorageRequestContext | null {
  return requestContext.getStore() ?? null;
}
