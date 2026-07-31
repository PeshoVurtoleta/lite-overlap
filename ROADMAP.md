# `@zakkster/lite-overlap` — roadmap

The module to build on aabb 2.0 + bvh 2.0. Five sessions, one A+ demo.

Both 2.0.0 releases landed 2026-07-30 with the full ladder shipped — aabb
1.0.1 → 1.3.0 → 2.0.0, bvh 1.0.1 → 1.3.0 → 2.0.0, `FORMAT_VERSION = 1` and
`FORMAT.md` in both. That unlocks exactly one thing, and it is a good one.

---

## 1. The gap, measured

bvh answers **"which entities overlap box X, right now."** Games need two things
it cannot give, and both are measurable against the shipped 2.0.0.

### 1.1 There is no all-pairs query. Every pair is found twice.

`grep -ci "selfQuery|allPairs|queryPairs|pairs"` across `Bvh.d.ts` and
`llms.txt`: **0**. So a caller who wants "everything overlapping everything"
loops over N entities and calls `query()` per entity. Measured at N = 2000,
14×14 boxes over a 1000×1000 field:

```
brute-force O(N²) ground truth        : 1,543 unordered overlapping pairs
N root-down queries report            : 3,086 directed  -> every pair seen TWICE
cost                                  : 1.472 ms/frame, half of it duplicate
plus                                  : N AABB rebuilds per frame to feed query()
tree height (rotations working)       : 13 for 2000 leaves
```

A tree self-traversal — descend `(nodeA, nodeB)` node pairs, prune when their
boxes miss — yields each pair exactly once and never rebuilds a query box.

**And it is subtle enough to justify a package.** A 20-line sketch of that
traversal written directly against the exposed SoA returned **94 pairs instead
of 1,543** on the first attempt: the node-versus-itself case and the
height-based descent choice are both easy to get wrong, and wrong here means
silently missing collisions. That failure is the argument for shipping a tested
implementation rather than a snippet in a README.

### 1.2 There is no temporal dimension, and the usual fix allocates

bvh says "A and B overlap." Games need **"A *started* overlapping B"** (fire the
pickup, deal damage once, play the sound) and **"A *stopped*"** (leave the zone,
drop aggro). That is a frame-over-frame delta, and every JS implementation of it
reaches for `Set<string>` with `` `${a},${b}` `` keys. Measured for the same
1,543 pairs:

```
Set<string> pair keys : 7.8 KB/frame  ->  0.46 MB/s of garbage at 60 fps
```

Half a megabyte per second of string garbage, in a package family whose entire
identity is that it does not allocate. That is the number the demo puts on
screen next to a toggle.

### 1.3 The enabling fact

bvh 2.0 exposes the whole structure as `readonly` public members — `bboxes`,
`parents`, `children`, `heights`, `userData`, `root`, `nodeCount`, `maxNodes`.
So a third package can traverse the tree with **no fork, no patch, and no
runtime dependency** — format agreement only, the same rule aabb and bvh already
live by. `lite-overlap` becomes the third participant in `FORMAT_VERSION 1`.

---

## 2. The module

**`@zakkster/lite-overlap`** — persistent overlap events over a dynamic BVH.
Name verified free on npm, scoped and unscoped.

> Turns "who overlaps now" into "who just started, who is still touching, who
> just left" — in one tree traversal, with zero allocation per frame.

**It is not a solver.** No contact normals, no MTV, no impulses, no restitution.
aabb's README already draws that line and this package stays on the same side of
it. What it owns is the layer between a spatial index and game logic: pair
lifecycle, filtering, and swept detection so a fast projectile cannot pass
through a trigger.

Why this and not the obvious alternatives:

| Candidate | Verdict |
| --- | --- |
| Full collision solver | Competes with Rapier/Matter/Planck on their terms. No niche, no win. |
| Spatial hash | bvh already covers the index. Duplicate. |
| Frustum culling | Real but thin — one `intersects` loop and a mask. A feature, not a package. |
| Narrowphase / SAT for rotated shapes | A different geometry contract; the FORMAT is axis-aligned. Separate package if ever. |
| **Pair lifecycle + all-pairs + swept** | **Nobody ships this zero-alloc. It is the piece every game hand-rolls and gets wrong twice.** |

