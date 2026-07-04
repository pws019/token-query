import { createEnv } from "@t3-oss/env-core";

const runtimeEnv = (import.meta as any).env;

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {},
  runtimeEnv,
  skipValidation: !!runtimeEnv.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
