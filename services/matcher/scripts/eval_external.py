"""External real-world evaluation — same physical page, many messy captures.

Runs the PRODUCT protocol against three public datasets landed in
testdata/external/ (see each MANIFEST.md):

  smartdoc-qa      15 pages x 10 phone captures (blur/light/perspective)
  smartdoc15-ch1   30 pages x 5 backgrounds x 6 hand-held video frames
  docunet          65 pages x 2 crumpled/folded photos

Protocol per dataset: register ONE capture per page (production references
ARE phone photos), query the rest. Slices:
  A  accuracy     all pages registered, remaining captures queried
  B  unknowns     subset of pages registered; captures of the excluded pages
                  must come back no_match
  C  clean-refs   (smartdoc-qa only) register the flatbed/tif references
                  instead of a capture, query all captures

Each slice uses a throwaway bank directory. Results are appended to
eval/external_report.md and dumped to eval/external_results.json.

Run:  .venv/bin/python scripts/eval_external.py [--quick]
"""

from __future__ import annotations

import json
import shutil
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from matcher.config import Settings  # noqa: E402
from matcher.engine import MatcherEngine  # noqa: E402

EXT = ROOT / "testdata" / "external"
OUT_DIR = ROOT / "eval"
QUICK = "--quick" in sys.argv


@dataclass
class SliceResult:
    name: str
    registered: int = 0
    queries: int = 0
    correct: int = 0
    wrong_match: int = 0        # decision=match but wrong page  -> the cardinal sin
    ambiguous: int = 0
    ambiguous_containing_truth: int = 0
    no_match: int = 0
    unknown_queries: int = 0
    unknown_no_match: int = 0   # correct rejections
    unknown_accepted: int = 0   # false accepts of never-registered pages
    latencies: list = field(default_factory=list)

    def latency(self, q: float) -> float:
        return sorted(self.latencies)[max(0, int(len(self.latencies) * q) - 1)] if self.latencies else 0.0

    def row(self) -> dict:
        acc = self.correct / self.queries * 100 if self.queries else None
        return {
            "slice": self.name,
            "registered": self.registered,
            "queries": self.queries,
            "top1_acc_pct": round(acc, 2) if acc is not None else None,
            "wrong_match": self.wrong_match,
            "ambiguous": self.ambiguous,
            "ambiguous_containing_truth": self.ambiguous_containing_truth,
            "no_match_on_known": self.no_match,
            "unknown_queries": self.unknown_queries,
            "unknown_rejected": self.unknown_no_match,
            "unknown_false_accepts": self.unknown_accepted,
            "latency_p50_ms": round(self.latency(0.50), 1),
            "latency_p95_ms": round(self.latency(0.95), 1),
        }


def fresh_engine(tag: str) -> MatcherEngine:
    data_dir = ROOT / "data-eval-ext" / tag
    if data_dir.exists():
        shutil.rmtree(data_dir)
    data_dir.mkdir(parents=True)
    return MatcherEngine(Settings(data_dir=data_dir))


def run_slice(
    name: str,
    refs: list[tuple[str, Path]],           # (page_id, reference image)
    known: list[tuple[str, Path]],          # (true page_id, query image)
    unknown: list[Path] = (),               # queries that must be rejected
) -> SliceResult:
    engine = fresh_engine(name.replace("/", "_"))
    res = SliceResult(name=name)
    for page_id, path in refs:
        engine.register(path.read_bytes(), page_id, f"comp:{page_id}", "front")
        res.registered += 1
    for truth, path in known:
        out = engine.match(path.read_bytes())
        res.queries += 1
        res.latencies.append(out["latency_ms"])
        got = out["best"]["page_id"] if out["best"] else None
        if out["decision"] == "match":
            if got == truth:
                res.correct += 1
            else:
                res.wrong_match += 1
                print(f"    WRONG {name}: {path.name} -> {got} (true {truth})", flush=True)
        elif out["decision"] == "ambiguous":
            res.ambiguous += 1
            if any(c["page_id"] == truth for c in out["candidates"][:3]):
                res.ambiguous_containing_truth += 1
        else:
            res.no_match += 1
    for path in unknown:
        out = engine.match(path.read_bytes())
        res.unknown_queries += 1
        res.latencies.append(out["latency_ms"])
        if out["decision"] == "no_match":
            res.unknown_no_match += 1
        elif out["decision"] == "match":
            res.unknown_accepted += 1
            print(f"    FALSE-ACCEPT {name}: {path.name} -> {out['best']['page_id']}", flush=True)
    print(f"  {name}: {json.dumps(res.row())}", flush=True)
    return res


def images(d: Path) -> list[Path]:
    return sorted(p for p in d.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".tif", ".tiff"})


