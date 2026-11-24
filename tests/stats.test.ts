import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { concertStats } from "../src/server/domain/stats.js";
import { resetDb, testServices, user } from "./helpers.js";

const s = await testServices();
afterAll(() => s.close());
beforeEach(() => resetDb(s.db));

describe("look back stats", () => {
  it("counts past concerts per year, top artists, venues and people, and 'on this day'", async () => {
    const anna = await user(s, "anna@example.com");
    const add = async (artist: string, venue: string, startsAt: string, status = "attended") =>
      (await (await anna.api.post("/api/concerts", { artist, venue, city: "Amsterdam", startsAt, status })).json()) as { id: string };
    const a = await add("Foo Fighters", "Ziggo Dome", "2023-11-24T19:00:00Z");
    await add("foo fighters", "Ziggo Dome", "2024-06-01T19:00:00Z");
    await add("Muse", "Paradiso", "2024-07-01T19:00:00Z");
    await add("Skipped Band", "Paradiso", "2024-08-01T19:00:00Z", "skipped");
    await add("Future", "AFAS Live", "2099-01-01T19:00:00Z", "planned");
    const bob = await (await anna.api.post("/api/people", { name: "Bob" })).json();
    await anna.api.put(`/api/concerts/${a.id}/people`, { personIds: [bob.id] });

    const st = await concertStats(s.db, anna.id, new Date("2026-11-24T12:00:00Z"), "Europe/Amsterdam");
    expect(st.totals).toEqual({ concerts: 3, artists: 2, venues: 2, photos: 0 });
    expect(st.perYear).toEqual([
      { year: 2023, count: 1 },
      { year: 2024, count: 2 },
    ]);
    expect(st.topArtists[0]).toEqual({ name: "Foo Fighters", count: 2 });
    expect(st.topVenues[0]).toMatchObject({ name: "Ziggo Dome", count: 2 });
    expect(st.topPeople).toEqual([{ id: bob.id, name: "Bob", count: 1 }]);
    expect(st.onThisDay.map((c) => c.artist)).toEqual(["Foo Fighters"]);

    const res = await anna.api.get("/api/stats?tz=Europe/Amsterdam");
    expect(res.status).toBe(200);
    expect((await res.json()).totals.concerts).toBe(3);
  });

  it("only counts the user's own concerts", async () => {
    const anna = await user(s, "anna@example.com");
    const bob = await user(s, "bob@example.com");
    await anna.api.post("/api/concerts", { artist: "X", startsAt: "2020-01-01T19:00:00Z", status: "attended" });
    expect((await concertStats(s.db, bob.id)).totals.concerts).toBe(0);
  });
});
