# lite-overlap 1.4.0 -- subtree prune vs leaf filtering (O2.1 / F3 deferral)

Does a PER-FRAME `subtreeLayers` rebuild + subtree prune (the only rotation-
safe form F3 admits) save more descent work than the O(nodes) rebuild costs,
versus the shipped LEAF-LEVEL layer filter alone? Both paths share one descent
mirror, proven to emit the byte-identical pair set as the real library before
any count is trusted. Matrix is DIAGONAL (each layer self-interacts only --
favorable to pruning); clustered is best-case, interleaved worst-case spatial.
See `bench/subtree-prune-vs-leaf.mjs` for the full protocol.

```
node v26.3.1 | Apple M4 Pro | arm64 | 2026-08-03T03:55:52.086Z | seed=0x1543beef | density=0.002 box=14x14 margin=2 | warmup=100 reps=11 matrix=diagonal
```

## Correctness gate (mirror == shipped library, prototype == leaf-only)

| cluster | N | layers | pairs | mirror==lib | proto==leaf |
| :--- | ---: | ---: | ---: | :---: | :---: |
| clustered | 500 | 1 | 666 | PASS | PASS |
| clustered | 500 | 4 | 686 | PASS | PASS |
| clustered | 500 | 16 | 646 | PASS | PASS |
| clustered | 2000 | 1 | 2671 | PASS | PASS |
| clustered | 2000 | 4 | 2662 | PASS | PASS |
| clustered | 2000 | 16 | 2654 | PASS | PASS |
| clustered | 8000 | 1 | 10392 | PASS | PASS |
| clustered | 8000 | 4 | 10649 | PASS | PASS |
| clustered | 8000 | 16 | 10716 | PASS | PASS |
| interleaved | 500 | 1 | 701 | PASS | PASS |
| interleaved | 500 | 4 | 153 | PASS | PASS |
| interleaved | 500 | 16 | 40 | PASS | PASS |
| interleaved | 2000 | 1 | 2639 | PASS | PASS |
| interleaved | 2000 | 4 | 632 | PASS | PASS |
| interleaved | 2000 | 16 | 157 | PASS | PASS |
| interleaved | 8000 | 1 | 10494 | PASS | PASS |
| interleaved | 8000 | 4 | 2698 | PASS | PASS |
| interleaved | 8000 | 16 | 648 | PASS | PASS |

- mirror==lib mismatches: 0 -> PASS
- proto==leaf (SAFETY: prune never drops a real pair) mismatches: 0 -> PASS

## Cross-pair node visits (exact, timing-independent) and rebuild cost

`reduction` = (leaf-only visits - prototype visits) / leaf-only visits.
`rebuild` is the fixed O(nodeCount) node-visit cost the prototype adds per frame.

| cluster | N | layers | leaf visits | proto visits | reduction | rebuild (nodes) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| clustered | 500 | 1 | 6265 | 6265 | 0.0% | 999 |
| clustered | 500 | 4 | 6029 | 6019 | 0.2% | 999 |
| clustered | 500 | 16 | 6779 | 6469 | 4.6% | 999 |
| clustered | 2000 | 1 | 29405 | 29405 | 0.0% | 3999 |
| clustered | 2000 | 4 | 27791 | 27759 | 0.1% | 3999 |
| clustered | 2000 | 16 | 30719 | 30507 | 0.7% | 3999 |
| clustered | 8000 | 1 | 146739 | 146739 | 0.0% | 15999 |
| clustered | 8000 | 4 | 159331 | 159233 | 0.1% | 15999 |
| clustered | 8000 | 16 | 223391 | 219397 | 1.8% | 15999 |
| interleaved | 500 | 1 | 6271 | 6271 | 0.0% | 999 |
| interleaved | 500 | 4 | 6859 | 5643 | 17.7% | 999 |
| interleaved | 500 | 16 | 8083 | 4495 | 44.4% | 999 |
| interleaved | 2000 | 1 | 36189 | 36189 | 0.0% | 3999 |
| interleaved | 2000 | 4 | 32137 | 27391 | 14.8% | 3999 |
| interleaved | 2000 | 16 | 33835 | 20001 | 40.9% | 3999 |
| interleaved | 8000 | 1 | 163451 | 163451 | 0.0% | 15999 |
| interleaved | 8000 | 4 | 148547 | 126811 | 14.6% | 15999 |
| interleaved | 8000 | 16 | 310011 | 206037 | 33.5% | 15999 |

