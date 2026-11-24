import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users } from "../src/server/db/schema.js";
import { TAG_EMAIL_DELAY_MS } from "../src/server/domain/notifications.js";
import { jpeg, resetDb, testServices, upload, user } from "./helpers.js";

const s = await testServices();
afterAll(() => s.close());
beforeEach(async () => {
  await resetDb(s.db);
  s.mailer.sent = [];
  s.jobs.queue = [];
});

type U = Awaited<ReturnType<typeof user>>;

async function setup(opts: { bobMember?: boolean; bobRole?: string } = {}) {
  const anna = await user(s, "anna@example.com");
  const bob = await user(s, "bob@example.com");
  const c = (await (await anna.api.post("/api/concerts", { artist: "Foo Fighters", venue: "Ziggo Dome", startsAt: "2026-06-01T19:00:00Z" })).json()) as { id: string };
  if (opts.bobMember !== false) {
    const inv = await (await anna.api.post(`/api/concerts/${c.id}/invites`, { role: opts.bobRole ?? "editor" })).json();
    await bob.api.post(`/api/invites/${inv.url.split("/invite/")[1]}/accept`);
  }
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push((await (await upload(s, anna, c.id, await jpeg(200, 200))).json()).id);
  await s.jobs.drain();
  const bobPerson = await (await anna.api.post("/api/people", { name: "Bob", linkedEmail: "bob@example.com" })).json();
  s.mailer.sent = [];
  return { anna, bob, c, ids, bobPerson, clear: () => bob.api.patch("/api/notifications", { all: true }) };
}

const unread = async (u: U) => (await (await u.api.get("/api/notifications/unread-count")).json()).unread as number;
const later = () => Date.now() + TAG_EMAIL_DELAY_MS + 60_000;

describe("bulk tagging", () => {
  it("adds labels and people by id or name to many photos and filters on them", async () => {
    const { anna, ids } = await setup();
    const res = await anna.api.post("/api/photos/bulk-tag", { photoIds: ids.slice(0, 2), addLabels: [{ name: "encore" }], addPeople: [{ name: "Zoe" }] });
    expect(res.status).toBe(200);
    const [label] = await (await anna.api.get("/api/labels")).json();
    expect(label).toMatchObject({ name: "encore", photoCount: 2 });
    const zoe = (await (await anna.api.get("/api/people")).json()).find((p: { name: string }) => p.name === "Zoe");
    expect((await (await anna.api.get(`/api/photos?label=${label.id}`)).json())).toHaveLength(2);
    expect((await (await anna.api.get(`/api/photos?person=${zoe.id}`)).json())).toHaveLength(2);

    await anna.api.post("/api/photos/bulk-tag", { photoIds: [ids[0]], removeLabels: [label.id], removePeople: [zoe.id] });
    const [p0] = (await (await anna.api.get(`/api/photos?concert=${(await (await anna.api.get(`/api/photos/${ids[0]}`)).json()).concertId}`)).json()).filter(
      (p: { id: string }) => p.id === ids[0],
    );
    expect(p0.labels).toEqual([]);
    expect(p0.people).toEqual([]);
  });

  it("stores a pin position and moves it when re-tagged with a new position", async () => {
    const { anna, ids } = await setup();
    await anna.api.post("/api/photos/bulk-tag", { photoIds: [ids[0]], addPeople: [{ name: "Zoe", x: 0.25, y: 0.5 }] });
    let p = await (await anna.api.get(`/api/photos/${ids[0]}`)).json();
    expect(p.people[0]).toMatchObject({ name: "Zoe", x: 0.25, y: 0.5, mine: true });
    await anna.api.post("/api/photos/bulk-tag", { photoIds: [ids[0]], addPeople: [{ id: p.people[0].id, x: 0.75, y: 0.1 }] });
    p = await (await anna.api.get(`/api/photos/${ids[0]}`)).json();
    expect(p.people[0]).toMatchObject({ x: 0.75, y: 0.1 });
    expect((await anna.api.post("/api/photos/bulk-tag", { photoIds: [ids[0]], addPeople: [{ name: "X", x: 2, y: 0 }] })).status).toBe(400);
  });

  it("viewers can't tag; strangers get 404; other users' labels can't be used", async () => {
    const { anna, bob, ids } = await setup({ bobRole: "viewer" });
    expect((await bob.api.post("/api/photos/bulk-tag", { photoIds: ids, addLabels: [{ name: "x" }] })).status).toBe(403);
    const carl = await user(s, "carl@example.com");
    expect((await carl.api.post("/api/photos/bulk-tag", { photoIds: ids, addLabels: [{ name: "x" }] })).status).toBe(404);
    const carlsLabel = await (await carl.api.post("/api/labels", { name: "mine" })).json();
    expect((await anna.api.post("/api/photos/bulk-tag", { photoIds: ids, addLabels: [{ id: carlsLabel.id }] })).status).toBe(404);
  });
});

