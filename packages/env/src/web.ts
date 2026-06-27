import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const runtimeEnv = (import.meta as any).env;

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {
    VITE_SERVER_URL: z.url(),
  },
  runtimeEnv,
  skipValidation: !!runtimeEnv.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
