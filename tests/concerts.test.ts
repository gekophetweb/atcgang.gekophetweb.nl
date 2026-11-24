import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { concertInvites, users } from "../src/server/db/schema.js";
import { NEW_ACCOUNT_DAILY_CONCERTS } from "../src/server/domain/concerts.js";
import { resetDb, testServices, user } from "./helpers.js";

const s = await testServices();
afterAll(() => s.close());
beforeEach(() => resetDb(s.db));

const day = 86400_000;
const concert = (over: Record<string, unknown> = {}) => ({
  artist: "Foo Fighters",
  venue: "Ziggo Dome",
  city: "Amsterdam",
  country: "NL",
  startsAt: new Date(Date.now() + 30 * day).toISOString(),
  ...over,
});

async function create(api: Awaited<ReturnType<typeof user>>["api"], over: Record<string, unknown> = {}) {
  const res = await api.post("/api/concerts", concert(over));
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; artist: string };
}

async function inviteAndAccept(owner: Awaited<ReturnType<typeof user>>, guest: Awaited<ReturnType<typeof user>>, id: string, role = "editor") {
  const inv = await (await owner.api.post(`/api/concerts/${id}/invites`, { role })).json();
  const token = inv.url.split("/invite/")[1];
  const res = await guest.api.post(`/api/invites/${token}/accept`);
  expect(res.status).toBe(200);
  return res.json();
}

describe("concerts CRUD and privacy", () => {
  it("creates a concert owned by the creator and lists it", async () => {
    const anna = await user(s, "anna@example.com");
    const c = await create(anna.api);
    const list = await (await anna.api.get("/api/concerts")).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: c.id, artist: "Foo Fighters", myRole: "owner", photoCount: 0 });
    expect(list[0].members.map((m: { id: string }) => m.id)).toEqual([anna.id]);
  });

  it("is private: other users get 404 and don't see it in lists", async () => {
    const anna = await user(s, "anna@example.com");
    const bob = await user(s, "bob@example.com");
    const c = await create(anna.api);
    expect((await bob.api.get(`/api/concerts/${c.id}`)).status).toBe(404);
    expect((await bob.api.patch(`/api/concerts/${c.id}`, { notes: "x" })).status).toBe(404);
    expect((await bob.api.del(`/api/concerts/${c.id}`)).status).toBe(404);
    expect(await (await bob.api.get("/api/concerts")).json()).toEqual([]);
  });

  it("returns 404 for malformed ids and 401 without a session", async () => {
    const anna = await user(s, "anna@example.com");
    expect((await anna.api.get("/api/concerts/not-a-uuid")).status).toBe(404);
    expect((await s.app.request("/api/concerts")).status).toBe(401);
  });

  it("validates input", async () => {
    const anna = await user(s, "anna@example.com");
    expect((await anna.api.post("/api/concerts", { artist: "" })).status).toBe(400);
    expect((await anna.api.post("/api/concerts", concert({ rating: 9 }))).status).toBe(400);
    expect((await anna.api.post("/api/concerts", concert({ setlistUrl: "javascript:alert(1)" }))).status).toBe(400);
    const start = Date.now() + day;
    expect(
      (await anna.api.post("/api/concerts", concert({ startsAt: new Date(start).toISOString(), endsAt: new Date(start - 3600_000).toISOString() })))
        .status,
    ).toBe(400);
  });

  it("splits upcoming and past and filters by search, status, year and person", async () => {
    const anna = await user(s, "anna@example.com");
    await create(anna.api, { artist: "Future Band", startsAt: new Date(Date.now() + 5 * day).toISOString() });
    const old = await create(anna.api, {
      artist: "Old Band",
      venue: "Paradiso",
      status: "attended",
      startsAt: "2019-06-01T19:00:00Z",
    });
    const upcoming = await (await anna.api.get("/api/concerts?when=upcoming")).json();
    const past = await (await anna.api.get("/api/concerts?when=past")).json();
    expect(upcoming.map((c: { artist: string }) => c.artist)).toEqual(["Future Band"]);
    expect(past.map((c: { artist: string }) => c.artist)).toEqual(["Old Band"]);

    expect((await (await anna.api.get("/api/concerts?q=paradiso")).json()).map((c: { id: string }) => c.id)).toEqual([old.id]);
    expect(await (await anna.api.get("/api/concerts?q=%25")).json()).toEqual([]);
    expect((await (await anna.api.get("/api/concerts?status=attended")).json())).toHaveLength(1);
    expect((await (await anna.api.get("/api/concerts?year=2019")).json())).toHaveLength(1);

    const person = await (await anna.api.post("/api/people", { name: "Bob" })).json();
    expect((await anna.api.put(`/api/concerts/${old.id}/people`, { personIds: [person.id] })).status).toBe(204);
    const byPerson = await (await anna.api.get(`/api/concerts?person=${person.id}`)).json();
    expect(byPerson.map((c: { id: string }) => c.id)).toEqual([old.id]);
    expect(byPerson[0].people).toEqual([{ id: person.id, name: "Bob", linkedUserId: null }]);
  });

  it("returns concerts in a calendar date range [from, to)", async () => {
    const anna = await user(s, "anna@example.com");
    await create(anna.api, { artist: "In", startsAt: "2027-05-10T20:00:00Z" });
    await create(anna.api, { artist: "Edge", startsAt: "2027-06-01T00:00:00Z" });
    await create(anna.api, { artist: "Before", startsAt: "2027-04-30T20:00:00Z" });
    const list = await (await anna.api.get("/api/concerts?from=2027-05-01T00:00:00Z&to=2027-06-01T00:00:00Z")).json();
    expect(list.map((c: { artist: string }) => c.artist)).toEqual(["In"]);
  });

  it("updates and deletes", async () => {
    const anna = await user(s, "anna@example.com");
    const c = await create(anna.api);
    const res = await anna.api.patch(`/api/concerts/${c.id}`, { rating: 5, status: "attended", notes: "Great" });
    expect(await res.json()).toMatchObject({ rating: 5, status: "attended", notes: "Great" });
    expect((await anna.api.del(`/api/concerts/${c.id}`)).status).toBe(204);
    expect((await anna.api.get(`/api/concerts/${c.id}`)).status).toBe(404);
  });

  it("limits how many concerts a new account adds per day", async () => {
    const anna = await user(s, "anna@example.com");
    for (let i = 0; i < NEW_ACCOUNT_DAILY_CONCERTS; i++) await create(anna.api, { artist: `Band ${i}` });
    expect((await anna.api.post("/api/concerts", concert())).status).toBe(429);
    await s.db.update(users).set({ createdAt: new Date(Date.now() - 30 * day) }).where(eq(users.id, anna.id));
    expect((await anna.api.post("/api/concerts", concert())).status).toBe(201);
  });

  it("exports an .ics file", async () => {
    const anna = await user(s, "anna@example.com");
    const c = await create(anna.api, { startsAt: "2027-01-15T19:30:00Z", notes: "Bring earplugs, please; really" });
    const res = await anna.api.get(`/api/concerts/${c.id}/ics`);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    const body = await res.text();
    expect(body).toContain("DTSTART:20270115T193000Z");
    expect(body).toContain("DTEND:20270115T223000Z");
    expect(body).toContain("SUMMARY:Foo Fighters");
    expect(body).toContain("LOCATION:Ziggo Dome\\, Amsterdam\\, NL");
    expect(body).toContain("earplugs\\, please\\; really");
    expect(body.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
  });
});

