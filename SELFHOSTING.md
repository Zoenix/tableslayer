# Self-hosting Table Slayer

This fork runs Table Slayer entirely on your own hardware (TrueNAS SCALE, any Docker host, or a
plain Node machine). No Cloudflare, Turso, Fly, Stripe or Sentry accounts are needed.

## What replaces the cloud services

| Upstream (tableslayer.com)                 | Self-hosted                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| Turso (libSQL) database                    | Local SQLite file (`/data/db/tableslayer.db`), migrated automatically on start         |
| Cloudflare R2 bucket                       | Local folder (`/data/files`), served by the app at `/files/...`                        |
| Cloudflare Image Transformations           | Built-in resizer (sharp) at `/files/cdn-cgi/image/...`, cached on disk                 |
| Realtime worker on Cloudflare Workers + DO | Same worker code in `workerd` (wrangler local runtime), state in `/data/realtime`      |
| R2 presigned uploads                       | HMAC-signed upload URLs handled by the app                                             |
| files.tableslayer.com static assets        | Mirrored once into `/data/files` on first start (~155 MB)                              |
| Stripe / email / Google / Turnstile        | Optional, off by default (every party gets the lifetime plan, users are auto-verified) |

```
browser ──► web :3000 ──┬── SvelteKit app, /files, image resizing ──► /data/db, /data/files
                        └── /parties/* websockets ──► realtime :1999 ──► /data/realtime
                                                         │
                                 hydrate/persist via ◄───┘ http://web:3000/api/internal/*
```

Only port 3000 needs to be reachable. Both containers use the same image.

## TrueNAS SCALE (24.10 "Electric Eel" or newer)

### 1. Get an image

TrueNAS can't build images from source in the Apps UI, so publish one to GitHub's registry:

1. Fork `Siege-Perilous/tableslayer` on GitHub (or create an empty repo) and push this branch:
   ```sh
   git remote add origin https://github.com/<you>/tableslayer.git
   git push -u origin selfhost
   ```
2. In the repo's **Actions** tab, enable workflows if GitHub asks. The **Self-host image** workflow runs on
   every push to `selfhost` and publishes `ghcr.io/<you>/tableslayer:latest`.
3. In **Packages → tableslayer → Package settings**, either make the package public, or add GHCR credentials
   to TrueNAS (**Apps → Configuration → Manage Container Image Registries**).

