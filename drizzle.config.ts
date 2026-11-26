import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  casing: "snake_case",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://atc:atc@localhost:5432/atc" },
});
