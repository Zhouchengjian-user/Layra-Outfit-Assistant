"use client";

import * as Sentry from "@sentry/nextjs";
import NextError from "next/error";
import { useEffect } from "react";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SENTRY_DSN?.trim()) Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="zh-CN">
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
