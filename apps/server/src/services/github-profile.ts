import { db } from "@token-query/db";
import { githubProfiles } from "@token-query/db/schema";
import { z } from "zod";

export const githubProfileRequestSchema = z.object({
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

export class GithubProfileError extends Error {
  constructor(
    public readonly code:
      | "github_request_failed"
      | "github_response_invalid"
      | "database_upsert_failed"
      | "database_delete_failed",
    message: string,
    public readonly meta: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "GithubProfileError";
  }
}

export async function queryAndSaveGithubProfile(token: string) {
  let response: Response;
  try {
    response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
  } catch (error) {
    throw new GithubProfileError("github_request_failed", "GitHub request failed", {
      cause: error instanceof Error ? error.name : "UnknownError",
    });
  }

  if (!response.ok) {
    throw new GithubProfileError("github_request_failed", "GitHub profile query failed", {
      status: response.status,
    });
  }

  let githubUser: z.infer<typeof githubUserSchema>;
  try {
    githubUser = githubUserSchema.parse(await response.json());
  } catch (error) {
    throw new GithubProfileError("github_response_invalid", "GitHub response is invalid", {
      cause: error instanceof Error ? error.name : "UnknownError",
    });
  }

  try {
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

    return profile;
  } catch (error) {
    throw new GithubProfileError("database_upsert_failed", "Database upsert failed", {
      cause: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : undefined,
    });
  }
}

export async function deleteGithubProfiles() {
  try {
    await db.delete(githubProfiles);
  } catch (error) {
    throw new GithubProfileError("database_delete_failed", "Database delete failed", {
      cause: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : undefined,
    });
  }
}
