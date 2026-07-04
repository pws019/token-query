import { Hono } from "hono";

import {
  deleteGithubProfiles,
  githubProfileRequestSchema,
  queryAndSaveGithubProfile,
} from "../services/github-profile";

const queryFailedError = "GitHub information query failed. Please check your token.";
const deleteFailedError = "Delete failed. Please try again.";

export const githubRoutes = new Hono();

githubRoutes.post("/profile", async (c) => {
  try {
    const parseResult = githubProfileRequestSchema.safeParse(await c.req.json());
    if (!parseResult.success) {
      return c.json({ error: queryFailedError }, 400);
    }

    const profile = await queryAndSaveGithubProfile(parseResult.data.token);
    return c.json({ profile });
  } catch {
    return c.json({ error: queryFailedError }, 400);
  }
});

githubRoutes.delete("/profile", async (c) => {
  try {
    await deleteGithubProfiles();
    return c.json({ success: true });
  } catch {
    return c.json({ error: deleteFailedError }, 500);
  }
});
