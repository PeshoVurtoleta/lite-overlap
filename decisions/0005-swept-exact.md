# 0005 -- sweptOverlapExact: the exact opt-in swept recheck (0004 S1 resolved)

- **Status:** ACCEPTED -- to ship in v1.4.0 as an additive opt-in predicate, the
  deferral in `0004-swept.md` S1 resolved WITH A BENCH rather than a guess.
  Proven by the test suite (the independent Sutherland-Hodgman clip oracle over
  12k pairs, the strict-subset and axis-aligned-identity anchors, the committed
  diagonal over-report fixture, and the fail-closed boundary matrix), the torture
  gate (`alloc=0 B/op`, `maxMajor=0` over >=1e6 predicate calls), and the decision
  bench `bench/swept-union-vs-hull.mjs` (G0-G3 green, an independent clip oracle
  agreeing 0-disagreement over ~60k pairs).
- **Date:** 2026-08-03
- **Session:** O3.1 (v1.4.0)
- **Scope:** the exact-test definition (X1), the pre-registered bench gate and its
  verdict (X2), why it ships PREDICATE-ONLY not as a collect default (X3), the
  fail-closed design and the two fail-opens the pipeline caught before ship (X4),
  the min-corner motion (X5), and the non-finite fail-closed behaviour (X6).

This builds directly on `0004-swept.md`. That decision (S1) shipped the swept
volume as the AABB `union(prev, curr)` -- a sound broadphase that never misses,
but over-reports on diagonal motion (the union is the bounding rectangle of a thin
diagonal ribbon). S1 named the exact ribbon test `sweptOverlapExact` and
**deferred** it explicitly: "only worth shipping if a bench shows the ribbon test
is cheap enough to matter, and the union answer is the correct broadphase in the
meantime." This session ran that bench and acted on the number. Repo-only record,
never shipped in `files[]`; the bench and this ledger both stay out of the package.

---

## X1 -- The exact test is the swept-ribbon convex-hull overlap, via SAT

The swept ribbon of an axis-aligned box translating `prev -> curr` is the convex
hull of its 8 corners (4 of `prev`, 4 of `curr`): a hexagon under diagonal motion,
the union rectangle under axis-aligned motion. `sweptOverlapExact(prevA, currA,
prevB, currB)` returns whether the two ribbons overlap, tested with the Separating
Axis Theorem on exactly the hull edge normals -- four candidate axes: `x = (1,0)`,
`y = (0,1)`, `perp(motionA)`, `perp(motionB)`. Those are the complete set of edge
normals of a swept hexagon (two axis-aligned edge pairs give x and y; the two
slanted edges are parallel to the motion, normal `perp(motion)`), so SAT on them
is exact for hull-vs-hull. It is a geometric boolean, NOT a time-of-impact test:
time-correlated moving-vs-moving is a different, tighter question that edges into
solver territory `@zakkster/lite-aabb` rejects, and is out of scope here.

It is the exact analog of `narrow` (the tight recheck for `collectPairs`) applied
to swept volumes: the exact recheck for `sweptOverlap`. Zero allocation, no table,
no tree, no import -- the union math (`sweptOverlap`) and the hull math live side
by side.

**Surface form.** `sweptOverlapExact` ships as BOTH a top-level named export and an
instance method (`ov.sweptOverlapExact === sweptOverlapExact` -- the method IS the
exported function, no wrapper), matching the pure-predicate pair `narrow` /
`sweptOverlap`. This session also fixed a pre-existing bug found while wiring the
docs: `narrow` and `sweptOverlap` had always been documented as importable
(`import { narrow }`) but were instance-methods-only, so the README example threw
`does not provide an export named 'narrow'` (shipped that way through v1.3.0, never
caught because no test covered the import surface). All three pure predicates are
now genuine named exports, and a named-export regression test guards the set so it
cannot regress. The stateful `createOverlap` methods stay instance-only.

---

## X2 -- The decision was bench-first and the gate pre-registered

