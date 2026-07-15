import { env } from "@token-query/env/server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import type { HonoEnv } from "./hono-env";
import { adminRoutes } from "./routes/admin";
import { githubRoutes } from "./routes/github";
import { healthRoutes } from "./routes/health";
import { ensureRequestId, logInfo, requestIdHeader } from "./utils/request-log";

const app = new Hono<HonoEnv>();

app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "X-Internal-Proxy-Token",
      "X-Admin-Migration-Token",
      "X-Preview-Id",
      requestIdHeader,
    ],
    exposeHeaders: [requestIdHeader],
  }),
);

app.use("*", async (c, next) => {
  const startedAt = Date.now();
  const requestId = ensureRequestId(c.req.raw.headers);
  const previewId = c.req.header("X-Preview-Id") ?? env.PREVIEW_ID;

  c.set("requestId", requestId);
  c.header(requestIdHeader, requestId);

  logInfo("lambda_request_start", {
    requestId,
    appEnv: env.APP_ENV,
    previewId,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
  });

  await next();

  logInfo("lambda_request_end", {
    requestId,
    appEnv: env.APP_ENV,
    previewId,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    durationMs: Date.now() - startedAt,
  });
});

app.use("/api/*", async (c, next) => {
  if (!env.INTERNAL_PROXY_TOKEN) {
    return next();
  }

  const token = c.req.header("X-Internal-Proxy-Token");
  if (token !== env.INTERNAL_PROXY_TOKEN) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return next();
});

app.route("/api/admin", adminRoutes);
app.route("/api/github", githubRoutes);
app.route("/api/health", healthRoutes);

app.get("/", (c) => {
  return c.text("OK");
});

export { app };
