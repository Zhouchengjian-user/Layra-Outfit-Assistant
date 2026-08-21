import { S3Client } from "@aws-sdk/client-s3";

export type S3Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export function createS3Client(credentials: S3Credentials): S3Client {
  // AWS SDK 3.1115+ annotates credential objects with a mutable `$source`
  // field. Request contexts are deliberately frozen, so hand the SDK a
  // shallow copy while keeping the AsyncLocalStorage value immutable.
  const clientCredentials = { ...credentials };
  return new S3Client({
    region: process.env.TOS_REGION || "cn-beijing",
    endpoint: process.env.TOS_ENDPOINT || undefined,
    credentials: clientCredentials,
    // 火山引擎 TOS 的 S3 兼容接口仅支持 VirtualHostStyle：
    // https://{bucket}.tos-s3-{region}.volces.com/{key}
    forcePathStyle: false,
  });
}
