# 0006 -- Per-frame subtree-layer prune: CLOSED on evidence (0003 F3 resolved)

- **Status:** CLOSED -- the per-frame `subtreeLayers` rebuild + subtree prune is
  NOT shipped. Leaf-level layer filtering (0003 F1/F2, shipped in v1.2.0) remains
  the sole layer-filter mechanism. This resolves the last open deferral in the
  decision record: `0003-filters.md` F3 named the only rotation-safe form of
  subtree pruning and **deferred the ship/close to a bench** ("whether to ship that
  per-frame rebuild at all, or leaf-level filtering alone ... decide with the bench
  in hand"). This session ran that bench and acted on the number. No library change;
  `Overlap.js`, `files[]`, and FORMAT_VERSION (`1`) are untouched.
- **Date:** 2026-08-03
- **Session:** O2.1
- **Decided by:** `bench/subtree-prune-vs-leaf.mjs` (repo-only, never in `files[]`),
  results in `bench/RESULTS-subtree.md`, against a pre-registered gate (X2). The
  bench was adversarially reviewed for strawman-fairness and count-trustworthiness
  before the CLOSE was accepted (X5).

This is the mirror of `0005-swept-exact.md`: a deferred optimization decided
bench-first with a gate fixed before the run. Where 0005 SHIPPED an opt-in
predicate, this one CLOSES -- and a CLOSE with a number is a shipped decision, not
dead work. The bench and this ledger stay out of the package.

---

## X1 -- What was on trial (the only admissible form)

0003 F3 REJECTED any subtree-layer mask cached across frames: a BVH relink
(rotation) with no invalidation hook leaves a stale mask that can prune a subtree
still holding a real interacting pair -- a fail-OPEN, the worst failure the Law
forbids. F3 admitted subtree pruning in EXACTLY ONE correct form:

> Rebuilt every frame, never cached. At the start of `collectPairs`, one bottom-up
> O(nodeCount) pass computes `subtreeLayers[node] = subtreeLayers[left] |
> subtreeLayers[right]` (leaves seed from `layerOf[userData[node]]`) into a
> pre-owned `Int32Array(maxNodes)`. During descent, a cross-pair `(a,b)` is pruned
> when `(subtreeLayers[a] & interactMaskOf(subtreeLayers[b])) === 0`.

Because it is recomputed from the authoritative current topology every collect,
rotation cannot make it stale -- there is nothing to invalidate. That correctness
is not in question here; 0003 settled it. The ONLY open question was economic:
**does the pruning save more descent work than the unconditional O(nodes) rebuild
costs, or is leaf-level filtering alone already enough?**

---

## X2 -- The gate was pre-registered before the run

The bench drives a descent mirror proven byte-identical to the shipped library on
every cell before any count is trusted (X5). It measures both halves of the
economic question across `entities {500, 2000, 8000} x layers {1, 4, 16} x spatial
{clustered, interleaved}`, diagonal interaction matrix (each layer self-interacts
only -- the arrangement most favorable to pruning), seeded PRNG:

1. **Work saved** -- exact, timing-independent cross-pair node-visit count,
   leaf-only vs. prototype, and the `% reduction`.
2. **Cost paid** -- median-of-11 ns/frame; the single-layer overhead
   `(proto - leaf) / leaf` isolates the rebuild's fixed cost where the prune can
   never fire.

Gate FIXED before the run: **SHIP** iff cross-pair node-visits drop `>= 25%` on
`>= 2` of the four qualifying clustered cells (`N >= 2000` AND `layers >= 4`) AND
single-layer (`layers=1`) ns/frame overhead `<= 3.0%`. Otherwise **CLOSE**.

---

## X3 -- The number, and the verdict

Both clauses fail, each on its own by an order of magnitude:

- **Work saved on the intended best case: ~none.** The four qualifying clustered
  cells reduced cross-pair visits by **0.1%, 0.7%, 0.1%, 1.8%** -- 0 of 4 clear the
  25% bar (need 2).
- **Cost on the common case: ~10x the budget.** Single-layer overhead measured
  **~30%** (this run 30.24% at the worst cell; an earlier committed run 47.18% --
  the figure is a wall-clock sample that drifts run to run, see X6), versus the
  3.0% ceiling. The deterministic visit counts and the order-of-magnitude margin
  are the stable, load-bearing facts; the exact overhead percentage is not.

**VERDICT: CLOSE.** Leaf-level filtering alone ships. The per-frame rebuild is not
added to `collectPairs`.

---

## X4 -- Why the intended best case was the wrong bet (the premise inversion)

The hypothesis behind F3 was that CLUSTERED scenes -- same-layer entities sharing a
spatial region -- make subtrees layer-homogeneous and therefore prunable, so
clustering was registered as the prune's best case. The bench inverts that premise,
and the inversion is a real geometric fact, not a bench bug:

- **Clustered: prune reduction ~0% (0.0-1.8%).** When each layer occupies its own
  spatial region, the fat-box AABB broadphase ALREADY separates different-layer
  subtrees -- their fat boxes do not overlap, so the cross-pair is dropped by the
  existing geometric test before the layer-prune could act. The subtree-prune is
  **redundant with the broadphase exactly where it was supposed to help.**
- **Interleaved: prune reduction 14.6-44.4% (at `layers=16`).** When layers coexist
  spatially, the fat boxes DO overlap, the geometric test does not separate them,
  and the layer-prune does real additional work on small disjoint-layer subtrees.

The prune machinery is proven LIVE (it fires 33-44% in interleaved cells) and
proven CORRECT (`proto == leaf`, 0 dropped pairs on all 18 cells -- it never skips
a real pair), so the clustered ~0% is genuine geometry, not a dead or miscomputed
prune. At `layers=1` the reduction is exactly 0.0% on every cell, as it must be (the
prune structurally cannot fire) -- a self-check that the machinery isn't inventing
savings.

---

## X5 -- Where the prune DID win, and why that still does not ship it

The honest record: on interleaved multi-layer scenes the prune is a net wall-clock
WIN -- overhead went NEGATIVE, to **-24% to -30%** at `layers=16` (the pruned visits
more than repay the rebuild). So the feature is not worthless; it is
*conditionally* valuable on spatially-interleaved, many-layer scenes.

It still closes, because **the rebuild is unconditional by construction.** 0003
forbids caching the mask across frames (fail-open under rotation), so the O(nodes)
rebuild must run at the start of EVERY collect, before anything is known about the
scene. On the common cases -- single-layer scenes, and clustered multi-layer scenes
where the broadphase already separates layers -- that rebuild is pure overhead that
buys nothing and busts the frame budget by ~10x. An always-on per-frame rebuild
that is a large net loss on the common case to win on a narrower case is a bad
default. And the only forms that could make it conditional -- a cached mask, or a
caller-supplied "my layers are spatially interleaved" hint driving cross-frame
state -- are exactly the node-keyed staleness 0003 rejected. There is no shippable
middle: the correct form is unconditional, and unconditional loses on the common
case. CLOSED.

(If a real caller ever presents a workload that is durably interleaved-many-layer
AND cannot restructure into the far cheaper clustered layout the broadphase already
rewards, an OPT-IN `collectPairs` mode could be reopened as its own decision. No
such caller exists; speculative generality is not shipped.)

---

## X6 -- Trust in the number (the adversarial review)

The CLOSE retires the final deferral in the record, so the bench was audited as
hard as a SHIP would be:

- **Counts are trustworthy.** The bench's descent mirror is compared against the
  REAL `collectPairs` output (`mirror == lib`), not against itself -- 0 mismatches
  / 18 cells. The descent is line-for-line the shipped `traverse`, so its
  visit counts are the library's.
- **The prototype is a fair minimal-correct form, not a strawman.** The prune check
  sits at the top of the cross-pair branch (where F3 places it), the interact-mask
  is folded into the rebuild pass (already hoisted), and -- decisively -- since
  F3's only admissible form is a per-frame rebuild, the O(nodes) cost is
  unremovable in ANY correct form. No leaner-but-correct variant escapes it.
- **The CLOSE is robust to the premise inversion.** SHIP is `clause1 AND clause2`.
  Even re-keying clause 1 onto the interleaved cells (which would pass 25%), the
  single-layer overhead clause fails independently -- so the verdict is CLOSE
  regardless of which cells the reduction clause inspects.
- **Zero-alloc / Law clean.** The prototype's `subtreeLayers` buffer is allocated
  once outside the timed loop; the descent and rebuild allocate nothing;
  ASCII-only; `bench/` absent from `files[]`.
- **Known limitation of the recorded figure (NIT):** the overhead % is a wall-clock
  sample that drifts run to run (30% here, 47% in the committed results file). The
  deterministic visit reductions and the ~10x margin are stable and carry the
  decision; the overhead percentage should be read as "an order of magnitude over
  budget," not a fixed constant.

---

## Summary of load-bearing couplings (do not reopen one without the others)

- **The CLOSE rests on the rebuild being unconditional.** That is F3's own
  anti-staleness requirement (no cached node-keyed state). Relax it and you
  reintroduce the fail-open rotation bug 0003 rejected. So the overhead is
  structural, not an implementation detail to optimize away.
- **The premise inversion rests on the fat-box broadphase.** The layer-prune is
  redundant with the geometric prune precisely when subtrees are spatially
  separated (clustered). This is why clustering -- the hypothesized best case -- is
  where the prune adds least.
- **Leaf-level filtering (0003 F1/F2) already carries the correctness and most of
  the win.** `userData`-keyed leaf filtering is immune to rotation with no per-frame
  pass; F3's rejection is what stops a "clever optimization" from reintroducing
  node-keyed staleness. Both hold after this CLOSE.
- **The decision record is now complete.** 0001-0006 are all resolved (0006 the
  last deferral). No open deferrals remain in `decisions/`.
