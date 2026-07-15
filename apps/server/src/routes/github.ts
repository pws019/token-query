import { Hono } from "hono";
import { z } from "zod";

import { env } from "@token-query/env/server";
import type { HonoEnv } from "../hono-env";
import {
  deleteGithubProfiles,
  GithubProfileError,
  githubProfileRequestSchema,
  queryAndSaveGithubProfile,
} from "../services/github-profile";
import { generateProfileIntro, GoProfileIntroError } from "../services/go-profile-intro";
import { serializeError } from "../utils/error-log";
import { logError, logInfo, logWarn } from "../utils/request-log";

const queryFailedError = "GitHub information query failed. Please check your token.";
const invalidRequestError = "Invalid request payload.";
const databaseFailedError = "Profile saved failed. Please check database configuration.";
const deleteFailedError = "Delete failed. Please try again.";
const introFailedError = "Invalid intro request payload.";
const introServiceFailedError = "Self introduction generation failed. Please try again.";

const githubProfileIntroRequestSchema = z.object({
  githubId: z.number().int().positive(),
});

export const githubRoutes = new Hono<HonoEnv>();

githubRoutes.post("/profile", async (c) => {
  const requestId = c.get("requestId");
  const previewId = c.req.header("X-Preview-Id") ?? env.PREVIEW_ID;

  try {
    const parseResult = githubProfileRequestSchema.safeParse(await c.req.json());
    if (!parseResult.success) {
      logWarn("github_profile_invalid_request", {
        requestId,
        appEnv: env.APP_ENV,
        previewId,
        issues: parseResult.error.issues.map((issue) => issue.path.join(".")),
      });
      return c.json({ code: "invalid_request", error: invalidRequestError }, 400);
    }

    const profile = await queryAndSaveGithubProfile(parseResult.data.token);
    logInfo("github_profile_query_success", {
      requestId,
      appEnv: env.APP_ENV,
      previewId,
      githubId: profile?.githubId,
      login: profile?.login,
    });
    return c.json({ profile });
  } catch (error) {
    if (error instanceof GithubProfileError) {
      logError("github_profile_request_failed", {
        requestId,
        appEnv: env.APP_ENV,
        previewId,
        code: error.code,
        meta: error.meta,
      });

      if (error.code === "database_upsert_failed") {
        return c.json({ code: error.code, error: databaseFailedError }, 500);
      }

      return c.json({ code: error.code, error: queryFailedError }, 400);
    }

    logError("github_profile_unexpected_error", {
      requestId,
      appEnv: env.APP_ENV,
      previewId,
      cause: serializeError(error),
    });
    return c.json({ code: "unexpected_error", error: queryFailedError }, 500);
  }
});

githubRoutes.post("/profile/intro", async (c) => {
  const requestId = c.get("requestId");
  const previewId = c.req.header("X-Preview-Id") ?? env.PREVIEW_ID;

  try {
    const parseResult = githubProfileIntroRequestSchema.safeParse(await c.req.json());
    if (!parseResult.success) {
      logWarn("github_profile_intro_invalid_request", {
        requestId,
        appEnv: env.APP_ENV,
        previewId,
        issues: parseResult.error.issues.map((issue) => issue.path.join(".")),
      });
      return c.json({ code: "invalid_request", error: introFailedError }, 400);
    }

    logInfo("github_profile_intro_request", {
      requestId,
      appEnv: env.APP_ENV,
      previewId,
      githubId: parseResult.data.githubId,
      goServiceOrigin: env.GO_SERVICE_ORIGIN,
    });

    const intro = await generateProfileIntro(parseResult.data.githubId, {
      requestId,
      appEnv: env.APP_ENV,
      previewId,
    });

    logInfo("github_profile_intro_success", {
      requestId,
      appEnv: env.APP_ENV,
      previewId,
      githubId: intro.githubId,
      login: intro.login,
    });

    return c.json(intro);
  } catch (error) {
    if (error instanceof GoProfileIntroError) {
      logError("github_profile_intro_go_service_failed", {
        requestId,
        appEnv: env.APP_ENV,
        previewId,
        code: error.code,
        status: error.status,
        cause: serializeError(error.cause),
      });
      return c.json({ code: error.code, error: introServiceFailedError }, 502);
    }

    logError("github_profile_intro_unexpected_error", {
      requestId,
      appEnv: env.APP_ENV,
      previewId,
      cause: serializeError(error),
    });
    return c.json({ code: "unexpected_error", error: introServiceFailedError }, 500);
  }
});

githubRoutes.delete("/profile", async (c) => {
  const requestId = c.get("requestId");
  const previewId = c.req.header("X-Preview-Id") ?? env.PREVIEW_ID;

  try {
    await deleteGithubProfiles();
    logInfo("github_profile_delete_success", {
      requestId,
      appEnv: env.APP_ENV,
      previewId,
    });
    return c.json({ success: true });
  } catch (error) {
    logError("github_profile_delete_failed", {
      requestId,
      appEnv: env.APP_ENV,
      previewId,
      code: error instanceof GithubProfileError ? error.code : "unexpected_error",
      meta: error instanceof GithubProfileError ? error.meta : undefined,
      cause: error instanceof GithubProfileError ? undefined : serializeError(error),
    });
    return c.json({ code: "database_delete_failed", error: deleteFailedError }, 500);
  }
});