describe("sharing", () => {
  it("emails an invite; accepting makes the invitee a member with the invite's role", async () => {
    const anna = await user(s, "anna@example.com");
    const bob = await user(s, "bob@example.com");
    const c = await create(anna.api);
    const res = await anna.api.post(`/api/concerts/${c.id}/invites`, { email: "bob@example.com", role: "viewer" });
    expect(res.status).toBe(201);
    const mail = s.mailer.last("bob@example.com")!;
    expect(mail.subject).toContain("Foo Fighters");
    const token = mail.text.match(/\/invite\/([\w-]+)/)![1]!;

    const preview = await s.app.request(`/api/invites/${token}`);
    expect(preview.status).toBe(200);
    expect((await preview.json()).concert.artist).toBe("Foo Fighters");

    expect((await bob.api.post(`/api/invites/${token}/accept`)).status).toBe(200);
    const detail = await (await bob.api.get(`/api/concerts/${c.id}`)).json();
    expect(detail.myRole).toBe("viewer");
    expect((await bob.api.patch(`/api/concerts/${c.id}`, { notes: "x" })).status).toBe(403);

    const carl = await user(s, "carl@example.com");
    expect((await carl.api.post(`/api/invites/${token}/accept`)).status).toBe(410);
  });

  it("share links work for several people until they expire", async () => {
    const anna = await user(s, "anna@example.com");
    const c = await create(anna.api);
    const inv = await (await anna.api.post(`/api/concerts/${c.id}/invites`, {})).json();
    const token = inv.url.split("/invite/")[1];
    for (const email of ["bob@example.com", "carl@example.com"]) {
      const u = await user(s, email);
      expect((await u.api.post(`/api/invites/${token}/accept`)).status).toBe(200);
      expect((await u.api.get(`/api/concerts/${c.id}`)).status).toBe(200);
    }
    await s.db.update(concertInvites).set({ expiresAt: new Date(Date.now() - 1000) });
    const dana = await user(s, "dana@example.com");
    expect((await dana.api.post(`/api/invites/${token}/accept`)).status).toBe(404);
  });

  it("only the owner invites; editors edit; viewers read", async () => {
    const anna = await user(s, "anna@example.com");
    const bob = await user(s, "bob@example.com");
    const c = await create(anna.api);
    await inviteAndAccept(anna, bob, c.id, "editor");
    expect((await bob.api.patch(`/api/concerts/${c.id}`, { notes: "from bob" })).status).toBe(200);
    expect((await bob.api.post(`/api/concerts/${c.id}/invites`, {})).status).toBe(403);
    expect((await bob.api.del(`/api/concerts/${c.id}`)).status).toBe(403);
  });

  it("detects a duplicate concert on accept so it can be merged", async () => {
    const anna = await user(s, "anna@example.com");
    const bob = await user(s, "bob@example.com");
    const shared = await create(anna.api, { startsAt: "2027-03-03T19:00:00Z" });
    const own = await create(bob.api, { artist: "foo fighters", startsAt: "2027-03-03T20:00:00Z" });
    const res = await inviteAndAccept(anna, bob, shared.id);
    expect(res).toMatchObject({ concertId: shared.id, duplicateOf: own.id });
  });

  it("members can leave, owners remove members, owners can't leave", async () => {
    const anna = await user(s, "anna@example.com");
    const bob = await user(s, "bob@example.com");
    const carl = await user(s, "carl@example.com");
    const c = await create(anna.api);
    await inviteAndAccept(anna, bob, c.id);
    await inviteAndAccept(anna, carl, c.id);
    expect((await bob.api.del(`/api/concerts/${c.id}/members/${carl.id}`)).status).toBe(403);
    expect((await bob.api.del(`/api/concerts/${c.id}/members/${bob.id}`)).status).toBe(204);
    expect((await bob.api.get(`/api/concerts/${c.id}`)).status).toBe(404);
    expect((await anna.api.del(`/api/concerts/${c.id}/members/${carl.id}`)).status).toBe(204);
    expect((await anna.api.del(`/api/concerts/${c.id}/members/${anna.id}`)).status).toBe(400);
  });

  it("people lists stay private per user on a shared concert", async () => {
    const anna = await user(s, "anna@example.com");
    const bob = await user(s, "bob@example.com");
    const c = await create(anna.api);
    await inviteAndAccept(anna, bob, c.id);
    const annasFriend = await (await anna.api.post("/api/people", { name: "Zoe" })).json();
    const bobsFriend = await (await bob.api.post("/api/people", { name: "Yuri" })).json();
    await anna.api.put(`/api/concerts/${c.id}/people`, { personIds: [annasFriend.id] });
    await bob.api.put(`/api/concerts/${c.id}/people`, { personIds: [bobsFriend.id] });
    expect((await (await anna.api.get(`/api/concerts/${c.id}`)).json()).people.map((p: { name: string }) => p.name)).toEqual(["Zoe"]);
    expect((await (await bob.api.get(`/api/concerts/${c.id}`)).json()).people.map((p: { name: string }) => p.name)).toEqual(["Yuri"]);
    // Bob can't put Anna's person on a concert.
    expect((await bob.api.put(`/api/concerts/${c.id}/people`, { personIds: [annasFriend.id] })).status).toBe(404);
  });
});

