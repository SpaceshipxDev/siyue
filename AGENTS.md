<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Architecture & Deployment

## Stack

- **Framework:** Next.js 16.2.4 (App Router, Turbopack, `experimental.viewTransition`), React 19, TypeScript.
- **DB / storage:** Supabase (Postgres + storage, accessed with the service-role key on the server).
- **AI:** `@google/genai` SDK calling **Gemini via Vertex AI** (not AI Studio). Requires Google Cloud service-account credentials — see env vars below.
- **PDF:** `@react-pdf/renderer`. **XLSX parsing:** `xlsx`.
- **Auth:** JWT in cookies via `jose` + `bcryptjs`. Bootstrap user seeded via `BOOTSTRAP_PIN`.

## Hosting

**Production runs on a single Alibaba Cloud SWAS VM** — no Vercel, no Docker, no CI build. The `.vercel/` directory in the repo root is stale; ignore it.

- **VM:** `47.238.237.229` (Aliyun SWAS, Hong Kong region)
- **OS:** Alibaba Cloud Linux 3 — RHEL-based, **use `dnf`, not `apt`**.
- **SSH:** `root@47.238.237.229`, password auth currently (no key set up yet).
- **App path:** `/srv/siyue` — git clone of `https://github.com/SpaceshipxDev/siyue.git`.
- **Process manager:** pm2 (global install).
  - `siyue` — Next.js app (`npm start` → `next start` on :3000).
  - `caddy` — reverse proxy, TLS termination, proxies :443 → localhost:3000. **Do not stop or replace caddy.** Its config lives wherever pm2 launched it from; check `pm2 show caddy`.
- **Persistence across reboot:** `pm2 save` + `pm2 startup` (already configured for root).

### Legacy `/opt/selaira/`

The old deployment (before this repo) lives at `/opt/selaira/`. **Most of it is dead weight, but one file is still load-bearing:** `/opt/selaira/adc.json` — the Google Vertex AI service-account key, referenced by `GOOGLE_APPLICATION_CREDENTIALS` in `/srv/siyue/.env.local`. **Do not delete `/opt/selaira/` without first moving `adc.json` to a permanent home (e.g. `/etc/siyue/adc.json`) and updating the env var.**

## Environment variables

All env vars live in `/srv/siyue/.env.local` on the VM (and a local copy on the developer's machine). **Never commit `.env.local`** — it's gitignored.

| Variable | Purpose |
|---|---|
| `GOOGLE_CLOUD_PROJECT` | GCP project ID for Vertex AI |
| `GOOGLE_CLOUD_LOCATION` | Vertex region (defaults to `global` in code) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to service-account JSON. Currently `/opt/selaira/adc.json`. |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase key. **Never expose to client.** |
| `SESSION_SECRET` | JWT signing secret for `jose` |
| `BOOTSTRAP_PIN` | First-run admin PIN (see `app/login/`) |

See `.env.local.example` for the up-to-date list.

## Deployment workflow

**Source of truth:** GitHub repo `SpaceshipxDev/siyue`, branch `main`.

**Standard deploy** (after `git push origin main`):

```bash
./deploy.sh
```

`deploy.sh` SSHes into the VM, pulls, reinstalls deps, rebuilds, and reloads pm2 with fresh env. **The build runs on the VM, not in CI.** The SWAS box has enough RAM for `next build`; no need to ship artifacts.

Manual equivalent if `deploy.sh` is unavailable:

```bash
ssh root@47.238.237.229 'cd /srv/siyue && git pull && npm ci && npm run build && pm2 restart siyue --update-env'
```

**The `--update-env` flag is mandatory** when `.env.local` has changed. pm2 caches env at process spawn time, so plain `pm2 restart siyue` keeps stale env vars.

## Local development

```bash
npm run dev    # next dev with Turbopack, http://localhost:3000
```

Requires a local `.env.local` (ask another developer or copy from the VM). Same vars as production.

## Debugging the live VM

```bash
ssh root@47.238.237.229

pm2 list                              # status + restart counts
pm2 logs siyue --lines 50 --nostream  # recent stdout + stderr
pm2 show siyue                        # cwd, exec path, env keys
pm2 restart siyue --update-env        # safe to do; sub-second downtime
pm2 reset siyue                       # zero the restart counter
```

### Common failure modes

- **`Could not find a production build in the '.next' directory`** — someone restarted pm2 without running `npm run build` first. Fix: `cd /srv/siyue && npm run build && pm2 restart siyue`.
- **`Could not load the default credentials`** — Gemini/Vertex auth is broken. Either `GOOGLE_APPLICATION_CREDENTIALS` is missing from `.env.local`, points at a nonexistent file, or the JSON is corrupt. Verify with `ls -la $(grep GOOGLE_APPLICATION_CREDENTIALS /srv/siyue/.env.local | cut -d= -f2)`.
- **High `↺` restart counter** — process is crash-looping. Always check logs first; never just "restart harder."
- **Env var change not taking effect** — you forgot `--update-env`.

### Things NOT to do

- **Don't run `npm audit fix --force`** — happily bumps majors and breaks the build for no real security benefit on app deps.
- **Don't `pm2 delete caddy`** — it's the reverse proxy. The site goes dark.
- **Don't push directly to the VM via rsync/scp.** Source of truth is GitHub. If you bypass git, the next `git pull` will overwrite changes or fail to fast-forward.
- **Don't use `apt`** — this is RHEL, use `dnf`.

## Repo hygiene

Gitignored at root (do not commit): `*.png` (Playwright screenshots), `/.playwright-mcp/`, `/inspect-*.mjs`, `/make-cookie.mjs`, `.env*`, `.vercel/`, `.next/`, `node_modules/`, `data/`, `public/uploads/`.
