# Yingma Page Matcher Evaluation

Generated deterministically with seed `20260711` on `arm64` using Python `3.12.10`.
The bank contains 3 real photographed sheets and 50 distinct rendered sheets.

## Target results

| Metric | Result | Target | Pass |
|---|---:|---:|:---:|
| Registered-query top-1 accuracy | 99.70% (329/330) | >=99% | yes |
| IMG_7294/IMG_7295 false matches | 0/200 | 0 | yes |
| Match latency p50 | 2336.39 ms | <=2500 ms CPU | yes |

## Decision metrics

- False-match rate: 0.00% (0/330)
- Unknown/no-match precision: 90.91%
- Unknown/no-match recall: 100.00% (20/20)
- Ambiguous rate on registered queries: 0.00% (0/330)

## CPU latency

| Stage | p50 | p95 |
|---|---:|---:|
| embed_ms | 210.62 ms | 302.25 ms |
| shortlist_ms | 1.33 ms | 2.43 ms |
| verify_ms | 2100.24 ms | 4764.46 ms |
| total_ms | 2336.39 ms | 5015.16 ms |

## IMG_7294 vs IMG_7295 confusion test

The table reports the composite geometric score for the correct sheet and the other near-identical program sheet. A dash means the wrong sheet was outside the geometrically verified top five.