describe("people and labels", () => {
  it("links a person to a registered user by email and merges duplicates", async () => {
    const anna = await user(s, "anna@example.com");
    const bob = await user(s, "bob@example.com");
    const p1 = await (await anna.api.post("/api/people", { name: "Bob", linkedEmail: "bob@example.com" })).json();
    expect(p1.linkedUserId).toBe(bob.id);
    expect((await anna.api.post("/api/people", { name: "X", linkedEmail: "nobody@example.com" })).status).toBe(404);

    const p2 = await (await anna.api.post("/api/people", { name: "Bobby" })).json();
    const c = await create(anna.api);
    await anna.api.put(`/api/concerts/${c.id}/people`, { personIds: [p2.id] });
    expect((await anna.api.post(`/api/people/${p2.id}/merge`, { intoId: p1.id })).status).toBe(204);
    const list = await (await anna.api.get("/api/people")).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: p1.id, concertCount: 1 });
  });

  it("labels are unique per user and mergeable", async () => {
    const anna = await user(s, "anna@example.com");
    const a = await (await anna.api.post("/api/labels", { name: "encore" })).json();
    const again = await (await anna.api.post("/api/labels", { name: "encore" })).json();
    expect(again.id).toBe(a.id);
    const b = await (await anna.api.post("/api/labels", { name: "Encore!", color: "#22c55e" })).json();
    expect((await anna.api.patch(`/api/labels/${b.id}`, { name: "encore" })).status).toBe(409);
    expect((await anna.api.post(`/api/labels/${b.id}/merge`, { intoId: a.id })).status).toBe(204);
    expect(await (await anna.api.get("/api/labels")).json()).toHaveLength(1);
    const bob = await user(s, "bob@example.com");
    expect((await bob.api.del(`/api/labels/${a.id}`)).status).toBe(404);
  });
});
