# External real-world evaluation

Protocol: register ONE phone capture per page (production-mirroring), query the rest. Quick mode: False.

| slice | refs | queries | top-1 acc | wrong-match | ambiguous (truth in top3) | no-match on known | unknown rejected | unknown false-accepts | p50 ms | p95 ms |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| smartdoc-qa/A phone-ref | 15 | 135 | 88.89% | 0 | 0 (0) | 15 | — | 0 | 1217.9 | 3751.2 |
| smartdoc-qa/B unknowns | 10 | 0 | — | 0 | 0 (0) | 0 | 50/50 | 0 | 4275.7 | 4780.8 |
| smartdoc-qa/C clean-ref(10p) | 10 | 100 | 41.0% | 0 | 0 (0) | 59 | — | 0 | 4174.5 | 6294.9 |
| smartdoc15-ch1/A video-frames | 30 | 300 | 10.0% | 0 | 0 (0) | 270 | — | 0 | 3741.0 | 5256.4 |
| docunet/A crumpled-pair | 65 | 65 | 13.85% | 0 | 0 (0) | 56 | — | 0 | 4051.6 | 6103.8 |

Wall time: 2362.6s