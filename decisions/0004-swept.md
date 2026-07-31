# 0004 -- Swept detection: a trigger you can shoot through is a bug

- **Status:** ACCEPTED -- shipped in v1.3.0 and proven by the test suite (the
  bulk-vs-manual-vs-brute differential, the S3 superset and zero-motion-identity
  anchors, the S6 tunneling fixture, the S2 pass-through lifecycle, and the S4/S5
  fail-closed and world-scale checks; 103 tests green, torture gate `ok` with
  `maxArrayBuffersGrowth: 0` over 200k swept collects, control still exits 1).
  Implementation notes: `collectSweptPairs` shares ONE traversal with
  `collectPairs` (a `traverse(tree, swept)` inner function -- the 94-vs-1,543
  descent proven once, reused), handing the refinement inputs through closure
  slots so no per-call closure allocates; the swept unions are computed in
  registers (no scratch box); the union is inlined (no aabb runtime import, C1).
  The manual door shipped as the PAIR form `addSwept(a, prevA, currA, b, prevB,
  currB)` (the roadmap's single-entity sketch cannot form a pair), with a pure
  `sweptOverlap` predicate added alongside `narrow`.
- **Date:** 2026-08-01
- **Session:** O3 (v1.3.0), shipped
- **Scope:** the swept-volume shape (S1), the pass-through lifecycle (S2), the
  superset/identity contract vs discrete (S3), what `collectSweptPairs` requires
  of the tree and how it keys the tight refinement (S4), the world-scale ULP
  hazard (S5), and the committed tunneling fixture (S6).

This builds on `0001-pair-identity.md` (the pair table, `add`, the mark-sweep),
`0002-traversal.md` (the fat-bound self-traversal and its E4 leaf-leaf emit
site), and `0003-filters.md` (the `userData`-keyed refinement pattern). O3 adds a
*swept* candidate source feeding the SAME `addPair` door and the SAME lifecycle;
it does not touch the O0 structure, the O1 descent shape, or the O2 filter.
Repo-only record, never shipped in `files[]`.

The bug this session exists to kill: a projectile moving faster than its own
width is in front of a thin trigger at frame N and behind it at frame N+1, and
the overlap existed at no sampled instant. Every discrete-sampling trigger system
in JS has it. Asking whether a swept volume overlapped during a frame is a
**broadphase** question -- the answer is a boolean, not an impulse -- so it is in
this package's lane, not aabb's (which rejects swept *resolution* as physics).

---

## S1 -- The swept volume is the AABB union of the prev and curr boxes

### Decision

For an entity that moved from tight box `prev` to tight box `curr` during a
frame, its swept volume is the axis-aligned union
`[min(prev.min, curr.min), max(prev.max, curr.max)]`. Two entities are reported
as a swept overlap when their swept volumes overlap (the touching-edge
convention, same as `narrow`). Computed inline with `Math.min` / `Math.max` in
registers -- **no `@zakkster/lite-aabb` runtime import** (the suite Law: zero
runtime deps; the union is four mins/maxes, the same reason `narrow` inlines the
overlap test rather than importing `aabb2.intersects`).

### Why union, and the conservatism named precisely

The union of the endpoints is the tightest *axis-aligned* box that contains the
entire linear sweep, so it **never misses** a real swept overlap: it is a
conservative broadphase, exactly like the fat-box traversal it rides on. It
**over-reports on diagonal motion**: an entity sliding along the `x=y` diagonal
sweeps a thin diagonal ribbon, but its union box is the full bounding rectangle
of that ribbon, so two entities crossing opposite corners of the rectangle
without their ribbons meeting are still reported. State this in the docs in those
words. The exact answer -- testing the swept *ribbons* (a segment / Minkowski
test) -- is named `sweptOverlapExact` and **deferred**: it is only worth shipping
if a bench shows the ribbon test is cheap enough to matter, and the union answer
is the correct broadphase in the meantime (never a missed pair; the caller
gates geometry with its own tight recheck exactly as it does after
`collectPairs`).

### Surface (deviation from the roadmap sketch, on the record)

The roadmap's one-line sketch writes `addSwept(a, prevBoxA, currBoxA)` -- a
single entity. A swept volume yields a *pair* only when tested against another
swept volume, so the shipped manual door is a **pair** door:

    addSwept(a, prevBoxA, currBoxA, b, prevBoxB, currBoxB)

It mirrors `add(a, b)`: supply the two entities' motions, it decides and records.
It is the swept analog of `add` and the differential **oracle** for the bulk
path, precisely as `add` is the oracle for `collectPairs`. A pure predicate

    sweptOverlap(prevA, currA, prevB, currB) -> boolean

is added alongside, mirroring `narrow`: zero-alloc, no table, no tree, no import
-- the primitive `addSwept` and `collectSweptPairs` are both built on.

---

## S2 -- A pass-through fires ENTER on the crossing frame, through the ordinary channel

**This is the session's load-bearing decision.** A projectile that crosses a
trigger entirely within one frame -- swept volumes overlap, current boxes do not
-- fires **enter on the crossing frame via the normal `addPair` / `drainEnter`
path**, and **exit on the next frame it is no longer swept-overlapping**, via the
ordinary 0001 mark-sweep. No new event channel. No same-frame special case.

### The three candidates, and why enter-through-the-normal-channel wins

1. **Separate `drainPass` channel** (pass-throughs reported on their own drain,
   never entering the pair table). Clean *semantics* -- a crossing is ontologically
   not a sustained contact -- but it is a **footgun that reintroduces the exact
   bug this session kills**: a caller who wires `drainEnter` / `drainExit` (the
   O0/O1/O2 contract every existing caller already has) and does *not* adopt the
   new channel would **silently miss every pass-through hit**. Rejected: the whole
   point is that a fast projectile is not silently missed.

2. **Enter + exit in the same frame** (compress the transition into one frame).
   Requires either a phantom insert-then-remove or a per-slot "transient" bit plus
   special-case logic in `end()`, and it tangles with a pair that was genuinely
   overlapping last frame and is separating this frame (that pair is *exiting*, not
   passing -- distinguishing the two needs a table probe anyway). Muddies the O0
   lifecycle for no fail-safety gain over option 3. Rejected.

3. **Enter on the crossing frame, exit on the next non-overlapping frame, via
   `addPair` and the ordinary sweep** (chosen). The swept candidate feeds the same
   door as every other source. A pass-through therefore fires `onEnter` -- the
   projectile *did* enter the trigger's region -- through the channel the caller
   already handles, **with zero new wiring**, and `onExit` the following frame when
   the swept volume has moved on. The only cost is a one-frame tail where the pair
   is a "stay" although the entities are already apart; that tail is itself a
   faithful enter -> exit transition (it entered, then it left), and it is the same
   one-frame quantization the whole delta system already lives with.

The deciding argument is fail-safety: option 3 delivers the hit through the
enter channel every existing caller already reads; options 1 and 2 either risk a
silent miss (1) or complicate the lifecycle (2). "Never silently miss a
collision" is the package's reason to exist, and option 3 is the only one that
honors it with no new caller obligation.

### Consequence for the table invariant

Because swept candidates feed `addPair`, the pair table after a swept collect
holds the **swept-union** overlaps. That is a superset of the current-box
overlaps (S3), never a subset -- so no discrete pair is ever lost by using the
swept path, and the DONE-WHEN "swept is provably a superset" is a table-level
fact, not a cross-channel reconciliation.

---

## S3 -- Swept is a superset of discrete, and zero motion is bit-identical

- **Superset, always.** `union(prev, curr)` contains `curr` by construction, so
  if two current boxes overlap, their swept unions overlap. Every discrete pair
  is therefore a swept pair. Asserted directly against `collectPairs` on the same
  frame: `sweptSet` is a superset of `discreteSet`, always.
- **Zero motion is the discrete path, bit-for-bit.** When `prev === curr`
  (component-wise), `min(x, x) = x` and `max(x, x) = x` are exact in float32, so
  the swept union *is* the current box and the swept test *is* the discrete test.
  `collectSweptPairs` with `prev === curr` produces the byte-identical set
  `collectPairs` does. Asserted. This is the anchor that makes the superset a
  clean extension rather than a different algorithm.

---

## S4 -- `collectSweptPairs` requires a swept-bounding tree; the refinement keys on `userData`

    collectSweptPairs(tree, prevPacked, currPacked, count)

### The precondition, and why it cannot be checked

Broadphase pruning is only sound if a node's box bounds every position its leaves
occupy *during the frame*. So the caller MUST build the tree with leaf boxes that
bound the swept motion -- insert `fatten(union(prev, curr))` (the caller uses
`aabb2.merge` / `mergeAll` to build these; that batch op shipped in aabb 2.0 for
exactly this, and it is the caller's tree-build, not this package's runtime
dependency). If the tree holds only current boxes, the descent prunes a
tunneling pair before it ever reaches a leaf -- the projectile's current box is
nowhere near the wall -- and the swept refinement never runs. This is a **caller
contract**, documented and not machine-checkable, the same class as "feed `add`
the right ids": the library cannot see the motion the tree was built from.

### The refinement, and the key

The traversal prunes on the swept-fat tree boxes (sound: never misses), and at
each leaf-leaf candidate it recomputes the **tight** swept union from
`prevPacked` / `currPacked` and tests overlap -- dropping the fat-only
over-reports the fattened tree produced, exactly as `narrow` refines
`collectPairs`, but inlined into the bulk path so no pair escapes to a second
call. The prev/curr boxes are packed `4*count` and indexed by **`userData`**
(leaf `u` -> `prevPacked[u*4 .. u*4+3]`), the same entity-id keying F1 chose and
for the same reason: it is stable across bvh rotations, and it lines up the
motion data with the leaf's identity, not its transient node id. A leaf whose
`userData >= count` is a **fail-closed** throw (the motion arrays do not reach
it -- `null` is not zero; a swept test on absent data would silently under-report).

Zero allocation: both swept unions are computed in registers (mins/maxes of the
eight packed slots), the overlap is four comparisons, and the result feeds
`addPair`. No scratch box, no per-pair object.

---

## S5 -- World-scale coordinates: the union is exact, but a sub-ULP motion vanishes

`min` / `max` of float32 values are exact, so the union itself introduces no
error. The hazard is upstream and is aabb's finding A-01: at a coordinate near
`1e7`, one float32 ULP is ~1, so a motion delta smaller than that ULP is
swallowed -- `curr` rounds to `prev`, the union equals a single box, and a
grazing swept contact is lost with nothing thrown. Decisions:

- **Assert the swept union is strictly larger than both inputs** at coordinates
  `1`, `1e3`, `1e6`, `1e7`, with a motion delta above the local ULP at each scale
  -- the A-01 detector pointed at this package. Strict containment must hold
  wherever the motion is representable.
- **Surface `marginFloor` guidance** in the docs: to keep a swept volume strictly
  larger than its endpoints at world scale, ensure the motion delta (or a
  `fatten` margin applied when building the tree) exceeds
  `aabb2.marginFloor(box)` for the box's magnitude. Below that floor the union
  degenerates to a point-in-time test -- documented, the A-01 shape, not a
  silent surprise.

---

## S6 -- The tunneling fixture is committed as numbers, and lives in the README

A committed table of `(speed, thickness)` cases where discrete detection provably
fails and swept provably succeeds -- both columns as literal numbers, checked in
`test/`, and reproduced in the README as the package's proof of value. The test
asserts, for every row: discrete (current-box `collectPairs` / `narrow`) reports
**no** pair, and swept (`addSwept` / `collectSweptPairs`) reports the pair. The
honest bench framing accompanies it: "swept costs X% more and catches what
discrete cannot" -- never "swept is free."

---

## Summary of load-bearing couplings (do not change one without the others)

- **S1 union feeds S3 superset.** The union contains `curr`, which is *why*
  swept is a superset and *why* zero-motion is bit-identical. Replacing the union
  with any volume that does not contain `curr` breaks both at once.
- **S2 routes swept candidates through `addPair`.** That is what makes the
  superset a table-level fact (S3) and what makes a pass-through fire on the
  enter channel every caller already reads. A separate pass channel would
  reintroduce the silent-miss this session exists to kill.
- **S4's precondition is the soundness of the whole bulk path.** A tree not built
  from swept-bounding boxes prunes tunneling pairs before the refinement can see
  them -- the refinement tightens, it cannot recover a pair the descent already
  dropped. The tight refinement keys on `userData` for the same rotation-immunity
  reason F1/F3 do.
- **C1 still holds:** no runtime import of aabb or bvh. S1 inlines the union; the
  caller uses `aabb2.merge`/`mergeAll` to *build* the swept tree, off this
  package's runtime path. FORMAT_VERSION stays `1` -- no buffer contract changes.
