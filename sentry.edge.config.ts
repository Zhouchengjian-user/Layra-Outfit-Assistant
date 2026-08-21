import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "./sentry.options";

const dsn = process.env.SENTRY_DSN?.trim();
if (dsn) Sentry.init({ dsn, ...sentryOptions });