describe("tagged users", () => {
  it("see the photos on 'Photos of me', get one grouped notification and one batched email", async () => {
    const { anna, bob, ids, bobPerson, clear } = await setup();
    await clear();
    await anna.api.post("/api/photos/bulk-tag", { photoIds: ids.slice(0, 2), addPeople: [{ id: bobPerson.id }] });
    await anna.api.post("/api/photos/bulk-tag", { photoIds: [ids[2]], addPeople: [{ id: bobPerson.id }] });

    const mine = await (await bob.api.get("/api/photos?me=1")).json();
    expect(mine.map((p: { id: string }) => p.id).sort()).toEqual([...ids].sort());

    expect(await unread(bob)).toBe(1);
    const [n] = await (await bob.api.get("/api/notifications")).json();
    expect(n).toMatchObject({ type: "tagged", payload: { actorName: "anna", count: 3, artist: "Foo Fighters" } });

    await s.jobs.drain(); // not due yet
    expect(s.mailer.sent).toHaveLength(0);
    await s.jobs.drain(later());
    expect(s.mailer.sent).toHaveLength(1);
    const mail = s.mailer.sent[0]!;
    expect(mail.to).toBe("bob@example.com");
    expect(mail.subject).toBe("anna tagged you in 3 photos from Foo Fighters, Ziggo Dome");
    expect(mail.html).toMatch(/\/photos\/[0-9a-f-]+\/thumb\?exp=\d+&amp;sig=/);
  });

  it("untagging before the batch goes out cancels the email", async () => {
    const { anna, bob, ids, bobPerson } = await setup();
    await anna.api.post("/api/photos/bulk-tag", { photoIds: ids, addPeople: [{ id: bobPerson.id }] });
    await anna.api.post("/api/photos/bulk-tag", { photoIds: ids, removePeople: [bobPerson.id] });
    await s.jobs.drain(later());
    expect(s.mailer.sent).toHaveLength(0);
    expect(await (await bob.api.get("/api/photos?me=1")).json()).toEqual([]);
  });

  it("respects the email setting but always notifies in-app", async () => {
    const { anna, bob, ids, bobPerson, clear } = await setup();
    await clear();
    await s.db.update(users).set({ emailNotifications: false }).where(eq(users.id, bob.id));
    await anna.api.post("/api/photos/bulk-tag", { photoIds: ids, addPeople: [{ id: bobPerson.id }] });
    await s.jobs.drain(later());
    expect(s.mailer.sent).toHaveLength(0);
    expect(await unread(bob)).toBe(1);
  });

  it("nothing reaches a linked user who isn't a member of the concert", async () => {
    const { anna, bob, ids, bobPerson, clear } = await setup({ bobMember: false });
    await clear();
    await anna.api.post("/api/photos/bulk-tag", { photoIds: ids, addPeople: [{ id: bobPerson.id }] });
    await s.jobs.drain(later());
    expect(s.mailer.sent).toHaveLength(0);
    expect(await unread(bob)).toBe(0);
    expect(await (await bob.api.get("/api/photos?me=1")).json()).toEqual([]);
  });

  it("the tagged user can remove their own tag but not the photo", async () => {
    const { anna, bob, ids, bobPerson } = await setup();
    await anna.api.post("/api/photos/bulk-tag", { photoIds: [ids[0]], addPeople: [{ id: bobPerson.id }] });
    expect(await (await bob.api.del(`/api/photos/${ids[0]}/people/me`)).json()).toEqual({ removed: 1 });
    expect(await (await bob.api.get("/api/photos?me=1")).json()).toEqual([]);
    expect((await bob.api.del(`/api/photos/${ids[0]}`)).status).toBe(403);
    const carl = await user(s, "carl@example.com");
    expect((await carl.api.del(`/api/photos/${ids[0]}/people/me`)).status).toBe(404);
  });
});

describe("other notifications", () => {
  it("members hear about new photos (grouped) and the inviter about accepted invites", async () => {
    const { anna, bob, c } = await setup();
    // Bob joined → Anna was notified.
    const annaN = await (await anna.api.get("/api/notifications")).json();
    expect(annaN.map((n: { type: string }) => n.type)).toContain("invite_accepted");
    // Anna uploaded 3 photos after Bob joined → one grouped notification for Bob.
    const bobN = await (await bob.api.get("/api/notifications")).json();
    const added = bobN.filter((n: { type: string }) => n.type === "photos_added");
    expect(added).toHaveLength(1);
    expect(added[0].payload).toMatchObject({ count: 3, concertId: c.id });

    expect((await bob.api.patch("/api/notifications", { all: true })).status).toBe(204);
    expect(await unread(bob)).toBe(0);
  });
});