Dogfood target: the scratch-card games' reveal regions, and any Vikings-rewrite
HUD hit-testing — both are trigger-shaped problems currently solved by hand.

---

## 3. The four decisions that make it A+

Every one of these has a precedent in this ecosystem, and three of them are
precedents where something went wrong. The roadmap's value is refusing to repeat
them.

### D1 — Pair keys are two parallel `Int32Array`s, never one packed number

`userData` is a non-negative int32, `[0, 2^31-1]`. Two of them is **62 bits**,
and a JS number holds exact integers only to **2^53**. So a packed key either
imposes an undocumented ~2^26 ceiling per id or silently loses precision on
large ids.

Three precedents, all from this ecosystem:

- **lite-arena AR-01** — a signed handle stored in a `Uint32Array`; the compare
  failed above generation 2048 and every component operation silently broke.
- **lite-audio AU-01** — `busIndex * 2^32 + poolHandle` is exact to 2^53 but
  leaves SMI range, so every `play()` on a bus above 0 returns a heap-boxed
  double. Measured 57× the allocation of an SMI return.
- **lite-bvh** — solved it the right way by keeping `userData` inside int32 and
  never packing.

So: `keyA: Int32Array`, `keyB: Int32Array`, hashed from both. No ceiling, no
boxing, no sign hazard. Store pairs canonically ordered (`a < b`) so `(a,b)` and
`(b,a)` are the same slot by construction.

### D2 — The pair table is open-addressed over typed arrays, not a `Map`

A number-keyed `Map` allocates an iterator on every `for…of`, and rehashing
allocates. A trigger system iterates its whole pair set every frame — the one
access pattern `Map` charges for.

Linear probing over `Int32Array`, power-of-2 capacity, bitmask indexing,
**backward-shift deletion rather than tombstones** (a trigger set churns every
frame; tombstones degrade under exactly that load). Capacity fixed at
construction.

### D3 — Exit detection is an epoch mark-sweep

Stamp every pair touched this frame with the frame epoch. After the pass, any
pair whose epoch ≠ current has stopped overlapping → emit exit, remove. O(pairs),
zero allocation, and it is the same pattern `lite-signal-dom`'s `keyed`
reconciler already uses — ecosystem-consistent rather than novel.

**Name the wraparound before it bites.** An int32 epoch at 60 fps wraps in ~414
days. A pair untouched across the wrap looks current and its exit never fires —
the AR-01 failure shape exactly, one wrap later. Decide at O0: sweep the whole
table on wrap, or widen the epoch, or fail closed. Do not leave it implicit.

### D4 — Capacity exhaustion is atomic and carries its remedy

The two precedents point opposite ways and the good one is in this ecosystem:

- **lite-bvh B-01** (fixed in 1.0.2): `insertLeaf` allocated the leaf, then the
  parent, and the second throw left a node consumed and orphaned with
  `nodeCount` corrupted.
- **lite-signal-gsap**: the 65th tween throws `"proxy pool exhausted (64). Use
  configure({ growthPolicy: 'grow' })"` — and `liveTweens` stays exactly 64,
  `killTweensOf` restores the pool, the next call succeeds. Verified.

Copy the second. Reserve before mutating; throw at the boundary; put the remedy
in the message: `"lite-overlap: pair table full (4096). Raise maxPairs."`

---

## 4. Sessions

```
O0 (1.0.0 pair lifecycle) ──► O1 (1.1.0 self-traversal) ──► O2 (1.2.0 filters)
                                                              │
                                              O3 (1.3.0 swept) ┴──► D1 (demo)
```

O0 before O1 deliberately: the pair table is independently useful — it works
today driven by N `query()` calls — and shipping it first means O1's traversal
lands against a gate and an oracle that already exist. The traversal is the part
that returned 94 instead of 1,543; it should not also be the part inventing its
own test harness.