The bench (`bench/swept-union-vs-hull.mjs`) measured both halves of the S1 gate
against an independent Sutherland-Hodgman polygon-clip oracle (a DIFFERENT
algorithm from the SAT, so the agreement is a real differential, not a copy of
itself checked against itself):

1. **Over-report** -- across motion angle {0, 15, 45} deg x speed {0.5, 1.5, 4.0}
   box-widths x density {0.001, 0.002, 0.004}, the fraction of union-positive pairs
   the exact hull rejects. Axis-aligned motion (0 deg): **0.000** (the hull IS the
   union rectangle -- a self-check). Worst diagonal cell (45 deg, 4.0 widths):
   **0.548** -- the union over-reports more than half its positives on fast
   diagonal motion. (Uniform per-cell motion is the worst case, an upper bound on a
   real mixed-motion scene, stamped as such in the results.)
2. **Cost** -- median ns/pair, exact hull SAT vs the union: **~4-5x** the union
   (union ~12 ns/pair, hull ~50-65 ns/pair; the ratio wanders 4.0-5.2x with timing
   variance, the comparison count is fixed).

The gate was FIXED BEFORE the run: `worstFrac = max over-report over the 45 deg
cells`; SHIP if `worstFrac >= 0.05` AND `ratio <= 3.0`; PREDICATE-ONLY if
`worstFrac >= 0.05` AND `3.0 < ratio <= 8.0`; CLOSE otherwise. The measured
`worstFrac = 0.548`, `ratio ~= 4-5x` lands squarely in **PREDICATE-ONLY**.

---

## X3 -- It ships PREDICATE-ONLY, not as the collect default

The over-report is real and large (the caller genuinely wants the tightener on
fast diagonal motion), but at ~4-5x the union it is too expensive to spend on
every broadphase candidate. So the S1 union stays the never-miss default candidate
source for `collectSweptPairs` / `addSwept`, and `sweptOverlapExact` ships as the
exact analog of `narrow`: a pure predicate the caller invokes BY HAND on the pairs
it cares about, after the cheap conservative broadphase has flagged them. There is
no `collectSweptPairsExact` and no bulk exact mode -- the same shape as the discrete
side, where `narrow` is the opt-in tightener and there is no `collectPairsExact`.

Invariants on the record (all asserted):
- **Strict subset of `sweptOverlap`, always.** The x and y axis-overlap tests ARE
  the union-AABB overlap test; the two perp axes only AND more constraints. So
  `sweptOverlapExact(...) => sweptOverlap(...)` structurally, on any input.
- **Equal to `sweptOverlap` under axis-aligned motion** (perp of an axis-aligned
  motion is itself an axis, adding no new constraint; the hull is the union rect).
