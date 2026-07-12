# DocUNet Benchmark (CVPR 2018) — crop set + partial scans

## Source
- Project page: https://www3.cs.stonybrook.edu/~cvl/docunet.html
- crop.zip (281 MB, downloaded in full): http://vision.cs.stonybrook.edu/~kema/docwarp/crop.zip
- scan.zip (416 MB, 17 of 65 files fetched via HTTP range requests): http://vision.cs.stonybrook.edu/~kema/docwarp/scan.zip
- Also available, not downloaded: original.zip (uncropped photos, 328 MB), eval.zip (1 MB).

## License
No explicit license; authors request citation:
Ma, Shu, Bai, Wang, Samaras. "DocUNet: Document Image Unwarping via A Stacked U-Net", CVPR 2018.

## What this is
65 distinct paper documents (receipts, letters, magazines, academic papers), each physically
distorted TWICE (curved, folded, crumpled) and photographed with mobile cameras indoors and
outdoors: 130 photos total. Ground truth flat versions come from a flatbed scanner.

## Layout
- crop/<page>_<shot> copy.png — page in 1..65, shot in {1,2}; document-centered crops of the
  two distorted photos of the same physical page (this is the set papers evaluate on).
- scan/<page>.png — flatbed scan (flat reference) for pages 1,5,9,...,65 (every 4th page,
  17 refs; the rest were skipped to stay inside the download budget — same URL above).

## Ground-truth page identity
Filename prefix number = page identity: crop/12_1 and crop/12_2 are two different physical
distortions + captures of the SAME page; scan/12.png (when present) is its flat reference.

## Conditions
Crumple/curve/fold distortion, indoor + outdoor illumination, varied camera angle.
Only 2 captures per page — use as a hard warp/crumple probe set, not as a
many-captures-per-page retrieval set.
