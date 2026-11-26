# atcgang.gekophetweb.nl

Keep track of upcoming concerts, look back at the ones you went to, upload and tag photos, and talk to it all from Claude over MCP.
Design and decisions: [docs/plans/2026-11-23-concert-site-plan.md](docs/plans/2026-11-23-concert-site-plan.md).

**Stack:** Node 22 + Hono (API, MCP, SPA) · PostgreSQL 17 + Drizzle · pg-boss jobs · sharp thumbnails · React + Vite + TanStack Router/Query + Tailwind · FullCalendar · Better Auth (email codes, Google/Microsoft/Apple/GitHub, OAuth for MCP) · Docker Compose + Cloudflare Tunnel.

**Contents**

1. [Develop locally](#develop-locally)
2. [Setup manual: the home server](#setup-manual-the-home-server)
3. [Mail](#mail)
4. [SSO: step by step per provider](#sso-step-by-step-per-provider)
5. [Backups and restore](#backups-and-restore)
6. [Deploys](#deploys)
7. [MCP](#mcp)
8. [Configuration reference](#configuration-reference)
9. [Troubleshooting](#troubleshooting)

---

## Develop locally

Needs Node 22+, Docker Desktop, and pnpm through Corepack:

```powershell
npm i -g corepack@latest
corepack enable
pnpm install
```

| Command | What it does |
| --- | --- |
| `pnpm dev` | Docker Compose dev stack: Vite on http://localhost:5173, API on :3000, Postgres on 127.0.0.1:5432 |
| `pnpm test` | API tests against a throwaway Postgres container (Docker must be running) |
| `pnpm build` then `pnpm test:e2e` | Playwright: log in → add concert → upload → tag, on desktop and mobile |
| `pnpm lint` / `pnpm typecheck` | ESLint / TypeScript |
| `pnpm db:generate` | New Drizzle migration after editing `src/server/db/schema.ts` |

Without a mail provider the login codes are printed in the `web` container log (`docker compose logs -f web`). The first account you create locally is admin.

---

## Setup manual: the home server

What you end up with: four containers on the home server (`web`, `db`, `cloudflared`, `backup`). Nothing listens on a host port. Visitors reach the site through a Cloudflare Tunnel, and the database is only on an internal Docker network.

### What you need before you start

- A Linux machine with Docker Engine and the Compose plugin (`docker compose version` works), amd64 or arm64.
- The `gekophetweb.nl` zone on Cloudflare (free plan is enough).
- A GitHub account with read access to this repository (for pulling the image from GHCR).
- An off-site place for backups: a Cloudflare R2 bucket or a Backblaze B2 bucket.
- Optional but recommended: a mail provider account (Resend, Mailgun, or any SMTP server). Without it, nobody receives login codes except via the server log.

### Step 1: Put the files on the server

```bash
sudo mkdir -p /opt/atcgang && sudo chown $USER /opt/atcgang
git clone --branch main --filter=blob:none --sparse https://github.com/gekophetweb/atcgang.gekophetweb.nl.git /opt/atcgang
cd /opt/atcgang
git sparse-checkout set deploy backup
cp .env.example .env
chmod 600 .env
```

This is a sparse checkout of `main`: only `deploy/` (compose file and update script), `backup/` and the top-level files. The app itself arrives as a Docker image. `.env` sets `COMPOSE_FILE=deploy/docker-compose.yml`, so every `docker compose ...` command in this manual works from `/opt/atcgang`.

### Step 2: Fill in the basics in `.env`

```bash
openssl rand -base64 32   # → BETTER_AUTH_SECRET
openssl rand -base64 24   # → POSTGRES_PASSWORD
openssl rand -base64 24   # → RESTIC_PASSWORD
```

Set at least:

| Variable | Value |
| --- | --- |
| `BASE_URL` | `https://atcgang.gekophetweb.nl` |
| `POSTGRES_PASSWORD` | the generated password (and leave `DATABASE_URL` alone: compose builds its own) |
| `BETTER_AUTH_SECRET` | the generated secret. **Keep a copy in your password manager.** Sessions, signed photo links and the encrypted mail/SSO secrets in the database depend on it; if you change it, everyone is signed out and you must re-enter the secrets in Admin. |
| `ADMIN_EMAILS` | optional: comma-separated emails that are always admin (on top of "first account is admin") |

Store `RESTIC_PASSWORD` in your password manager too: without it the backups cannot be read.

### Step 3: Cloudflare Tunnel

1. Cloudflare dashboard → **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel** → **Cloudflared**.
2. Name it `atcgang`. On the "Install connector" screen choose **Docker**, and copy only the token (the long string after `--token`). Put it in `.env` as `TUNNEL_TOKEN`. You do not run the command shown; compose runs cloudflared for you.
3. **Public hostname** tab → **Add a public hostname**:
   - Subdomain `atcgang`, domain `gekophetweb.nl`, path empty.
   - Service type `HTTP`, URL `web:3000`.
4. Cloudflare dashboard → `gekophetweb.nl` → **SSL/TLS** → **Overview**: mode **Full**.
5. **Caching** → **Cache Rules** → create two rules:
   - *Bypass*: hostname is `atcgang.gekophetweb.nl` and URI path starts with `/api`, `/mcp`, `/photos` or `/.well-known` → **Bypass cache**.
   - *Assets*: hostname is `atcgang.gekophetweb.nl` and URI path starts with `/assets/` → **Eligible for cache** (the files have hashed names, so they can be cached forever).

### Step 4: Turnstile (bot protection on the login form)

1. Cloudflare dashboard → **Turnstile** → **Add widget**.
2. Name `atcgang`, hostname `atcgang.gekophetweb.nl`, mode **Managed**.
3. Copy the site key and the secret key into `.env` as `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`.

Leave both empty to switch Turnstile off (fine for development, not for the public site).

### Step 5: Allow the server to pull the image

The CI workflow publishes `ghcr.io/gekophetweb/atcgang.gekophetweb.nl:main` on every push to `main`. If the package is private:

1. GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token**, scope `read:packages` only, no expiry or a long one.
2. On the server: `echo <token> | docker login ghcr.io -u <github-username> --password-stdin`

Nothing has been published until `develop` is merged into `main` once. To start without CI, build locally on the server instead: `git sparse-checkout disable` (gets the source), then `docker compose build web`.

### Step 6: Start it

```bash
cd /opt/atcgang
docker compose up -d
docker compose ps            # all services "running", web "healthy"
docker compose logs -f web   # "listening on :3000", migrations applied
```

Database migrations run automatically every time `web` starts.

### Step 7: Become admin

Open https://atcgang.gekophetweb.nl and sign in with your email. **The first account ever created becomes admin.** If no mail provider is configured yet, get the code from `docker compose logs web`.

As admin you see **Admin** in the menu, with:

- **Users**: everyone who has an account, when they joined, their concerts, photos and storage use; disable an account or make someone admin. Totals for users, sign-ups in the last 7 days and photo storage are above the table.
- **Mail & SSO**: the mail provider and the sign-in providers (next two sections).
- Disk usage of the photo volume; admins get an email each morning when it is over `DISK_ALERT_PERCENT` (default 80%).

### Step 8: Mail, SSO, backups, deploys

Continue with [Mail](#mail), then [SSO](#sso-step-by-step-per-provider) for each provider you want, then check [backups](#backups-and-restore) and enable [deploys](#deploys).

---

## Mail

Mail is used for login codes, "you were tagged" emails (batched per 15 minutes) and the admin disk alert. Configure it in **Admin → Mail & SSO → Mail**. Changes apply immediately, with no restart. Use **Send test email** to check: it mails you (the signed-in admin).

Before saving anything in Admin, the `RESEND_API_KEY` and `MAIL_FROM` values in `.env` are used. Once saved in Admin, the database wins and `.env` is ignored for mail.

The **From** address must be on a domain you have verified with the provider, for example `ATC Gang <noreply@gekophetweb.nl>`.

### Resend

1. https://resend.com → sign up → **Domains** → **Add domain** → `gekophetweb.nl` (or a subdomain like `mail.gekophetweb.nl`), region EU.
2. Add the DNS records Resend shows (DKIM, SPF via MX/TXT on `send.`) in Cloudflare DNS. Set them to **DNS only** (grey cloud). Wait until Resend shows *Verified*.
3. **API keys** → **Create API key**, permission *Sending access*, domain `gekophetweb.nl`.
4. Admin → Mail: provider **Resend**, paste the key, set From, **Save**, **Send test email**.

### Mailgun

1. https://mailgun.com → sign up → choose the **EU** region if you want data in the EU (it cannot be changed later per domain).
2. **Sending** → **Domains** → **Add new domain** → e.g. `mg.gekophetweb.nl`.
3. Add the TXT (SPF, DKIM) and MX records in Cloudflare DNS (grey cloud), then **Verify DNS settings**.
4. **API Security** (or the domain's **Sending keys**) → create a sending API key.
5. Admin → Mail: provider **Mailgun**, API key, domain `mg.gekophetweb.nl`, region **EU** or **US** matching step 1, From `ATC Gang <noreply@mg.gekophetweb.nl>`, **Save**, **Send test email**.

### SMTP (any other provider)

Admin → Mail: provider **SMTP**, then host, port and credentials from your provider. Port 587 with *Secure* off (STARTTLS) or port 465 with *Secure* on.

### Deliverability

Add a DMARC record if you don't have one: TXT `_dmarc.gekophetweb.nl` → `v=DMARC1; p=none; rua=mailto:you@yourdomain`. Without SPF, DKIM and DMARC, Gmail and Outlook may put login codes in spam.

---

## SSO: step by step per provider

All four providers follow the same pattern:

1. Register an app with the provider and give it this site's **callback URL**.
2. Copy the IDs and secrets into **Admin → Mail & SSO → Sign-in with SSO**, tick the checkbox next to the provider's name, **Save**.
3. Sign out, and check the new button on the login page.

The admin page shows the exact callback URL for each provider. For the live site they are:

| Provider | Callback URL |
| --- | --- |
| Google | `https://atcgang.gekophetweb.nl/api/auth/callback/google` |
| Microsoft | `https://atcgang.gekophetweb.nl/api/auth/callback/microsoft` |
| Apple | `https://atcgang.gekophetweb.nl/api/auth/callback/apple` |
| GitHub | `https://atcgang.gekophetweb.nl/api/auth/callback/github` |

How it behaves:

- A provider only appears on the login page when it is ticked **and** all its fields are filled in. The admin page shows *active* when that is the case, and *incomplete* when it is ticked but a field is missing.
- Secrets are stored encrypted. The admin page never shows them again; the field says *saved – leave empty to keep*.
- Changes apply without a restart. Existing sessions stay signed in.
- **Accounts are matched by email.** Someone who signed in with an email code and later uses Google, Microsoft or Apple with the same verified address lands in the same account. GitHub is not trusted for this automatic linking (GitHub emails are not always verified), so a GitHub sign-in with an email that already has an account is refused; the user signs in another way first.
- Instead of the admin page, you can also set the `GOOGLE_*`, `MICROSOFT_*`, `APPLE_*` and `GITHUB_*` variables in `.env`. They are used until SSO settings are saved in Admin once; after that the database wins.
- For local development, register separate apps (or add a second redirect URI) with `http://localhost:5173/api/auth/callback/<provider>`.

### Google

Cost: free. Time: about 10 minutes.

1. Go to https://console.cloud.google.com and create a project (top bar → project picker → **New project**), name `atcgang`.
2. Menu → **Google Auth Platform** (formerly "OAuth consent screen") → **Get started**:
   - **App information:** app name `ATC Gang`, user support email: yours.
   - **Audience:** **External**.
   - **Contact information:** your email. Agree and **Create**.
3. **Branding** (left menu):
   - App home page `https://atcgang.gekophetweb.nl`, privacy policy `https://atcgang.gekophetweb.nl/privacy`, terms `https://atcgang.gekophetweb.nl/terms`.
   - **Authorized domains:** add `gekophetweb.nl`. Save.
4. **Data access** → **Add or remove scopes** → tick `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`. These are non-sensitive, so Google does not need to review the app. Save.
5. **Audience** → **Publish app** → confirm. The status must be **In production**. In *Testing* mode only listed test users can sign in, and their sign-ins expire after 7 days.
6. **Clients** → **Create client**:
   - Application type **Web application**, name `atcgang web`.
   - **Authorized JavaScript origins:** `https://atcgang.gekophetweb.nl`
   - **Authorized redirect URIs:** `https://atcgang.gekophetweb.nl/api/auth/callback/google`
   - **Create**.
7. Copy the **Client ID** and **Client secret** right away. Google shows the secret only once; download the JSON if you want a copy.
8. Admin → Sign-in with SSO → **Google**: paste both, tick the Google checkbox, **Save**.
9. Test: sign out → **Continue with Google**.

### Microsoft (personal accounts and work/school accounts)

Cost: free (a free Microsoft account is enough to get an Entra tenant). Time: about 10 minutes.

1. Go to https://entra.microsoft.com (sign in with any Microsoft account) → **Identity** → **Applications** → **App registrations** → **New registration**.
2. Fill in:
   - Name: `ATC Gang`.
   - **Supported account types:** *Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)*. Any other choice locks out either personal or work accounts; the app signs in against the `common` tenant.
   - **Redirect URI:** platform **Web**, `https://atcgang.gekophetweb.nl/api/auth/callback/microsoft`.
   - **Register**.
3. On the **Overview** page copy the **Application (client) ID**.
4. **Certificates & secrets** → **Client secrets** → **New client secret**:
   - Description `atcgang`, expiry: the longest offered (24 months).
   - Copy the **Value** column right away; it is shown once. (Not the *Secret ID*: that one doesn't work.)
   - **Put a reminder in your calendar** a few weeks before it expires. When it expires, Microsoft sign-in stops working until you create a new secret and paste it in Admin.
5. **API permissions:** the default *Microsoft Graph → User.Read* is enough. `openid`, `email` and `profile` are requested at sign-in. Do not add more.
6. Optional, removes the "unverified" label on the consent screen: **Branding & properties** → set the publisher domain to `gekophetweb.nl` (verify it via a DNS TXT record), and fill in the home page, privacy and terms URLs.
7. Admin → Sign-in with SSO → **Microsoft**: paste the client ID and the secret value, tick the Microsoft checkbox, **Save**.
8. Test: sign out → **Continue with Microsoft**, once with a personal account (outlook.com/hotmail) and once with a work account if you have one. A work account in an organization that blocks user consent shows "Need admin approval"; that organization's admin has to approve the app, nothing you can fix on this side.

### Apple

Cost: a paid **Apple Developer Program** membership (€99 per year). Time: about 20 minutes, plus waiting for the membership to be approved.

Apple needs four values: a **Services ID** (the client ID), your **Team ID**, a **Key ID** and the **private key** (`.p8` file). The site turns the key into Apple's client secret by itself and renews it daily, so the usual "Apple secret expires every 6 months" problem doesn't apply.

1. **Team ID:** https://developer.apple.com/account → **Membership details** → copy the 10-character **Team ID**.
2. **App ID** (Apple requires one, even for a website):
   - **Certificates, Identifiers & Profiles** → **Identifiers** → **+** → **App IDs** → **Continue** → type **App** → **Continue**.
   - Description `ATC Gang`, Bundle ID **Explicit**: `nl.gekophetweb.atcgang`.
   - Under **Capabilities**, tick **Sign in with Apple**. **Continue** → **Register**.
3. **Services ID** (this becomes the client ID):
   - **Identifiers** → **+** → **Services IDs** → **Continue**.
   - Description `ATC Gang web` (users see this on Apple's sign-in screen), Identifier `nl.gekophetweb.atcgang.web`. **Continue** → **Register**.
   - Open the new Services ID → tick **Sign in with Apple** → **Configure**:
     - Primary App ID: `nl.gekophetweb.atcgang`.
     - **Domains and Subdomains:** `atcgang.gekophetweb.nl` (no `https://`).
     - **Return URLs:** `https://atcgang.gekophetweb.nl/api/auth/callback/apple`.
     - **Next** → **Done** → **Continue** → **Save**.
4. **Key:**
   - **Keys** → **+** → name `atcgang sign in`, tick **Sign in with Apple** → **Configure** → primary App ID `nl.gekophetweb.atcgang` → **Save** → **Continue** → **Register**.
   - **Download** the `.p8` file. Apple lets you download it **only once**; keep it in your password manager.
   - Copy the **Key ID** (10 characters) shown on the same page.
5. **Email relay** (needed so "Hide My Email" users receive login codes and tag emails):
   - **Certificates, Identifiers & Profiles** → **Services** → **Sign in with Apple for Email Communication** → **Configure** → **+**.
   - Add your mail sending domain (e.g. `gekophetweb.nl` or `mg.gekophetweb.nl`) and/or the exact From address (`noreply@gekophetweb.nl`).
   - Apple checks that the domain has SPF set up (the mail provider's DNS records from the [Mail](#mail) section). Wait until it shows a green check.
6. Admin → Sign-in with SSO → **Apple**:
   - Services ID: `nl.gekophetweb.atcgang.web` (not the App ID).
   - Team ID, Key ID.
   - Private key: open the `.p8` file in a text editor and paste all of it, including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines.
   - Tick **Apple**, **Save**. If the key can't be read, the Apple button does not appear on the login page; paste the key again.
7. Test: sign out → **Continue with Apple**. Apple only works on the real `https` domain; it does not accept `localhost` return URLs. Apple sends the user's name only on the very first sign-in; if it is missing, the user can set it in Settings.

### GitHub

Cost: free. Time: about 5 minutes.

1. GitHub → your avatar → **Settings** → **Developer settings** → **OAuth Apps** → **New OAuth App**. (An *OAuth App*, not a *GitHub App*.) To own it as an organization instead: the organization's **Settings** → **Developer settings** → **OAuth Apps**.
2. Fill in:
   - Application name `ATC Gang`.
   - Homepage URL `https://atcgang.gekophetweb.nl`.
   - **Authorization callback URL** `https://atcgang.gekophetweb.nl/api/auth/callback/github`.
   - Leave *Enable Device Flow* off. **Register application**.
3. Copy the **Client ID**. Click **Generate a new client secret** and copy it right away; it is shown once.
4. Optional: upload a logo so users recognise the app on GitHub's consent screen.
5. Admin → Sign-in with SSO → **GitHub**: paste both, tick the GitHub checkbox, **Save**.
6. Test: sign out → **Continue with GitHub**. The app asks for `user:email`, so users whose email is private on GitHub can still sign in.

A GitHub OAuth App has exactly one callback URL. For local development create a second app with `http://localhost:5173/api/auth/callback/github`.

---

## Backups and restore

The `backup` container runs every night at 03:30 (container time, UTC):

1. `pg_dump` of the database.
2. The dump plus the whole photo volume go into two restic repositories: the off-site one in `RESTIC_REPOSITORY` and a local copy in `BACKUP_LOCAL_DIR` (default `./backups` next to the compose file).
3. Old snapshots are pruned: 14 daily + 4 weekly are kept. Deleted photos and accounts are gone from backups after at most 14 days + 4 weeks.

Both repositories are encrypted with `RESTIC_PASSWORD` and created on the first run.

### Setting up the off-site repository

**Cloudflare R2:**

1. Cloudflare dashboard → **R2** → **Create bucket** `atcgang-backup`, location hint Western Europe.
2. **R2** → **Manage API tokens** → **Create API token**: permission **Object Read & Write**, applied to that bucket only.
3. In `.env`:
   ```
   RESTIC_REPOSITORY=s3:https://<account-id>.r2.cloudflarestorage.com/atcgang-backup
   AWS_ACCESS_KEY_ID=<access key id>
   AWS_SECRET_ACCESS_KEY=<secret access key>
   ```

**Backblaze B2:** create a private bucket and an application key limited to it, then use `RESTIC_REPOSITORY=s3:https://s3.<region>.backblazeb2.com/<bucket>` with the key ID and key as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.

### Check that backups work

Run one now instead of waiting for the night:

```bash
docker compose exec backup backup.sh
docker compose exec backup restic snapshots                                  # off-site
docker compose exec backup restic -r /backups/local/restic snapshots         # local
```

### Restore

Restoring replaces the current database and photos.

```bash
docker compose stop web
docker compose run --rm restore                        # latest off-site snapshot
docker compose run --rm restore restore.sh <snapshot>  # a specific snapshot id
docker compose start web
```

Do a test restore every few months, ideally on a second machine with a copy of `.env`.

---

## Deploys

Deploys are pull-based: the server checks for a new image, so CI never needs access to your home network.

1. Push or merge to `main` (with git flow: finish a release or hotfix). CI runs lint, tests, shellcheck and the update-script tests, then publishes `ghcr.io/gekophetweb/atcgang.gekophetweb.nl:main` and `:<commit sha>` (amd64 + arm64).
2. On the server, `deploy/update.sh` runs from crontab every 5 minutes. It is silent when nothing changed. When something did, it:
   1. takes a lock, so two runs never overlap;
   2. runs `git pull --ff-only` in `/opt/atcgang`, so changes to `deploy/` and `backup/` arrive too (and re-applies all services if the compose file or `backup/` changed);
   3. pulls the web image and compares it with the running one;
   4. remembers the running image as `state/last-good` (and tags it `:last-good`);
   5. dumps the database to `state/pre-update-<time>.dump` (keeps 5) and stops if that fails;
   6. starts the new `web` container; it runs migrations on start;
   7. waits for the container to be healthy, then checks `https://atcgang.gekophetweb.nl/healthz` through the tunnel;
   8. rolls back to the last good image if that fails, and skips the failed image until a newer one is published;
   9. removes old unused images and logs the result, plus an optional message to ntfy, Discord or Slack.

   The database is never restored automatically. Migrations therefore only *add* columns and tables; removing old ones waits for a later release, so the previous image keeps working after a rollback.

### Set up the cron job (once)

Run it as a normal user in the `docker` group (here `deploy`), not as root:

```bash
sudo mkdir -p /var/log/atcgang && sudo chown deploy: /var/log/atcgang
sudo cp /opt/atcgang/deploy/logrotate.conf /etc/logrotate.d/atcgang   # change "deploy" in it to your user
cp /opt/atcgang/deploy/update.conf.example /opt/atcgang/update.conf     # optional: NOTIFY_URL etc.
/opt/atcgang/deploy/update.sh --dry-run                                 # see what it would do
crontab -e
```

```
MAILTO=you@example.com
# check for a new release every 5 minutes
*/5 * * * *  /opt/atcgang/deploy/update.sh >> /var/log/atcgang/update.log 2>&1
# weekly: also update the Postgres minor version, cloudflared and the backup image (Sunday 04:30)
30 4 * * 0   /opt/atcgang/deploy/update.sh --all >> /var/log/atcgang/update.log 2>&1
```

With the output going to the log file, cron only mails you if the script itself cannot start. For a message on every deploy and failure, set `NOTIFY_URL` in `update.conf` (an ntfy topic such as `https://ntfy.sh/<random-topic>`, a Discord webhook or a Slack webhook). Failures where the site may be down are sent with urgent priority. Setup problems that stop an update before anything changes (`git pull`, the registry, low disk space, the database dump) are reported once the same error happens two runs in a row, repeated at most daily, with a "recovered" message when it works again. Before the dump the script also checks that `state/` has room for the database plus `MIN_FREE_MB` (1 GB).

### By hand

| Command | Does |
| --- | --- |
| `deploy/update.sh` | check and deploy now |
| `deploy/update.sh --dry-run` | show what would happen, change nothing |
| `deploy/update.sh --force` | redeploy even if the image did not change |
| `deploy/update.sh --tag <sha>` | deploy a specific build (full commit sha) |
| `deploy/update.sh --rollback` | go back to the last good image (and skip the current one) |
| `deploy/update.sh --all` | also update `db` (stays on Postgres 17), `cloudflared` (pinned in `deploy/docker-compose.yml`; bump the tag there to upgrade) and `backup` |
| `deploy/update.sh --restore-db state/pre-update-<time>.dump` | stop `web`, restore that dump, start `web`; asks first (or add `--yes`) and dumps the current database beforehand |

Exit codes: `0` nothing to do or deployed · `1` deploy failed, rolled back · `2` deploy and rollback failed, the site is probably down · `3` another run is busy · `4` setup problem (no `.env`, no Docker, `git pull` cannot fast-forward, database dump failed). See what happened: `tail -n 50 /var/log/atcgang/update.log`.

### Moving from the old systemd timer

Servers set up before the update script used a full clone and `atcgang-deploy.timer`. Once:

```bash
sudo systemctl disable --now atcgang-deploy.timer
sudo rm /etc/systemd/system/atcgang-deploy.{service,timer} && sudo systemctl daemon-reload
cd /opt/atcgang && git checkout main && git pull --ff-only
git sparse-checkout set deploy backup        # optional: drop the source code from the server
echo 'COMPOSE_FILE=deploy/docker-compose.yml' >> .env
sed -i 's|^BACKUP_LOCAL_DIR=./backups|BACKUP_LOCAL_DIR=../backups|' .env   # now relative to deploy/
docker compose up -d
```

Then set up the cron job as above. The project name stays `atcgang`, so the database and photo volumes are the same ones.

---

## MCP

Add `https://atcgang.gekophetweb.nl/mcp` as a custom connector in Claude (Settings → Connectors → **Add custom connector**), or in any MCP client that supports OAuth. It sends you to the site to sign in, shows a consent screen, and then acts as you. Connections are listed in **Settings** and can be revoked there.

Tools: `list_concerts`, `get_concert`, `add_concert`, `update_concert`, `delete_concert`, `search_photos`, `tag_photos`, `list_people`, `list_labels`, `concert_stats`. Resource: `concert://{id}`.

---

## Configuration reference

All variables go in `.env`. Mail and SSO values can also be set in Admin, which then takes precedence.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:3000` | Public URL; used in links, cookies and OAuth callbacks |
| `BETTER_AUTH_SECRET` | (required) | Signs sessions and photo links, encrypts stored secrets. At least 16 characters |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `atc` / – / `atc` | Database credentials (compose) |
| `DATABASE_URL` | – | Only for running the server outside compose |
| `ADMIN_EMAILS` | – | Comma-separated emails that are always admin |
| `PHOTO_DIR` | `/data/photos` | Photo volume path inside the container |
| `STORAGE_QUOTA_BYTES` | `2147483648` (2 GB) | Photo storage per user |
| `DISK_ALERT_PERCENT` | `80` | Daily admin email when the photo disk is fuller than this |
| `MAIL_FROM` / `RESEND_API_KEY` | – | Mail defaults until mail is saved in Admin |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | – | Bot protection on the login form; empty = off |
| `TUNNEL_TOKEN` | – | Cloudflare Tunnel connector token |
| `GOOGLE_*`, `MICROSOFT_*`, `APPLE_*`, `GITHUB_*` | – | SSO defaults until SSO is saved in Admin. `APPLE_PRIVATE_KEY` with newlines written as `\n` |
| `RESTIC_REPOSITORY` / `RESTIC_PASSWORD` | – | Off-site backup repository and its encryption password |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | – | Credentials for the R2/B2 bucket |
| `BACKUP_LOCAL_DIR` | `./backups` | Local copy of the backup repository |
| `TRUST_CF_HEADERS` | `true` | Use `CF-Connecting-IP` for rate limits. Only safe because `web` is reachable through the tunnel alone |
| `WEB_IMAGE` | `ghcr.io/gekophetweb/atcgang.gekophetweb.nl:main` | Image the server runs |

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Site shows a Cloudflare 1033 / 502 error | Tunnel not connected or `web` not healthy: `docker compose ps`, `docker compose logs cloudflared web` |
| Login code never arrives | Admin → Mail → **Send test email**. Check the provider's logs and the spam folder. Without a provider, codes are only in `docker compose logs web` |
| "Too many requests" on the login form | At most 5 codes per email and 20 per IP address per hour; wait and try again |
| SSO: `redirect_uri_mismatch` (Google) or `AADSTS50011` (Microsoft) | The callback URL at the provider doesn't exactly match the one in Admin. No trailing slash, `https`, exact hostname |
| SSO: `invalid_client` (Apple) | Client ID must be the Services ID (not the App ID); check Team ID and Key ID; the key must be enabled for Sign in with Apple |
| SSO: Microsoft stopped working after months | The client secret expired; create a new one in Entra and paste it in Admin |
| SSO: Google says "access blocked: app is in testing" | Google Auth Platform → Audience → **Publish app** |
| SSO button missing on login page | Provider not *active* in Admin: its checkbox is unticked or a field is empty (for Apple: the key could not be read) |
| "Account not linked" after GitHub sign-in | An account with that email already exists; sign in with the email code (or Google/Microsoft/Apple) instead |
| Everyone was signed out and SSO stopped | `BETTER_AUTH_SECRET` changed; restore the old value, or re-enter mail and SSO secrets in Admin |
| Uploads fail with "Your photo storage is full" | The user is at `STORAGE_QUOTA_BYTES`; raise it in `.env` and `docker compose up -d` |
