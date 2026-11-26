# Concert site – plan

**Site:** atcgang.gekophetweb.nl
**Date:** 2026-11-23
**Status:** Draft – all open questions answered; ready to turn into an implementation plan.

## 1. What we're building

A web app where people:

- keep track of **upcoming concerts** (list view + calendar view)
- **look back** at concerts they went to
- **upload many photos** per concert at once
- **tag photos** with free labels ("encore", "crowd", "merch") and/or **people**
- sign in with **SSO** (Google / Microsoft / Apple / GitHub) or **email + one-time login code**
- talk to their data from Claude or another AI client through an **MCP server**

### Non-goals (v1)

- Ticket buying, price tracking, or scraping ticket sites
- Public social network features (followers, likes, comments)
- Video uploads
- Native mobile apps (the site is responsive / installable as a PWA instead)

## 2. Technical choices (my calls – correct me)

| Area | Choice | Why |
|---|---|---|
| Hosting | **Self-hosted with Docker Compose**, published through a **Cloudflare Tunnel** | Decided – see section 2a |
| Website | **Node 22 + Hono** (`@hono/node-server`) serving the API, MCP endpoint and built React SPA – one `web` container | One image to build and deploy; Hono keeps the backend small |
| Database | **PostgreSQL 17** in its own `db` container + **Drizzle ORM** | Decided: DB separate from the website. Relational data, typed migrations, also hosts the job queue |
| Background jobs | **pg-boss** (queue in Postgres) | Thumbnails, batched emails, account deletion – no extra Redis container |
| Photo storage | **Docker volume** behind a small storage interface (`put/get/delete/stream`) | Simplest on one host; the interface lets us swap to S3/R2 later without touching features |
| Thumbnails | **sharp** in a pg-boss job: 400 px + 1600 px WebP per photo | No external image service needed |
| Frontend | **React + Vite + TanStack Router/Query + Tailwind** | SPA served by the `web` container |
| Calendar | **FullCalendar** (MIT core: dayGrid, list, interaction) | Mature month/week/list views |
| Auth | **Better Auth** on Postgres – `emailOTP` plugin + Google/Microsoft/Apple/GitHub providers | Email code + SSO in one library |
| Email | **Resend** | Reliable transactional mail for login codes and notifications |
| MCP | **`@modelcontextprotocol/sdk`** Streamable HTTP mounted in Hono at `/mcp`, OAuth via **Better Auth's MCP / OIDC-provider plugin** | Claude/other clients log in with the same account via OAuth; no API keys to copy around |
| Tests | Vitest against a throwaway Postgres container (Testcontainers), Playwright for a few E2E flows | Tests run against the real database |

## 2a. Docker, separate DB, Cloudflare Tunnel (decided 2026-11-23)

### Containers (`docker-compose.yml`)

```
                 Internet
                    │  https://atcgang.gekophetweb.nl
             Cloudflare edge (TLS, WAF, Turnstile)
                    │  outbound-only tunnel
┌───────────────────┼──────────── Docker host ─────────────────┐
│  cloudflared ─────┘                                           │
│      │  network: frontend                                     │
│      ▼                                                        │
│    web  (Node: Hono API + SPA + /mcp + pg-boss workers)       │
│      │  network: backend (internal: true)     volume: photos  │
│      ▼                                                        │
│    db   (PostgreSQL 17)                       volume: pgdata  │
│                                                               │
│    backup (pg_dump nightly + photo volume snapshot)           │
└───────────────────────────────────────────────────────────────┘
```

| Service | Image | Notes |
|---|---|---|
| `web` | own multi-stage `Dockerfile` (build with pnpm → `node:22-slim` runtime, non-root user) | Listens on `:3000` inside Docker only – **no published ports**. Runs migrations on start. Healthcheck on `/healthz`. |
| `db` | `postgres:17-alpine` | Only on the `backend` network (`internal: true`), so it can't reach or be reached from the internet. Credentials from `.env`. Volume `pgdata`. |
| `cloudflared` | `cloudflare/cloudflared` | `tunnel run` with `TUNNEL_TOKEN` from `.env`. Public hostname `atcgang.gekophetweb.nl` → `http://web:3000`. |
| `backup` | small cron image with **restic** | Nightly `pg_dump` + `photos` volume → encrypted, deduplicated restic repo **off-site** (Backblaze B2 or Cloudflare R2) plus a second copy on a local disk/NAS; keeps 14 daily + 4 weekly. |

