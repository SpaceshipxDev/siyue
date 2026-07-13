# Yingma Page-Matcher Service — Build Spec

You are building a production document-photo matching service for a CNC factory MES.

## The real-world problem

A programmer prints an order packet: one 2D engineering drawing (stamped with qty/due-date in blue ink + red handwriting) + one or more CNC程序单 pages. He photographs every page with his phone → those photos are REGISTERED as references, each linked to a `component_id`.

Later, machine operators on the floor photograph ONE page of the physical packet (usually the front/drawing page) with THEIR phones — different angle, lighting (yellow factory light), glare, oil stains, crumples, partial occlusion by hands/tools. The service must return the exact `component_id` — near-instant, near-perfect.

Critical property: the reference and the query are photos of the SAME PHYSICAL SHEET of paper. This is image-copy detection + geometric verification, NOT semantic similarity. Two repeat orders of the same drawing are two different physical printouts distinguished by their unique handwritten stamps — but they may look 99% alike, so ambiguity must be surfaced, not guessed.

Real sample photos are in `testdata/real/`:
- `IMG_7293.jpeg` — 2D drawing page, blue stamp (数量 346, 交货期 7-1), red handwriting, drawing no. BSZ4255.04.01.01.09.021
- `IMG_7294.jpeg` — CNC程序单 第1次加工 (OP1) for the same packet
- `IMG_7295.jpeg` — CNC程序单 第2次加工 (OP2) for the same packet

NOTE: 7294 vs 7295 are near-identical layouts differing in small table content (加工次数, tool rows). They MUST NOT be confused with each other. This is your hardest negative pair — build the eval around it.

## Architecture (mandatory, do not simplify away layers)

```
query photo
  → preprocess: EXIF-rotate, downscale (~1600px long side), optional doc-quad crop (never hard-fail if absent)
  → SSCD embedding (facebookresearch/sscd-copy-detection, torchscript sscd_disc_mixup) — embed query at 4 rotations, max-cosine vs bank
  → cosine shortlist top-K (K=8) from embedding bank
  → geometric verification on top candidates (early-exit if top-1 passes with wide margin):
      SuperPoint + LightGlue (pip install from github.com/cvg/LightGlue) point matching
      → cv2.findHomography(..., cv2.USAC_MAGSAC, 3.0)
      → geometric score = inliers × inlier_ratio × grid_coverage × edge_agreement
  → decision: match | ambiguous (top-2 both pass / margin small) | no_match
```

- grid_coverage: inlier correspondences must occupy ≥8 cells of a 4×4 grid on the reference page — kills matching-title-block-only false positives.
- edge_agreement: warp reference via H onto query frame, Canny both, dilated-edge overlap score on visible region.
- Cache per-registered-page: SSCD vector + SuperPoint keypoints/descriptors (so /match never recomputes reference features).
- Ranking rule: NEVER argmax on raw match count. Use the composite geometric score. If best and second-best both exceed accept threshold and share high visual similarity (repeat-drawing case), return decision="ambiguous" with both candidates.
- Rotation: LightGlue handles moderate rotation; for 90/180/270 cases rely on the 4-rotation embedding to pick candidates and try the best rotation for verification (verify at the rotation that scored highest cosine).

## Service contract (FastAPI, port 8788, bearer token auth via env MATCHER_TOKEN, default "dev")

- `POST /register` multipart: `image` (file) OR `image_url`, form fields `page_id` (str, unique), `component_id` (str), `kind` (front|program|drawing|other). Idempotent on page_id (re-register replaces). Stores original under `data/pages/`, updates bank (sqlite `data/bank.db` for metadata + numpy .npy or sqlite blob for vectors — keep it simple, bank is ≤ a few thousand pages).
- `POST /match` multipart `image`: returns
  ```json
  {"decision":"match|ambiguous|no_match",
   "best":{"page_id":"..","component_id":"..","score":123.4,"cosine":0.87,"inliers":412,"inlier_ratio":0.71,"coverage":13,"edge_agreement":0.62},
   "candidates":[...top5 same shape...],
   "latency_ms": 1830, "stages":{"embed_ms":210,"shortlist_ms":2,"verify_ms":1600}}
  ```