===============================================================================
# O0 — lite-overlap v1.0.0 — the pair lifecycle
===============================================================================

```markdown
---
package: "@zakkster/lite-overlap"
version_target: 1.0.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-bvh ^2.0.0", "@zakkster/lite-aabb ^2.0.0"]
devPeers: ["@zakkster/lite-gc-profiler ^1.11.0"]
blocks: [O1]
---

# lite-overlap — enter / stay / exit without a single allocation

PURPOSE
  Turn a per-frame set of overlapping pairs into a per-frame *delta*. This
  session ships the data structure and the lifecycle; candidate pairs come from
  the caller (who can feed them from N `query()` calls today). O1 replaces the
  source, not the structure.

  The number to beat: the usual `Set<string>` implementation costs 7.8 KB/frame
  at 1,543 pairs — 0.46 MB/s at 60 fps, measured.

TASKS
  - `createOverlap({ maxPairs })` -> an instance owning the pair table. All
    buffers allocated once at construction; nothing allocates afterwards.
  - **Decide and record the four D-decisions above before writing code**, in
    `decisions/0001-pair-identity.md`:
      * D1 two parallel `Int32Array`s vs a packed key — including why 62 bits
        does not fit 2^53, with the AR-01 and AU-01 precedents named.
      * D2 open addressing vs `Map`, and backward-shift vs tombstones.
      * D3 the epoch sweep **and its wraparound policy**.
      * D4 fixed capacity, atomic reserve, remedy in the message.
  - `begin()` / `add(a, b)` / `end()` frame cycle. `add` is idempotent within a
    frame and canonicalises order so `(a,b)` and `(b,a)` are one pair.
  - **Event delivery — decide and record.** Two shapes:
      A. **Out-buffers** (recommended): `drainEnter(outA, outB)` /
         `drainExit(outA, outB)` -> count, writing into caller `Int32Array`s.
         Matches bvh's `query(out)` convention exactly, batches naturally, and
         lets the caller sort or filter before acting.
      B. Callbacks `onEnter(a, b)` / `onExit(a, b)` — sugar, two numbers never an
         object.
    If B ships, **name the re-entrancy contract**: a callback that calls `add`
    or mutates the tree mid-sweep mutates the table being iterated. That is the
    lite-signal-dom SD-01 failure shape. Decide — defer mutations to a queue
    drained after the sweep, or document that mutation during a callback is
    undefined and assert the guard in checked mode.
  - `stayCount()` / `pairCount()` / `stats()` — live pairs, table load factor,
    probe-length high-water, epoch. **`highWaterMark` is the number that tells a
    user what to set `maxPairs` to**, which is the one thing
    `lite-signal-gsap`'s `stats()` gets right that most pools do not.
  - `clear()` — reset without reallocating; emits exit for every live pair, or
    does not, per a recorded decision. (Scene teardown wants silence; a level
    reset may want the exits. Pick one and give the other a flag.)
  - Assert `FORMAT_VERSION` equality against both peers at construction, failing
    loud with both numbers named. Third participant in the contract.

HOT PATH
  `add` is the per-pair hot body: one hash, one probe loop, one epoch write. No
  string, no object, no closure. `end()` is one linear scan of the table.
  Everything else is cold.

ASSERTIONS
  - Lifecycle correctness against a naive `Set<string>` oracle over a seeded
    corpus of 10k+ frames of random appear/persist/disappear — enter, stay and
    exit sets identical every frame. Seed printed on failure.
  - `add(a,b)` and `add(b,a)` are one pair; adding the same pair twice in a
    frame yields one enter.
  - A pair that appears, persists 100 frames and vanishes produces exactly one
    enter and one exit.
  - A pair that vanishes and returns the next frame produces exit then enter,
    not a silent stay.
  - **Epoch wraparound:** force the epoch to its boundary and assert the
    recorded policy fires. This test is the whole reason D3 names it.
  - Table full: throws at the boundary, `pairCount()` unchanged, the table still
    usable, a subsequent remove-then-add succeeds. The lite-bvh B-01 test shape,
    applied before the bug can exist.
  - **0 B/frame** across 10k frames of churn — `checkNoGc` at `maxMajor: 0`
    **and `maxArrayBuffersGrowth: 0` with `stabilize: 'deep'`.** The heap gate
    alone cannot see a growing typed array, which is what this package is made
    of; that is the lite-bvh B-08 lesson.
  - Probe-length high-water stays bounded under a 0.7 load factor across the
    fuzz corpus — assert the number, so a hash change cannot quietly degrade it.
  - A control variant using `Set<string>` fails the alloc gate, proving the gate
    can fail.
  - `node --test`, `engines >= 18`, CHANGELOG, `VERSION`, llms.txt, `files[]`
    whitelist, `sideEffects: false`, zero runtime dependencies.

NON-GOALS
  No traversal (O1). No filtering (O2). No sweep (O3). No solver, ever.

DONE WHEN
  the lifecycle matches an oracle over 10k fuzzed frames at 0 B/frame, and the
  four decisions are on the record before the code
```

