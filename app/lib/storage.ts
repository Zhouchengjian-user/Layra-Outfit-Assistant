import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getStorageRequestContext, type StorageRequestContext } from "./storage-request-context";

export type StoredObject = { body: Uint8Array<ArrayBuffer>; contentType: string };

/**
 * 双模式对象存储：
 * - 配置了 TOS_BUCKET 时使用 S3 兼容客户端（火山引擎 TOS / 生产）；
 * - 未配置时使用本地文件目录（本地开发，零依赖）。
 */
function isS3(): boolean {
  if (process.env.TOS_BUCKET) return true;
  const production = process.env.NODE_ENV === "production" || process.env.ENV?.trim().toLowerCase() === "prod";
  if (production) {
    throw new Error("生产环境必须配置 TOS_BUCKET，禁止使用实例本地文件系统");
  }
  return false;
}

const LOCAL_DATA_DIR = join(process.cwd(), ".data", "objects");

// ---------- S3（TOS）----------
let staticClientPromise: Promise<S3Client> | null = null;

function bucketName(): string {
  const bucket = process.env.TOS_BUCKET;
  if (!bucket) throw new Error("服务端缺少 TOS_BUCKET 配置");
  return bucket;
}

type S3Credentials = Pick<StorageRequestContext, "accessKeyId" | "secretAccessKey"> &
  Partial<Pick<StorageRequestContext, "sessionToken">>;

function createS3Client(credentials: S3Credentials): S3Client {
  return new S3Client({
    region: process.env.TOS_REGION || "cn-beijing",
    endpoint: process.env.TOS_ENDPOINT || undefined,
    credentials,
    // 火山引擎 TOS 的 S3 兼容接口仅支持 VirtualHostStyle：
    // https://{bucket}.tos-s3-{region}.volces.com/{key}
    forcePathStyle: false,
  });
}

function envS3Credentials(): S3Credentials {
  const sessionToken = process.env.TOS_SESSION_TOKEN;
  return {
    accessKeyId: process.env.TOS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.TOS_ACCESS_KEY_SECRET || "",
    ...(sessionToken ? { sessionToken } : {}),
  };
}

async function getStaticS3Client(credentials: S3Credentials): Promise<S3Client> {
  if (!staticClientPromise) {
    staticClientPromise = Promise.resolve(createS3Client(credentials));
  }
  return staticClientPromise;
}

async function withS3Client<T>(operation: (client: S3Client) => Promise<T>): Promise<T> {
  const requestCredentials = getStorageRequestContext();
  if (requestCredentials) {
    // veFaaS 角色凭据有有效期且按请求注入，绝不能放入进程级客户端缓存。
    const client = createS3Client(requestCredentials);
    try {
      return await operation(client);
    } finally {
      client.destroy();
    }
  }

  const envCredentials = envS3Credentials();
  if (envCredentials.sessionToken) {
    // 本地也可能注入可轮换的 STS 三元组，同样不复用进程级客户端。
    const client = createS3Client(envCredentials);
    try {
      return await operation(client);
    } finally {
      client.destroy();
    }
  }

  return operation(await getStaticS3Client(envCredentials));
}

async function collect(body: unknown): Promise<Uint8Array<ArrayBuffer>> {
  if (body == null) return new Uint8Array(0);
  const transformable = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof transformable.transformToByteArray === "function") {
    return new Uint8Array(await transformable.transformToByteArray());
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function isS3NotFound(error: unknown): boolean {
  const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  const name = (error as { name?: string }).name;
  return metadata?.httpStatusCode === 404 || name === "NoSuchKey" || name === "NotFound";
}

// ---------- 本地文件 ----------
function localPath(key: string): string {
  return join(LOCAL_DATA_DIR, key);
}

function metaPath(key: string): string {
  return `${localPath(key)}.meta`;
}

export type PutBody = Uint8Array | ArrayBuffer | Buffer | ReadableStream<Uint8Array>;

async function toBuffer(body: PutBody): Promise<Buffer> {
  if (body instanceof ReadableStream) {
    return Buffer.from(await new Response(body).arrayBuffer());
  }
  return Buffer.from(body as ArrayBuffer);
}

/** 上传对象。 */
export async function storagePut(key: string, body: PutBody, contentType: string): Promise<void> {
  const data = await toBuffer(body);
  if (isS3()) {
    await withS3Client((client) =>
      client.send(new PutObjectCommand({ Bucket: bucketName(), Key: key, Body: data, ContentType: contentType })),
    );
    return;
  }
  const filePath = localPath(key);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, data);
  writeFileSync(metaPath(key), contentType || "application/octet-stream");
}

/** 读取对象；不存在返回 null。 */
export async function storageGet(key: string): Promise<StoredObject | null> {
  if (isS3()) {
    try {
      return await withS3Client(async (client) => {
        const response = await client.send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
        return { body: await collect(response.Body), contentType: response.ContentType || "application/octet-stream" };
      });
    } catch (error) {
      if (isS3NotFound(error)) return null;
      throw error;
    }
  }
  const filePath = localPath(key);
  if (!existsSync(filePath)) return null;
  const contentType = existsSync(metaPath(key)) ? readFileSync(metaPath(key), "utf8") : "application/octet-stream";
  return { body: new Uint8Array(readFileSync(filePath)), contentType };
}

/** 删除对象。 */
export async function storageDelete(key: string): Promise<void> {
  if (isS3()) {
    await withS3Client((client) => client.send(new DeleteObjectCommand({ Bucket: bucketName(), Key: key })));
    return;
  }
  const filePath = localPath(key);
  if (existsSync(filePath)) rmSync(filePath);
  if (existsSync(metaPath(key))) rmSync(metaPath(key));
}

/** 判断对象是否存在。 */
export async function storageExists(key: string): Promise<boolean> {
  if (isS3()) {
    try {
      await withS3Client((client) => client.send(new HeadObjectCommand({ Bucket: bucketName(), Key: key })));
      return true;
    } catch (error) {
      if (isS3NotFound(error)) return false;
      throw error;
    }
  }
  return existsSync(localPath(key));
}
