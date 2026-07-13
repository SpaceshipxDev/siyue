# External real-world evaluation

Protocol: register ONE phone capture per page (production-mirroring), query the rest. Quick mode: True.

| slice | refs | queries | top-1 acc | wrong-match | ambiguous (truth in top3) | no-match on known | unknown rejected | unknown false-accepts | p50 ms | p95 ms |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| smartdoc-qa/A phone-ref | 15 | 45 | 88.89% | 0 | 0 (0) | 5 | — | 0 | 937.0 | 3272.9 |
| smartdoc-qa/B unknowns | 10 | 0 | — | 0 | 0 (0) | 0 | 20/20 | 0 | 5966.4 | 6139.9 |
| smartdoc-qa/C clean-ref(10p) | 10 | 40 | 55.0% | 0 | 0 (0) | 18 | — | 0 | 4547.4 | 6739.7 |
| smartdoc15-ch1/A video-frames | 30 | 150 | 12.67% | 0 | 0 (0) | 131 | — | 0 | 6951.3 | 9193.1 |
| docunet/A crumpled-pair | 33 | 33 | 36.36% | 0 | 0 (0) | 21 | — | 0 | 5664.7 | 7311.8 |

Wall time: 1635.1s
## Relaxed-gate experiment (quick mode, production gates since 2026-07-12)

`MIN_INLIERS=20 MIN_SCORE=120 MIN_EDGE=0.06 MIN_INLIER_RATIO=0.14 MIN_COSINE=0.12`

| slice | top-1 acc (strict → relaxed) | wrong-match | unknowns rejected |
|---|---|--:|--:|
| smartdoc-qa/A phone-ref | 88.9% → 88.9% | 0 | — |
| smartdoc-qa/B unknowns | — | 0 | 20/20 |
| smartdoc-qa/C clean-ref | 41% → 55% | 0 | — |
| smartdoc15-ch1 video-frames | 10% → 12.7% | 0 | — |
| docunet crumpled | 13.9% → 36.4% | 0 | — |

Precision is untouched by the relaxation (geometry is the wall, gates only
trade recall). Remaining misses are feature-level (1080p video frames, severe
crumple) — the next step there is a dense-matcher fallback (RoMa v2) on
uncertain queries, not more threshold tuning. Production failure mode stays
"reject → Gemini OCR of 货号/图纸号", never a wrong part.