- `DELETE /pages/{page_id}`; `GET /healthz`; `GET /stats` (bank size, model versions).
- Persistence dir configurable via env MATCHER_DATA (default ./data).

## Environment

- Work ONLY inside `services/matcher/` of this repo. Do not touch any other repo path.
- macOS dev machine, Apple Silicon; system python is 3.14 (torch won't support it) — install/use python 3.12 (brew install python@3.12 is fine, or pyenv if present) in a local venv `services/matcher/.venv`. Torch CPU build. Also produce a `Dockerfile` (linux/amd64, CPU) + `run.sh` for later deploy to a 4-core/7GB Aliyun VM.
- Download SSCD torchscript weights from the official facebookresearch/sscd-copy-detection GitHub release links into `models/` (script it: `scripts/get_models.py`). LightGlue via pip git install downloads SuperPoint weights on first use — pre-warm them.
- If SSCD download is truly unreachable, fallback plan: DINOv2 ViT-S/14 embeddings — but exhaust SSCD first and record what happened in README.

## Synthetic data + evaluation (this is not optional; the numbers are the deliverable)

1. `scripts/synth.py` — augmentation generator: given a reference photo, produce N phone-shot variants: perspective warp (up to ~35°), rotation (0/90/180/270 + ±15° jitter), partial crop (60–100% of page), shadow gradients, warm/yellow color cast, specular glare blobs, motion blur, gaussian noise, JPEG q30–80, random occlusion patches (hand/tool-like), paste onto desk/machine background textures, slight crumple-like local warps. Deterministic with seed.
2. Bank realism: also generate ~50 DISTINCT fake reference pages that look like the real ones (render engineering-drawing-style pages + CNC程序单-style tables — matplotlib/PIL line art with title blocks, varying drawing numbers/geometry) so the bank isn't just 3 pages. Register all.
3. Eval `scripts/eval.py` → writes `eval/report.md`:
   - Register the 3 real pages + 50 synthetic pages.
   - Queries: 100 synthetic variants of each real page + 30 variants of a sample of fake pages + 20 "unknown page" queries (fake pages never registered) that must return no_match.
   - Metrics: top-1 accuracy on registered queries, false-match rate (wrong component returned as "match"), no_match precision/recall for unknowns, ambiguous rate, latency p50/p95 per stage (on this Mac, CPU).
   - Special section: IMG_7294-vs-7295 confusion test — variants of each must match their own page_id, table showing scores of correct vs. wrong candidate.
   - Target: ≥99% top-1 on synthetic variants, 0 false-match on the 7294/7295 pair, p50 match latency ≤ 2.5s CPU. Tune thresholds/keypoint budgets until met; if a target is impossible, document exactly why with numbers.
4. OPTIONAL time-boxed (≤30 min): try fetching public "same document photographed in multiple conditions" data — ICDAR SmartDoc 2015 challenge frames or similar — as an extra eval slice. If URLs are dead, note it and move on. Do not let this block the core deliverable.

## Deliverables checklist

- `app.py` (FastAPI), `matcher/` package (preprocess, embed, verify, score, bank), `scripts/get_models.py`, `scripts/synth.py`, `scripts/eval.py`, `tests/` (pytest: bank roundtrip, end-to-end register+match on real photos), `eval/report.md` (the numbers), `README.md` (how every stage works, every tunable threshold documented, how to run, how to deploy via Docker/run.sh), `requirements.txt` (pinned), `Dockerfile`, `run.sh`.
- Everything reproducible by: `./run.sh setup && ./run.sh eval && ./run.sh serve`.
- When finished, print a final summary of eval numbers to stdout.

Grind until the eval targets pass. Do not stub, do not fake numbers, do not return early.
