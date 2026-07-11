# Demo build — 脱敏 (de-identified) sales demo

A safe-to-show build of the MES: **real customer names, realistic part names and
hard ¥ amounts, ~12 months of a busy mid-size shop's order book** — but the
factory's own identity (越侬模型 / 杭州越侬… / YNMX / phone / address / staff
names) never appears. It runs against an **isolated demo database**, never
production.

## What's in the box

- **Env-driven de-identification** (`lib/brand.ts`). Every factory-identifying
  string falls back to the real production value but is overridable via
  `NEXT_PUBLIC_BRAND_*`. Production sets none of them → prod is byte-for-byte
  unchanged. The demo build sets them to a fictional shop (`杭州智造精密科技有限公司`).
  Flips the page title, footer, printed-doc headers, the doc-number prefix, and
  the "我方商务" field label.
- **`scripts/seed-demo.ts`** — generates ~240 orders for a fictional shop:
  - real customers (Hikvision 海康威视, DJI 大疆, Dahua 大华, Mindray 迈瑞,
    Scantech 思看, BYD, NIO, Unitree …), Hikvision-weighted
  - generic-but-real part names (球机外壳, 中框, 关节外壳, 散热支架 …), real
    materials/surface treatments — no model numbers that pin to a real job
  - hard amounts rolled up from per-part unit prices (median ≈ ¥22k, up to
    ~¥300k), ~¥8M/yr total
  - full lifecycle mix: 新单 / 在产 / 已出货 / 已开票待回款 / 逾期 / 已结清,
    plus 外协, a few 暂停, products, and **one pinned showcase Hikvision order**
  - ~12 months of history (job numbers + timestamps backdated), weighted recent

## Decisions baked in

- **Surface:** hosted demo URL (a separate deployment).
- **Data:** an isolated Supabase **branch** off prod (or a separate free
  project — identical steps).
- **Shape:** "busy mid-size shop", ~240 orders.

---

## One-time setup

### 1. Create the isolated demo database

Supabase tracks **zero** migrations for this project (schema was applied by
hand), so a branch comes up **empty** — you apply the schema yourself in step 3.

- **Option A — branch (chosen):** Supabase dashboard → Branches → create a
  branch off `main`. (Branching is a paid Pro feature, ~$0.32/day.)
- **Option B — separate free project:** create a new Supabase project. Same
  steps, free, fully isolated.

### 2. Fill in `.env.demo`

```bash
cp .env.demo.example .env.demo
```

From the **branch/project** (not prod) dashboard, fill in:

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — Project Settings → API
- `DATABASE_URL` — Project Settings → Database → Connection string (URI)
- `SESSION_SECRET` — `openssl rand -base64 32`
- `BOOTSTRAP_PIN` — the demo login PIN

The demo brand vars are pre-filled with the fictional shop; edit if you like.

### 3. Apply the schema, then seed

```bash
# schema → empty branch (uses DATABASE_URL from .env.demo; needs psql/libpq)
DATABASE_URL="$(grep '^DATABASE_URL=' .env.demo | cut -d= -f2-)" ./scripts/db-migrate.sh

# generate the order book (wipes the demo DB first; refuses without the guard)
npx -y tsx --env-file=.env.demo scripts/seed-demo.ts
```

> If your node lacks `--env-file`, just run `npx -y tsx scripts/seed-demo.ts` —
> the script reads `.env.demo` itself (override path via `SEED_ENV_FILE`).

Dry-run the generator (no DB, prints the distribution) any time:

```bash
SEED_DRY=yes SEED_RESET=no SUPABASE_URL=x SUPABASE_SERVICE_ROLE_KEY=x \
  npx -y tsx scripts/seed-demo.ts
```

Tune `SEED_COUNT` (default 240) for a bigger/smaller book; `SEED_SEED` changes
the random draw deterministically.

### 4. Run / deploy the demo

- **Local preview:** `npx -y tsx --env-file=.env.demo` isn't how Next runs —
  instead copy the demo values into a local `.env.local` (or use a tool like
  `dotenv -e .env.demo -- npm run dev`) and `npm run dev`. Because the brand
  vars are `NEXT_PUBLIC_*`, they're inlined at **build** time — rebuild after
  changing them.
- **Hosted demo:** deploy this branch to a **separate** host with `.env.local`
  holding the demo values (the de-identified brand + the demo DB creds). Same
  pm2/Caddy pattern as prod, different box + different DB. Do **not** reuse the
  prod VM's env.

---

## Safety rails

- The seed **wipes** its target DB first and refuses to run unless
  `SEED_I_UNDERSTAND_THIS_WIPES_THE_DB=yes` — set only in `.env.demo`, never in
  prod env.
- De-identification defaults to the **real** values, so forgetting to set the
  brand vars makes the demo look like prod (safe-fail toward "looks real", but
  double-check the footer says 智造精密 before showing anyone).
- Files with real data are local-only and not committed: `PRODUCT_BRIEF.md`,
  `inspect-paintsilk-backup-*.json`, `snapshot-master.md`. Keep them out of any
  demo deploy (they're already untracked/gitignored).
