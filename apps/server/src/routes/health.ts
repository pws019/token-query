import { env } from "@token-query/env/server";
import { Hono } from "hono";

import { logWarn, requestIdHeader } from "../utils/request-log";

const GO_HEALTH_CHECK_TIMEOUT_MS = 2000;

export const healthRoutes = new Hono();

async function checkGoService(requestId: string | undefined): Promise<"ok" | "unreachable"> {
  try {
    const url = new URL("/health", env.GO_SERVICE_ORIGIN);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(GO_HEALTH_CHECK_TIMEOUT_MS),
    });

    if (!response.ok) {
      logWarn("health_go_service_unreachable", {
        requestId,
        appEnv: env.APP_ENV,
        previewId: env.PREVIEW_ID,
        goServiceOrigin: env.GO_SERVICE_ORIGIN,
        status: response.status,
      });
      return "unreachable";
    }

    return "ok";
  } catch (error) {
    logWarn("health_go_service_unreachable", {
      requestId,
      appEnv: env.APP_ENV,
      previewId: env.PREVIEW_ID,
      goServiceOrigin: env.GO_SERVICE_ORIGIN,
      cause: error instanceof Error ? error.name : "UnknownError",
    });
    return "unreachable";
  }
}

healthRoutes.get("/", async (c) => {
  const goService = await checkGoService(c.req.header(requestIdHeader));

  return c.json({
    ok: true,
    service: "token-query-api",
    version: "lambda-workflow-check-2026-07-14-feat-005",
    nodeEnv: env.NODE_ENV,
    appEnv: env.APP_ENV,
    previewId: env.PREVIEW_ID,
    goService,
  });
});
