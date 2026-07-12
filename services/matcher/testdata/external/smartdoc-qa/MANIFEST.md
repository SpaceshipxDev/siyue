# SmartDoc-QA (CBDAR@ICDAR 2015) — curated subset

## Source
- Zenodo record: https://zenodo.org/records/5293201 (single archive "Dataset SmartDoc-QA.zip", 13.66 GB)
- Project page: http://smartdoc.univ-lr.fr/smartdoc-qa/
- Acquisition note: the full 13.66 GB zip exceeded the download budget; this subset was pulled
  file-by-file out of the remote zip via HTTP range requests (central-directory parsing), so
  every file here is byte-identical to the one inside the official archive.

## License
CC BY 4.0 (per Zenodo record; full text in ./SmartDoc-QA_Dataset_License.pdf). Cite:
N. Nayef et al., "SmartDoc-QA: A Dataset for Quality Assessment of Smartphone Captured
Document Images - Single and Multiple Distortions", CBDAR 2015.

## What this is
30 physical printed pages (10 modern documents, 10 old administrative letters from the Tobacco
dataset, 10 real shop receipts), each photographed 142 times (71 per phone: Samsung Galaxy S4
"Android", Nokia Lumia 920 "WP") under controlled messy conditions:
- Lighting L1..L5 (daylight, neon, night+lamp, lamp+cast shadow, lamp+grid shadow)
- Perspective angles a in {-10,-5,0,5}, b in {-5,0,5,10} degrees, 35 cm distance
- Motion blur (Mb1 horizontal, Mb2 2D) and out-of-focus blur (Ob1..Ob4)
- S_ prefix = single distortion, M_ prefix = multiple simultaneous distortions
Full-resolution 4128x3096 JPEGs with EXIF.

## Curation applied
Kept 15 of 30 pages (odd document numbers D1,D3,...,D29) x 10 Samsung captures each
(7 stratified from the 60-image multi-distortion set + 3 from the 11-image single-distortion
set) = 150 captures, ~500 MB. Nokia captures and per-image OCR outputs/accuracy files were
not downloaded. References + transcriptions kept for ALL 30 pages.

## Layout
- captures/page_<N>/<original filename>.jpg — N = document number from the filename's D field.
  Filename encodes all capture parameters (see README.txt "Format of file name").
- references/page_<N>.{pdf,tif,jpg} — the original source document (all 30 pages).
- ground_truth/page_<N>.txt — manually keyed text transcription (all 30 pages).
- README.txt — official dataset README. SmartDoc-QA_Dataset_License.pdf — license.

## Ground-truth page identity
captures/page_N/* are all photos of the SAME physical page; references/page_N.* is the source
document; ground_truth/page_N.txt its transcription. The D<N> field inside each capture
filename is the authoritative identity link (per official README).
