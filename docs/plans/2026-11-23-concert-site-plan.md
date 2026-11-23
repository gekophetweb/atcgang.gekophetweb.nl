# Concert site – plan

**Site:** atcgang.gekophetweb.nl
**Date:** 2026-11-23
**Status:** Draft – open questions at the bottom need answers before Phase 1 starts.

## 1. What we're building

A web app where people:

- keep track of **upcoming concerts** (list view + calendar view)
- **look back** at concerts they went to
- **upload many photos** per concert at once
- **tag photos** with free labels ("encore", "crowd", "merch") and/or **people**
- sign in with **SSO** (Google / Microsoft / Apple) or **email + one-time login code**
- talk to their data from Claude or another AI client through an **MCP server**

### Non-goals (v1)

- Ticket buying, price tracking, or scraping ticket sites
- Public social network features (followers, likes, comments)
- Video uploads
- Native mobile apps (the site is responsive / installable as a PWA instead)

## 2. Technical choices (my calls – correct me)

| Area | Choice | Why |
|---|---|---|
| Hosting | **Cloudflare Workers** (static assets + API in one Worker) | Cheap/free at this scale, Cloudflare account is already connected, D1/R2 live next to it |
| Database | **Cloudflare D1** (SQLite) + **Drizzle ORM** | Relational data (concerts ↔ people ↔ photos ↔ tags), typed migrations |
| Photo storage | **Cloudflare R2** | No egress fees; direct browser upload via presigned URLs |
| Thumbnails | **Cloudflare Image Transformations** on R2 URLs (fallback: client-side resize before upload) | No thumbnail pipeline to maintain |
| Backend | **Hono** (TypeScript) | Small, Workers-native, good middleware |
| Frontend | **React + Vite + TanStack Router/Query + Tailwind** | SPA served by the same Worker |
| Calendar | **FullCalendar** (MIT core: dayGrid, list, interaction) | Mature month/week/list views |
| Auth | **Better Auth** with D1 – `emailOTP` plugin + Google/Microsoft/Apple providers | Email code + SSO in one library, sessions in D1 |
| Email | **Resend** (or Cloudflare Email Sending if enabled on the account) | Reliable transactional mail for login codes |
| MCP | Remote MCP server on the same Worker (`agents` `McpAgent`, Streamable HTTP) behind **`@cloudflare/workers-oauth-provider`** | Claude/other clients log in with the same account via OAuth; no API keys to copy around |
| Tests | Vitest + `@cloudflare/vitest-pool-workers`, Playwright for a few E2E flows | Runs against real D1/R2 bindings locally |

## 3. Data model

```
users            id, email, name, avatar_url, created_at
accounts/sessions/verifications   (Better Auth tables)

concerts         id, owner_id → users, artist, title?, venue, city, country,
                 starts_at, ends_at?, status (planned|attending|attended|cancelled|skipped),
                 ticket_info?, setlist_url?, notes, rating?, created_at, updated_at
concert_members  concert_id, user_id, role (owner|editor|viewer)      -- sharing a concert with friends

people           id, owner_id → users, name, linked_user_id? → users  -- "who was there", may or may not have an account
concert_people   concert_id, person_id                                -- who went with you

photos           id, concert_id, uploader_id, r2_key, width, height, bytes,
                 mime, taken_at? (from EXIF), caption?, created_at
labels           id, owner_id, name, color                            -- unique (owner_id, name)
photo_labels     photo_id, label_id
photo_people     photo_id, person_id, x?, y?                          -- optional face position for a tag pin
```

"Upcoming" vs "past" is derived from `starts_at` vs now; `status` captures intent and outcome.

## 4. Features per screen

**Sign in** – email field → "send code" → 6-digit code screen (10 min expiry, 5 attempts, rate-limited per IP + email). Buttons for Google / Microsoft / Apple. Same email via different methods = same account (verified-email linking).

**Concerts – list view** – tabs *Upcoming* / *Past*; grouped by month; search on artist/venue/city; filter by status, year, person. Each row: date, artist, venue/city, people avatars, photo count.

**Concerts – calendar view** – month / week / agenda (FullCalendar). Click a day to add a concert; drag to reschedule. Toggle between list and calendar remembered per user.

**Concert detail** – details, who went, notes, rating, setlist link, photo grid, upload drop-zone, "Add to calendar" (.ics download).

**Look back ("Memories")** – past concerts as a timeline by year, stats (concerts per year, most-seen artists, venues, who you went with most), "on this day" card.

**Photo upload** – drag & drop or pick many files (also from phone camera roll):
1. Client reads EXIF date/size, makes a preview, optionally downsizes > 4096 px.
2. `POST /api/concerts/:id/photos/uploads` → server returns one presigned R2 PUT URL per file.
3. Browser uploads in parallel (3–4 at a time) with per-file progress and retry.
4. `POST …/complete` registers the rows in D1.
Limits: JPEG/PNG/HEIC/WebP, 25 MB per file, server checks mime + size.

**Photo viewer & tagging** – lightbox with keyboard/swipe; side panel to add labels (autocomplete, create on the fly) and people (pick from people list or type a new name; optional click-on-photo pin). Bulk select in the grid → apply labels/people to many photos at once.

**Photo browse** – all photos across concerts, filter by label, person, artist, year.

**People & labels** – manage lists, merge duplicates, link a person to a registered user (then shared concerts show up for them).

**Settings** – profile, connected sign-in methods, MCP connections (list/revoke granted clients), export all data (JSON + photos zip).

## 5. API (REST, all under `/api`, session cookie)

