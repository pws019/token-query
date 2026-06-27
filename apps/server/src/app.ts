import { trpcServer } from "@hono/trpc-server";
import { createContext } from "@token-query/api/context";
import { appRouter } from "@token-query/api/routers/index";
import { db } from "@token-query/db";
import { githubProfiles } from "@token-query/db/schema";
import { env } from "@token-query/env/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { z } from "zod";

const app = new Hono();

const githubProfileRequestSchema = z.object({
  token: z.string().trim().min(1),
});

const githubUserSchema = z.object({
  id: z.number(),
  login: z.string(),
  name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  html_url: z.string().nullable(),
  bio: z.string().nullable(),
  public_repos: z.number().int().default(0),
  followers: z.number().int().default(0),
  following: z.number().int().default(0),
});

const queryFailedError = "GitHub information query failed. Please check your token.";
const deleteFailedError = "Delete failed. Please try again.";

app.use(logger());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

app.post("/api/github/profile", async (c) => {
  try {
    const parseResult = githubProfileRequestSchema.safeParse(await c.req.json());
    if (!parseResult.success) {
      return c.json({ error: queryFailedError }, 400);
    }

    const { token } = parseResult.data;
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!response.ok) {
      return c.json({ error: queryFailedError }, 400);
    }

    const githubUser = githubUserSchema.parse(await response.json());
    const [profile] = await db
      .insert(githubProfiles)
      .values({
        githubId: githubUser.id,
        login: githubUser.login,
        name: githubUser.name,
        avatarUrl: githubUser.avatar_url,
        htmlUrl: githubUser.html_url,
        bio: githubUser.bio,
        publicRepos: githubUser.public_repos,
        followers: githubUser.followers,
        following: githubUser.following,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: githubProfiles.githubId,
        set: {
          login: githubUser.login,
          name: githubUser.name,
          avatarUrl: githubUser.avatar_url,
          htmlUrl: githubUser.html_url,
          bio: githubUser.bio,
          publicRepos: githubUser.public_repos,
          followers: githubUser.followers,
          following: githubUser.following,
          updatedAt: new Date(),
        },
      })
      .returning({
        githubId: githubProfiles.githubId,
        login: githubProfiles.login,
        name: githubProfiles.name,
        avatarUrl: githubProfiles.avatarUrl,
        htmlUrl: githubProfiles.htmlUrl,
        bio: githubProfiles.bio,
        publicRepos: githubProfiles.publicRepos,
        followers: githubProfiles.followers,
        following: githubProfiles.following,
      });

    return c.json({ profile });
  } catch {
    return c.json({ error: queryFailedError }, 400);
  }
});

app.delete("/api/github/profile", async (c) => {
  try {
    await db.delete(githubProfiles);
    return c.json({ success: true });
  } catch {
    return c.json({ error: deleteFailedError }, 500);
  }
});

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
