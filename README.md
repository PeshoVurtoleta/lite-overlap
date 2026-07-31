# @zakkster/lite-overlap

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-overlap.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-overlap)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Engine-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-overlap?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-overlap)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-overlap?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-overlap)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-overlap?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-overlap)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational?style=for-the-badge)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?style=for-the-badge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

**Zero-GC persistent overlap events over a dynamic BVH (2D).** Overlap is not a
set -- it is a set of *transitions*. This turns "who overlaps now" into "who just
started (enter), who is still touching (stay), who just left (exit)," and finds
every pair exactly once in a single tree self-traversal. **No allocations after
construction**, on any frame path.

```js
import { createOverlap, narrow } from '@zakkster/lite-overlap';
import { DynamicBVH2D } from '@zakkster/lite-bvh';

const tree = new DynamicBVH2D(4096);
const ov   = createOverlap({ maxPairs: 8192 });

const enterA = new Int32Array(1024), enterB = new Int32Array(1024);
const exitA  = new Int32Array(1024), exitB  = new Int32Array(1024);

// Per frame:
ov.begin();
ov.collectPairs(tree);            // every overlapping pair, found once
ov.end();

const nEnter = ov.drainEnter(enterA, enterB);
for (let k = 0; k < nEnter; k++) onOverlapStart(enterA[k], enterB[k]);

const nExit = ov.drainExit(exitA, exitB);
for (let k = 0; k < nExit; k++) onOverlapEnd(exitA[k], exitB[k]);
```

---

## Contents

