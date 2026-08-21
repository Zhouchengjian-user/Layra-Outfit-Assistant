import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "./sentry.options";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
if (dsn) Sentry.init({ dsn, ...sentryOptions });

export const onRouterTransitionStart = dsn
  ? Sentry.captureRouterTransitionStart
  : () => undefined;
