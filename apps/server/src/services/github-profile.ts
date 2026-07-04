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

export async function queryAndSaveGithubProfile(token: string) {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    throw new Error("GitHub profile query failed");
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

  return profile;
}

export async function deleteGithubProfiles() {
  await db.delete(githubProfiles);
}
