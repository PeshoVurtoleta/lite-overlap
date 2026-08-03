# lite-overlap 1.4.0 -- swept union vs exact hull (S1 deferral)

Does the shipped AABB-union swept test (`sweptOverlap`) over-report enough
vs the exact swept-ribbon hull test to justify shipping `sweptOverlapExact`,
and how much more does the exact test cost? Gated against an independent
Sutherland-Hodgman clip oracle before any timing. See
`bench/swept-union-vs-hull.mjs` for the full protocol.

```
node v26.3.1 | Apple M4 Pro | arm64 | 2026-08-02T22:13:34.890Z | seed=0x1543beef | box=14x14 overN=2000 diffPairs=60000 costM=100000 | warmup=200 reps=11 band=0.01
```

## Gates (all must PASS before timing)

- G0 shipped-mirror: unionOverlap === Overlap.js sweptOverlap over 20000 pairs -> PASS (mismatches=0)
- G1 axis-aligned identity (angle 0 and 90): SAT === union every pair, unionPos=41790 exactPos=41790 frac=0.000 -> PASS (mismatches=0)
- G2 SAT-vs-oracle differential: compared=59975 excluded(band)=25 (0.04%) disagreements=0 -> PASS

## Over-report (union positives that the exact hull rejects)

Uniform per-cell motion (all boxes share the cell angle+speed) is the
WORST CASE the planner flagged: parallel diagonal ribbons maximize the gap
between the union rectangle and the true hull. Read the 45deg rows as an
UPPER BOUND, not a real-scene over-report rate.

| angle(deg) | speed(bw) | density | field | unionPos | exactPos | frac |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 0.5 | 0.001 | 1414 | 1219 | 1219 | 0.000 |
| 0 | 0.5 | 0.002 | 1000 | 2394 | 2394 | 0.000 |
| 0 | 0.5 | 0.004 | 707 | 4838 | 4838 | 0.000 |
| 0 | 1.5 | 0.001 | 1414 | 1989 | 1989 | 0.000 |
| 0 | 1.5 | 0.002 | 1000 | 3865 | 3865 | 0.000 |
| 0 | 1.5 | 0.004 | 707 | 7977 | 7977 | 0.000 |
| 0 | 4.0 | 0.001 | 1414 | 3916 | 3916 | 0.000 |
| 0 | 4.0 | 0.002 | 1000 | 7643 | 7643 | 0.000 |
| 0 | 4.0 | 0.004 | 707 | 15135 | 15135 | 0.000 |
| 15 | 0.5 | 0.001 | 1414 | 1363 | 1318 | 0.033 |
| 15 | 0.5 | 0.002 | 1000 | 2587 | 2500 | 0.034 |
| 15 | 0.5 | 0.004 | 707 | 5196 | 5008 | 0.036 |
| 15 | 1.5 | 0.001 | 1414 | 2617 | 2177 | 0.168 |
| 15 | 1.5 | 0.002 | 1000 | 5347 | 4504 | 0.158 |
| 15 | 1.5 | 0.004 | 707 | 10436 | 8784 | 0.158 |
| 15 | 4.0 | 0.001 | 1414 | 7790 | 4629 | 0.406 |
| 15 | 4.0 | 0.002 | 1000 | 15171 | 9105 | 0.400 |
| 15 | 4.0 | 0.004 | 707 | 29522 | 17619 | 0.403 |
| 45 | 0.5 | 0.001 | 1414 | 1415 | 1323 | 0.065 |
| 45 | 0.5 | 0.002 | 1000 | 2817 | 2614 | 0.072 |
| 45 | 0.5 | 0.004 | 707 | 5802 | 5404 | 0.069 |
| 45 | 1.5 | 0.001 | 1414 | 3211 | 2365 | 0.263 |
| 45 | 1.5 | 0.002 | 1000 | 6765 | 5014 | 0.259 |
| 45 | 1.5 | 0.004 | 707 | 13385 | 9888 | 0.261 |
| 45 | 4.0 | 0.001 | 1414 | 11251 | 5082 | 0.548 |
| 45 | 4.0 | 0.002 | 1000 | 22270 | 10087 | 0.547 |
| 45 | 4.0 | 0.004 | 707 | 44172 | 20297 | 0.541 |

- G3 superset (exact positive => union positive), violations across all gated+tabulated pairs: 0 -> PASS

## Cost (median-of-11 ns/pair over 100000 cases, 45deg mixed speeds)

| test | ns/pair | ratio vs union |
| :--- | ---: | ---: |
| unionOverlap (shipped) | 11.980 | 1.00x |
| sweptExactSAT (hull)   | 51.363 | 4.29x |

(checksum=1 -- forces both calls live)

## Pre-registered verdict

Rule (fixed before the run): worstFrac = max over-report fraction across the
45deg cells. SHIP if worstFrac >= 0.05 AND ratio <= 3.0; PREDICATE-ONLY if
worstFrac >= 0.05 AND 3.0 < ratio <= 8.0; CLOSE otherwise.

**VERDICT: PREDICATE-ONLY (worstFrac=0.548, ratio=4.29x)**