===============================================================================
# O1 — lite-overlap v1.1.0 — all-pairs self-traversal
===============================================================================

```markdown
---
package: "@zakkster/lite-overlap"
version_target: 1.1.0
status: planned
depends_on: [O0]
blocks: [O2]
---

# lite-overlap — find every pair once, in one descent

PURPOSE
  Replace N root-down queries with a single self-traversal. Measured today at
  N = 2000: 3,086 directed reports for 1,543 real pairs (every pair twice),
  1.472 ms/frame, plus N AABB rebuilds to feed `query()`.

  bvh exposes `bboxes`, `children`, `heights`, `userData` and `root` as readonly
  public members, so this needs no bvh change — format agreement only.

WHY THIS SESSION IS THE RISKY ONE
  A 20-line sketch of this traversal returned **94 pairs instead of 1,543**. The
  node-versus-itself case and the height-based descent choice are both easy to
  get wrong, and wrong means silently missing collisions — the worst failure mode
  available, because nothing throws. O0 exists first so this session inherits a
  working oracle instead of writing one under pressure.

TASKS
  - `overlap.collectPairs(tree)` — iterative self-traversal over an explicit
    `Int32Array` node-pair stack, feeding `add(a, b)` directly. Descend the
    deeper node; recurse a node against itself only when it is internal; prune
    on box miss.
  - **Stack sizing is a no-grow contract.** bvh 2.0 ships rotations, so height
    is O(log n) — measured 13 at N = 2000. Size the stack from `maxNodes` at
    construction and **assert it never grows**, exactly as bvh's own
    `queryStack` policy does after B-08. A mid-frame `new Int32Array` here is
    the same bug in a new package.
  - Keep the caller-fed path (`add` directly) fully supported and tested — it is
    how O0 shipped, it is how a caller with a non-bvh index uses this package,
    and it is the differential oracle for the traversal.
  - Decide whether `collectPairs` reads fat bounds (tree-stored) or the caller's
    tight bounds. **Fat bounds are what the tree holds**, so pairs are
    conservative — a pair can be reported whose tight boxes do not overlap.
    That is correct broadphase behaviour and it must be documented loudly,
    because a caller firing damage on `onEnter` without a tight recheck will
    have off-by-a-margin bugs. Consider shipping `narrow(tree, a, b)` as the
    documented tight recheck.

ASSERTIONS
  - **Pair set identical to the N-query path** across a seeded fuzz corpus:
    random N ∈ {1, 2, 10, 1000, 5000}, random box sizes including zero-area and
    fully-overlapping stacks, 10k+ frames. Sorted pair sets compared, not order.
  - Pair set identical to a brute-force O(N²) oracle at N ≤ 500. The 1,543
    number is committed as a fixture.
  - Degenerate trees: empty tree, one leaf, two leaves, all leaves identical, all
    leaves at one point, leaves in a single row. Each pinned.
  - `queryStack`-style assertion: traversal stack `.length` identical before and
    after a full collect on the adversarial monotone-insert order.
  - `maxArrayBuffersGrowth: 0` across 200k collect operations.
  - Bench, both machines, protocol-stamped: collect vs N-query at
    N ∈ {100, 1000, 5000, 20000}. Publish the crossover point honestly — if
    N-query wins below some N, say so and keep both paths.
  - Fat-versus-tight behaviour pinned by a named test.

DONE WHEN
  one traversal produces the same pairs as the oracle at every N, the stack
  provably never grows, and the crossover point is published
```