| Query | Variant | Decision | Top page | Correct score | Wrong-page score |
|---|---:|---|---|---:|---:|
| IMG_7294 | 0 | match | img_7294 | 6674.782 | 2536.023 |
| IMG_7294 | 1 | match | img_7294 | 5588.596 | 1079.796 |
| IMG_7294 | 2 | match | img_7294 | 6995.134 | — |
| IMG_7294 | 3 | match | img_7294 | 6511.769 | — |
| IMG_7294 | 4 | match | img_7294 | 6922.897 | 2845.66 |
| IMG_7294 | 5 | match | img_7294 | 6340.742 | — |
| IMG_7294 | 6 | match | img_7294 | 5977.087 | 2233.36 |
| IMG_7294 | 7 | match | img_7294 | 5209.554 | 1916.161 |
| IMG_7294 | 8 | match | img_7294 | 6502.498 | 1148.134 |
| IMG_7294 | 9 | match | img_7294 | 6222.151 | 2495.153 |
| IMG_7294 | 10 | match | img_7294 | 5402.876 | 2360.675 |
| IMG_7294 | 11 | match | img_7294 | 5418.27 | — |
| IMG_7294 | 12 | match | img_7294 | 6846.738 | — |
| IMG_7294 | 13 | match | img_7294 | 6351.21 | 1998.486 |
| IMG_7294 | 14 | match | img_7294 | 5663.426 | 2214.837 |
| IMG_7294 | 15 | match | img_7294 | 6267.945 | 2561.59 |
| IMG_7294 | 16 | match | img_7294 | 6702.471 | 2403.422 |
| IMG_7294 | 17 | match | img_7294 | 6820.467 | 1181.705 |
| IMG_7294 | 18 | match | img_7294 | 5121.437 | 1562.426 |
| IMG_7294 | 19 | match | img_7294 | 6509.085 | 2926.593 |
| IMG_7294 | 20 | match | img_7294 | 5842.58 | — |
| IMG_7294 | 21 | match | img_7294 | 6555.871 | 2413.782 |
| IMG_7294 | 22 | match | img_7294 | 6790.61 | 1364.49 |
| IMG_7294 | 23 | match | img_7294 | 6669.125 | — |
| IMG_7294 | 24 | match | img_7294 | 6047.451 | 2316.686 |
| IMG_7294 | 25 | match | img_7294 | 5955.306 | — |
| IMG_7294 | 26 | match | img_7294 | 6598.082 | 2954.804 |
| IMG_7294 | 27 | match | img_7294 | 7001.46 | — |
| IMG_7294 | 28 | match | img_7294 | 6719.571 | 2533.642 |
| IMG_7294 | 29 | match | img_7294 | 7617.834 | 1662.692 |
| IMG_7294 | 30 | match | img_7294 | 6596.534 | — |
| IMG_7294 | 31 | match | img_7294 | 7038.589 | 1.055 |
| IMG_7294 | 32 | match | img_7294 | 7359.798 | — |
| IMG_7294 | 33 | match | img_7294 | 7187.09 | — |
| IMG_7294 | 34 | match | img_7294 | 7303.315 | — |
| IMG_7294 | 35 | match | img_7294 | 5463.043 | 1427.383 |
| IMG_7294 | 36 | match | img_7294 | 7008.384 | — |
| IMG_7294 | 37 | match | img_7294 | 6797.237 | — |
| IMG_7294 | 38 | match | img_7294 | 5820.696 | 2059.268 |
| IMG_7294 | 39 | match | img_7294 | 6491.071 | — |
| IMG_7294 | 40 | match | img_7294 | 6587.822 | 2206.161 |
| IMG_7294 | 41 | match | img_7294 | 5948.503 | 2710.522 |
| IMG_7294 | 42 | match | img_7294 | 6037.937 | 1820.731 |
| IMG_7294 | 43 | match | img_7294 | 5134.653 | 2277.429 |
| IMG_7294 | 44 | match | img_7294 | 7420.014 | 1431.526 |
| IMG_7294 | 45 | match | img_7294 | 6100.087 | 2424.082 |
| IMG_7294 | 46 | match | img_7294 | 6717.711 | 1226.885 |
| IMG_7294 | 47 | match | img_7294 | 6295.61 | 1910.317 |
| IMG_7294 | 48 | match | img_7294 | 6535.156 | 1211.319 |
| IMG_7294 | 49 | match | img_7294 | 5814.347 | — |
| IMG_7294 | 50 | match | img_7294 | 6559.419 | 2467.632 |
| IMG_7294 | 51 | match | img_7294 | 6718.531 | — |
| IMG_7294 | 52 | match | img_7294 | 6699.242 | 2798.938 |
| IMG_7294 | 53 | match | img_7294 | 6142.735 | — |
| IMG_7294 | 54 | match | img_7294 | 6347.05 | — |
| IMG_7294 | 55 | match | img_7294 | 6750.69 | 3379.683 |
| IMG_7294 | 56 | match | img_7294 | 6467.887 | 2477.601 |
| IMG_7294 | 57 | match | img_7294 | 6003.782 | 1286.238 |
| IMG_7294 | 58 | match | img_7294 | 6324.113 | 1439.229 |
| IMG_7294 | 59 | match | img_7294 | 5612.929 | 1984.899 |
| IMG_7294 | 60 | match | img_7294 | 6085.861 | — |
| IMG_7294 | 61 | match | img_7294 | 6259.27 | 2422.23 |
| IMG_7294 | 62 | match | img_7294 | 5706.665 | 2652.555 |
| IMG_7294 | 63 | match | img_7294 | 6068.427 | 2586.467 |
| IMG_7294 | 64 | match | img_7294 | 6923.929 | 1201.384 |
| IMG_7294 | 65 | match | img_7294 | 5994.858 | 1993.012 |
| IMG_7294 | 66 | match | img_7294 | 5857.168 | — |
| IMG_7294 | 67 | match | img_7294 | 6307.138 | 2379.888 |
| IMG_7294 | 68 | match | img_7294 | 6548.439 | 2624.47 |
| IMG_7294 | 69 | match | img_7294 | 6439.997 | 1539.548 |
| IMG_7294 | 70 | match | img_7294 | 5571.331 | 2955.503 |
| IMG_7294 | 71 | match | img_7294 | 6755.67 | 2815.687 |
| IMG_7294 | 72 | match | img_7294 | 6692.287 | 1003.512 |
| IMG_7294 | 73 | match | img_7294 | 5915.892 | — |
| IMG_7294 | 74 | match | img_7294 | 6174.382 | 2480.92 |
| IMG_7294 | 75 | match | img_7294 | 6824.968 | 2345.696 |
| IMG_7294 | 76 | match | img_7294 | 6320.12 | 2620.852 |
| IMG_7294 | 77 | match | img_7294 | 6792.306 | 2095.53 |
| IMG_7294 | 78 | match | img_7294 | 5801.716 | 2535.624 |
| IMG_7294 | 79 | match | img_7294 | 6331.712 | 2948.289 |
| IMG_7294 | 80 | match | img_7294 | 5986.025 | 1108.109 |
| IMG_7294 | 81 | match | img_7294 | 7689.443 | — |
| IMG_7294 | 82 | match | img_7294 | 6853.196 | 2597.813 |
| IMG_7294 | 83 | match | img_7294 | 5946.822 | 2770.017 |
| IMG_7294 | 84 | match | img_7294 | 5524.194 | 1744.684 |
| IMG_7294 | 85 | match | img_7294 | 6317.185 | 2686.282 |
| IMG_7294 | 86 | match | img_7294 | 6116.635 | 2752.233 |
| IMG_7294 | 87 | match | img_7294 | 7576.3 | 2836.502 |
| IMG_7294 | 88 | match | img_7294 | 6578.564 | 2159.646 |
| IMG_7294 | 89 | match | img_7294 | 5222.999 | 1722.913 |
| IMG_7294 | 90 | match | img_7294 | 7247.757 | 1238.012 |
| IMG_7294 | 91 | match | img_7294 | 5469.935 | 1124.585 |
| IMG_7294 | 92 | match | img_7294 | 6236.272 | — |
| IMG_7294 | 93 | match | img_7294 | 6139.973 | 2380.391 |
| IMG_7294 | 94 | match | img_7294 | 5598.073 | 2664.167 |
| IMG_7294 | 95 | match | img_7294 | 6461.932 | 2659.084 |
| IMG_7294 | 96 | match | img_7294 | 5811.69 | 1994.999 |
| IMG_7294 | 97 | match | img_7294 | 6444.468 | — |
| IMG_7294 | 98 | match | img_7294 | 7040.917 | 3124.857 |
| IMG_7294 | 99 | match | img_7294 | 6245.44 | 2716.75 |
| IMG_7295 | 0 | match | img_7295 | 5124.304 | 2186.318 |
| IMG_7295 | 1 | match | img_7295 | 3820.539 | 1340.764 |
| IMG_7295 | 2 | match | img_7295 | 4989.265 | 1826.78 |
| IMG_7295 | 3 | match | img_7295 | 5281.103 | 2422.158 |
| IMG_7295 | 4 | match | img_7295 | 4702.58 | 1518.545 |
| IMG_7295 | 5 | match | img_7295 | 3868.65 | 1304.641 |
| IMG_7295 | 6 | match | img_7295 | 4061.827 | — |
| IMG_7295 | 7 | match | img_7295 | 5153.194 | — |
| IMG_7295 | 8 | match | img_7295 | 4146.26 | 1562.011 |
| IMG_7295 | 9 | match | img_7295 | 5442.714 | 0.606 |
| IMG_7295 | 10 | match | img_7295 | 5082.732 | 0.622 |
| IMG_7295 | 11 | match | img_7295 | 5697.237 | — |
| IMG_7295 | 12 | match | img_7295 | 4492.786 | 1311.383 |
| IMG_7295 | 13 | match | img_7295 | 4958.973 | 2016.874 |
| IMG_7295 | 14 | match | img_7295 | 5851.222 | — |
| IMG_7295 | 15 | match | img_7295 | 6045.522 | 1668.347 |
| IMG_7295 | 16 | match | img_7295 | 2262.958 | 786.89 |
| IMG_7295 | 17 | match | img_7295 | 5538.502 | 2014.642 |
| IMG_7295 | 18 | match | img_7295 | 5692.876 | 2551.555 |
| IMG_7295 | 19 | match | img_7295 | 5450.989 | — |
| IMG_7295 | 20 | match | img_7295 | 4481.764 | 1585.219 |
| IMG_7295 | 21 | match | img_7295 | 5463.59 | 1725.344 |
| IMG_7295 | 22 | match | img_7295 | 4976.263 | 2017.67 |
| IMG_7295 | 23 | match | img_7295 | 5271.264 | 1.536 |
| IMG_7295 | 24 | match | img_7295 | 3795.03 | — |
| IMG_7295 | 25 | match | img_7295 | 4620.526 | — |
| IMG_7295 | 26 | match | img_7295 | 4439.681 | 1776.095 |
| IMG_7295 | 27 | match | img_7295 | 6552.468 | — |
| IMG_7295 | 28 | match | img_7295 | 3641.86 | 1605.861 |
| IMG_7295 | 29 | match | img_7295 | 4565.442 | 1480.786 |
| IMG_7295 | 30 | match | img_7295 | 4216.846 | 1059.54 |
| IMG_7295 | 31 | match | img_7295 | 5649.397 | 2213.284 |
| IMG_7295 | 32 | match | img_7295 | 5699.451 | 2489.786 |
| IMG_7295 | 33 | match | img_7295 | 5526.27 | 1943.669 |
| IMG_7295 | 34 | match | img_7295 | 5210.624 | — |
| IMG_7295 | 35 | match | img_7295 | 5146.758 | 2306.82 |
| IMG_7295 | 36 | match | img_7295 | 4014.304 | 1155.341 |
| IMG_7295 | 37 | match | img_7295 | 6113.128 | 2287.004 |
| IMG_7295 | 38 | match | img_7295 | 4700.978 | — |
| IMG_7295 | 39 | match | img_7295 | 4904.276 | 1649.116 |
| IMG_7295 | 40 | match | img_7295 | 4982.372 | 1.438 |
| IMG_7295 | 41 | match | img_7295 | 4184.622 | — |
| IMG_7295 | 42 | match | img_7295 | 6242.766 | 2470.809 |
| IMG_7295 | 43 | match | img_7295 | 6597.246 | 2179.676 |
| IMG_7295 | 44 | match | img_7295 | 6315.054 | 1761.822 |
| IMG_7295 | 45 | match | img_7295 | 3807.802 | 1378.143 |
| IMG_7295 | 46 | match | img_7295 | 5887.704 | 2100.627 |
| IMG_7295 | 47 | match | img_7295 | 5453.363 | 1.106 |
| IMG_7295 | 48 | match | img_7295 | 4831.388 | 2235.608 |
| IMG_7295 | 49 | match | img_7295 | 5358.019 | 1.512 |
| IMG_7295 | 50 | match | img_7295 | 5659.71 | 1643.349 |
| IMG_7295 | 51 | match | img_7295 | 5464.717 | 1960.139 |
| IMG_7295 | 52 | match | img_7295 | 4824.846 | 1455.052 |
| IMG_7295 | 53 | match | img_7295 | 5909.077 | 1492.364 |
| IMG_7295 | 54 | match | img_7295 | 5443.221 | 1515.36 |
| IMG_7295 | 55 | match | img_7295 | 5633.571 | 1.155 |
| IMG_7295 | 56 | match | img_7295 | 5658.753 | 1619.845 |
| IMG_7295 | 57 | match | img_7295 | 5188.294 | — |
| IMG_7295 | 58 | match | img_7295 | 5969.153 | — |
| IMG_7295 | 59 | match | img_7295 | 5209.722 | 1298.448 |
| IMG_7295 | 60 | match | img_7295 | 5298.393 | 2428.984 |
| IMG_7295 | 61 | match | img_7295 | 4518.684 | 0.75 |
| IMG_7295 | 62 | match | img_7295 | 4552.565 | 2694.404 |
| IMG_7295 | 63 | match | img_7295 | 4556.259 | 1497.982 |
| IMG_7295 | 64 | match | img_7295 | 5302.202 | 2480.289 |
| IMG_7295 | 65 | match | img_7295 | 6185.349 | — |
| IMG_7295 | 66 | match | img_7295 | 4821.968 | 1181.309 |
| IMG_7295 | 67 | match | img_7295 | 5343.69 | — |
| IMG_7295 | 68 | match | img_7295 | 6175.888 | 1953.568 |
| IMG_7295 | 69 | match | img_7295 | 5570.031 | 1775.795 |
| IMG_7295 | 70 | match | img_7295 | 6723.694 | 1998.505 |
| IMG_7295 | 71 | match | img_7295 | 6137.047 | 2087.76 |
| IMG_7295 | 72 | match | img_7295 | 6187.713 | 1782.682 |
| IMG_7295 | 73 | match | img_7295 | 4513.177 | 1461.676 |
| IMG_7295 | 74 | match | img_7295 | 6164.502 | 1196.309 |
| IMG_7295 | 75 | match | img_7295 | 6384.643 | 2673.427 |
| IMG_7295 | 76 | match | img_7295 | 4997.024 | — |
| IMG_7295 | 77 | match | img_7295 | 4717.672 | 1865.903 |
| IMG_7295 | 78 | match | img_7295 | 4756.038 | 0.961 |
| IMG_7295 | 79 | match | img_7295 | 3463.89 | 0.742 |
| IMG_7295 | 80 | match | img_7295 | 5359.137 | 1.049 |
| IMG_7295 | 81 | match | img_7295 | 4889.396 | 1404.642 |
| IMG_7295 | 82 | match | img_7295 | 3704.565 | 1352.406 |
| IMG_7295 | 83 | match | img_7295 | 4194.067 | 1452.455 |
| IMG_7295 | 84 | match | img_7295 | 3599.492 | 1734.488 |
| IMG_7295 | 85 | match | img_7295 | 4750.152 | 0.925 |
| IMG_7295 | 86 | match | img_7295 | 6557.123 | 2963.843 |
| IMG_7295 | 87 | match | img_7295 | 6296.333 | 2856.596 |
| IMG_7295 | 88 | match | img_7295 | 6016.357 | 2.872 |
| IMG_7295 | 89 | match | img_7295 | 5234.352 | 1398.748 |
| IMG_7295 | 90 | match | img_7295 | 4810.107 | 1584.01 |
| IMG_7295 | 91 | match | img_7295 | 6436.649 | 2317.936 |
| IMG_7295 | 92 | match | img_7295 | 4272.859 | 1210.855 |
| IMG_7295 | 93 | match | img_7295 | 5495.986 | 0.526 |
| IMG_7295 | 94 | match | img_7295 | 5684.345 | 1418.846 |
| IMG_7295 | 95 | match | img_7295 | 5936.312 | — |
| IMG_7295 | 96 | match | img_7295 | 4599.494 | 1654.843 |
| IMG_7295 | 97 | match | img_7295 | 5275.87 | 1.731 |
| IMG_7295 | 98 | match | img_7295 | 4235.129 | 1574.308 |
| IMG_7295 | 99 | match | img_7295 | 5460.521 | 1546.06 |

## Errors

Top-1 errors: **1**. Unknown false accepts: **0**.

| Category | Variant | Expected | Returned | Decision | Score |
|---|---:|---|---|---|---:|
| registered_fake | 13 | fake-013 | fake-009 | no_match | 72.028 |

## Tuned acceptance thresholds

```json
{
  "feature_resize": 768,
  "max_keypoints": 768,
  "shortlist_k": 8,
  "verify_k": 5,
  "min_cosine": 0.2,
  "min_inliers": 35,
  "min_inlier_ratio": 0.22,
  "min_coverage": 8,
  "min_edge_agreement": 0.1,
  "min_score": 300.0,
  "early_cosine_margin": 0.08,
  "ambiguous_score_margin": 0.18,
  "homography_threshold": 3.0
}
```

Full evaluation wall time: 1293.94 seconds.
