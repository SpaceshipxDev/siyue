# SmartDoc 2015 — Challenge 1 (curated subset)

## Source
- Archive: https://github.com/jchazalon/smartdoc15-ch1-dataset/releases/download/v2.0.0/frames.tar.gz (1019 MB, sha256 list in same release)
- Project: https://github.com/jchazalon/smartdoc15-ch1-dataset (also Zenodo original: https://zenodo.org/record/1230218)
- Pristine page images (NOT downloaded, 409 MB): https://github.com/jchazalon/smartdoc15-ch1-dataset/releases/download/v2.0.0/models.tar.gz

## License
Creative Commons Attribution 4.0 International (CC BY 4.0). Cite:
Burie et al., "ICDAR2015 Competition on Smartphone Document Capture and OCR (SmartDoc)", ICDAR 2015.
Full text in ./LICENCE.

## What this is
30 distinct A4 printed pages (6 types x 5 docs: datasheet, letter, magazine, paper, patent, tax),
each hand-held video-captured with a Nexus 7 (1920x1080) over 5 different backgrounds
(background05 = strong occlusions/lighting). Frames show motion blur, out-of-focus blur,
perspective, illumination change, partial occlusion. "Model classification" (page identity
per frame) is an official task of this dataset.

## Curation applied
Full archive has 24,894 frames (150 videos, ~166 frames/video). Kept 6 frames per video,
evenly spaced across each clip: 30 pages x 5 backgrounds x 6 frames = 900 captures
(30 captures per page). Archive deleted after extraction.

## Layout
- frames/background0{1..5}/<model><NNN>/frame_XXXX.jpeg
- metadata.csv.gz — per-frame ground truth for ALL original frames (model id, quad corner
  coordinates of the page in the frame); keyed by background/model/frame filename.
- README.md, LICENCE, VERSION, original_datasets_files.txt — from archive root.

## Ground-truth page identity
Directory name = page identity: datasheet001 ... tax005 (30 classes). Same directory name
under different background0X dirs = the SAME physical printed page. metadata.csv.gz
additionally gives the page's quadrilateral in every frame.