The database being a separate service means it can later move to another machine or a managed Postgres by changing `DATABASE_URL` only.

### Files

```
Dockerfile                 multi-stage build for web
deploy/docker-compose.yml  production: web, db, cloudflared, backup
docker-compose.dev.yml     dev override of deploy/docker-compose.yml: Vite + tsx watch with hot reload, db port 5432 exposed to localhost, no tunnel
.env.example               DATABASE_URL, POSTGRES_*, TUNNEL_TOKEN, BETTER_AUTH_SECRET,
                           GOOGLE_*/MICROSOFT_*/APPLE_*/GITHUB_*, RESEND_API_KEY, TURNSTILE_*, PHOTO_DIR
.dockerignore
deploy/update.sh           crontab update script – see section 2b
deploy/update.conf.example
deploy/logrotate.conf
```

### What the tunnel changes in the app

- **Real client IP** comes from the `CF-Connecting-IP` header; trust it only because nothing reaches `web` except via `cloudflared`. Used for rate limiting and audit logs.
- **Upload size:** Cloudflare caps a request body at 100 MB (free plan). Photos upload **one file per request**, max 25 MB, so this is fine.
- **Caching:** Cloudflare cache rule: cache SPA static assets (hashed filenames); bypass `/api`, `/mcp`, `/photos`.
- **Long-lived MCP streams:** Streamable HTTP over the tunnel works; keep responses short or send keep-alives within Cloudflare's 100 s idle timeout.
- Cloudflare SSL mode **Full**; the tunnel itself is encrypted, `web` speaks plain HTTP inside Docker.

### Deploy

GitHub Actions on push to `main` (git-flow release/hotfix merges): build → test → push a multi-arch image (`linux/amd64` + `linux/arm64`) to **GHCR** tagged `:main` and `:<sha>`. `develop` builds and tests but doesn't publish `:main`.

GitHub can't reach the home server (and shouldn't), so deploys are **pull-based**: an update script on the host, run from **crontab** – see section 2b.

## 2b. Update script (`deploy/update.sh`, run from crontab)

A single Bash script on the home server that checks for a new release and deploys it safely. Safe to run every few minutes: it does nothing (and prints nothing) when there is no update.

### Install layout on the host

```
/opt/atcgang/                 sparse git checkout of `main`: deploy/ and backup/ (backup is built on the host)
  deploy/update.sh
  deploy/docker-compose.yml
  deploy/update.conf.example
  .env                        secrets (never in git)
  update.conf                 optional overrides (see below)
  state/                      last-good image digest, pre-update DB dumps
/var/log/atcgang/update.log   rotated weekly by logrotate (config shipped in deploy/)
```

`docker-compose.yml` references the web image as `${WEB_IMAGE:-ghcr.io/gekophetweb/atcgang.gekophetweb.nl:main}`, so the script can pin an exact digest for rollback. If the GHCR package is private, run `docker login ghcr.io` once with a read-only (`read:packages`) token.

### What one run does

1. **Lock** – `flock -n` on `/var/lock/atcgang-update.lock`; if another run is busy, exit quietly (exit 3).
2. **Update deploy files** – `git pull --ff-only` in `/opt/atcgang`. If `docker-compose.yml` changed, remember to re-apply all services in step 6.
3. **Check for a new image** – `docker compose pull web`, then compare the pulled image ID with the one the running `web` container uses. Same image and no compose change → exit 0, no output.
4. **Remember the current version** – save the running image's repo digest to `state/last-good`.
5. **Snapshot the database** – `pg_dump -Fc` via `docker compose exec -T db` into `state/pre-update-<timestamp>.dump`; keep the last 5. Abort the update if the dump fails.
6. **Deploy** – `docker compose up -d --no-deps web` (or `docker compose up -d` for everything if the compose file changed). The new container runs database migrations on start.
7. **Health check** – wait up to 120 s for the container healthcheck to be `healthy`, then `curl` `https://atcgang.gekophetweb.nl/healthz` through the tunnel to prove the whole path works.
8. **On failure, roll back** – start `web` again with `WEB_IMAGE=<last-good digest>` and re-check health. The database is **not** restored automatically (that would throw away anything users saved in the meantime); the dump from step 5 is there for a manual `update.sh --restore-db <file>`. Because of this, migrations follow the *expand → contract* rule: a release may only add columns/tables; removing old ones happens in a later release, so the previous image always still works with the new schema.
9. **Clean up** – `docker image prune -f --filter until=168h` (keeps the last-good image).
10. **Report** – one timestamped log line per step. Output only on a deploy or an error, so cron's `MAILTO` mails only when something happened. Optional `NOTIFY_URL` (ntfy / Discord / Slack webhook) gets a message on success and failure.

