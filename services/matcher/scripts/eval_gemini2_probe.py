"""Evaluate Gemini Embedding 2 image retrieval on SmartDoc-QA.

The public benchmark images are resized before upload.  At current published
pricing this 150-image probe costs about USD $0.02.  Embeddings and timing data
are cached on the external SSD so the API is not called twice.
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
import time
from pathlib import Path

import cv2
import httpx
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from matcher.preprocess import preprocess  # noqa: E402


PROJECT = ROOT.parents[1]
EXT = ROOT / "testdata" / "external"
CACHE = ROOT / "eval" / "gemini2_smartdocqa_embeddings.npz"
REPORT = ROOT / "eval" / "gemini2_smartdocqa_report.json"
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent"


def api_key() -> str:
    for line in (PROJECT / ".env.local").read_text().splitlines():
        if line.startswith("GEMINI_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("GEMINI_API_KEY is missing from project .env.local")


def images(directory: Path) -> list[Path]:
    return sorted(path for path in directory.iterdir() if path.suffix.lower() in {".jpg", ".jpeg"})


def payload(path: Path) -> dict:
    rgb = preprocess(path.read_bytes(), 512, False).rgb
    ok, encoded = cv2.imencode(
        ".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR),
        [cv2.IMWRITE_JPEG_QUALITY, 80],
    )
    if not ok:
        raise RuntimeError(f"could not encode {path}")
    return {
        "content": {"parts": [{"inline_data": {
            "mime_type": "image/jpeg", "data": base64.b64encode(encoded).decode(),
        }}]},
        "output_dimensionality": 768,
    }


async def embed_one(
    client: httpx.AsyncClient, semaphore: asyncio.Semaphore, key: str, path: Path,
) -> tuple[np.ndarray, float]:
    body = payload(path)
    for attempt in range(5):
        async with semaphore:
            started = time.perf_counter()
            response = await client.post(ENDPOINT, headers={"x-goog-api-key": key}, json=body)
            latency = (time.perf_counter() - started) * 1000
        if response.status_code == 200:
            vector = np.asarray(response.json()["embedding"]["values"], np.float32)
            vector /= max(float(np.linalg.norm(vector)), 1e-9)
            return vector, latency
        if response.status_code not in {429, 500, 502, 503, 504}:
            raise RuntimeError(f"Gemini API {response.status_code}: {response.text[:300]}")
        await asyncio.sleep(2 ** attempt)
    raise RuntimeError(f"Gemini API retries exhausted for {path.name}")


async def download_stable(paths: list[Path]) -> tuple[np.ndarray, np.ndarray]:
    key = api_key()
    semaphore = asyncio.Semaphore(8)
    async with httpx.AsyncClient(timeout=45, limits=httpx.Limits(max_connections=8)) as client:
        tasks = [asyncio.create_task(embed_one(client, semaphore, key, path)) for path in paths]
        completed = 0
        for future in asyncio.as_completed(tasks):
            await future
            completed += 1
            if completed % 25 == 0:
                print(f"embedded {completed}/{len(paths)}", flush=True)
        results = [task.result() for task in tasks]
    return np.stack([item[0] for item in results]), np.asarray([item[1] for item in results])


def main() -> None:
    captures = EXT / "smartdoc-qa" / "captures"
    pages = sorted(path for path in captures.iterdir() if path.is_dir())
    labels: list[str] = []
    paths: list[Path] = []
    is_reference: list[bool] = []
    for page in pages:
        for number, path in enumerate(images(page)):
            labels.append(page.name)
            paths.append(path)
            is_reference.append(number == 0)

    if CACHE.exists():
        cached = np.load(CACHE)
        vectors = cached["vectors"]
        latencies = cached["latencies"]
    else:
        vectors, latencies = asyncio.run(download_stable(paths))
        np.savez_compressed(
            CACHE, vectors=vectors, latencies=latencies,
            labels=np.asarray(labels), paths=np.asarray([str(path.relative_to(EXT)) for path in paths]),
            is_reference=np.asarray(is_reference),
        )

    ref_indices = np.flatnonzero(is_reference)
    query_indices = np.flatnonzero(np.logical_not(is_reference))
    ref_vectors = vectors[ref_indices]
    ref_labels = np.asarray(labels)[ref_indices]
    similarities = np.einsum(
        "qd,rd->qr", vectors[query_indices].astype(np.float64), ref_vectors.astype(np.float64),
        optimize=True,
    )
    order = np.argsort(-similarities, axis=1)
    truths = np.asarray(labels)[query_indices]
    top1 = int(np.sum(ref_labels[order[:, 0]] == truths))
    top5 = int(sum(truth in ref_labels[row[:5]] for truth, row in zip(truths, order)))
    report = {
        "references": int(len(ref_indices)), "queries": int(len(query_indices)),
        "top1": top1, "top1_pct": round(top1 / len(query_indices) * 100, 2),
        "top5": top5, "top5_pct": round(top5 / len(query_indices) * 100, 2),
        "api_latency_p50_ms": round(float(np.percentile(latencies, 50)), 1),
        "api_latency_p95_ms": round(float(np.percentile(latencies, 95)), 1),
    }
    REPORT.write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