===============================================================================
# O2 — lite-overlap v1.2.0 — layers and filters
===============================================================================

```markdown
---
package: "@zakkster/lite-overlap"
version_target: 1.2.0
status: planned
depends_on: [O1]
---

# lite-overlap — the feature that makes it usable in a real game

PURPOSE
  Every real trigger system needs "player against pickups, not pickups against
  each other." Without filtering, a 500-entity scene reports thousands of pairs
  nobody cares about and the caller filters in JS — after paying for them.
  Filtering during descent is strictly cheaper than filtering after.

TASKS
  - `setLayer(userData, layerIndex)` and a 32×32 collision matrix as a
    `Int32Array(32)` bitmask table. `shouldTest(layerA, layerB)` is one AND.
  - **Filter during traversal, not after.** At a leaf-leaf candidate, mask-test
    before `add`. Decide whether an internal node can carry a union-of-layers
    mask to prune whole subtrees — that is the real win for scenes with many
    non-interacting layers, and it costs a per-node int that must be maintained
    on insert/refit. Since the node arrays belong to bvh and are `readonly`,
    a subtree mask lives in a parallel array owned by lite-overlap, keyed by
    node id. **Decide whether that array can stay correct** when bvh reshapes
    the tree via rotation — if it cannot be maintained from outside without
    hooks, reject subtree masking, record why, and keep leaf-level filtering.
    This is the session's one real design risk; name it up front.
  - `setEnabled(userData, bool)` — a disabled entity generates no pairs and
    fires exit for its live pairs on the frame it is disabled. Cheaper and
    clearer than removing it from the tree and re-inserting.
  - Layer changes mid-flight: a pair that becomes filtered must fire exit. Decide
    and pin it — a silent disappearance is the failure users report as "my exit
    never fired."

ASSERTIONS
  - Filtered pair sets equal the unfiltered set post-filtered in JS, over the
    fuzz corpus. Filtering changes cost, never results.
  - The 32×32 matrix is symmetric by construction; setting `(a,b)` sets `(b,a)`.
  - Changing a layer mid-frame fires exit for now-filtered live pairs, per the
    recorded decision.
  - `setEnabled(false)` fires exit for every live pair of that entity, exactly
    once.
  - Subtree masking either ships with a correctness proof under rotation, or is
    rejected in the ledger with the reason.
  - Alloc gates from O0/O1 still green with filtering active.

DONE WHEN
  layers cut cost without changing results, and the subtree-mask question is
  decided with evidence
```

===============================================================================
# O3 — lite-overlap v1.3.0 — swept detection (the headline)
===============================================================================