(Alternative: build on the NAS from a shell. See [Docker Compose](#docker-compose-any-host).)

### 2. Create a dataset

e.g. `tank/apps/tableslayer`. The containers run as root, so default permissions are fine.

### 3. Install

**Apps → Discover Apps → ⋮ → Install via YAML**, paste [`selfhost-truenas.yaml`](selfhost-truenas.yaml),
and edit:

- `ghcr.io/YOUR_GITHUB_USER/...` → your image
- `/mnt/tank/apps/tableslayer` → your dataset path (both services)
- `BASE_URL` → the exact URL you'll open in the browser, e.g. `http://192.168.1.50:3000`
- `INTERNAL_API_TOKEN` → output of `openssl rand -hex 32`

Open `BASE_URL`, sign up, and you're the first user. The first start takes a minute or two while
static assets download.

### Updating

Push or merge into `selfhost` → wait for the Action → in TrueNAS, **Apps → tableslayer → Update** (or
restart it to pull `latest`). Migrations run automatically.

## Docker Compose (any host)

```sh
cp .env.selfhost.example .env.selfhost      # set BASE_URL and INTERNAL_API_TOKEN
docker compose -f docker-compose.selfhost.yml --env-file .env.selfhost up -d --build
```

On TrueNAS you can do this from **System → Shell** inside a dataset, e.g.
`git clone … /mnt/tank/apps/tableslayer-src`.

## HTTPS / reverse proxy

Everything goes through port 3000, websockets included, so one proxy entry is enough (Nginx Proxy
Manager, Traefik, Caddy). Requirements:

- Websocket support enabled (NPM: tick **Websockets Support**).
- The proxy sends `X-Forwarded-Proto` and `X-Forwarded-Host` (all of the above do by default).
- `BASE_URL` is set to the public URL, e.g. `https://tableslayer.example.com`.
- Raise the proxy's upload limit to ~200 MB for large maps (NPM: `client_max_body_size 200m;`).

Plain `http://` on the LAN works too. Session cookies are only marked `Secure` on https, and
"copy link" buttons need https because browsers only allow clipboard access on secure pages.

## Tailscale Serve

[Tailscale Serve](https://tailscale.com/kb/1312/serve) gives the app an HTTPS address that only
devices on your tailnet can reach. It passes websockets through, so live sync works.

1. In the Tailscale admin console, enable **MagicDNS** and **HTTPS certificates**.
2. Serve port 3000 at the root of the NAS's tailnet name:
   ```sh
   tailscale serve --bg 3000
   ```
   If Tailscale runs in a container without host networking, point it at the NAS's LAN address
   instead: `tailscale serve --bg http://<nas-ip>:3000`.
3. Set both `BASE_URL` and `ORIGIN` to that address (no trailing slash; include the port if you
   serve on one other than 443):
   ```yaml
   BASE_URL: https://truenas.your-tailnet.ts.net
   ORIGIN: https://truenas.your-tailnet.ts.net
   ```
   `ORIGIN` pins the app's public address, so it doesn't depend on which forwarded headers
   Tailscale sends.

Things to know:

- **Use only the `ts.net` address.** With `ORIGIN` set to https, logins over
  `http://<nas-ip>:3000` won't stick, and map and image URLs always point at the `ts.net` name.
- **Serve at `/`, not under a path.** The app expects to live at the root, so
  `https://….ts.net/tableslayer` won't work.
- **Every device needs Tailscale**, including the table display and players' phones. For a fixed
  group, share the NAS node with their Tailscale accounts.
- **Use Serve, not Funnel.** Funnel publishes the app on the public internet, where anyone who
  finds the URL can create an account.

## Configuration reference

| Variable                                                          | Default (image)                | Notes                                                              |
| ----------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `BASE_URL`                                                        | —                              | **Required.** URL users open; base for file URLs and invites       |
| `INTERNAL_API_TOKEN`                                              | —                              | **Required.** Same value on both containers                        |
| `TURSO_APP_DB_URL`                                                | `file:/data/db/tableslayer.db` | Any `file:` URL, or a Turso `libsql://` URL with auth token        |
| `STORAGE_DRIVER`                                                  | `local`                        | `s3` to use R2/MinIO/Garage instead (see below)                    |
| `LOCAL_STORAGE_PATH`                                              | `/data/files`                  |                                                                    |
| `MAX_UPLOAD_BYTES`                                                | `209715200` (200 MB)           | Keep `BODY_SIZE_LIMIT` at least this large                         |
| `REALTIME_INTERNAL_URL`                                           | `http://realtime:1999`         | How web reaches the realtime container                             |
| `APP_API_URL`                                                     | `http://web:3000`              | How realtime reaches the web container                             |
| `PUBLIC_PARTYKIT_HOST`                                            | empty (same origin)            | Only set if realtime is exposed on its own host                    |
| `ORIGIN`                                                          | empty                          | Pin the public origin instead of trusting forwarded headers        |
| `SKIP_ASSET_DOWNLOAD`                                             | `false`                        | Skip mirroring files.tableslayer.com assets on start               |
| `EMAIL_FROM`, `CLOUDFLARE_EMAIL_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` | empty                          | Optional email                                                     |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                        | empty                          | Optional Google login (callback: `BASE_URL/login/google/callback`) |

**S3-compatible storage instead of a folder:** set `STORAGE_DRIVER=s3`, `S3_ENDPOINT`, `S3_REGION`,
`CLOUDFLARE_R2_ACCESS_KEY`, `CLOUDFLARE_R2_SECRET_KEY`, `CLOUDFLARE_R2_BUCKET_NAME`, and
`CLOUDFLARE_R2_BUCKET_URL` (the bucket's public URL). Image resizing then needs Cloudflare in front of
the bucket, so local storage is the simpler choice at home.

## Backups

Everything lives in the one data folder:

- `db/`: users, parties, scenes (SQLite; snapshot the dataset rather than copying the live file)
- `files/`: uploaded maps, markers, fog masks (`files/.cache` is safe to delete)
- `realtime/`: live session snapshots (rebuilt from the database if lost)

A periodic ZFS snapshot of the dataset covers it.

## Running without Docker

```sh
pnpm install
pnpm turbo run web#build
cd apps/web
INTERNAL_API_TOKEN=secret APP_API_URL=http://localhost:3000 pnpm realtime:selfhost &
BASE_URL=http://localhost:3000 INTERNAL_API_TOKEN=secret REALTIME_INTERNAL_URL=http://localhost:1999 \
  pnpm start:selfhost
```

Data goes to `apps/web/data/` by default.

## Known limitations

- The realtime server runs on wrangler's local runtime (workerd/miniflare). It is the same engine
  Cloudflare uses, but wrangler labels it a dev server. It's fine for a home table; for many
  concurrent groups, watch its memory (~200–300 MB idle).
- The changelog page and Gravatar avatars still load from the internet when available.
- The `docs` app (UI component playground) is not part of the self-hosted image.
