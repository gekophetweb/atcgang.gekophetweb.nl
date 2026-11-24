import { sql } from "drizzle-orm";
import { createDb } from "../src/server/db/client.js";
import { loadConfig, type Config } from "../src/server/config.js";

export function testConfig(overrides: Partial<Record<string, string>> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BASE_URL: "http://localhost:3000",
    CLIENT_DIR: "./tests/fixtures/client",
    TRUST_CF_HEADERS: "true",
    ...overrides,
  });
}

export function testDb() {
  return createDb(process.env.TEST_DATABASE_URL!);
}

/** Empties every table in the public schema (except migration bookkeeping). */
export async function resetDb(db: ReturnType<typeof testDb>["db"]) {
  const rows = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const names = rows.map((r) => `"${r.tablename}"`);
  if (names.length) await db.execute(sql.raw(`truncate ${names.join(", ")} restart identity cascade`));
}
