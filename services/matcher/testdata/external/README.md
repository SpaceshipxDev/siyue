# External evaluation datasets — same physical page, multiple messy captures

Downloaded 2026-07-11. Each dataset directory has a MANIFEST.md with source URL, license,
layout, and how ground-truth page identity is encoded. Total downloaded ~1.95 GB (budget 2 GB);
archives were deleted after curation.

| Dataset | Pages | Captures/page | Resolution | Conditions | Identity ground truth |
|---|---|---|---|---|---|
| `smartdoc-qa/` | 15 (of 30; refs+GT for all 30) | 10 (of 142 available) | 4128x3096 | 5 lighting setups incl. cast/grid shadow, perspective angles, motion blur, out-of-focus blur, single+multiple distortions | `captures/page_N/` dir = `references/page_N.*` = `ground_truth/page_N.txt`; D-field in filename |
| `smartdoc15-ch1/` | 30 | 30 (6 frames x 5 backgrounds; of ~830 available) | 1920x1080 | hand-held video frames: motion/focus blur, perspective, illumination change, partial occlusion, 5 different backgrounds/scenes | directory name `background0X/<model>/`; 30 model classes; per-frame page quad in `metadata.csv.gz` |
| `docunet/` | 65 (flat scans for 17) | 2 | ~2000px crops | physical curving/folding/crumpling, indoor+outdoor scenes, varied angle | filename `crop/<page>_<shot>` pairs; `scan/<page>.png` flat reference |

Guidance:
- Retrieval/matching eval with many probes per page: use `smartdoc-qa` (high-res photos) and
  `smartdoc15-ch1` (low-res video frames, harder: occlusion + background clutter).
- Hard geometric-distortion probe set: `docunet` (crumpled/warped, only 2 shots per page).

Not downloaded (budget): SmartDoc-QA Nokia captures + remaining 15 pages (in the 13.66 GB
Zenodo zip, extractable via HTTP ranges — see smartdoc-qa/MANIFEST.md), smartdoc15-ch1
pristine page models (models.tar.gz, 409 MB), DocUNet original uncropped photos (328 MB) and
remaining 48 scans.
