import { afterAll, describe, expect, it } from "vitest";
import { testServices } from "./helpers.js";

const s = await testServices();
afterAll(() => s.close());

describe("health and static", () => {
  it("GET /healthz reports the database is reachable", async () => {
    const res = await s.app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("serves index.html for client routes", async () => {
    const res = await s.app.request("/concerts/123");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("fixture spa");
  });

  it("does not fall back to the SPA for unknown API paths", async () => {
    const res = await s.app.request("/api/does-not-exist");
    expect([401, 404]).toContain(res.status);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