### Options

| Flag | Does |
|---|---|
| *(none)* | normal check-and-deploy, as above |
| `--force` | redeploy even if the image didn't change |
| `--dry-run` | show what would happen, change nothing |
| `--all` | also pull and restart `db` (same Postgres major only – the tag is pinned to `17`), `cloudflared` and `backup` |
| `--tag <sha>` | deploy a specific build instead of `:main` |
| `--rollback` | go back to `state/last-good` |
| `--restore-db <file>` | stop `web`, restore a dump, start `web` (asks for confirmation unless `--yes`) |

### Exit codes

`0` nothing to do or deployed fine · `1` deploy failed, rolled back OK · `2` deploy **and** rollback failed (site down – notify loudly) · `3` another run is busy · `4` config/precondition error (no Docker, no `.env`, git pull not fast-forward).

### `update.conf` (all optional)

```
WEB_IMAGE_REPO=ghcr.io/gekophetweb/atcgang.gekophetweb.nl
CHANNEL=main                 # image tag to follow
HEALTH_URL=https://atcgang.gekophetweb.nl/healthz
HEALTH_TIMEOUT=120
KEEP_DUMPS=5
NOTIFY_URL=
```

### Crontab

```
MAILTO=you@example.com
# check for a new release every 5 minutes
*/5 * * * *  /opt/atcgang/deploy/update.sh >> /var/log/atcgang/update.log 2>&1
# weekly: also update Postgres minor version, cloudflared and backup images (Sunday 04:30)
30 4 * * 0   /opt/atcgang/deploy/update.sh --all >> /var/log/atcgang/update.log 2>&1
```

(Run as a user in the `docker` group, not root. Cron has a minimal `PATH`, so the script sets its own `PATH` and `cd`s to its own folder.)

### Testing the script

`shellcheck` in CI, plus **bats** tests that run the script with stubbed `docker`, `git` and `curl` commands to cover: no update, normal deploy, failed health check → rollback, failed rollback, lock held, `--dry-run` changing nothing. Built in **Phase 0**, and exercised for real on the home server before Phase 1 starts.

## 3. Data model

```
users            id, email, name, avatar_url, role (user|admin), created_at
accounts/sessions/verifications   (Better Auth tables)

concerts         id, owner_id → users, artist, title?, venue, city, country,
                 starts_at, ends_at?, status (planned|attending|attended|cancelled|skipped),
                 ticket_info?, setlist_url?, notes, rating?, created_at, updated_at
concert_members  concert_id, user_id, role (owner|editor|viewer)      -- sharing a concert with friends
concert_invites  id, concert_id, email, role, token_hash, expires_at, accepted_at

people           id, owner_id → users, name, linked_user_id? → users  -- "who was there", may or may not have an account
concert_people   concert_id, person_id                                -- who went with you

photos           id, concert_id, uploader_id, storage_key, width, height, bytes,
                 mime, taken_at? (from EXIF), caption?, thumbs_ready, created_at
labels           id, owner_id, name, color                            -- unique (owner_id, name)
photo_labels     photo_id, label_id
photo_people     photo_id, person_id, x?, y?                          -- optional face position for a tag pin

notifications    id, user_id, type, payload_json, read_at, created_at
```

"Upcoming" vs "past" is derived from `starts_at` vs now; `status` captures intent and outcome.

## 4. Features per screen

**Sign in** – email field → "send code" → 6-digit code screen (10 min expiry, 5 attempts, rate-limited per IP + email). Buttons for Google / Microsoft / Apple / GitHub. Same email via different methods = same account (verified-email linking).

