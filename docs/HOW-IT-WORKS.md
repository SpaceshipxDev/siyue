# yingma.siyue.ai — how the whole thing works

One paper packet (stamped 2D drawing + CNC程序单 pages) drives everything.
The programmer photographs it once; from then on any worker can photograph
any page of it and the system knows exactly which part it is.

```
编程 prints packet ──📷 /ingest──▶ Gemini reads pages ──▶ component created
                                   │                       (货号/图纸/数量/交期/OPs)
                                   └──▶ pages registered in the MATCHER BANK

worker picks up job ──📷 /p──▶ matcher: which physical sheet is this?
                               │ match      → /s/<token>  (报工 page)
                               │ ambiguous  → pick between repeat orders
                               └ no_match   → Gemini OCR of 图纸号 → DB lookup

worker taps 报工 ──▶ part_stages.done_qty + report_events (append-only)
                     └▶ board 工序 chips + 最近报工 + 今日报工 + worker tally
```

## The pieces

| Piece | Where | What it does |
|---|---|---|
| Next.js app | `/srv/yingma-suite/app` on the VM, port 3901, Caddy → `yingma.siyue.ai` | Board, /ingest, /p, /s, all DB writes |
| Matcher service | same VM, `pm2 yingma-matcher`, port 8788 (localhost only) | photo → page_id/component_id |
| Supabase cloud | project `tvkaiuwcaaljsprbveyd` (org Afterlight, Tokyo) | jobs/parts/part_stages/packets/packet_pages/report_events + `uploads` bucket |
| Gemini | Vertex AI via `/opt/selaira/adc.json` (same as yuenong; the AI-Studio API key is geo-blocked from the HK VM) | packet extraction + OCR fallback |

## 1. Ingestion (`/ingest` → `app/api/packet-ingest`)

1. Phone photos are downscaled client-side to ≤2000px JPEG (`app/_camera.ts`).
2. Originals go to the `uploads` bucket under `packets/<packetId>/pN.jpg` FIRST
   (photos are ground truth; extraction can always be retried).
