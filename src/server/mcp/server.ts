import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { HTTPException } from "hono/http-exception";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import type { Config } from "../config.js";
import { labels, people } from "../db/schema.js";
import {
  concertInput,
  createConcert,
  deleteConcert,
  getConcert,
  listConcerts,
  updateConcert,
} from "../domain/concerts.js";
import { listLabels, listPeople } from "../domain/people.js";
import { listPhotos } from "../domain/photos.js";
import { bulkTag } from "../domain/tagging.js";
import { concertStats } from "../domain/stats.js";
import { signPhotoUrl } from "../lib/signed-url.js";
import type { Storage } from "../lib/storage.js";
import type { AppNotifier } from "../domain/notifications.js";

export interface McpDeps {
  db: Db;
  config: Config;
  storage: Storage;
  notify: AppNotifier;
}

export interface McpUser {
  id: string;
  name: string;
}

const STATUS = z.enum(["planned", "attending", "attended", "cancelled", "skipped"]);
const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

/** Runs a tool body; access/validation errors become tool errors the model can read. */
async function run(fn: () => Promise<unknown>) {
  try {
    return json(await fn());
  } catch (e) {
    const msg = e instanceof HTTPException ? e.message : e instanceof z.ZodError ? z.prettifyError(e) : "Something went wrong";
    if (!(e instanceof HTTPException) && !(e instanceof z.ZodError)) console.error("[mcp]", e);
    return { isError: true, content: [{ type: "text" as const, text: msg }] };
  }
}

const brief = (c: Awaited<ReturnType<typeof listConcerts>>[number]) => ({
  id: c.id,
  artist: c.artist,
  title: c.title,
  venue: c.venue,
  city: c.city,
  country: c.country,
  startsAt: c.startsAt,
  status: c.status,
  rating: c.rating,
  myRole: c.myRole,
  photoCount: c.photoCount,
  people: c.people.map((p) => p.name),
  members: c.members.map((m) => m.name),
});

async function personIdByName(db: Db, userId: string, name: string) {
  const [p] = await db
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.ownerId, userId), sql`lower(${people.name}) = lower(${name.trim()})`));
  if (!p) throw new HTTPException(404, { message: `No person called "${name}" in your people list` });
  return p.id;
}
async function labelIdByName(db: Db, userId: string, name: string) {
  const [l] = await db
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.ownerId, userId), sql`lower(${labels.name}) = lower(${name.trim()})`));
  if (!l) throw new HTTPException(404, { message: `No label called "${name}"` });
  return l.id;
}