**Concerts – list view** – tabs *Upcoming* / *Past*; grouped by month; search on artist/venue/city; filter by status, year, person. Each row: date, artist, venue/city, people avatars, photo count.

**Concerts – calendar view** – month / week / agenda (FullCalendar). Click a day to add a concert; drag to reschedule. Toggle between list and calendar remembered per user.

**Concert detail** – details, who went, notes, rating, setlist link, photo grid, upload drop-zone, "Add to calendar" (.ics download).

**Look back ("Memories")** – past concerts as a timeline by year, stats (concerts per year, most-seen artists, venues, who you went with most), "on this day" card.

**Photo upload** – drag & drop or pick many files (also from phone camera roll):
1. Client reads EXIF date/size, makes a preview, converts HEIC → JPEG (heic2any), optionally downsizes > 4096 px.
2. Browser sends each file as its own `POST /api/concerts/:id/photos` (multipart, streamed to the photo volume), 3–4 in parallel, with per-file progress and retry.
3. Server checks mime (magic bytes, not just extension), size and quota, writes the row, and queues a thumbnail job.
4. Grid shows a placeholder until `thumbs_ready`.
Limits: JPEG/PNG/WebP (HEIC converted in the browser), 25 MB per file.

**Photo viewer & tagging** – lightbox with keyboard/swipe; side panel to add labels (autocomplete, create on the fly) and people (pick from people list or type a new name; optional click-on-photo pin). Bulk select in the grid → apply labels/people to many photos at once.

**Photo browse** – all photos across concerts, filter by label, person, artist, year. **"Photos of me"** page.

**People & labels** – manage lists, merge duplicates, link a person to a registered user (then shared concerts show up for them).

**Settings** – profile, connected sign-in methods, email notification toggle, storage used, MCP connections (list/revoke granted clients), export all data (JSON + photos zip), delete account.

## 5. API (REST, all under `/api`, session cookie)

```
GET/POST        /concerts                ?from&to&status&q&person
GET/PATCH/DELETE /concerts/:id
POST/DELETE     /concerts/:id/members
POST            /concerts/:id/invites
GET             /concerts/:id/ics
POST            /concerts/:id/photos     (multipart, one file)
GET             /photos                  ?concert&label&person&me
PATCH/DELETE    /photos/:id
POST            /photos/bulk-tag
DELETE          /photos/:id/people/me    (untag me)
GET/POST/PATCH/DELETE /labels, /people
GET/PATCH       /notifications
GET             /stats
```

Photo files are served from `GET /photos/:id/{thumb|large|original}` by the `web` container after the same access check, with `Cache-Control: private`. MCP and emails get **signed, short-lived URLs** to the same route.

Every handler checks access through `concert_members` (one shared helper, tested).

## 6. MCP server

Endpoint `https://atcgang.gekophetweb.nl/mcp` (Streamable HTTP, through the tunnel like the rest of the site). OAuth 2.1 with dynamic client registration via Better Auth's MCP plugin; the authorize step reuses the normal site login and shows a consent screen. Tools act as the signed-in user with the same access checks as the REST API.

| Tool | What it does |
|---|---|
| `list_concerts` | filter by date range, status, artist, person |
| `get_concert` | details + people + photo summary |
| `add_concert` / `update_concert` / `delete_concert` | manage dates (delete asks for confirmation flag) |
| `search_photos` | by concert, label, person, date; returns signed thumbnail URLs |
| `tag_photos` | add/remove labels and people on one or many photos |
| `list_people` / `list_labels` | lookups for the above |
| `concert_stats` | the "look back" numbers |
| `add_photo_from_url` | (stretch) import an image by URL |

Resources: `concert://{id}` for detail. Photo bytes are never streamed through MCP – only signed short-lived URLs.

## 7. Phases

**Phase 0 – Setup (1½ days)**
Repo scaffold (pnpm, Vite, Hono, Drizzle), `Dockerfile`, `docker-compose.yml` + dev override, `.env.example`, Postgres migrations on start, `/healthz`. Create the Cloudflare Tunnel and route atcgang.gekophetweb.nl to `web:3000`. CI: lint, typecheck, tests, shellcheck + bats, build image → GHCR. `deploy/update.sh` + crontab on the home server (section 2b). *Done when:* the home server serves a "hello" page at the real domain, the DB port is not reachable from outside Docker, and a push to `main` reaches the site through the cron update – including one deliberately broken release that rolls back on its own.

