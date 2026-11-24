import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

export function createDb(url: string) {
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzle(sql, { schema, casing: "snake_case" });
  return { db, sql };
}

export type Db = ReturnType<typeof createDb>["db"];
