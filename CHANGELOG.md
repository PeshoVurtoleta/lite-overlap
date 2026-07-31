# Changelog

All notable changes to `@zakkster/lite-overlap` are documented here.
The format follows Keep a Changelog; this package adheres to SemVer.

## [1.3.0] - 2026-08-01

Swept detection -- the headline. A projectile moving faster than its own width is
in front of a thin trigger at frame N and behind it at frame N+1; the overlap
existed at no sampled instant, and every discrete-sampling trigger system misses
it. This release tests the swept volume `union(prev, curr)` instead of the
instantaneous box, so the crossing is caught. It feeds the SAME `add` door and
enter/stay/exit lifecycle as everything else: a pass-through fires **enter** on
the crossing frame through the ordinary channel and **exit** the next -- no new
drain to wire up, no pair silently missed. No new runtime dependency;
`FORMAT_VERSION` stays `1`. Design of record: `decisions/0004-swept.md`.

### Added
- **`addSwept(a, prevBoxA, currBoxA, b, prevBoxB, currBoxB)`** -- the manual
  swept pair door, the swept analog of `add`: supply the two entities' motions,
  it records the pair iff their swept volumes overlap. The differential oracle for
  `collectSweptPairs`. Unfiltered by design, like `add` (decision S1).
- **`collectSweptPairs(tree, prevPacked, currPacked, count)`** -- the bulk swept
  broadphase. Prunes on a swept-bounding tree (a caller contract: build leaf boxes
  as `fatten(union(prev, curr))`) and refines each surviving leaf pair with the
  tight `union(prev, curr)` from the packed motion arrays -- indexed by `userData`,
  the same rotation-stable keying the O2 filter uses. A leaf `userData >= count`
  fails closed (decision S4). The O2 filter applies identically.
- **`sweptOverlap(prevA, currA, prevB, currB)`** -- the pure swept predicate, the
  swept analog of `narrow`: zero allocation, no table, tree, or import
  (decision S1).

### Semantics
- **Swept is a superset of discrete, always** -- the union contains `curr`, so
  every instantaneous overlap is a swept overlap; no discrete pair is ever lost by
  using the swept path (decision S3).
- **Zero motion is bit-identical to discrete.** With `prevPacked === currPacked`
  the union *is* the current box (`min`/`max` are idempotent and exact in float32),
  so `collectSweptPairs` reproduces `collectPairs` byte-for-byte (decision S3).
- **Conservative on diagonal motion** (named precisely): the axis-aligned union
  over-reports two entities crossing opposite corners of a shared bounding
  rectangle without their thin diagonal ribbons meeting. Never a missed pair;
  gate geometry with your own tight boxes as after any broadphase. The exact
  ribbon test (`sweptOverlapExact`) is deferred (decision S1).
- **Pass-through fires enter, not a separate event** (decision S2). A separate
  `drainPass` channel was rejected: a caller who reads only `drainEnter` /
  `drainExit` would silently miss pass-through hits -- the exact bug this release
  exists to kill.

### Guarantees held
- Zero allocation on the swept frame path: both swept unions are register mins/
  maxes, nothing per pair. Proven by the torture gate (`maxArrayBuffersGrowth: 0`
  over 200k swept collects) plus a dedicated node:test buffer-growth assertion;
  the `Set<string>` control still trips the gate.
- Fail closed on world-scale coordinates (finding A-01): the swept union is
  strictly larger than both inputs whenever the motion exceeds the local float32
  ULP; below it the union degenerates to a point-in-time box -- asserted at
  coordinates 1, 1e3, 1e6, 1e7, with `marginFloor` guidance in the docs
  (decision S5).
- 103 tests pass (`node --test`), including the bulk-vs-manual-vs-brute
  differential, the superset and zero-motion-identity anchors, the committed
  tunneling fixture (decision S6), the pass-through lifecycle, and the fail-closed
  range checks.

## [1.2.0] - 2026-07-31

Layers and filters. The self-traversal from 1.1.0 reported every overlapping
pair; a real trigger system wants "player against pickups, not pickups against
each other." This release filters **during** the descent -- strictly cheaper than
filtering the emitted set -- keyed by `userData` so it stays correct across BVH
rotations, and results-preserving: the filtered set equals the unfiltered set
post-filtered in JS, always. No new runtime dependency; `FORMAT_VERSION` stays
`1`. Design of record: `decisions/0003-filters.md`.

### Added
- **`setLayer(userData, layerIndex)`** -- assign an entity to one of 32 layers
  (default 0). Keyed by `userData` (the stable entity id), never a node id, so
  the assignment survives BVH rotations -- a refit relinks node ids but never
  `userData` (decision F1).
- **`setInteract(layerA, layerB, enabled)`** -- set whether two layers test each
  other. Writes both `(a,b)` and `(b,a)`: the 32x32 collision matrix is symmetric
  by construction, so an asymmetric rule (a pair whose appearance depends on which
  node the descent reached first) is unrepresentable. Default is all-pairs-enabled,
  so an instance whose layers are never touched reports exactly the 1.1.0 set
  (decision F2).
- **`setEnabled(userData, enabled)`** -- enable or disable an entity. A disabled
  entity generates no pairs; all of its live pairs fire exit at the next `end()`,
  exactly once, through the ordinary mark-sweep -- no special exit path, cheaper
  than removing the leaf and re-inserting it (decision F4).
- **`createOverlap({ maxPairs, maxEntityId? })`** -- optional `maxEntityId` caps
  the `userData`-keyed filter arrays (fixed size, fail-closed above it). Omitted,
  they grow lazily-once on the cold `setLayer` / `setEnabled` path -- never on a
  frame path -- so `createOverlap({ maxPairs })` stays a valid, non-breaking call
  and a caller who never filters allocates no filter storage.

