# Yingma Page Matcher

Production-oriented physical-sheet copy detection for photographed factory paperwork. The matcher deliberately combines global retrieval with local geometric proof: visually similar forms are shortlisted cheaply, but no page is accepted from semantic or layout similarity alone.

## Reproduce

Python 3.12 is required. All state, dependencies, and downloaded weights remain under this directory.

```bash
./run.sh setup
./run.sh eval
./run.sh serve
```

`setup` creates `.venv` when needed, installs pinned packages, downloads the official `sscd_disc_mixup.torchscript.pt`, and instantiates SuperPoint and LightGlue so their release weights are downloaded before first traffic. `eval` recreates a 53-page bank and writes `eval/report.md`. `serve` listens on port 8788. Run tests with `./run.sh test`.

Environment:

- `MATCHER_TOKEN` — bearer token, default `dev`.
- `MATCHER_DATA` — persistent bank root, default `./data`.
- `MATCHER_MODELS` — model directory, default `./models`.
- Every threshold below can be overridden by its named environment variable.

Example:

```bash
curl -H 'Authorization: Bearer dev' \
  -F page_id=packet-42-op1 -F component_id=component-42 -F kind=program \
  -F image=@page.jpg http://localhost:8788/register

curl -H 'Authorization: Bearer dev' \
  -F image=@floor-photo.jpg http://localhost:8788/match
```

`POST /register` also accepts the form field `image_url` instead of `image`. Re-registering a `page_id` atomically replaces its image, vector, features, and metadata. Other endpoints are `DELETE /pages/{page_id}`, authenticated `GET /stats`, and unauthenticated `GET /healthz`.

## Pipeline

1. Pillow applies EXIF orientation. The image is converted to RGB and reduced to a 1600-pixel long side. Conservative quadrilateral rectification exists and can be enabled with `MATCHER_DOC_CROP=1`; failing to find a page boundary is never an error.
2. SSCD receives a single batch containing the query at 0, 90, 180, and 270 degrees. The maximum cosine over rotations ranks the persistent embedding bank, and the best rotation is retained per candidate.
3. The eight best vectors form the shortlist. SuperPoint is extracted once for each query rotation actually needed. Reference SuperPoint keypoints, scores, descriptors, and image size are loaded from registration-time `.npz` caches.
4. LightGlue matches local features. OpenCV `findHomography` with `USAC_MAGSAC` and a 3-pixel threshold rejects inconsistent correspondences.
5. Inliers must span at least 8 distinct cells of a 4x4 reference grid. This prevents a shared logo, heading, or title block from proving identity.
6. Reference Canny edges are warped through the homography. Symmetric overlap against dilated query/reference edges measures agreement over the visible warp.
7. Candidates rank by `inliers * inlier_ratio * occupied_grid_cells * edge_agreement`, never raw match count. A candidate must pass every independent gate. Two passing, highly similar candidates within the score margin produce `ambiguous`.

If the SSCD winner has a wide cosine lead, the engine exits early only after that winner passes every geometric gate. A failed winner causes verification to continue down the shortlist.

## Persistence

`MATCHER_DATA/bank.db` stores page metadata and float32 SSCD vectors. Originals (normalized registration JPEGs) live in `pages/`; compressed SuperPoint tensors live in `features/`. SQLite uses WAL mode. Filenames are SHA-256-derived rather than using untrusted `page_id` text. The intended bank size is a few thousand pages, for which an in-memory NumPy cosine matrix is simpler and fast enough.

## Tunables

Defaults are defined in `matcher/config.py` and are included in `GET /stats` and the evaluation report.

| Environment variable | Default | Meaning |
|---|---:|---|
| `MATCHER_MAX_SIDE` | 1600 | Preprocessed long side |
| `MATCHER_EMBED_SIZE` | 320 | SSCD square input |
| `MATCHER_FEATURE_RESIZE` | 768 | SuperPoint extraction long side |
| `MATCHER_MAX_KEYPOINTS` | 768 | SuperPoint budget per page |
| `MATCHER_SHORTLIST_K` | 8 | Cosine shortlist size |
| `MATCHER_VERIFY_K` | 5 | Maximum candidates geometrically checked |
| `MATCHER_MIN_COSINE` | 0.20 | Lowest acceptable SSCD similarity |
| `MATCHER_MIN_INLIERS` | 35 | Minimum MAGSAC inlier count |
| `MATCHER_MIN_INLIER_RATIO` | 0.22 | Minimum inliers / LightGlue matches |
| `MATCHER_MIN_COVERAGE` | 8 | Minimum occupied 4x4 cells |
| `MATCHER_MIN_EDGE` | 0.10 | Minimum symmetric edge overlap |
| `MATCHER_MIN_SCORE` | 300.0 | Minimum composite score |
| `MATCHER_H_THRESHOLD` | 3.0 | MAGSAC reprojection threshold in pixels |
| `MATCHER_EARLY_COSINE_MARGIN` | 0.08 | Lead needed for post-proof early exit |
| `MATCHER_AMBIGUOUS_MARGIN` | 0.18 | Maximum relative top-two score gap for ambiguity |
| `MATCHER_AMBIGUOUS_COSINE` | 0.72 | Second candidate similarity required for ambiguity |

The independent gates are intentional. Lowering only the composite threshold cannot compensate for title-block-only coverage, too few inliers, or weak edge agreement.

## Synthetic data and evaluation

`scripts/synth.py` renders distinct engineering drawings and CNC program tables with unique geometry, rows, drawing numbers, checksums, stamps, and pen marks. Its phone-photo augmentation includes deterministic perspective distortion, quadrant rotation and ±15-degree roll, 60–100% crops, desk/machine texture, warm illumination, directional shadow, glare, crumple displacement, motion blur, sensor noise, JPEG quality 30–80, and hand/tool-like occlusion.

The default evaluation registers the three supplied photographs and 50 rendered physical sheets. It queries 100 independently augmented copies of each real sheet, 30 registered fake-sheet copies, and 20 unregistered sheets. The report includes top-1/error decisions, no-match precision and recall, ambiguity, per-stage p50/p95 latency, and per-variant correct/wrong geometric scores for IMG_7294 versus IMG_7295. Raw case data is written to ignored `eval/results.json` for tuning.

For short diagnostics, counts can be reduced without changing the default deliverable:

```bash
./run.sh eval --real-variants 2 --fake-variants 2 --unknown 2 --reuse-bank
```

## Deployment

The image is CPU-only linux/amd64 and persists the bank at `/data`:

```bash
docker build --platform linux/amd64 -t yingma-matcher .
docker run --rm --platform linux/amd64 -p 8788:8788 \
  -e MATCHER_TOKEN='replace-me' -v matcher-data:/data yingma-matcher
```

On a non-container host, install Python 3.12, run `./run.sh setup`, set the token and data path, then supervise `./run.sh serve`. Do not use multiple Uvicorn workers against one CPU model instance unless memory has been sized for one complete model set per worker.

## Models and licenses

- SSCD is downloaded from the official Facebook Research artifact endpoint by `scripts/get_models.py`; the upstream code is MIT licensed.
- LightGlue is pinned to commit `eb42fee2d71449efb0aa5c10549752b5d75384d8`; LightGlue weights/code are Apache-2.0. SuperPoint has its separate upstream license, which should be reviewed for the intended commercial deployment.

The SSCD endpoint was reachable during this build; DINOv2 fallback was not used.
