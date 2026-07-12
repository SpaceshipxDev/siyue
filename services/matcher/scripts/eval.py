#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from matcher.config import Settings
from matcher.engine import MatcherEngine
from matcher.preprocess import decode_image
from scripts.synth import augment_image, fake_reference, jpeg_bytes

REAL = ["IMG_7293.jpeg", "IMG_7294.jpeg", "IMG_7295.jpeg"]


def percentile(values: list[float], p: int) -> float:
    return round(float(np.percentile(values, p)), 2) if values else 0.0


def case_result(result: dict, expected_page: str | None, category: str, index: int) -> dict:
    best = result.get("best") or {}
    candidates = result.get("candidates") or []
    return {
        "category": category, "index": index, "expected_page": expected_page,
        "decision": result["decision"], "best_page": best.get("page_id"),
        "best_component": best.get("component_id"), "score": best.get("score", 0),
        "cosine": best.get("cosine", 0), "latency_ms": result["latency_ms"],
        "stages": result["stages"], "candidates": candidates,
    }


def register_bank(engine: MatcherEngine, real_dir: Path) -> None:
    engine.bank.clear()
    for name in REAL:
        page = Path(name).stem.lower()
        engine.register((real_dir / name).read_bytes(), page, f"component-{page}", "drawing" if "7293" in name else "program")
        print(f"registered {page}", flush=True)
    for index in range(50):
        engine.register(jpeg_bytes(fake_reference(index)), f"fake-{index:03d}", f"component-fake-{index:03d}",
                        "drawing" if index % 2 == 0 else "program")
        if (index + 1) % 10 == 0:
            print(f"registered synthetic pages: {index + 1}/50", flush=True)


