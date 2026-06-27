import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const githubProfiles = pgTable("github_profiles", {
  id: serial("id").primaryKey(),
  githubId: integer("github_id").notNull().unique(),
  login: text("login").notNull(),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  htmlUrl: text("html_url"),
  bio: text("bio"),
  publicRepos: integer("public_repos").default(0).notNull(),
  followers: integer("followers").default(0).notNull(),
  following: integer("following").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