```markdown
---
package: "@zakkster/lite-overlap"
version_target: 1.3.0
status: planned
depends_on: [O2]
---

# lite-overlap — a trigger you can shoot through is a bug

PURPOSE
  This is the feature that makes the package essential rather than convenient.
  A projectile moving faster than its own width passes through a thin trigger in
  one frame: at frame N it is in front, at frame N+1 behind, and the overlap
  never existed at any sampled instant. Every discrete-sampling trigger system
  in every JS game has this bug, and the fix has never been packaged.

  It is also squarely in this package's lane rather than aabb's. aabb rejects a
  "swept-AABB solver" because resolution — time of impact, response, sliding —
  is a physics problem. **Asking whether a swept volume overlapped during a
  frame is a broadphase question**, and the answer is a boolean, not an impulse.

TASKS
  - `addSwept(a, prevBoxA, currBoxA)` — build the swept volume as the union of
    the two boxes (`aabb2.merge`, one call, zero alloc into scratch) and test
    that. Conservative: it reports overlaps the true swept path may miss on
    diagonal motion. **Document that conservatism precisely** and give the
    tight answer a name (`sweptOverlapExact`) if the segment test proves cheap
    enough to ship.
  - Bulk path: `collectSweptPairs(tree, prevPacked, currPacked, count)` using
    `aabb2.mergeAll` over the packed `4*N` layout — the batch op that shipped in
    aabb 2.0.0 exists for exactly this and nothing currently uses it.
  - **Enter-only semantics for a passed-through trigger.** A projectile that
    crosses a trigger entirely within one frame should fire enter *and* exit in
    the same frame, in that order, or fire a distinct `onPass` — decide and
    record. Firing only enter leaves a phantom live pair; firing neither is the
    bug this session exists to fix. This is the most consequential decision in
    the session.
  - `marginFloor` interaction: aabb 2.0's `marginFloor(a)` exists because
    `fatten` silently no-ops below half an f32 ULP (finding A-01 — at coordinate
    1e7 a 0.5 margin vanishes). A swept volume at world-scale coordinates hits
    the same wall. **Assert the swept union is strictly larger than either input
    at 1e7-scale coordinates**, and surface `marginFloor` guidance in the docs.
    This is the cross-package hazard the FORMAT contract was written for.
  - Tunneling regression fixture: a committed set of (speed, thickness) pairs
    where discrete detection provably fails and swept provably succeeds. That
    fixture is the package's proof of value and belongs in the README.

ASSERTIONS
  - The tunneling fixture: every case missed by discrete detection is caught by
    swept. Both columns committed as numbers.
  - Swept pair sets are a superset of discrete pair sets, always — a swept test
    must never lose a pair discrete finds.
  - Zero-motion input (`prev === curr`) is bit-identical to the discrete path.
  - Enter/exit ordering for a single-frame pass-through matches the recorded
    decision, asserted.
  - Swept union strictly larger than both inputs at coordinates 1, 1e3, 1e6,
    1e7 — the A-01 detector, pointed at this package.
  - Alloc gates green: `mergeAll` into pre-allocated scratch, nothing per pair.
  - Bench: swept vs discrete cost at N = 2000, published. The honest framing is
    "swept costs X% more and catches what discrete cannot" — not "swept is free."

DONE WHEN
  the tunneling fixture passes, swept is provably a superset, and the
  world-scale ULP case is asserted rather than assumed
```

===============================================================================
# D1 — demo — **SWEEP // LINE**
===============================================================================

```markdown
---
package: "@zakkster/lite-overlap"
version_target: none (demo, no publish)
status: planned
depends_on: [O3]
---

# SWEEP // LINE — four scenes, and the toggle that shows the garbage

THESIS, one sentence: **overlap is not a set, it is a set of transitions — and
the transitions cost nothing.**

  Oscilloscope blueprint, single file at `demo/overlap.html`, inline `<style>` +
  `<script type="module">`, `data-scene` tabs in `#tabs`, importmap
  lite-overlap → `../Overlap.js` and siblings → esm.sh, `npx serve .`, never in
  `files[]`. All demo CSS/JS conventions: `$`-prefixed cached refs at init,
  pre-allocated `Float64Array`/`Int32Array` ring buffers with power-of-2 bitmask
  indexing, telemetry `textContent` throttled to ~10 Hz via a frame-counter
  mask, no `toFixed` in the frame loop, pointer events, flat module code, oklch
  with hex fallback, `@media (hover: hover)`, initial UI from `peek()`.

## 01 · PAIRS — the money shot
  N drifting boxes over a phosphor grid; overlapping pairs drawn as connecting
  lines that flash on enter and fade on exit. Live readouts: pair count,
  enter/s, exit/s, stay count, and a **GC events counter pinned at zero**.

  The interaction that makes the whole package legible: a single toggle labelled
  `Set<string>` that swaps the pair store for the naive implementation. Flip it
  and a heap sparkline beside the counter grows teeth — **7.8 KB/frame,
  0.46 MB/s at 60 fps, measured** — while the GC counter starts ticking. Flip it
  back and the sawtooth flatlines. Nothing else in the ecosystem's demos shows
  a design decision that directly.

  Entity-count slider to 5,000 so the flat line holds under load.

