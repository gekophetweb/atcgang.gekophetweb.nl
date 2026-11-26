import { existsSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

export async function runMigrations(url: string, folder = path.resolve("drizzle")) {
  if (!existsSync(path.join(folder, "meta", "_journal.json"))) return;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: folder });
  } finally {
    await sql.end();
  }
}