**Phase 1 – Auth (2 days)**
Better Auth on Postgres, email OTP via Resend, Google + Microsoft + Apple + GitHub (see question 4), linking extra sign-in methods in Settings, sign-in pages, session middleware, Turnstile + rate limiting on `CF-Connecting-IP`. *Done when:* email code and each SSO provider log into the same account (same verified email) and tests cover code expiry/attempt limits.

**Phase 2 – Concerts (2 days)**
Schema + CRUD API, list view with Upcoming/Past, search & filters, concert detail, people on a concert, invites, .ics export.

**Phase 3 – Calendar (1 day)**
FullCalendar month/week/agenda, click-to-add, drag-to-reschedule, view toggle.

**Phase 4 – Photos (3 days)**
Storage interface + volume driver, streamed uploads, multi-file drop-zone with progress/retry, HEIC conversion, EXIF date, pg-boss + sharp thumbnails, authorised photo serving, grid + lightbox, delete, quota.

**Phase 5 – Tagging & notifications (3 days)**
Labels and people on photos, bulk tagging, optional position pins, photo browse + "Photos of me", untag me, notifications (in-app + batched email via pg-boss).

**Phase 6 – Look back (1 day)**
Timeline by year, stats, "on this day".

**Phase 7 – MCP (1–2 days)**
OAuth via Better Auth MCP plugin, consent screen, tools above, connection list/revoke in settings; test with Claude and MCP Inspector through the tunnel.

**Phase 8 – Polish & ops (2–3 days)**
Concert merge, PWA manifest, data export, account deletion, privacy/terms pages, admin page, accessibility pass, `backup` container + a tested restore, Playwright E2E for login → add concert → upload → tag.

Rough total: **~3½ weeks** of focused work.

## 7a. Open sign-up (decided 2026-11-23)

Anyone can create an account. Consequences for the build:

- **Private by default.** A new concert is visible only to its owner. Sharing is explicit: the owner invites someone by email or share link, and they become a `concert_members` row. Nothing is ever public/indexable in v1.
- **Invites to non-users.** An invite email to an address without an account lets them sign up and lands them straight in the concert (`concert_invites`).
- **People are per user.** Each user's `people` list is private. Tagging a person linked to another user only shows them the photo if they are a member of that concert.
- **Abuse protection** (Phase 1): Cloudflare Turnstile on "send login code", rate limits per IP and per email, disposable-email blocklist, max concerts/day for new accounts.
- **Storage quota** (Phase 4): default 2 GB of photos per user, shown in settings; upload API refuses past the quota. Photos count against the uploader. Watch total disk use on the host – the admin page shows it.
- **Legal / GDPR** (Phase 8): privacy policy and terms pages, cookie notice limited to the essential session cookie, self-service **account deletion** (deletes DB rows + photo files, owned shared concerts transfer to another member or get deleted), data export. Backups older than 14 days roll off, so deleted data is gone from backups within 14 days – state this in the privacy policy.
- **Admin**: a minimal admin page (`users.role = admin`) to see sign-ups, storage and disk use, and to disable an account.

## 8. Risks

- **Single home server** – power cuts, internet outages and reboots take the site down, and photos live on its disk. Mitigation: all services `restart: unless-stopped` and Docker enabled at boot, a UPS if possible, a Cloudflare custom error page for when the tunnel is down, nightly off-site backups with a tested restore; the storage interface allows moving photos to S3/R2 later.
- **Home upload bandwidth** – every photo view is served from home through the tunnel. Mitigation: grids load only the 400 px WebP thumbnails, lazy-loaded; the 1600 px version opens in the lightbox; originals only on explicit download. Photos are private so Cloudflare can't cache them for everyone, but `Cache-Control: private, max-age=86400` lets each browser keep them.
- **Disk space** – open sign-up + photos can fill the disk. Mitigation: per-user quota, admin disk view, alert at 80 %.
- **Email deliverability** – login codes in spam kill the email login. Set SPF/DKIM/DMARC on the sending domain from day one.
- **HEIC from iPhones** – browsers can't show HEIC and prebuilt sharp can't decode it; convert in the browser before upload.
- **Privacy** – photos of friends: photo volume is never exposed directly, every photo request goes through an access check, URLs given to MCP/email are signed and short-lived.
- **Tunnel token** – anyone with `TUNNEL_TOKEN` can serve the domain. Keep it only in `.env` on the host (never committed); rotate if leaked.
- **Apple SSO** – €99/yr developer account, client-secret JWT that expires every 6 months, and private-relay emails; handled as described in question 4.

