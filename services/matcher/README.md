# Yingma Page Matcher

Production-oriented visual matching for job photos. Drawings, program sheets,
labels, product views, fixtures, and later phone photos can all be enrolled as
references. The matcher combines global retrieval with local geometric proof:
visually similar images are shortlisted cheaply, but no reference is accepted
from semantic or layout similarity alone.

## Reproduce

Python 3.12 is required. All state, dependencies, datasets, evaluation artifacts,
and downloaded weights remain under this directory on the external SSD.

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
- `GEMINI_API_KEY` — optional. When present, registration caches a Gemini
  Embedding 2 vector and local `no_match` decisions use it as the deformation
  fallback. Normal matching never waits for Gemini.
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

1. Pillow applies EXIF orientation and bounds the image to 1600 pixels. A
   deterministic contour rectifier handles sheets that fill most of the frame.
   Otherwise a 5.9 MB MobileNetV3 corner regressor localizes pages in clutter
   in about 42–51 ms CPU. Already document-centred images are not unnecessarily
   re-warped.
2. SSCD receives a single batch containing the query at 0, 90, 180, and 270 degrees. The maximum cosine over rotations ranks the persistent embedding bank, and the best rotation is retained per candidate.
3. A cosine lead of at least 0.03 is the fast path: only the winner receives a
   reduced-budget geometric proof. A smaller margin activates a five-candidate
   rerank. SuperPoint uses 288 cached keypoints at 416px.
4. LightGlue matches local features. OpenCV `findHomography` with
   `USAC_MAGSAC` supplies correspondence evidence. Candidate identity ranking
   uses inlier consensus first.
5. Accepted local candidates require at least 10 inliers, 0.11 inlier ratio,
   and coverage of 3 cells in the 4x4 reference grid.
6. Reference Canny edges are warped through the homography. Symmetric overlap against dilated query/reference edges measures agreement over the visible warp.
7. If local evidence abstains and cached Gemini vectors are available,
   `gemini-embedding-2` resolves the non-planar/deformation tail. Responses
   expose `via: local|gemini_embedding_2`.

The local fast path remains entirely offline. Gemini is never called for a
locally accepted query.

## Persistence

`MATCHER_DATA/bank.db` stores page metadata, float32 SSCD vectors, and optional
Gemini vectors. Originals (normalized registration JPEGs) live in `pages/`;
compressed SuperPoint tensors live in `features/`. SQLite migrations add the
Gemini columns to existing banks in place. Filenames are SHA-256-derived rather
than using untrusted `page_id` text.

## Tunables

Defaults are defined in `matcher/config.py` and are included in `GET /stats` and the evaluation report.

| Environment variable | Default | Meaning |
|---|---:|---|
| `MATCHER_MAX_SIDE` | 1600 | Preprocessed long side |
| `MATCHER_EMBED_SIZE` | 320 | SSCD square input |
| `MATCHER_FEATURE_RESIZE` | 416 | SuperPoint extraction long side |
| `MATCHER_MAX_KEYPOINTS` | 288 | SuperPoint budget per page |
| `MATCHER_SHORTLIST_K` | 8 | Cosine shortlist size |
| `MATCHER_VERIFY_K` | 5 | Maximum candidates geometrically checked |
| `MATCHER_MIN_COSINE` | 0.20 | Lowest acceptable SSCD similarity |
| `MATCHER_MIN_INLIERS` | 10 | Minimum MAGSAC inlier count |
| `MATCHER_MIN_INLIER_RATIO` | 0.11 | Minimum inliers / LightGlue matches |
| `MATCHER_MIN_COVERAGE` | 3 | Minimum occupied 4x4 cells |
| `MATCHER_MIN_EDGE` | 0.10 | Minimum symmetric edge overlap |
| `MATCHER_MIN_SCORE` | 300.0 | Minimum composite score |
| `MATCHER_H_THRESHOLD` | 3.0 | MAGSAC reprojection threshold in pixels |
| `MATCHER_EARLY_COSINE_MARGIN` | 0.03 | Lead needed for one-candidate fast path |
| `MATCHER_AMBIGUOUS_MARGIN` | 0.18 | Maximum relative top-two score gap for ambiguity |
| `MATCHER_AMBIGUOUS_COSINE` | 0.72 | Second candidate similarity required for ambiguity |

`MATCHER_LEARNED_CROP=0` disables the MobileNet page detector. The legacy
`MATCHER_DOC_CROP` switch remains for deployments without the learned model.

## Real external evaluation (v2)

These are end-to-end `MatcherEngine` results, not retrieval-only probes:

| Slice | Accuracy | Wrong | Abstain | p50 | p95 |
|---|---:|---:|---:|---:|---:|
| SmartDoc-QA phone distortion, 135 queries | 98.52% | 0 | 2 | 506 ms | 677 ms |
| SmartDoc15 clutter/video, 300 queries | 96.33% | 1 | 10 | 557 ms | 770 ms |
| DocUNet crumpled + Gemini fallback, 65 queries | 95.38% | 3 | 0 | 556 ms | 2087 ms |
| SmartDoc15 with 250-page bank, 300 queries | 96.33% | 1 | 10 | 533 ms | 676 ms |

Gemini handled 21/65 DocUNet queries; normal local queries remained sub-second.
The accepted 95% target is met on all three real datasets.

This operating point is **closed-set**: the caller asserts that a query is one
of the enrolled documents. It is not a calibrated open-set recognizer. In the
SmartDoc-QA exclusion test, only 15/50 unknown pages were rejected locally.
Do not use a returned identity as proof that an arbitrary unknown page was
enrolled; add an explicit unknown/confirmation model for that separate use case.

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
- The MobileNetV3 paper-corner regressor is trained by
  `scripts/train_doc_detector.py` from the CC BY 4.0 SmartDoc15 annotations.
  Its held-out-page median polygon IoU is 0.824; the trained 5.9 MB state dict
  is included under `models/`.
- Gemini Embedding 2 is optional and billed by Google. The benchmark used far
  less than USD $1 of the provided cap; no remote model is on the normal path.

The SSCD endpoint was reachable during this build; DINOv2 fallback was not used.
