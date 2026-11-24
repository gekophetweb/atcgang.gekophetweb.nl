import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const ts = () => timestamp({ withTimezone: true });
const created = () => ts().notNull().defaultNow();
const updated = () =>
  ts()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// Better Auth tables (model names: user, session, account, verification)
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  role: text({ enum: ["user", "admin"] }).notNull().default("user"),
  emailNotifications: boolean().notNull().default(true),
  disabled: boolean().notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text().primaryKey(),
    expiresAt: ts().notNull(),
    token: text().notNull().unique(),
    ipAddress: text(),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index().on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text().primaryKey(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: ts(),
    refreshTokenExpiresAt: ts(),
    scope: text(),
    password: text(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index().on(t.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: ts().notNull(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index().on(t.identifier)],
);

// ---------------------------------------------------------------------------
// App tables
// ---------------------------------------------------------------------------

export const concertStatus = pgEnum("concert_status", ["planned", "attending", "attended", "cancelled", "skipped"]);
export const memberRole = pgEnum("member_role", ["owner", "editor", "viewer"]);

export const concerts = pgTable(
  "concerts",
  {
    id: uuid().primaryKey().defaultRandom(),
    ownerId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    artist: text().notNull(),
    title: text(),
    venue: text().notNull().default(""),
    city: text().notNull().default(""),
    country: text().notNull().default(""),
    startsAt: ts().notNull(),
    endsAt: ts(),
    status: concertStatus().notNull().default("planned"),
    ticketInfo: text(),
    setlistUrl: text(),
    notes: text().notNull().default(""),
    rating: integer(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index().on(t.startsAt),
    index().on(t.ownerId),
    check("rating_range", sql`${t.rating} is null or (${t.rating} between 1 and 5)`),
  ],
);

export const concertMembers = pgTable(
  "concert_members",
  {
    concertId: uuid()
      .notNull()
      .references(() => concerts.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole().notNull(),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.concertId, t.userId] }), index().on(t.userId)],
);

export const concertInvites = pgTable(
  "concert_invites",
  {
    id: uuid().primaryKey().defaultRandom(),
    concertId: uuid()
      .notNull()
      .references(() => concerts.id, { onDelete: "cascade" }),
    invitedBy: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** null for a share link that anyone with the token can accept */
    email: text(),
    role: memberRole().notNull().default("editor"),
    tokenHash: text().notNull().unique(),
    expiresAt: ts().notNull(),
    acceptedAt: ts(),
    acceptedBy: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
  },
  (t) => [index().on(t.concertId)],
);

export const people = pgTable(
  "people",
  {
    id: uuid().primaryKey().defaultRandom(),
    ownerId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text().notNull(),
    linkedUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
  },
  (t) => [index().on(t.ownerId), index().on(t.linkedUserId)],
);

export const concertPeople = pgTable(
  "concert_people",
  {
    concertId: uuid()
      .notNull()
      .references(() => concerts.id, { onDelete: "cascade" }),
    personId: uuid()
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.concertId, t.personId] })],
);

export const photos = pgTable(
  "photos",
  {
    id: uuid().primaryKey().defaultRandom(),
    concertId: uuid()
      .notNull()
      .references(() => concerts.id, { onDelete: "cascade" }),
    uploaderId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    storageKey: text().notNull(),
    width: integer(),
    height: integer(),
    bytes: bigint({ mode: "number" }).notNull(),
    mime: text().notNull(),
    takenAt: ts(),
    caption: text(),
    thumbsReady: boolean().notNull().default(false),
    createdAt: created(),
  },
  (t) => [index().on(t.concertId), index().on(t.uploaderId)],
);

export const labels = pgTable(
  "labels",
  {
    id: uuid().primaryKey().defaultRandom(),
    ownerId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text().notNull(),
    color: text().notNull().default("#f97316"),
  },
  (t) => [uniqueIndex().on(t.ownerId, t.name)],
);

export const photoLabels = pgTable(
  "photo_labels",
  {
    photoId: uuid()
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" }),
    labelId: uuid()
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.photoId, t.labelId] }), index().on(t.labelId)],
);

export const photoPeople = pgTable(
  "photo_people",
  {
    photoId: uuid()
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" }),
    personId: uuid()
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    taggedBy: text().references(() => users.id, { onDelete: "set null" }),
    x: real(),
    y: real(),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.photoId, t.personId] }), index().on(t.personId)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text().notNull(),
    payload: jsonb().notNull().$type<Record<string, unknown>>(),
    readAt: ts(),
    createdAt: created(),
  },
  (t) => [index().on(t.userId, t.createdAt)],
);

/** Pending tag-notification emails, grouped per (tagger, tagged user, concert) within a 15-minute window. */
export const tagEmailBatches = pgTable(
  "tag_email_batches",
  {
    id: uuid().primaryKey().defaultRandom(),
    taggerId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    concertId: uuid()
      .notNull()
      .references(() => concerts.id, { onDelete: "cascade" }),
    sendAfter: ts().notNull(),
    sentAt: ts(),
    createdAt: created(),
  },
  (t) => [index().on(t.userId, t.concertId, t.taggerId)],
);

