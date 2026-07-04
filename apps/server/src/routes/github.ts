import { Hono } from "hono";

import {
  deleteGithubProfiles,
  GithubProfileError,
  githubProfileRequestSchema,
  queryAndSaveGithubProfile,
} from "../services/github-profile";
import { serializeError } from "../utils/error-log";

const queryFailedError = "GitHub information query failed. Please check your token.";
const invalidRequestError = "Invalid request payload.";
const databaseFailedError = "Profile saved failed. Please check database configuration.";
const deleteFailedError = "Delete failed. Please try again.";

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
