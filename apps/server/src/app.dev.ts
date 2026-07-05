import { trpcServer } from "@hono/trpc-server";
import { createContext } from "@token-query/api/context";
import { appRouter } from "@token-query/api/routers/index";
import { env } from "@token-query/env/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { adminRoutes } from "./routes/admin";
import { githubRoutes } from "./routes/github";
import { healthRoutes } from "./routes/health";

const app = new Hono();

app.use(logger());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

app.route("/api/admin", adminRoutes);
app.route("/api/github", githubRoutes);
app.route("/api/health", healthRoutes);

app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext: (_opts, context) => {
      return createContext({ context });
    },
  }),
);

app.get("/", (c) => {
  return c.text("OK");
});

export { app };
