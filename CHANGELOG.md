# Changelog

All notable changes to `@zakkster/lite-overlap` are documented here.
The format follows Keep a Changelog; this package adheres to SemVer.

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
