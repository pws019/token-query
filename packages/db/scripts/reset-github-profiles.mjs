import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const client = new Client({
  connectionString: databaseUrl,
});

try {
  await client.connect();

  const existsResult = await client.query("select to_regclass('public.github_profiles') as table_name");
  const tableExists = existsResult.rows[0]?.table_name === "github_profiles";

  if (!tableExists) {
    console.log("github_profiles table does not exist; reset skipped.");
    process.exit(0);
  }

  const beforeResult = await client.query("select count(*)::int as count from public.github_profiles");
  const beforeCount = beforeResult.rows[0]?.count ?? 0;

  await client.query("truncate table public.github_profiles restart identity");

  const afterResult = await client.query("select count(*)::int as count from public.github_profiles");
  const afterCount = afterResult.rows[0]?.count ?? 0;

  console.log(
    JSON.stringify({
      event: "github_profiles_reset",
      beforeCount,
      afterCount,
    }),
  );
} finally {
  await client.end();
}