3. `lib/packet-extract.ts` sends all pages to Gemini in one call with a
   structured schema. Field rules that matter:
   - 数量/交期 come from the BLUE STAMP handwriting, never the CNC sheet's
     printed 数量 (that's the programming batch, usually 1).
   - 零件名称 prefers the drawing title block (清洁棒调整块), not the CNC
     sheet's internal 零件编号 (A板).
   - 加工次数 count (第1次/第2次加工…) = number of CNC OPs.
   - Due-date year = nearest year (overdue packets must not jump to next year).
4. `lib/packets.ts createComponentFromPacket`:
   - If an open part with the same 货号 exists and has no packet → the packet
     ATTACHES to it (order-entry-first flow). Else a fresh single-part job is
     created. `job_no` = 货号 (else 图纸号) — **no invented work ids**.
   - OP route: `setPartRoute` with the first N of the six OP stage keys.
     The DB keys are still the parent vocabulary (编程→OP1, 操机→OP2, 手工→OP3,
     打磨→OP4, 喷漆→OP5, 质量→OP6, 丝印→后处理); `stageLabel()` relabels
     display-only. 丝印(后处理)+出货 are force-added by `resolvePartStages` —
     that invariant keeps shipping close-out working.
   - `parts.drawing_no` gets the 图纸号, a QR token is minted, and
     `packets` + `packet_pages` rows index the photos.
5. Each page is pushed to the matcher `/register`. Failures stay
   `registered=false` and `sweepRegistrations` re-pushes them opportunistically
   on every later `/api/match-photo` call — the system self-heals if the
   matcher was down during ingestion.

## 2. The matcher (`services/matcher`) — why it's accurate

The key insight: the reference and the query are photos of the **same physical
sheet of paper** — same stamp, same handwriting, same creases. That makes this
image-COPY detection + geometric verification, not "similar drawing" search.

Pipeline per query (`matcher/engine.py`):

1. **Preprocess** — EXIF-rotate, downscale to 1600px.
2. **SSCD embedding** (`sscd_disc_mixup`, Facebook's image-copy-detection
   model) at 4 rotations → max cosine vs the bank → top-8 shortlist.
   This step is ~100ms and only needs to put the right page in the top 8.
3. **Geometric verification** on the shortlist: SuperPoint keypoints +
   LightGlue matching → `cv2.findHomography(USAC_MAGSAC)`. A photographed
   flat page differs from its reference by one perspective transform — the
   right page produces hundreds of correspondences agreeing with a single
   homography; a wrong-but-similar page does not.
4. **Composite score** = inliers × inlier_ratio × grid coverage (inliers must
   occupy ≥8 of 4×4 grid cells — kills "only the title block matches") ×
   post-warp edge agreement (warp the reference onto the query, compare
   Canny edges).
5. **Decision** — all gates pass → `match`; two candidates both pass within a
   margin (repeat orders of the same drawing) → `ambiguous`, the worker picks
   between 2 cards by 数量/交期; else `no_match`.
6. **Early exit** — when the retrieval winner has a wide cosine margin and
   passes all geometric gates, the other candidates are never verified.

Measured (see `services/matcher/eval/report.md` + `eval/external_report.md`):
- Synthetic (100 variants/page over a 53-page bank): **99.7% top-1, 0 false
  matches**, including 0/200 confusion on the two near-identical CNC sheets
  (OP1 vs OP2 of the same packet — they differ only in small table rows).
- SmartDoc-QA (real phone captures, 15 pages × 10 shots): **88.9% top-1,
  0 false matches, 50/50 unknown pages correctly rejected.**
- The failure mode is always *reject*, never *wrong part* — and a reject
  falls through to the OCR path, so the floor still gets an answer.

Tunables are all env vars (`MATCHER_MIN_INLIERS`, `MATCHER_MIN_SCORE`,
`MATCHER_FEATURE_RESIZE`, …) documented in `services/matcher/README.md`.

## 3. OCR fallback (`lib/matcher.ts` → `lib/packet-extract.ts readPhotoIdentity`)

If the matcher is down or unsure, one Gemini call reads 货号/图纸号 off the
photo and `findActivePartsByIdentity` looks it up **fuzzily**: both sides are
normalized to bare alphanumerics and compared with a small edit-distance
budget — OCR routinely drops a digit group from long drawing numbers
("…04.01.09.021" for "…04.01.01.09.021") and exact matching would miss.

## 4. 报工 (`/p` → `/s/<token>`)

- `/p` (public): one button → photo → `/api/match-photo` → redirect to
  `/s/<token>` — the same page the printed QR opens, so QR and photo are
  interchangeable credentials for the same narrow surface.
- `/s`: part block (name, 货号, one facts line, stage chips), then ONE
  control — the count prefilled with everything still open at the current OP,
  −/+/type to adjust, one button. The server re-derives the current stage and
  clamps; the phone can never name a stage.
- Every report writes `part_stages` (live state) AND `report_events`
  (append-only history) — history is what powers the job page's worker
  timeline, the board's 最近报工 column, 今日报工, and the worker's own
  count-up tally (the dopamine number).
- After reporting, the biggest button is 📷拍照报下一单 — the loop closes.

## 5. The PMC board (`/`)

One row per live 零件: 客户 · 货号 · 描述 · 图纸号 · 数量 · 交期 · 工序
(编程 ✓ → OP chips with a/b → 后处理 → 出货, all in one cell) · 最近报工
(who, +qty, how long ago). Search by any identity field, customer filter,
在产/已出货 segments. Click a row → part detail with the full stage table and
the 报工 tab. No xlsx import, no money pills, no yuenong tabs.

## Ops runbook

```bash
# VM (root@47.238.237.229)
pm2 ls                         # yingma-mes (:3901), yingma-matcher (:8788)
pm2 logs yingma-mes            # app logs
pm2 restart yingma-mes --update-env   # after editing /srv/yingma-suite/app/.env.local

# deploy a new build (from the Mac)
cd "/Volumes/Minas Tirith/xDocuments/yingma.siyue.ai"
rsync -az --delete --exclude node_modules --exclude .next --exclude .git \
  --exclude .env.local --exclude 'services/matcher/.venv' \
  --exclude 'services/matcher/data*' --exclude 'services/matcher/testdata' \
  ./ root@47.238.237.229:/srv/yingma-suite/app/
ssh root@47.238.237.229 'cd /srv/yingma-suite/app && npm ci && npm run build && pm2 restart yingma-mes'

# matcher eval (local Mac)
cd services/matcher
./run.sh eval                             # synthetic
.venv/bin/python scripts/eval_external.py # real-world datasets
```

- Secrets live in `/srv/yingma-suite/` (`.service_role_key`, `.matcher_token`)
  and `/srv/yingma-suite/app/.env.local`; nothing secret is in the repo.
- Supabase migrations: files in `supabase/migrations/`, applied to cloud via
  the Supabase MCP/dashboard (`0083` is the newest).
- Local dev: `npm run dev` against the colima local Supabase
  (`npx supabase start` inside the repo), matcher via
  `services/matcher/run.sh serve`, PIN 1111.

## Adding things later

- **New customer**: nothing to configure — customer comes off the packet
  (or edit it on the part). Filters pick it up automatically.
- **More OP stages**: the six OP keys cap CNC depth at 6; if a packet ever has
  7+ 加工次数, extend `YINGMA_STAGE_LABEL`/`TRACKING_STAGES` in `lib/data.ts`
  (a new DB stage key needs a `part_stages` row seeded — go through
  `resolvePartStages`).
- **Matcher accuracy on rough photos**: loosen the accept gates via env vars
  on the VM (`pm2 restart yingma-matcher` after editing
  `/srv/yingma-suite/run-matcher.sh`) — precision is protected by geometry,
  the gates only trade recall vs caution. Re-run the external eval to check.
- **More reference data per part**: register extra photos of the same packet
  (any page, any angle) with `POST /register` — more bank entries per
  component only helps retrieval.
