import { env } from "@token-query/env/server";
import { Hono } from "hono";

export const healthRoutes = new Hono();

healthRoutes.get("/", (c) => {
  return c.json({
    ok: true,
    service: "token-query-api",
    version: "lambda-workflow-check-2026-07-04",
    environment: env.NODE_ENV,
  });
});