### Filtering model
- Applied inside `collectPairs`, at each leaf-leaf candidate, **before** `add` and
  **after** the fail-closed duplicate-`userData` corruption check -- filtering
  never masks a corrupt tree (decision F1). The raw `add(a, b)` door stays
  unfiltered by design (it is the primitive and the differential oracle).
- Filter state is **sampled at collect**: set layers / enabled before the frame's
  `collectPairs`, not after.
- **No cached node-keyed subtree masks.** They cannot be maintained from outside
  `@zakkster/lite-bvh` (rotations relink node ids inside `_refit` with no external
  hook), so a cached mask would silently prune a subtree that should interact and
  drop pairs. Rejected on that evidence (decision F3); only leaf-level,
  `userData`-keyed filtering ships. A rotation-adversary test (monotone drift that
  provokes rotations) pins the filtered set equal to the brute filtered oracle
  every frame.

### Guarantees held
- Zero allocation on every frame path with filtering active: the mask test reads
  pre-owned buffers and the setters are cold config. Proven by the torture gate
  (`maxMajor: 0`, `maxArrayBuffersGrowth: 0`) plus a dedicated filtered-path
  buffer-growth assertion; the `Set<string>` control still trips the gate.
- 90 tests pass (`node --test`), including the F2 results-preserving corpus, the
  F3 rotation adversary, the F4 exit-on-disable lifecycle, and the fail-closed
  validation matrix.

## [1.1.0] - 2026-07-31

The all-pairs self-traversal. The pair table from 1.0.0 was fed by the caller
(N `query()` calls, every pair found twice). This release adds a single BVH
descent that finds each pair exactly once and rebuilds no query boxes -- reading
`@zakkster/lite-bvh`'s readonly Structure-of-Arrays directly, with no fork and no
runtime dependency (format agreement only; `FORMAT_VERSION` stays `1`). See
`decisions/0002-traversal.md`.

### Added
- **`collectPairs(tree)`** -- iterative self-traversal over a BVH's readonly SoA
  (`bboxes`, `children`, `heights`, `userData`, `root`, `maxNodes`), feeding
  `add(a, b)` directly. It reports the **fat-bound** pair set the tree holds:
  conservative broadphase, so a pair may be reported whose *tight* boxes do not
  overlap -- never the reverse (a real overlap is never missed). Feeds the frame
  you own: call it between `begin()` and `end()`, alongside any manual `add()`
  calls, for one unified enter/stay/exit delta. Zero allocation on the traversal
  path -- the node-pair stack is sized once from the tree's `maxNodes` and, on an
  impossible overflow, throws fail-closed rather than growing.
- **`narrow(boxA, boxB)`** -- the tight recheck, as a pure predicate on two
  caller-supplied `Float32Array(4)` boxes (`[minX, minY, maxX, maxY]`). Because a
  BVH stores only *fattened* boxes, only the caller holds the tight geometry; so
  `narrow` takes your boxes, not the tree. Zero allocation, zero dependency. Run
  it on a pair `collectPairs` reported, using your own tight boxes, before you
  act on geometry.
- **`stats().stackHighWater`** -- the traversal frontier's high-water mark, the
  sizing signal for the node-pair stack (mirroring `highWaterMark` for pairs).

### Notes
- `add`'s hot body was extracted into a shared internal insertion helper so the
  traversal and the caller-fed path share one door. Behaviour is byte-identical;
  the 1.0.0 lifecycle, canonicalisation, dedup, and atomic capacity throw are
  unchanged.
- The caller-fed path from 1.0.0 remains fully supported and is the differential
  oracle for the traversal: the same table and lifecycle, a different pair source,
  and the two pair sets must match.

## [1.0.0] - 2026-07-30

Initial release: the pair lifecycle. Turns a per-frame set of overlapping pairs
into a per-frame *delta* -- who just started overlapping (enter), who is still
touching (stay), who just stopped (exit) -- with zero allocation per frame. The
number it beats: the usual `Set<string>` pair-key implementation costs
7.8 KB/frame at 1,543 pairs (0.46 MB/s of garbage at 60 fps). See
`decisions/0001-pair-identity.md`.

### Added
- **`createOverlap({ maxPairs })`** -- an instance owning one open-addressed pair
  table. Every buffer is allocated at construction; nothing allocates afterwards
  on any frame path.
- **`begin()` / `add(a, b)` / `end()`** -- the frame cycle. `add` is
  order-invariant (`(a, b)` and `(b, a)` are one pair), idempotent within a frame,
  and rejects `a === b`. Pair identity is two parallel `Int32Array`s (never a
  packed key -- 62 bits does not fit 2^53); the table is open-addressed with
  backward-shift deletion; exit detection is a 1-bit alternating tag.
- **`drainEnter(outA, outB)` / `drainExit(outA, outB)`** -- copy this frame's
  enter/exit ids into caller `Int32Array`s (bvh's `query(out)` convention),
  returning the count. Non-destructive until the next `begin()`.
- **`pairCount()` / `stayCount()` / `stats()`** -- live pairs, load factor, probe
  high-water, and `highWaterMark` (the number to size `maxPairs` from).
- **`clear()`** -- silently empty the table without reallocating and without
  emitting exits. To flush exits on teardown, run one empty `begin(); end();`
  frame, then `clear()`.
- **`VERSION`** and **`FORMAT_VERSION`** (= `1`) -- the shared buffer-contract
  version, on a separate axis from semver, asserted equal against
  `@zakkster/lite-aabb` and `@zakkster/lite-bvh` by a conformance test (copied
  inline, no runtime dependency).
