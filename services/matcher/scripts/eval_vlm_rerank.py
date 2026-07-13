"""Evaluate a Gemini Flash visual reranker on low-margin SSCD cases."""

from __future__ import annotations

import asyncio
import base64
import json
import re
import sys
import time
from pathlib import Path

import cv2
import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from matcher.preprocess import preprocess  # noqa: E402

PROJECT = ROOT.parents[1]
CROPS = ROOT / "testdata" / "external" / "smartdoc15-ch1" / "detector-crops"
CASES = ROOT / "eval" / "fusion_smartdoc15_detector_cases.json"
CACHE = ROOT / "eval" / "vlm_rerank_cases.json"
MODEL = "gemini-3.1-flash-lite"
ENDPOINT = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
MARGIN = 0.03


def api_key() -> str:
    for line in (PROJECT / ".env.local").read_text().splitlines():
        if line.startswith("GEMINI_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("GEMINI_API_KEY missing")


def images(directory: Path) -> list[Path]:
    return sorted(path for path in directory.iterdir() if path.suffix.lower() in {".jpg", ".jpeg"})


def inline_image(path: Path) -> dict:
    rgb = preprocess(path.read_bytes(), 512, False).rgb
    ok, encoded = cv2.imencode(
        ".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR),
        [cv2.IMWRITE_JPEG_QUALITY, 78],
    )
    if not ok:
        raise RuntimeError(f"could not encode {path}")
    return {"inlineData": {"mimeType": "image/jpeg", "data": base64.b64encode(encoded).decode()}}


def dataset() -> tuple[list[tuple[str, Path]], list[tuple[str, Path]]]:
    backgrounds = sorted(path for path in CROPS.iterdir() if path.is_dir())
    labels = sorted(path.name for path in backgrounds[0].iterdir() if path.is_dir())
    references: list[tuple[str, Path]] = []
    queries: list[tuple[str, Path]] = []
    for label in labels:
        first = images(backgrounds[0] / label)
        references.append((label, first[0]))
        for background in backgrounds:
            pool = [path for path in images(background / label) if path != first[0]]
            queries.extend((label, path) for path in pool[1:3])
    return references, queries


async def rerank(
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    key: str,
    query: Path,
    candidates: list[tuple[str, Path]],
) -> tuple[int, float, str]:
    parts: list[dict] = [{"text": (
        "Identify which candidate is the exact same printed document page as the QUERY, "
        "despite blur, lighting, stains, perspective, or partial occlusion. Compare distinctive "
        "text, graphics, and layout. Reply with only one digit: 1, 2, 3, 4, or 5.\nQUERY:"
    )}, inline_image(query)]
    for number, (_, path) in enumerate(candidates, 1):
        parts.extend([{"text": f"CANDIDATE {number}:"}, inline_image(path)])
    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"temperature": 0, "maxOutputTokens": 8},
    }
    async with semaphore:
        started = time.perf_counter()
        response = await client.post(ENDPOINT, headers={"x-goog-api-key": key}, json=body)
        latency = (time.perf_counter() - started) * 1000
    if response.status_code != 200:
        raise RuntimeError(f"Gemini {response.status_code}: {response.text[:300]}")
    raw = response.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    match = re.search(r"[1-5]", raw)
    if not match:
        raise RuntimeError(f"could not parse reranker response: {raw!r}")
    return int(match.group()) - 1, latency, raw


async def main_async() -> None:
    references, queries = dataset()
    ref_by_label = dict(references)
    cases = json.loads(CASES.read_text())
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    work = []
    for index, ((truth, query), case) in enumerate(zip(queries, cases)):
        ranked = sorted(
            (candidate for candidate in case["candidates"] if candidate["sscd_top5"]),
            key=lambda candidate: candidate["cosine"], reverse=True,
        )
        margin = ranked[0]["cosine"] - ranked[1]["cosine"]
        if margin < MARGIN:
            work.append((index, truth, query, ranked))

    key = api_key()
    semaphore = asyncio.Semaphore(4)
    async with httpx.AsyncClient(timeout=60, limits=httpx.Limits(max_connections=4)) as client:
        pending = []
        metadata = []
        for index, truth, query, ranked in work:
            cache_key = str(index)
            if cache_key in cache:
                continue
            candidate_paths = [(candidate["label"], ref_by_label[candidate["label"]]) for candidate in ranked]
            pending.append(asyncio.create_task(rerank(client, semaphore, key, query, candidate_paths)))
            metadata.append((cache_key, truth, ranked))
        for number, (meta, task) in enumerate(zip(metadata, pending), 1):
            choice, latency, raw = await task
            cache_key, truth, ranked = meta
            cache[cache_key] = {
                "truth": truth, "choice": choice, "prediction": ranked[choice]["label"],
                "candidates": [candidate["label"] for candidate in ranked],
                "latency_ms": round(latency, 1), "raw": raw,
            }
            if number % 10 == 0:
                print(f"reranked {number}/{len(pending)}", flush=True)
        CACHE.write_text(json.dumps(cache, indent=2))

    correct = 0
    fallbacks = 0
    for index, ((truth, _), case) in enumerate(zip(queries, cases)):
        ranked = sorted(
            (candidate for candidate in case["candidates"] if candidate["sscd_top5"]),
            key=lambda candidate: candidate["cosine"], reverse=True,
        )
        if str(index) in cache:
            prediction = cache[str(index)]["prediction"]
            fallbacks += 1
        else:
            prediction = ranked[0]["label"]
        correct += prediction == truth
    latencies = [item["latency_ms"] for item in cache.values()]
    report = {
        "queries": len(queries), "correct": correct,
        "accuracy_pct": round(correct / len(queries) * 100, 2),
        "fallbacks": fallbacks, "fallback_pct": round(fallbacks / len(queries) * 100, 2),
        "fallback_latency_p50_ms": round(sorted(latencies)[len(latencies) // 2], 1),
    }
    (ROOT / "eval" / "vlm_rerank_report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    asyncio.run(main_async())