- **Zero-motion reduces to `narrow`** (a static box's hull is the box).

---

## X4 -- Fail closed (Law), and the two fail-opens the pipeline caught

The suite Law is "fail closed on every unverified state; null is not zero." A
swept predicate that reports a phantom hit on corrupt input is the exact failure
the Law forbids. Reaching a fail-closed `sweptOverlapExact` took two adversarial
catches before ship -- recorded here because both were live fail-opens a single
pass would have shipped:

1. **The OR-of-separations form (qa caught).** The first cut tested per-axis
   SEPARATION as `aMax < bMin || bMax < aMin` and negated the OR. A NaN (from a
   short array read past its end, or a corrupt component) makes both `<` false, so
   the axis reported "not separated" and the predicate returned **true** -- a
   phantom hit where `narrow` / `sweptOverlap` (which AND their comparisons) return
   false. Fixed by expressing SAT as a POSITIVE AND of per-axis overlaps
   (`aMax >= bMin && bMax >= aMin`, ANDed across the four axes): a NaN makes an
   axis false, collapsing the AND to false. Provably equivalent to the OR form on
   finite input.
2. **The ternary min/max fold (reviewer caught, on the fix).** The per-axis
   projection folds prev and curr with `aMin = aPMin < aCMin ? aPMin : aCMin`. A
   ternary min/max SILENTLY DROPS a NaN (`NaN < valid` is false, so the valid side
   wins and the corrupt value vanishes). Combined with the min-corner motion (X5,
   which reads only corners [0]/[1]), a corrupt MAX corner ([2]/[3]) in the PREV
   box alone bypassed every axis and failed OPEN -- `[0,0,NaN,10]` vs `[0,0,10,10]`
   reported overlap where the union did not. Fixed with NaN-PROPAGATING
   `Math.min` / `Math.max` folds, so a NaN in any projected corner of either box
   propagates and fails the axis closed. Fail-closed now lives in the projection
   folds (the code that reads all box data), independent of the motion formula.
   Byte-identical to the ternary on finite input.

Both fixes are finite-preserving: the bench numbers (X2) and the strict-subset and
axis-aligned-identity invariants held byte-for-byte across both, because
`Math.min`/`Math.max` and the positive-AND form equal their predecessors on all
finite inputs. Only the corrupt-input behaviour flipped, from fail-open to
fail-closed.

---

## X5 -- Motion is the min-corner displacement

The perp axes need the ribbon's slant direction = the box's translation vector.
It is computed as the min-corner displacement `curr[0] - prev[0]`, `curr[1] -
prev[1]`. For a rigid translation (box unchanged size, the swept-collision case)
every corner displaces identically, so this IS the translation vector -- BYTE-
IDENTICAL to a box-center delta on any finite box, hence identical to every
validated result. It is preferred over a center delta only because a center delta
of a static infinite box is `Inf - Inf = NaN`, whereas a min-corner delta keeps a
static box's well-defined zero motion. For size-changing boxes the two differ, but
both are heuristic (the ribbon is not a single-direction sweep then) and both stay
a valid subset of the union -- the subset is guaranteed by the x/y axes regardless
of the perp axis. The exactness claim is scoped to translating (constant-size)
boxes: the swept-collision case.

---

## X6 -- Non-finite box coordinates fail closed (a documented divergence)

`sweptOverlapExact` projects boxes onto axes via dot products `nx*x + ny*y`. On
the x and y axes one component is 0, so an `Infinity` box coordinate produces
`0 * Infinity = NaN`, collapsing the AND to false. So ANY non-finite box
coordinate fails the predicate closed. This DIVERGES from `narrow` /
`sweptOverlap`, which use pure comparisons (no multiply), tolerate `Infinity`, and
can report true (an infinitely-large box covers everything). The divergence is
contract-valid: `sweptOverlapExact` is always a subset of `sweptOverlap`, so
returning false where the union returns true is a valid tightening, never a phantom
hit -- and it is the Law's fail-closed applied to a degenerate box. Real entity
AABBs are finite, so this never arises in practice; it is asserted and documented
rather than left as a silent surprise.

---

## Summary of load-bearing couplings (do not change one without the others)

- **X1's four axes are exactly the hull edge normals.** Drop `perp(motionA)` or
  `perp(motionB)` and the SAT is no longer exact (it would over-report the corner
  cases the whole feature exists to reject); add a wrong axis and it may
  over-reject (miss a real hull overlap). The x/y axes double as the subset anchor.
- **X3's subset rests on x/y being the union test.** The perp axes only ever ADD
  constraints, so exact can only be a subset of `sweptOverlap`. Replace the x/y
  axis-overlap with anything other than the union interval and the subset breaks.
- **X4's fail-closed rests on the positive-AND form AND the propagating folds
  together.** Either one alone leaks: the OR form fails open on a NaN axis; the
  ternary fold fails open on a NaN corner the motion formula doesn't happen to read.
- **X6 follows from X1's dot-product projection.** `0 * Infinity = NaN` is the
  mechanism; it is why the exact test is stricter than the union on non-finite
  input, and why that is safe (subset, X3).
- **C1 still holds:** no runtime import of aabb or bvh; the hull SAT inlines its
  math. FORMAT_VERSION stays `1` -- no buffer contract change. This is a pure,
  additive, opt-in predicate: it touches no hot traversal path and changes no
  existing behaviour.
