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



// ---------------------------------------------------------------------------
// Better Auth plugin tables (jwt, OAuth provider for MCP, CIMD) – generated from the plugins' schemas
// ---------------------------------------------------------------------------

export const jwks = pgTable("jwks", {
					id: text('id').primaryKey(),
					publicKey: text('public_key').notNull(),
 privateKey: text('private_key').notNull(),
 createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
 expiresAt: timestamp('expires_at', { withTimezone: true }),
 alg: text('alg'),
 crv: text('crv')
					});

export const oauthClient = pgTable("oauth_client", {
					id: text('id').primaryKey(),
					clientId: text('client_id').notNull().unique(),
 clientSecret: text('client_secret'),
 clientDiscoveryId: text('client_discovery_id'),
 disabled: boolean('disabled').default(false),
 skipConsent: boolean('skip_consent'),
 enableEndSession: boolean('enable_end_session'),
 subjectType: text('subject_type'),
 scopes: text('scopes').array(),
 clientCredentialsScopes: text('client_credentials_scopes').array().default([]),
 userId: text('user_id').references(()=> users.id, { onDelete: 'cascade' }),
 createdAt: timestamp('created_at', { withTimezone: true }),
 updatedAt: timestamp('updated_at', { withTimezone: true }),
 name: text('name'),
 uri: text('uri'),
 icon: text('icon'),
 contacts: text('contacts').array(),
 tos: text('tos'),
 policy: text('policy'),
 softwareId: text('software_id'),
 softwareVersion: text('software_version'),
 softwareStatement: text('software_statement'),
 redirectUris: text('redirect_uris').array().notNull(),
 postLogoutRedirectUris: text('post_logout_redirect_uris').array(),
 backchannelLogoutUri: text('backchannel_logout_uri'),
 backchannelLogoutSessionRequired: boolean('backchannel_logout_session_required'),
 tokenEndpointAuthMethod: text('token_endpoint_auth_method'),
 applicationType: text('application_type'),
 jwks: text('jwks'),
 jwksUri: text('jwks_uri'),
 grantTypes: text('grant_types').array(),
 responseTypes: text('response_types').array(),
 requirePKCE: boolean('require_pkce'),
 dpopBoundAccessTokens: boolean('dpop_bound_access_tokens').default(false),
 referenceId: text('reference_id'),
 metadata: jsonb('metadata')
					}, (table) => [
  index("oauthClient_userId_idx").on(table.userId),
]);

export const oauthResource = pgTable("oauth_resource", {
					id: text('id').primaryKey(),
					identifier: text('identifier').notNull().unique(),
 name: text('name').notNull(),
 accessTokenTtl: integer('access_token_ttl'),
 refreshTokenTtl: integer('refresh_token_ttl'),
 signingAlgorithm: text('signing_algorithm'),
 signingKeyId: text('signing_key_id'),
 allowedScopes: text('allowed_scopes').array(),
 customClaims: jsonb('custom_claims'),
 dpopBoundAccessTokensRequired: boolean('dpop_bound_access_tokens_required').default(false),
 disabled: boolean('disabled').default(false),
 createdAt: timestamp('created_at', { withTimezone: true }),
 updatedAt: timestamp('updated_at', { withTimezone: true }),
 policyVersion: integer('policy_version').default(1),
 metadata: jsonb('metadata')
					});

export const oauthClientResource = pgTable("oauth_client_resource", {
					id: text('id').primaryKey(),
					clientId: text('client_id').notNull().references(()=> oauthClient.clientId, { onDelete: 'cascade' }),
 resourceId: text('resource_id').notNull().references(()=> oauthResource.identifier, { onDelete: 'cascade' }),
 metadata: jsonb('metadata'),
 createdAt: timestamp('created_at', { withTimezone: true })
					}, (table) => [
  uniqueIndex("oauthClientResource_clientId_resourceId_uidx").on(table.clientId, table.resourceId),
  index("oauthClientResource_clientId_idx").on(table.clientId),
  index("oauthClientResource_resourceId_idx").on(table.resourceId),
]);

