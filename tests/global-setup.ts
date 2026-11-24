import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { runMigrations } from "../src/server/db/migrate.js";

let container: StartedPostgreSqlContainer | undefined;

export async function setup() {
  if (!process.env.TEST_DATABASE_URL) {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    process.env.TEST_DATABASE_URL = container.getConnectionUri();
  }
  await runMigrations(process.env.TEST_DATABASE_URL);
}

export async function teardown() {
  await container?.stop();
}
