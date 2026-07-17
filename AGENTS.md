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

### Critical Yingma production exception (verified 2026-07-16)

The general `/srv/siyue` instructions below are correct for the main
`yuenong.siyue.ai` MES, but they are **not** the deployment target for
`yingma.siyue.ai`. Always inspect Caddy and `pm2 show` before deploying a
hostname.

- `yingma.siyue.ai` resolves to the same VM, but Caddy proxies it to
  `localhost:3901`.
- The process is PM2 app **`yingma-mes`**, not `siyue`.
- `pm2 show yingma-mes` reports the real cwd as
  **`/srv/yingma-suite/app`** and command `npm start -- -p 3901`.
- The checkout is on branch **`yingma-production`**. At the time of discovery
  it was at commit `a9ed2b5dbb466855ae53ae36a41fbf745711824b` and had a very
  dirty worktree containing live, uncommitted application work. Do not run
  `git pull`, `git reset`, `git checkout`, or a blanket rsync there.
- Yingma runtime variables live in
  **`/srv/yingma-suite/app/.env.local`**, including `MACHINE_INGEST_TOKEN`,
  `MACHINE_STORE_MODE`, `MACHINE_STORE_PATH`, and
  `MACHINE_DASHBOARD_PROXY_KEY`.
- Caddy injects `X-Yingma-Machine-Dashboard` only for `/machines`,
  `/machines/*`, `/api/machines`, and `/api/machines/*`. The matching key is
  already present in the Yingma `.env.local`; never print either secret.
- `/srv/yingma` is a separate legacy directory and is not the PM2 cwd.

Useful verification commands:

```bash
ssh root@47.238.237.229
sed -n '1,220p' /etc/caddy/Caddyfile
pm2 show yingma-mes
cd /srv/yingma-suite/app && git status --short
curl -I https://yingma.siyue.ai/machines
```

#### Failed CNC deployment attempt and why it failed

On 2026-07-16, CNC commit `1011bfb` was correctly built and deployed to
`/srv/siyue`, and `pm2 restart siyue --update-env` succeeded. That did **not**
update `yingma.siyue.ai` because the hostname never reaches port 3000. An
authenticated probe to `https://yingma.siyue.ai/api/machines/ingest` returned
401 even though a direct probe to `http://127.0.0.1:3000/api/machines/ingest`
returned the expected authenticated validation error. Inspecting Caddy exposed
the port-3901 split above. Do not repeat the `/srv/siyue` deploy when the target
is Yingma.

The same attempt pushed CNC commit `1011bfb` to GitHub `main` and restarted the
main `siyue` process without errors; Caddy stayed online and existing services
remained healthy. The intended Yingma production checkout was deliberately not
pulled or reset after its dirty worktree was discovered.

The corrected deployment preserved the dirty Yingma checkout. It fetched
GitHub `main`, backed up only the machine-related paths to
`/srv/yingma-suite/backups/cnc-20260717-151710`, then used targeted
`git restore --source origin/main --worktree` for `app/api/machines`,
`app/machines`, `lib/machines.ts`, and `services/machine-watcher`. The complete
dirty application built successfully, `yingma-mes` restarted cleanly, and Caddy
was not changed or restarted. The factory package token was then installed in
the Yingma `.env.local` and activated with
`pm2 restart yingma-mes --update-env`.

End-to-end checks after the corrected deployment:

- Authenticated `POST https://yingma.siyue.ai/api/machines/ingest` with `{}`
  returned HTTP 400 `watcherId must be...`, proving the public route, Caddy,
  token, and new parser were all reached. A 401 here means token/env mismatch.
- `https://yingma.siyue.ai/machines` returned HTTP 200.
- `https://yingma.siyue.ai/machines/reader` returned HTTP 200 and a valid ZIP.
- `pm2 show yingma-mes` was online with zero unstable restarts after reload.

#### Windows CNC work already completed; do not restart this investigation

- Factory CNC addresses are `192.168.10.81` through `.95`.
- `.81-.93` and `.95` answer Mitsubishi EZSocket on TCP 683. `.94` answers
  FANUC FOCAS on TCP 8193.
- Installing Mitsubishi `BND-1217W100-C7` installed **NC Explorer**, not the
  developer/runtime COM interface. It did not make `EZNcAut` available.
- The correct installed Mitsubishi package was
  **FCSB1224W100-A9** (Mitsubishi CNC communication software runtime). It
  registered the 32-bit COM automation object.
- The collector must launch
  `%WINDIR%\SysWOW64\WindowsPowerShell\v1.0\powershell.exe`; 64-bit PowerShell
  cannot use the in-process 32-bit Mitsubishi COM object.
- The working COM ProgID is unversioned
  `EZNcAut.DispEZNcCommunication`. Direct PowerShell method calls and several
  guessed 4/5-argument signatures failed with `DISP_E_TYPEMISMATCH` or
  `DISP_E_UNKNOWNNAME`. The reliable path is the official-style late binding
  in `YingmaVendorDrivers.ps1` using `Type.InvokeMember` with by-reference
  argument handling.
- A standalone read-only probe proved `.81` works: TCP/open/head calls returned
  code 0 and `Program_GetProgramNumber2` returned `35.003-4.NC`.
- The current driver then returned `connected: true`, real program names, and
  running/stopped state for all 14 Mitsubishi controllers. Examples observed:
  `.82 LEVER-69.NC` running, `.90 999.NC` running, `.93 05.039-5.NC` stopped,
  `.95 02.024-111.NC` stopped.
- Mitsubishi source capture initially failed with
  `File_OpenFile3(read-only) 0x80B0020C` (file does not exist at the attempted
  path). Version 4.1.0 now tries the dedicated `File_OpenNCFile3` API and both
  `M01:\PRG\USER\<program>` and `M01:\IC1\<program>` read-only paths.
- Mitsubishi count and duration reads are implemented from standard WRK COUNT
  parameters `#8002/#8003`, `Status_GetCycleTime`, `Time_GetRunTime`, and
  `Time_GetStartTime`. These still need one final factory run to verify the
  returned values on the actual M80 configuration.
- FANUC `.94` is still blocked on the official 32-bit FOCAS2 runtime
  `Fwlib32.dll`. Do not download an unofficial DLL. The collector installs and
  retries `.94` automatically so the 14 working Mitsubishi machines are not
  held hostage by that external runtime.
- The private transfer artifact is ignored by git at
  `services/machine-watcher/dist/YingmaMachineWatcher-4.1.0-FACTORY.zip`.
  It contains `factory.token`; never commit or paste that token into chat.

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