def build_report(cases: list[dict], elapsed: float, args: argparse.Namespace, settings: Settings) -> tuple[str, dict]:
    registered = [case for case in cases if case["expected_page"] is not None]
    unknown = [case for case in cases if case["expected_page"] is None]
    top1_correct = sum(case["best_page"] == case["expected_page"] for case in registered)
    false_matches = sum(case["decision"] == "match" and case["best_page"] != case["expected_page"] for case in registered)
    predicted_no_match = [case for case in cases if case["decision"] == "no_match"]
    unknown_no_match = sum(case["decision"] == "no_match" for case in unknown)
    no_match_precision = unknown_no_match / len(predicted_no_match) if predicted_no_match else 0.0
    no_match_recall = unknown_no_match / len(unknown) if unknown else 0.0
    ambiguous = sum(case["decision"] == "ambiguous" for case in registered)
    stage_names = ["embed_ms", "shortlist_ms", "verify_ms"]
    latency = {name: {
        "p50": percentile([case["stages"][name] for case in cases], 50),
        "p95": percentile([case["stages"][name] for case in cases], 95),
    } for name in stage_names}
    latency["total_ms"] = {
        "p50": percentile([case["latency_ms"] for case in cases], 50),
        "p95": percentile([case["latency_ms"] for case in cases], 95),
    }
    pair = [case for case in registered if case["category"] in {"IMG_7294", "IMG_7295"}]
    pair_false = sum(case["decision"] == "match" and case["best_page"] != case["expected_page"] for case in pair)
    summary = {
        "registered_queries": len(registered), "unknown_queries": len(unknown),
        "top1_correct": top1_correct, "top1_accuracy": top1_correct / len(registered) if registered else 0,
        "false_matches": false_matches, "false_match_rate": false_matches / len(registered) if registered else 0,
        "no_match_precision": no_match_precision, "no_match_recall": no_match_recall,
        "ambiguous": ambiguous, "ambiguous_rate": ambiguous / len(registered) if registered else 0,
        "pair_queries": len(pair), "pair_false_matches": pair_false, "latency": latency,
        "wall_seconds": round(elapsed, 2),
    }
    status = {
        "top1_accuracy_ge_99pct": summary["top1_accuracy"] >= .99,
        "pair_false_matches_zero": pair_false == 0,
        "p50_latency_le_2500ms": latency["total_ms"]["p50"] <= 2500,
    }
    lines = [
        "# Yingma Page Matcher Evaluation", "",
        f"Generated deterministically with seed `{args.seed}` on `{os.uname().machine}` using Python `{sys.version.split()[0]}`.",
        "The bank contains 3 real photographed sheets and 50 distinct rendered sheets.", "",
        "## Target results", "",
        "| Metric | Result | Target | Pass |", "|---|---:|---:|:---:|",
        f"| Registered-query top-1 accuracy | {summary['top1_accuracy']:.2%} ({top1_correct}/{len(registered)}) | >=99% | {'yes' if status['top1_accuracy_ge_99pct'] else 'no'} |",
        f"| IMG_7294/IMG_7295 false matches | {pair_false}/{len(pair)} | 0 | {'yes' if status['pair_false_matches_zero'] else 'no'} |",
        f"| Match latency p50 | {latency['total_ms']['p50']:.2f} ms | <=2500 ms CPU | {'yes' if status['p50_latency_le_2500ms'] else 'no'} |",
        "", "## Decision metrics", "",
        f"- False-match rate: {summary['false_match_rate']:.2%} ({false_matches}/{len(registered)})",
        f"- Unknown/no-match precision: {no_match_precision:.2%}",
        f"- Unknown/no-match recall: {no_match_recall:.2%} ({unknown_no_match}/{len(unknown)})",
        f"- Ambiguous rate on registered queries: {summary['ambiguous_rate']:.2%} ({ambiguous}/{len(registered)})",
        "", "## CPU latency", "",
        "| Stage | p50 | p95 |", "|---|---:|---:|",
    ]
    for name in ["embed_ms", "shortlist_ms", "verify_ms", "total_ms"]:
        lines.append(f"| {name} | {latency[name]['p50']:.2f} ms | {latency[name]['p95']:.2f} ms |")
    lines += ["", "## IMG_7294 vs IMG_7295 confusion test", "",
              "The table reports the composite geometric score for the correct sheet and the other near-identical program sheet. A dash means the wrong sheet was outside the geometrically verified top five.", "",
              "| Query | Variant | Decision | Top page | Correct score | Wrong-page score |", "|---|---:|---|---|---:|---:|"]
    for case in pair:
        expected = case["expected_page"]
        wrong = "img_7295" if expected == "img_7294" else "img_7294"
        by_page = {candidate["page_id"]: candidate for candidate in case["candidates"]}
        correct_score = by_page.get(expected, {}).get("score", 0)
        wrong_score = by_page.get(wrong, {}).get("score", "—")
        lines.append(f"| {case['category']} | {case['index']} | {case['decision']} | {case['best_page']} | {correct_score} | {wrong_score} |")
    failures = [case for case in registered if case["best_page"] != case["expected_page"]]
    unknown_failures = [case for case in unknown if case["decision"] != "no_match"]
    lines += ["", "## Errors", "", f"Top-1 errors: **{len(failures)}**. Unknown false accepts: **{len(unknown_failures)}**."]
    if failures:
        lines += ["", "| Category | Variant | Expected | Returned | Decision | Score |", "|---|---:|---|---|---|---:|"]
        for case in failures:
            lines.append(f"| {case['category']} | {case['index']} | {case['expected_page']} | {case['best_page']} | {case['decision']} | {case['score']} |")
    lines += ["", "## Tuned acceptance thresholds", "", "```json", json.dumps({
        key: value for key, value in vars(settings).items() if key.startswith("min_") or key in {
            "max_keypoints", "feature_resize", "shortlist_k", "verify_k", "early_cosine_margin",
            "ambiguous_score_margin", "homography_threshold"
        }
    }, indent=2, default=str), "```", "", f"Full evaluation wall time: {elapsed:.2f} seconds.", ""]
    return "\n".join(lines), {"summary": summary, "targets": status, "cases": cases}


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate the complete page matching pipeline")
    parser.add_argument("--seed", type=int, default=20260711)
    parser.add_argument("--real-variants", type=int, default=100)
    parser.add_argument("--fake-variants", type=int, default=30, help="total variants across sampled registered fake pages")
    parser.add_argument("--unknown", type=int, default=20)
    parser.add_argument("--reuse-bank", action="store_true")
    parser.add_argument("--data", type=Path, default=ROOT / "data" / "eval")
    parser.add_argument("--report", type=Path, default=ROOT / "eval" / "report.md")
    args = parser.parse_args()
    real_dir = ROOT / "testdata" / "real"
    settings = Settings(data_dir=args.data, model_dir=ROOT / "models")
    engine = MatcherEngine(settings)
    if not args.reuse_bank or engine.bank.count() != 53:
        register_bank(engine, real_dir)
    else:
        print("reusing 53-page evaluation bank", flush=True)
    cases: list[dict] = []
    started = time.perf_counter()
    for real_index, name in enumerate(REAL):
        source = decode_image((real_dir / name).read_bytes())
        rng = np.random.default_rng(args.seed + real_index * 100_003)
        expected = Path(name).stem.lower()
        for index in range(args.real_variants):
            query = jpeg_bytes(augment_image(source, rng), 94)
            result = engine.match(query)
            cases.append(case_result(result, expected, Path(name).stem, index))
            print(f"{Path(name).stem}: {index+1}/{args.real_variants} -> {result['decision']} {result.get('best',{}).get('page_id')} {result['latency_ms']:.0f}ms", flush=True)
    for index in range(args.fake_variants):
        fake_index = index % min(30, args.fake_variants)
        rng = np.random.default_rng(args.seed + 1_000_000 + index)
        result = engine.match(jpeg_bytes(augment_image(fake_reference(fake_index), rng), 94))
        cases.append(case_result(result, f"fake-{fake_index:03d}", "registered_fake", index))
        print(f"registered fake: {index+1}/{args.fake_variants} -> {result['decision']} {result.get('best',{}).get('page_id')} {result['latency_ms']:.0f}ms", flush=True)
    for index in range(args.unknown):
        rng = np.random.default_rng(args.seed + 2_000_000 + index)
        result = engine.match(jpeg_bytes(augment_image(fake_reference(50 + index), rng), 94))
        cases.append(case_result(result, None, "unknown", index))
        print(f"unknown: {index+1}/{args.unknown} -> {result['decision']} {result.get('best',{}).get('page_id')} {result['latency_ms']:.0f}ms", flush=True)
    elapsed = time.perf_counter() - started
    report, raw = build_report(cases, elapsed, args, settings)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(report, encoding="utf-8")
    (args.report.parent / "results.json").write_text(json.dumps(raw, indent=2), encoding="utf-8")
    summary = raw["summary"]
    print("\nFINAL EVAL", flush=True)
    print(f"top-1 accuracy: {summary['top1_accuracy']:.2%} ({summary['top1_correct']}/{summary['registered_queries']})", flush=True)
    print(f"false-match rate: {summary['false_match_rate']:.2%} ({summary['false_matches']})", flush=True)
    print(f"7294/7295 false matches: {summary['pair_false_matches']}/{summary['pair_queries']}", flush=True)
    print(f"unknown no_match precision/recall: {summary['no_match_precision']:.2%}/{summary['no_match_recall']:.2%}", flush=True)
    print(f"ambiguous rate: {summary['ambiguous_rate']:.2%}", flush=True)
    print(f"latency p50/p95: {summary['latency']['total_ms']['p50']:.2f}/{summary['latency']['total_ms']['p95']:.2f} ms", flush=True)
    passed = all(raw["targets"].values())
    print(f"targets passed: {passed}", flush=True)
    return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