def smartdoc_qa() -> list[SliceResult]:
    caps = EXT / "smartdoc-qa" / "captures"
    pages = sorted(caps.iterdir())
    per_page = {p.name: images(p) for p in pages}
    step = 3 if QUICK else 1

    # A: register capture[0] of every page, query the rest.
    refs = [(n, shots[0]) for n, shots in per_page.items()]
    known = [(n, q) for n, shots in per_page.items() for q in shots[1::step]]
    a = run_slice("smartdoc-qa/A phone-ref", refs, known)

    # B: register 10 pages only; the other 5 pages' captures must be rejected.
    names = sorted(per_page)
    reg_names, out_names = names[:10], names[10:]
    refs_b = [(n, per_page[n][0]) for n in reg_names]
    unknown = [q for n in out_names for q in per_page[n][::step]]
    b = run_slice("smartdoc-qa/B unknowns", refs_b, [], unknown)

    # C: clean references (only pages whose reference is a raster image —
    # pdf references would need rendering, noted in the report).
    ref_dir = EXT / "smartdoc-qa" / "references"
    refs_c = []
    for n in names:
        stem = n  # page_N
        for ext in (".tif", ".tiff", ".png", ".jpg"):
            f = ref_dir / f"{stem}{ext}"
            if f.exists():
                refs_c.append((n, f))
                break
    covered = {n for n, _ in refs_c}
    known_c = [(n, q) for n, shots in per_page.items() if n in covered for q in shots[::step]]
    c = run_slice(f"smartdoc-qa/C clean-ref({len(refs_c)}p)", refs_c, known_c)
    return [a, b, c]


def smartdoc15() -> list[SliceResult]:
    frames = EXT / "smartdoc15-ch1" / "frames"
    backgrounds = sorted(d for d in frames.iterdir() if d.is_dir())
    docs = sorted(d.name for d in backgrounds[0].iterdir() if d.is_dir())
    # Register: background01 frame 0 of each doc. Query: for every background,
    # sample frames (2 per bg normally, 1 in quick mode), skipping the
    # registered frame.
    refs, known = [], []
    n_q = 1 if QUICK else 2
    for doc in docs:
        shots0 = images(backgrounds[0] / doc)
        refs.append((doc, shots0[0]))
        for bg in backgrounds:
            shots = images(bg / doc)
            pool = [s for s in shots if s != shots0[0]]
            known.extend((doc, s) for s in pool[1 : 1 + n_q])
    return [run_slice("smartdoc15-ch1/A video-frames", refs, known)]


def docunet() -> list[SliceResult]:
    crop = EXT / "docunet" / "crop"
    by_page: dict[str, list[Path]] = {}
    for p in images(crop):
        page = p.name.split("_")[0]
        by_page.setdefault(page, []).append(p)
    pairs = {k: sorted(v) for k, v in by_page.items() if len(v) >= 2}
    refs = [(k, v[0]) for k, v in pairs.items()]
    known = [(k, v[1]) for k, v in pairs.items()]
    if QUICK:
        refs, known = refs[::2], known[::2]
    return [run_slice("docunet/A crumpled-pair", refs, known)]


def main() -> None:
    t0 = time.time()
    results: list[SliceResult] = []
    print("== smartdoc-qa ==", flush=True)
    results += smartdoc_qa()
    print("== smartdoc15-ch1 ==", flush=True)
    results += smartdoc15()
    print("== docunet ==", flush=True)
    results += docunet()

    rows = [r.row() for r in results]
    OUT_DIR.mkdir(exist_ok=True)
    (OUT_DIR / "external_results.json").write_text(json.dumps(rows, indent=2))

    lines = [
        "# External real-world evaluation",
        "",
        f"Protocol: register ONE phone capture per page (production-mirroring), query the rest. Quick mode: {QUICK}.",
        "",
        "| slice | refs | queries | top-1 acc | wrong-match | ambiguous (truth in top3) | no-match on known | unknown rejected | unknown false-accepts | p50 ms | p95 ms |",
        "|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|",
    ]
    for r in rows:
        amb = f"{r['ambiguous']} ({r['ambiguous_containing_truth']})"
        acc = f"{r['top1_acc_pct']}%" if r["top1_acc_pct"] is not None else "—"
        unk = f"{r['unknown_rejected']}/{r['unknown_queries']}" if r["unknown_queries"] else "—"
        lines.append(
            f"| {r['slice']} | {r['registered']} | {r['queries']} | {acc} | {r['wrong_match']} | {amb} | "
            f"{r['no_match_on_known']} | {unk} | {r['unknown_false_accepts']} | {r['latency_p50_ms']} | {r['latency_p95_ms']} |"
        )
    lines.append("")
    lines.append(f"Wall time: {round(time.time() - t0, 1)}s")
    (OUT_DIR / "external_report.md").write_text("\n".join(lines))
    print("\n".join(lines), flush=True)


if __name__ == "__main__":
    main()