- [Why](#why) - [Install](#install) - [The frame cycle](#the-frame-cycle)
- [Two ways to feed a frame](#two-ways-to-feed-a-frame)
- [Fat vs tight: the one thing to get right](#fat-vs-tight-the-one-thing-to-get-right)
- [How it works](#how-it-works)
- [API](#api) - [Guarantees](#guarantees) - [License](#license)

## Why

A spatial index answers **"what overlaps box X, right now."** Game logic needs two
things it cannot give:

1. **Transitions.** Fire the pickup *once* when the player touches it; drop aggro
   when they leave. That is a frame-over-frame delta, and every JS implementation
   reaches for `` new Set(`${a},${b}`) `` -- **7.8 KB/frame at 1,543 pairs, 0.46
   MB/s of string garbage at 60 fps**, measured. In a library family whose whole
   identity is that it does not allocate, that is the number to erase.

2. **All pairs, found once.** "Everything overlapping everything" by looping
   `query()` per entity finds every pair *twice* and rebuilds a query box per
   entity -- 3,086 directed reports for 1,543 real pairs at N = 2000. A single
   tree descent finds each pair once and rebuilds nothing.

`lite-overlap` is the layer between the index and the logic, and it does both with
zero allocation per frame. **It is not a solver** -- no contact normals, no MTV,
no impulses. The answer to "did these overlap this frame" is a boolean and a
transition, not a force.

## Install

```bash
npm install @zakkster/lite-overlap
```

Pair it with [`@zakkster/lite-bvh`](https://www.npmjs.com/package/@zakkster/lite-bvh)
for the tree and [`@zakkster/lite-aabb`](https://www.npmjs.com/package/@zakkster/lite-aabb)
for the box math. All three share one `FORMAT_VERSION` buffer contract and none
depends on the others at runtime -- format agreement only. ESM only; Node >= 18.

## The frame cycle

```
begin()  ->  report pairs  ->  end()  ->  drainEnter / drainExit
```

`begin()` flips a 1-bit tag so every stored pair is now "stale." Each reported
pair re-stamps its slot as "touched this frame." `end()` scans the table once:
every slot still stale was not touched, so it *exited* -- staged and removed. What
you drain after `end()` is the delta, and it holds until the next `begin()`.

`add(a, b)` is order-invariant (`(a,b)` and `(b,a)` are one pair), idempotent
within a frame (report the same pair twice, get one enter), and rejects `a === b`.

## Two ways to feed a frame

Both feed the same table, so you can mix them in one frame for one unified delta:

```js
// A) Traverse a BVH -- all pairs, one descent:
ov.begin();
ov.collectPairs(tree);
ov.end();

// B) Report pairs by hand -- from a non-BVH index, or extra trigger volumes:
ov.begin();
ov.collectPairs(tree);          // tree pairs...
ov.add(playerId, zoneId);       // ...plus a hand-fed pair, same frame
ov.end();
```

`collectPairs` owns no frame boundary -- **you** call `begin()` and `end()`. That
is what lets the two sources share one delta.

## Fat vs tight: the one thing to get right

A BVH keeps each box **fattened** (a margin, so small moves need no rebuild). So
`collectPairs` reports the *fat* pairs the tree holds: a **conservative
broadphase**. It never misses a real overlap -- but it can report a pair whose
*tight* boxes are a hair apart.

If you act on geometry from the raw pair -- deal damage, grant a pickup -- gate it
with a tight recheck first:

```js
// tightA / tightB are YOUR tight boxes for a and b (Float32Array(4)),
// the ones you had before you fattened them into the tree.
if (narrow(tightA, tightB)) {
    dealDamage(a, b);
}
```

`narrow` takes **your** boxes, not the tree, on purpose: the tree does not store
tight boxes -- only you have them. It is a pure `[minX, minY, maxX, maxY]` overlap
test, zero allocation, zero dependency.

## How it works

- **Pair identity is two parallel `Int32Array`s**, never one packed number. Two
  int32 ids are 62 bits; a JS number is exact only to 2^53, so a packed key either
  caps ids at ~2^26 or loses precision silently. Pairs are stored canonically
  (`a < b`), hashed from both ids with `Math.imul` (stays int32).
- **The table is open-addressed over typed arrays**, power-of-two capacity,
  bitmask index, **backward-shift deletion** (not tombstones -- a trigger set
  churns every frame, the one load tombstones degrade under).
- **Exit detection is a 1-bit alternating tag**, not a wide epoch counter. Because
  a pair is removed the moment it exits, no slot survives a frame untouched, so
  the tag cannot wrap into a false "current." No 414-day wraparound bug.
- **`collectPairs` descends node-pairs on a fixed `Int32Array` stack.** It recurses
  a node against itself (splitting into both children *and* the cross term),
  descends the taller node of a cross-pair, and prunes on a box miss -- so each
  pair is found once. The stack is sized from the tree's `maxNodes`; an impossible
  overflow throws fail-closed rather than allocating mid-frame.
- **Capacity is fixed and every overflow is atomic.** A pair past `maxPairs`
  throws *before* mutating -- the table is left unchanged and usable, and the
  message names the remedy. Size it from `stats().highWaterMark`.

## API

| Member | What it does |
| --- | --- |
| `createOverlap({ maxPairs })` | Allocate an instance and its table. The only allocating call. |
| `begin()` | Open a frame. O(1). |
| `add(a, b)` | Report a pair by hand. Order-invariant, idempotent, throws atomically past `maxPairs`. |
| `collectPairs(tree)` | Report every overlapping pair in a BVH, once. Fat-bound; feeds `add`. |
| `end()` | Close the frame; emit and remove exits. O(capacity). |
| `drainEnter(outA, outB)` / `drainExit(outA, outB)` | Copy this frame's enter / exit ids into your buffers; return the count. |
| `pairCount()` / `stayCount()` | Live pairs / live pairs that did not enter this frame. |
| `stats()` | `pairCount`, `stayCount`, `capacity`, `loadFactor`, `probeHighWater`, `highWaterMark`, `stackHighWater`, `epoch`. Cold path. |
| `clear()` | Empty the table without reallocating and without emitting exits. |
| `narrow(boxA, boxB)` | Tight AABB overlap on two of **your** boxes. Pure boolean, zero alloc. |
| `VERSION` / `FORMAT_VERSION` | Package semver / shared buffer-contract version (= `1`). |

Full types and per-method contracts are in `Overlap.d.ts`.

## Guarantees

- **Zero runtime dependencies.** Single ESM file, `sideEffects: false`.
- **Zero allocation on every frame path** -- `add`, `collectPairs`, `end`, the
  drains, `narrow`. Proven by a `node --expose-gc` torture gate at `maxMajor: 0`
  and `maxArrayBuffersGrowth: 0`, with a `Set<string>` control that **must fail**
  the gate, so the gate is falsifiable rather than decorative.
- **Fail closed on every unverified state** -- capacity exhaustion, traversal
  stack overflow, and a corrupt tree (leaf signals that disagree) each throw with
  a remedy in the message, never a silent mis-report. `null` is not zero.
- **Correctness pinned against an oracle** -- the traversal's pair set is asserted
  identical to a brute-force O(N^2) check and to the caller-fed `query()` path over
  a seeded fuzz corpus, including degenerate trees (empty, single leaf, all
  identical, all at one point, single row).

## License

MIT (c) 2026 Zahary Shinikchiev. See [LICENSE](LICENSE).
