import { env } from "@token-query/env/server";
import { initializeDatabase } from "@token-query/db/init";
import { Hono } from "hono";

export const adminRoutes = new Hono();

adminRoutes.post("/db/init", async (c) => {
  if (!env.ADMIN_MIGRATION_TOKEN) {
    return c.json({ code: "admin_migration_disabled", error: "Admin migration is disabled." }, 404);
  }

  const token = c.req.header("X-Admin-Migration-Token");
  if (token !== env.ADMIN_MIGRATION_TOKEN) {
    return c.json({ code: "unauthorized", error: "Unauthorized" }, 401);
  }

  try {
    await initializeDatabase();
    console.log("database_init_completed");
    return c.json({ success: true });
  } catch (error) {
    console.error("database_init_failed", {
      cause: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : undefined,
    });
    return c.json({ code: "database_init_failed", error: "Database initialization failed." }, 500);
  }
});