## 9. Open questions

1. ~~**Who uses it?**~~ **Decided: open sign-up** – see section 7a.
2. ~~**Shared or personal concerts?**~~ **Decided: one shared entry.** Friends at the same show are members of one concert and all add photos to it. Because concerts are private, two friends may each create the same show before inviting each other – so when an invite is accepted and the invitee already has a concert with the same artist on the same date, offer to **merge** them (photos, people, notes move into the shared one; the duplicate is deleted). Merge is in Phase 8.
3. ~~**Tagged people**~~ **Decided: notify and show it.** When a photo is tagged with a person linked to a registered user who is a member of that concert:
   - the photo appears on their **"Photos of me"** page (query over `photo_people` → `people.linked_user_id`, filtered by concert membership);
   - they get an **in-app notification** (bell icon, unread count) in `notifications`;
   - they get an **email**, batched: tags within the same 15 minutes are grouped into one mail ("Anna tagged you in 12 photos from Foo Fighters, Ziggo Dome"), sent by a delayed pg-boss job so bulk tagging never sends a flood;
   - a **settings toggle** per user for email notifications (default on; in-app always on);
   - the tagged user can **remove their own tag** (untag me), but not the photo.
   Untagging before the batch is sent cancels that email. Same notification system is reused for concert invites accepted and new photos in a shared concert (in-app only). In Phase 5.
4. ~~**Which SSO providers**~~ **Decided: Google, Microsoft, Apple and GitHub**, all in Phase 1 (+½ day). Notes for the build:
   - **Google:** OAuth client in Google Cloud Console; consent screen must be published (not "testing") for open sign-up.
   - **Microsoft:** Entra ID app registration with tenant `common` so both personal (outlook/hotmail) and work/school accounts work.
   - **Apple:** needs the Apple Developer Program (€99/yr), an App ID + Services ID with the domain and return URL verified, and a `.p8` key. Apple's client secret is a JWT that **expires after at most 6 months** – generate it from the key at startup instead of storing a fixed secret, so it never silently expires.
   - **Apple "Hide My Email":** users may sign in with a `@privaterelay.appleid.com` address. That won't match their real email, so it creates a separate account instead of linking – allow linking extra sign-in methods from Settings while logged in. To deliver login codes and notifications to relay addresses, register the Resend sending domain under *Sign in with Apple for Email Communication* in the Apple developer account.
   - **GitHub:** a GitHub **OAuth App** (not a GitHub App) with scope `user:email`. Many GitHub users keep their email private, so fetch `/user/emails` and use the **primary verified** address; refuse sign-in if there is none. An OAuth App allows only one callback URL, so use separate apps for production and dev.
   - **Apple sends the user's name only on the first sign-in** – store it then.
   - Apple's callback is a cross-site **POST**; the OAuth state cookie needs `SameSite=None; Secure` (Better Auth handles this – cover it in an E2E test).
   - Callback URLs for all four: `https://atcgang.gekophetweb.nl/api/auth/callback/{google|microsoft|apple|github}`; dev uses separate OAuth clients pointing at `localhost` (Apple doesn't allow `localhost` – test Apple through a dev tunnel hostname).
5. ~~**Hosting**~~ **Decided: Docker + separate DB container + Cloudflare Tunnel** – see section 2a.
6. ~~**Docker host**~~ **Decided: home server.** No port forwarding – the Cloudflare Tunnel is the only way in, and the home IP stays hidden. Images are built for amd64 and arm64 so the CPU type doesn't matter. Pull-based deploys (section 2a), off-site restic backups, and the outage/bandwidth measures in section 8 follow from this. Photos and Postgres data go on a disk with room to grow; the admin page alerts at 80 % full.
