"""Build a realistic handheld document-matching lab from SmartDoc15."""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "testdata" / "external" / "smartdoc15-ch1"
OUTPUT = ROOT / "testdata" / "matcher-lab-100"
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".tif", ".tiff"}


def images(directory: Path) -> list[Path]:
    return sorted(path for path in directory.iterdir() if path.suffix.lower() in IMAGE_SUFFIXES)


def thumbnail(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
        image.thumbnail((640, 640), Image.Resampling.LANCZOS)
        image.save(destination, "JPEG", quality=86, optimize=True)


def copy_asset(source: Path, relative: Path) -> tuple[str, str]:
    destination = OUTPUT / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    thumb = Path("thumbnails") / relative.with_suffix(".jpg")
    thumbnail(source, OUTPUT / thumb)
    return relative.as_posix(), thumb.as_posix()


def main() -> None:
    if not SOURCE.exists():
        raise RuntimeError(f"SmartDoc15 source is missing: {SOURCE}")
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    OUTPUT.mkdir(parents=True)

    frame_root = SOURCE / "frames"
    backgrounds = sorted(path for path in frame_root.iterdir() if path.is_dir())
    labels = sorted(path.name for path in backgrounds[0].iterdir() if path.is_dir())
    records: list[dict] = []

    for label in labels:
        reference_frames = images(backgrounds[0] / label)
        reference_source = reference_frames[0]
        suffix = reference_source.suffix.lower()
        asset, thumb = copy_asset(reference_source, Path("references") / f"sd-{label}{suffix}")

        variants = []
        descriptions = (
            "closer handheld view",
            "left or right camera angle",
            "rotated handheld view",
            "wider view with partial crop",
        )
        for background, description in zip(backgrounds[:4], descriptions):
            shots = images(background / label)
            pool = [shot for shot in shots if shot != reference_source]
            shot = pool[min(1, len(pool) - 1)]
            variant_id = f"view-{background.name[-2:]}"
            variant_asset, variant_thumb = copy_asset(
                shot,
                Path("angle-zoom-crop") / f"sd-{label}" / f"{variant_id}{shot.suffix.lower()}",
            )
            variants.append({
                "id": variant_id,
                "label": description,
                "asset": variant_asset,
                "thumbnail": variant_thumb,
                "source": str(shot),
            })

        records.append({
            "id": f"sd-{label}",
            "label": f"SmartDoc · {label}",
            "family": "handheld-angle-zoom-crop",
            "asset": asset,
            "thumbnail": thumb,
            "source": str(reference_source),
            "variants": variants,
        })

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "root": str(OUTPUT),
        "referenceCount": len(records),
        "variantCount": sum(len(record["variants"]) for record in records),
        "chosenCount": len(records),
        "documents": records,
        "dataset": {
            "name": "ICDAR 2015 SmartDoc Challenge 1",
            "source": "https://zenodo.org/records/1230218",
            "license": "CC BY 4.0",
            "profile": "clear handheld documents with angle, zoom, rotation, and partial crop",
        },
    }
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    (OUTPUT / "README.md").write_text(
        "# Realistic Matcher Lab\n\n"
        "30 distinct documents and 120 real smartphone frames from the official ICDAR 2015 "
        "SmartDoc Challenge 1 dataset (CC BY 4.0). Queries vary camera angle, zoom, "
        "rotation, crop, and background while keeping the document clearly visible. "
        "No crumpling or synthetic damage is included.\n"
    )
    print(json.dumps({
        "root": str(OUTPUT),
        "references": len(records),
        "realisticQueries": manifest["variantCount"],
    }, indent=2))


if __name__ == "__main__":
    main()