## Wall clock (median-of-11 ns/frame)

`leaf` and `proto` share the descent mirror; their delta isolates the rebuild+
prune. `overhead` = (proto - leaf) / leaf. `real` is the shipped library run as
a cost-fidelity cross-check on the mirror (leaf-level filter, no prune).

| cluster | N | layers | leaf | proto | overhead | real (lib) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| clustered | 500 | 1 | 27.99 us | 36.45 us | 30.24% | 37.95 us |
| clustered | 500 | 4 | 27.66 us | 35.27 us | 27.50% | 37.24 us |
| clustered | 500 | 16 | 30.41 us | 36.44 us | 19.83% | 40.93 us |
| clustered | 2000 | 1 | 133.55 us | 173.66 us | 30.03% | 191.30 us |
| clustered | 2000 | 4 | 136.55 us | 166.52 us | 21.95% | 181.76 us |
| clustered | 2000 | 16 | 142.38 us | 180.61 us | 26.85% | 205.86 us |
| clustered | 8000 | 1 | 1.226 ms | 1.452 ms | 18.41% | 1.500 ms |
| clustered | 8000 | 4 | 1.392 ms | 1.661 ms | 19.37% | 1.670 ms |
| clustered | 8000 | 16 | 1.915 ms | 2.202 ms | 14.95% | 2.276 ms |
| interleaved | 500 | 1 | 28.67 us | 36.77 us | 28.23% | 39.05 us |
| interleaved | 500 | 4 | 26.32 us | 27.59 us | 4.83% | 37.23 us |
| interleaved | 500 | 16 | 29.56 us | 21.36 us | -27.73% | 42.10 us |
| interleaved | 2000 | 1 | 164.03 us | 202.84 us | 23.67% | 229.78 us |
| interleaved | 2000 | 4 | 125.33 us | 134.31 us | 7.17% | 186.01 us |
| interleaved | 2000 | 16 | 126.09 us | 95.83 us | -24.00% | 191.27 us |
| interleaved | 8000 | 1 | 1.402 ms | 1.661 ms | 18.42% | 1.684 ms |
| interleaved | 8000 | 4 | 1.130 ms | 1.058 ms | -6.34% | 1.457 ms |
| interleaved | 8000 | 16 | 2.489 ms | 1.741 ms | -30.05% | 2.886 ms |

## Self-check: layers=1 is pure rebuild overhead (the prune can never fire)

| cluster | N | reduction | overhead |
| :--- | ---: | ---: | ---: |
| clustered | 500 | 0.0% | 30.24% |
| clustered | 2000 | 0.0% | 30.03% |
| clustered | 8000 | 0.0% | 18.41% |
| interleaved | 500 | 0.0% | 28.23% |
| interleaved | 2000 | 0.0% | 23.67% |
| interleaved | 8000 | 0.0% | 18.42% |

Worst single-layer overhead: 30.24% at clustered N=500 (reduction 0.0%, must be ~0 -- prune cannot fire).

## Pre-registered verdict (assertion A1)

Rule (FIXED before the run): SHIP iff cross-pair node-visits drop >= 25% on >= 2 of the clustered cells with
N >= 2000 AND layers >= 4, AND the single-layer (layers=1) ns/frame overhead
<= 3.0%. Otherwise CLOSE (leaf-level filtering alone; the
rebuild is dead weight).

Qualifying clustered cells (N>=2000, layers>=4):
  - N=2000 layers=4: reduction 0.1% (< 25% MISS)
  - N=2000 layers=16: reduction 0.7% (< 25% MISS)
  - N=8000 layers=4: reduction 0.1% (< 25% MISS)
  - N=8000 layers=16: reduction 1.8% (< 25% MISS)

Deciding numbers: 0/4 qualifying cells clear 25% (need >= 2); single-layer overhead 30.24% (limit 3.0%).

**VERDICT: CLOSE**