## 02 · SWEEP — the visceral one
  A single projectile fired at a thin vertical trigger wall, speed on a slider.
  Two lanes stacked: **DISCRETE** above, **SWEPT** below, same speed, same wall.
  Below ~200 px/frame both register. Push the slider and the discrete lane
  starts missing — its projectile sails through with no flash and a `TUNNELED`
  counter incrementing — while the swept lane keeps flashing.

  The swept volume is drawn as a translucent box spanning `prev → curr`, so the
  mechanism is visible rather than asserted. A thickness slider on the wall
  finds the failure boundary interactively; the committed tunneling fixture is
  printed as a table beside it, with the live run highlighting the row it is on.

## 03 · TRAVERSE — the perf argument, animated
  The BVH drawn as nested boxes. Step or play the self-traversal: the current
  `(nodeA, nodeB)` stack pair highlights, pruned subtrees dim, leaf-leaf
  candidates flash. Counters: node pairs tested, pairs found, stack depth,
  stack high-water against its fixed capacity.

  Beside it, the same frame's numbers for the N-query path: **3,086 directed
  reports for 1,543 pairs, 1.472 ms** at N = 2000. Two columns, one is half the
  work. A speed control from single-step to full-speed, because the pruning is
  the thing worth watching.

## 04 · MASKS — cost without changing results
  A 32×32 layer matrix as a clickable grid, entities coloured by layer. Toggle a
  cell and watch the pair count drop and the frame time with it — while a
  **"results identical" assertion light stays green**, comparing the filtered
  set against post-filtering the unfiltered set live. That light is the O2 gate,
  running on stage.

DEMO GATE
  - Zero steady-state allocations in every scene's frame loop, with the scene 01
    `Set<string>` toggle as the deliberate control that *must* allocate — a
    demo whose own gate can fail is a demo that proves something.
  - Scene 03's counters must match a headless `collectPairs` on the same seed;
    the demo checks the library, it does not echo it.
  - Scene 04's assertion light must be a real comparison, not a decoration.
  - Scene switch teardown: 100 switches, flat heap, no orphaned trees or
    listeners.
  - Conventions checklist; `npx serve .` run-check; `demo/` absent from
    `files[]`; mobile pointer pass on the sliders and the matrix grid.

DONE WHEN
  the Set<string> toggle makes the garbage visible, the swept lane catches what
  the discrete lane misses on screen, and every counter is checkable headlessly
```

---

## 5. Why this is the golden niche

- **It is the only unclaimed layer.** aabb owns the box math, bvh owns the
  index, arena owns the entities. Nothing owns the transition between "these
  overlap" and "this just happened," and that transition is what game code
  actually consumes.
- **The competition is a full physics engine or a `Set<string>`.** Rapier and
  Matter give you events bundled with a solver you may not want. Everyone else
  writes the string-key version. There is no middle, and the middle is where the
  measured 0.46 MB/s lives.
- **It consumes exactly what 2.0.0 just shipped.** `mergeAll` and the packed
  `4*N` layout exist and have no consumer yet — O3's bulk swept path is the
  first one. `marginFloor` exists because of finding A-01, and the swept volume
  at world scale is where that matters. `FORMAT_VERSION` was built to admit a
  third participant; this is the third participant.
- **It is small.** Roughly 400–600 lines across four sessions: a hash table, a
  traversal, a mask test, a union. Single file, zero runtime dependencies,
  `sideEffects: false`. Every law holds without strain.
- **The demo writes itself, and one toggle carries it.** Most zero-GC claims are
  a paragraph in a README. Scene 01 makes the alternative visible in one click,
  and scene 02 makes the correctness argument something you can feel with a
  slider. Those two interactions are the whole pitch.

*Planned against `@zakkster/lite-aabb@2.0.0` and `@zakkster/lite-bvh@2.0.0`,
both published 2026-07-30, `FORMAT_VERSION = 1`. All measurements taken against
those tarballs. Copyright Zahary Shinikchiev.*
