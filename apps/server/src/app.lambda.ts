import { env } from "@token-query/env/server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { adminRoutes } from "./routes/admin";
import { githubRoutes } from "./routes/github";

const app = new Hono();

app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-Internal-Proxy-Token", "X-Admin-Migration-Token"],
  }),
);

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

app.get("/", (c) => {
  return c.text("OK");
});

export { app };
