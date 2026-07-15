import { Hono } from "hono";
import { z } from "zod";

import {
  deleteGithubProfiles,
  GithubProfileError,
  githubProfileRequestSchema,
  queryAndSaveGithubProfile,
} from "../services/github-profile";
import { generateProfileIntro, GoProfileIntroError } from "../services/go-profile-intro";
import { serializeError } from "../utils/error-log";

const queryFailedError = "GitHub information query failed. Please check your token.";
const invalidRequestError = "Invalid request payload.";
const databaseFailedError = "Profile saved failed. Please check database configuration.";
const deleteFailedError = "Delete failed. Please try again.";
const introFailedError = "Invalid intro request payload.";
const introServiceFailedError = "Self introduction generation failed. Please try again.";

const githubProfileIntroRequestSchema = z.object({
  githubId: z.number().int().positive(),
});

export const githubRoutes = new Hono();

githubRoutes.post("/profile", async (c) => {
  try {
    const parseResult = githubProfileRequestSchema.safeParse(await c.req.json());
    if (!parseResult.success) {
      console.warn("github_profile_invalid_request", {
        issues: parseResult.error.issues.map((issue) => issue.path.join(".")),
      });
      return c.json({ code: "invalid_request", error: invalidRequestError }, 400);
    }

    const profile = await queryAndSaveGithubProfile(parseResult.data.token);
    return c.json({ profile });
  } catch (error) {
    if (error instanceof GithubProfileError) {
      console.error("github_profile_request_failed", {
        code: error.code,
        meta: error.meta,
      });

      if (error.code === "database_upsert_failed") {
        return c.json({ code: error.code, error: databaseFailedError }, 500);
      }

      return c.json({ code: error.code, error: queryFailedError }, 400);
    }

    console.error("github_profile_unexpected_error", {
      cause: serializeError(error),
    });
    return c.json({ code: "unexpected_error", error: queryFailedError }, 500);
  }
});

githubRoutes.post("/profile/intro", async (c) => {
  try {
    const parseResult = githubProfileIntroRequestSchema.safeParse(await c.req.json());
    if (!parseResult.success) {
      console.warn("github_profile_intro_invalid_request", {
        issues: parseResult.error.issues.map((issue) => issue.path.join(".")),
      });
      return c.json({ code: "invalid_request", error: introFailedError }, 400);
    }

    const intro = await generateProfileIntro(parseResult.data.githubId);
    return c.json(intro);
  } catch (error) {
    if (error instanceof GoProfileIntroError) {
      console.error("github_profile_intro_go_service_failed", {
        code: error.code,
        status: error.status,
        cause: serializeError(error.cause),
      });
      return c.json({ code: error.code, error: introServiceFailedError }, 502);
    }

    console.error("github_profile_intro_unexpected_error", {
      cause: serializeError(error),
    });
    return c.json({ code: "unexpected_error", error: introServiceFailedError }, 500);
  }
});

githubRoutes.delete("/profile", async (c) => {
  try {
    await deleteGithubProfiles();
    return c.json({ success: true });
  } catch (error) {
    console.error("github_profile_delete_failed", {
      code: error instanceof GithubProfileError ? error.code : "unexpected_error",
      meta: error instanceof GithubProfileError ? error.meta : undefined,
      cause: error instanceof GithubProfileError ? undefined : serializeError(error),
    });
    return c.json({ code: "database_delete_failed", error: deleteFailedError }, 500);
  }
});
