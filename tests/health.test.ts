import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { testConfig, testDb } from "./helpers.js";

const { db, sql } = testDb();
const app = createApp({ config: testConfig(), db });
afterAll(() => sql.end());

describe("health and static", () => {
  it("GET /healthz reports the database is reachable", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("serves index.html for client routes", async () => {
    const res = await app.request("/concerts/123");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("fixture spa");
  });

  it("does not fall back to the SPA for unknown API paths", async () => {
    const res = await app.request("/api/does-not-exist");
    expect(res.status).toBe(404);
  });
});