/** One MCP server instance per request, acting as `user` with the same access checks as the REST API. */
export function buildMcpServer(deps: McpDeps, user: McpUser) {
  const { db, config } = deps;
  const server = new McpServer(
    { name: "atcgang", title: "ATC Gang concerts", version: "1.0.0" },
    {
      instructions:
        "Concerts and concert photos of the signed-in ATC Gang user. Dates are ISO 8601. " +
        "Photo bytes are never returned; search_photos gives short-lived signed URLs.",
    },
  );
  const sign = (id: string, v: "thumb" | "large") => signPhotoUrl(config.BASE_URL, config.BETTER_AUTH_SECRET, id, v, 3600);

  server.registerTool(
    "list_concerts",
    {
      title: "List concerts",
      description: "Concerts the user owns or was invited to. Filter by date range, status, artist or person (name from their people list).",
      inputSchema: z.object({
        from: z.string().optional().describe("ISO date; concerts starting on/after"),
        to: z.string().optional().describe("ISO date; concerts starting before"),
        when: z.enum(["upcoming", "past"]).optional(),
        status: STATUS.optional(),
        artist: z.string().optional(),
        person: z.string().optional().describe("Name of someone who went"),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    (a) =>
      run(async () => {
        const person = a.person ? await personIdByName(db, user.id, a.person) : undefined;
        const list = await listConcerts(db, user.id, {
          from: a.from ? new Date(a.from) : undefined,
          to: a.to ? new Date(a.to) : undefined,
          when: a.when,
          status: a.status,
          artist: a.artist,
          person,
          limit: a.limit ?? 100,
        });
        return list.map(brief);
      }),
  );

  server.registerTool(
    "get_concert",
    {
      title: "Get concert",
      description: "Details of one concert: notes, people, members and a photo summary.",
      inputSchema: z.object({ id: z.string().uuid() }),
      annotations: { readOnlyHint: true },
    },
    (a) =>
      run(async () => {
        const c = await getConcert(db, user.id, a.id);
        const recent = await listPhotos(db, user.id, { concert: a.id, limit: 6 });
        return {
          ...brief(c),
          endsAt: c.endsAt,
          ticketInfo: c.ticketInfo,
          setlistUrl: c.setlistUrl,
          notes: c.notes,
          url: `${config.BASE_URL}/concerts/${c.id}`,
          photos: { count: c.photoCount, sample: recent.filter((p) => p.thumbsReady).map((p) => ({ id: p.id, thumbUrl: sign(p.id, "thumb") })) },
        };
      }),
  );

  server.registerTool(
    "add_concert",
    {
      title: "Add concert",
      description: "Adds a concert (private to the user until shared).",
      inputSchema: z.object({
        artist: z.string(),
        title: z.string().optional(),
        venue: z.string().optional(),
        city: z.string().optional(),
        country: z.string().optional(),
        startsAt: z.string().describe("ISO date-time"),
        endsAt: z.string().optional(),
        status: STATUS.optional(),
        ticketInfo: z.string().optional(),
        setlistUrl: z.string().optional(),
        notes: z.string().optional(),
        rating: z.number().int().min(1).max(5).optional(),
      }),
    },
    (a) => run(async () => brief({ ...(await createConcert(db, user, concertInput.parse(a))), myRole: "owner", photoCount: 0, members: [], people: [] })),
  );

  server.registerTool(
    "update_concert",
    {
      title: "Update concert",
      description: "Changes fields of a concert (needs editor access). Only the given fields change.",
      inputSchema: z.object({
        id: z.string().uuid(),
        artist: z.string().optional(),
        title: z.string().nullable().optional(),
        venue: z.string().optional(),
        city: z.string().optional(),
        country: z.string().optional(),
        startsAt: z.string().optional(),
        endsAt: z.string().nullable().optional(),
        status: STATUS.optional(),
        ticketInfo: z.string().nullable().optional(),
        setlistUrl: z.string().nullable().optional(),
        notes: z.string().optional(),
        rating: z.number().int().min(1).max(5).nullable().optional(),
      }),
    },
    ({ id, ...patch }) => run(async () => updateConcert(db, user.id, id, concertInput.partial().parse(patch))),
  );

  server.registerTool(
    "delete_concert",
    {
      title: "Delete concert",
      description: "Permanently deletes a concert and all its photos (owner only). Set confirm to true only after the user explicitly confirmed.",
      inputSchema: z.object({ id: z.string().uuid(), confirm: z.boolean() }),
      annotations: { destructiveHint: true },
    },
    (a) =>
      run(async () => {
        if (!a.confirm) throw new HTTPException(400, { message: "Not deleted: ask the user to confirm, then call again with confirm: true." });
        await deleteConcert(db, user.id, a.id);
        await deps.storage.deletePrefix(`photos/${a.id}/`);
        return { deleted: a.id };
      }),
  );

  server.registerTool(
    "search_photos",
    {
      title: "Search photos",
      description: "Finds photos by concert, label, person, date or 'photos of me'. Returns signed URLs valid for one hour.",
      inputSchema: z.object({
        concertId: z.string().uuid().optional(),
        label: z.string().optional().describe("Label name"),
        person: z.string().optional().describe("Person name from the user's people list"),
        me: z.boolean().optional().describe("Only photos the user is tagged in"),
        artist: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    (a) =>
      run(async () => {
        const list = await listPhotos(db, user.id, {
          concert: a.concertId,
          label: a.label ? await labelIdByName(db, user.id, a.label) : undefined,
          person: a.person ? await personIdByName(db, user.id, a.person) : undefined,
          me: a.me ?? false,
          artist: a.artist,
          from: a.from ? new Date(a.from) : undefined,
          to: a.to ? new Date(a.to) : undefined,
          limit: a.limit ?? 30,
        });
        return list.map((p) => ({
          id: p.id,
          concertId: p.concertId,
          concert: p.concert.artist,
          takenAt: p.takenAt,
          caption: p.caption,
          labels: p.labels.map((l) => l.name),
          people: p.people.map((x) => x.name),
          thumbUrl: p.thumbsReady ? sign(p.id, "thumb") : null,
          largeUrl: p.thumbsReady ? sign(p.id, "large") : null,
        }));
      }),
  );

  server.registerTool(
    "tag_photos",
    {
      title: "Tag photos",
      description: "Adds or removes labels and people (by name) on one or many photos. Unknown names are created.",
      inputSchema: z.object({
        photoIds: z.array(z.string().uuid()).min(1).max(500),
        addLabels: z.array(z.string()).optional(),
        removeLabels: z.array(z.string()).optional(),
        addPeople: z.array(z.string()).optional(),
        removePeople: z.array(z.string()).optional(),
      }),
    },
    (a) =>
      run(async () => {
        const res = await bulkTag(db, user.id, {
          photoIds: a.photoIds,
          addLabels: (a.addLabels ?? []).map((name) => ({ name })),
          removeLabels: await Promise.all((a.removeLabels ?? []).map((n) => labelIdByName(db, user.id, n))),
          addPeople: (a.addPeople ?? []).map((name) => ({ name })),
          removePeople: await Promise.all((a.removePeople ?? []).map((n) => personIdByName(db, user.id, n))),
        });
        await deps.notify.tagged(user, res.photoIds, res.newlyTaggedPeople);
        return { updated: res.photoIds.length };
      }),
  );

  server.registerTool(
    "list_people",
    { title: "List people", description: "The user's private list of people they go to concerts with.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    () => run(async () => (await listPeople(db, user.id)).map((p) => ({ id: p.id, name: p.name, hasAccount: !!p.linkedUserId, concerts: p.concertCount, photos: p.photoCount }))),
  );

  server.registerTool(
    "list_labels",
    { title: "List labels", description: "The user's photo labels.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    () => run(async () => (await listLabels(db, user.id)).map((l) => ({ id: l.id, name: l.name, photos: l.photoCount }))),
  );

  server.registerTool(
    "concert_stats",
    {
      title: "Concert stats",
      description: "Look-back numbers: concerts per year, most-seen artists, venues, who the user went with most, and 'on this day'.",
      inputSchema: z.object({ timeZone: z.string().optional() }),
      annotations: { readOnlyHint: true },
    },
    (a) => run(async () => concertStats(db, user.id, new Date(), a.timeZone ?? "Europe/Amsterdam")),
  );

  server.registerResource(
    "concert",
    new ResourceTemplate("concert://{id}", { list: undefined }),
    { title: "Concert", description: "A concert with notes and people", mimeType: "application/json" },
    async (uri, vars) => {
      const c = await getConcert(db, user.id, String(vars.id));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ ...brief(c), notes: c.notes, setlistUrl: c.setlistUrl }, null, 2) }] };
    },
  );

  return server;
}
