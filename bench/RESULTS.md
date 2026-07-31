# lite-overlap 1.1.0 -- collect vs N-query

One BVH self-traversal (`collectPairs`) vs N root-down `query()` calls,
both producing the identical fat pair set. Median ns/frame, static scene,
constant density. See `bench/collect-vs-nquery.mjs` for the full protocol.

```
node v26.3.1 | Apple M4 Pro | arm64 | 2026-07-31T00:09:49.807Z | seed=0x1543beef | density=0.002 box=14x14 margin=2 | warmup=200 reps=11
```

| N | field | pairs | collect | N-query | speedup |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 224 | 156 | 6.13 us | 9.66 us | 1.58x |
| 1000 | 707 | 1290 | 87.73 us | 189.86 us | 2.16x |
| 5000 | 1581 | 6503 | 798.11 us | 2.849 ms | 3.57x |
| 20000 | 3162 | 26098 | 8.040 ms | 35.374 ms | 4.40x |

**Crossover:** collect wins across the whole measured range (from N=100 up). No crossover -- self-traversal is the default.

`speedup` = N-query / collect (>1 means collect is faster). N-query reads
each box straight from the tree -- the cheapest possible query source, so
this understates collect's real-world edge over a caller that rebuilds boxes.