```
GET/POST        /concerts                ?from&to&status&q&person
GET/PATCH/DELETE /concerts/:id
POST/DELETE     /concerts/:id/members
GET             /concerts/:id/ics
POST            /concerts/:id/photos/uploads     → presigned URLs
POST            /concerts/:id/photos/complete
GET             /photos                  ?concert&label&person
PATCH/DELETE    /photos/:id
POST            /photos/bulk-tag
GET/POST/PATCH/DELETE /labels, /people
GET             /stats
```

Every handler checks access through `concert_members` (one shared helper, tested).

## 6. MCP server

Endpoint `https://atcgang.gekophetweb.nl/mcp` (Streamable HTTP). OAuth 2.1 with dynamic client registration via `workers-oauth-provider`; the authorize step reuses the normal site login and shows a consent screen. Tools act as the signed-in user with the same access checks as the REST API.

| Tool | What it does |
|---|---|
| `list_concerts` | filter by date range, status, artist, person |
| `get_concert` | details + people + photo summary |
| `add_concert` / `update_concert` / `delete_concert` | manage dates (delete asks for confirmation flag) |
| `search_photos` | by concert, label, person, date; returns thumbnail URLs |
| `tag_photos` | add/remove labels and people on one or many photos |
| `list_people` / `list_labels` | lookups for the above |
| `concert_stats` | the "look back" numbers |
| `add_photo_from_url` | (stretch) import an image by URL |

Resources: `concert://{id}` for detail. Photo bytes are never streamed through MCP – only signed short-lived URLs.

## 7. Phases

**Phase 0 – Setup (½ day)**
Repo scaffold (pnpm, Vite, Hono, Wrangler), D1 database + R2 bucket, Drizzle migrations, CI (lint, typecheck, tests), deploy to a preview Worker, DNS for atcgang.gekophetweb.nl.

**Phase 1 – Auth (1–2 days)**
Better Auth on D1, email OTP via Resend, Google + Microsoft (Apple later – needs a paid developer account), sign-in pages, session middleware, rate limiting. *Done when:* both methods log into the same account and tests cover code expiry/attempt limits.

**Phase 2 – Concerts (2 days)**
Schema + CRUD API, list view with Upcoming/Past, search & filters, concert detail, people on a concert, .ics export.

**Phase 3 – Calendar (1 day)**
FullCalendar month/week/agenda, click-to-add, drag-to-reschedule, view toggle.

**Phase 4 – Photos (2–3 days)**
Presigned R2 uploads, multi-file drop-zone with progress/retry, EXIF date, thumbnails via image transformations, grid + lightbox, delete.

**Phase 5 – Tagging (2 days)**
Labels and people on photos, bulk tagging, optional position pins, photo browse page with filters.

**Phase 6 – Look back (1 day)**
Timeline by year, stats, "on this day".

**Phase 7 – MCP (1–2 days)**
OAuth provider, consent screen, tools above, connection list/revoke in settings; test with Claude and MCP Inspector.

**Phase 8 – Polish (1–2 days)**
Sharing concerts with friends, PWA manifest, data export, accessibility pass, Playwright E2E for login → add concert → upload → tag.

Rough total: **~3 weeks** (incl. open sign-up work) of focused work.

## 7a. Open sign-up (decided 2026-11-23)

Anyone can create an account. Consequences for the build:

- **Private by default.** A new concert is visible only to its owner. Sharing is explicit: the owner invites someone by email or share link, and they become a `concert_members` row. Nothing is ever public/indexable in v1.
- **Invites to non-users.** An invite email to an address without an account lets them sign up and lands them straight in the concert. New table: `concert_invites (id, concert_id, email, role, token_hash, expires_at, accepted_at)`.
- **People are per user.** Each user's `people` list is private. Tagging a person linked to another user only shows them the photo if they are a member of that concert.
- **Abuse protection** (added to Phase 1): Cloudflare Turnstile on "send login code", rate limits per IP and per email, disposable-email blocklist, max concerts/day for new accounts.
- **Storage quota** (added to Phase 4): default 2 GB of photos per user, shown in settings; upload API refuses past the quota. Photos count against the uploader.
- **Legal / GDPR** (added to Phase 8): privacy policy and terms pages, cookie notice limited to the essential session cookie, self-service **account deletion** (deletes D1 rows + R2 objects, owned shared concerts transfer to another member or get deleted), data export.
- **Admin**: a minimal admin page (role flag on `users`) to see sign-ups and storage use and to disable an account.

Estimate goes up by about 2–3 days.

## 8. Risks

- **Email deliverability** – login codes in spam kill the email login. Set SPF/DKIM/DMARC on the sending domain from day one.
- **HEIC from iPhones** – browsers can't show HEIC; convert client-side (heic2any) or via image transformations.
- **Privacy** – photos of friends: R2 bucket stays private, all image URLs signed and short-lived.
- **Apple SSO** needs an Apple Developer account (€99/yr) – can ship without it.

## 9. Open questions

1. ~~**Who uses it?**~~ **Decided: open sign-up** – see section 7a.
2. ~~**Shared or personal concerts?**~~ **Decided: one shared entry.** Friends at the same show are members of one concert and all add photos to it. Because concerts are private, two friends may each create the same show before inviting each other – so when an invite is accepted and the invitee already has a concert with the same artist on the same date, offer to **merge** them (photos, people, notes move into the shared one; the duplicate is deleted). Merge added to Phase 8.
3. **Tagged people** – should tagging a friend who has an account notify them or make the photo show up in their own view?
4. **Which SSO providers** do you actually want? (Plan: Google + Microsoft first, Apple optional.)
5. **Hosting** – OK with Cloudflare, or do you have an existing server/host for gekophetweb.nl?
