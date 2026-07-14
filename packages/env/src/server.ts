import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().min(1),
    CORS_ORIGIN: z.url(),
    INTERNAL_PROXY_TOKEN: z.string().min(1).optional(),
    ADMIN_MIGRATION_TOKEN: z.string().min(1).optional(),
    APP_ENV: z.enum(["development", "prod", "preview", "test"]).default("development"),
    PREVIEW_ID: z.string().min(1).optional(),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