export const oauthRefreshToken = pgTable("oauth_refresh_token", {
					id: text('id').primaryKey(),
					token: text('token').notNull().unique(),
 clientId: text('client_id').notNull().references(()=> oauthClient.clientId, { onDelete: 'cascade' }),
 sessionId: text('session_id').references(()=> sessions.id, { onDelete: 'set null' }),
 userId: text('user_id').notNull().references(()=> users.id, { onDelete: 'cascade' }),
 referenceId: text('reference_id'),
 authorizationCodeId: text('authorization_code_id'),
 resources: text('resources').array(),
 requestedUserInfoClaims: text('requested_user_info_claims').array(),
 expiresAt: timestamp('expires_at', { withTimezone: true }),
 createdAt: timestamp('created_at', { withTimezone: true }),
 revoked: timestamp('revoked', { withTimezone: true }),
 rotatedAt: timestamp('rotated_at', { withTimezone: true }),
 rotationReplayResponse: text('rotation_replay_response'),
 rotationReplayExpiresAt: timestamp('rotation_replay_expires_at', { withTimezone: true }),
 authTime: timestamp('auth_time', { withTimezone: true }),
 confirmation: jsonb('confirmation'),
 scopes: text('scopes').array().notNull()
					}, (table) => [
  index("oauthRefreshToken_clientId_idx").on(table.clientId),
  index("oauthRefreshToken_sessionId_idx").on(table.sessionId),
  index("oauthRefreshToken_userId_idx").on(table.userId),
  index("oauthRefreshToken_authorizationCodeId_idx").on(table.authorizationCodeId),
]);

export const oauthAccessToken = pgTable("oauth_access_token", {
					id: text('id').primaryKey(),
					token: text('token').unique(),
 clientId: text('client_id').notNull().references(()=> oauthClient.clientId, { onDelete: 'cascade' }),
 sessionId: text('session_id').references(()=> sessions.id, { onDelete: 'set null' }),
 userId: text('user_id').references(()=> users.id, { onDelete: 'cascade' }),
 referenceId: text('reference_id'),
 authorizationCodeId: text('authorization_code_id'),
 resources: text('resources').array(),
 requestedUserInfoClaims: text('requested_user_info_claims').array(),
 refreshId: text('refresh_id').references(()=> oauthRefreshToken.id, { onDelete: 'cascade' }),
 expiresAt: timestamp('expires_at', { withTimezone: true }),
 createdAt: timestamp('created_at', { withTimezone: true }),
 revoked: timestamp('revoked', { withTimezone: true }),
 confirmation: jsonb('confirmation'),
 scopes: text('scopes').array().notNull()
					}, (table) => [
  index("oauthAccessToken_clientId_idx").on(table.clientId),
  index("oauthAccessToken_sessionId_idx").on(table.sessionId),
  index("oauthAccessToken_userId_idx").on(table.userId),
  index("oauthAccessToken_authorizationCodeId_idx").on(table.authorizationCodeId),
  index("oauthAccessToken_refreshId_idx").on(table.refreshId),
]);

export const oauthConsent = pgTable("oauth_consent", {
					id: text('id').primaryKey(),
					clientId: text('client_id').notNull().references(()=> oauthClient.clientId, { onDelete: 'cascade' }),
 userId: text('user_id').references(()=> users.id, { onDelete: 'cascade' }),
 referenceId: text('reference_id'),
 resources: text('resources').array(),
 requestedUserInfoClaims: text('requested_user_info_claims').array(),
 scopes: text('scopes').array().notNull(),
 createdAt: timestamp('created_at', { withTimezone: true }),
 updatedAt: timestamp('updated_at', { withTimezone: true })
					}, (table) => [
  index("oauthConsent_clientId_idx").on(table.clientId),
  index("oauthConsent_userId_idx").on(table.userId),
]);

export const oauthClientAssertion = pgTable("oauth_client_assertion", {
					id: text('id').primaryKey(),
					expiresAt: timestamp('expires_at', { withTimezone: true }).notNull()
					});
