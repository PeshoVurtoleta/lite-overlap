# 0002 -- Self-traversal, stack contract, fat pairs, and frame ownership

- **Status:** accepted
- **Date:** 2026-07-31
- **Session:** O1 (v1.1.0)
- **Scope:** the pre-code decisions the ROADMAP (O1 TASKS) requires on the record
  before the self-traversal exists. E1 stack no-grow contract; E2 fat-bound pair
  semantics plus `narrow()`; E3 frame ownership; E4 the traversal's one
  load-bearing correctness rule and the degenerate-tree contract.

This is the PRE-CODE gate for O1. It builds on `0001-pair-identity.md`: the pair
table, the lifecycle, and the `add(a,b)` door are unchanged. O1 adds a *pair
source* (`collectPairs`) and a *tight recheck* (`narrow`); it does NOT touch the
O0 structure. Repo-only record, not shipped in the npm tarball (`files[]`).

The session's whole risk is stated once: a 20-line sketch of this traversal
returned **94 pairs instead of 1,543**, and nothing threw. Every decision here
exists to make that failure impossible to ship silently -- by pinning the one
rule that causes it (E4), by defining the oracle that catches it (E2), and by
bounding the one resource that could make it allocate (E1).

The pair source is bvh 2.0's readonly SoA, traversed with no fork and no runtime
dependency -- format agreement only (C1). Verified member layout, node id `n`:

```
bboxes   : Float32Array(maxNodes*4)  ->  n*4     = [minX, minY, maxX, maxY]
children : Int32Array(maxNodes*2)    ->  n*2     = [leftChild, rightChild], -1/-1 at a leaf
heights  : Int32Array(maxNodes)      ->  n       = subtree height, 0 at a leaf
userData : Int32Array(maxNodes)      ->  n       = leaf id (>=0), -1 at an internal node
root, nodeCount, maxNodes, leafCount : scalars
```

Where the ROADMAP's letter and the suite Law disagree, the Law wins and the
deviation is named.

---

## E1 -- The traversal stack is a no-grow contract: fail closed, never grow

### Context

The self-traversal is iterative over an explicit node-pair stack (D2's discipline
applied to a second buffer). bvh 2.0 ships rotations, so height is O(log n) --
measured 13 at N = 2000 -- but the stack does not hold a root-to-leaf path, it
holds the live *frontier* of unexpanded node-pairs, and on adversarial input
(every box identical, or a monotone-insert order) that frontier is wide, not
deep. A guessed cap that is merely "big enough for typical scenes" is the
lite-bvh **B-08** failure shape one input away: a mid-frame `new Int32Array`
allocates on the hot path, and the alloc gate that is the package's identity goes
red -- or worse, silently grows and nobody notices until the soak.

### Decision

Size the stack from `maxNodes` at construction, once. If a push would ever exceed
that cap, **throw** -- reserve-before-push, exactly D4's atomic-throw shape, with
the remedy in the message. **Never** grow the buffer mid-frame.

- The static bound is derived and defended by the coder and checked by the
  reviewer; it is a function of `maxNodes` (a self-traversal can have at most a
  bounded number of simultaneously-pending node-pairs relative to the node
  count). The bound is conservative on purpose: over-allocating a few `Int32Array`
  slots at construction is free; a single mid-frame allocation is not.
- The overflow throw is a genuine fail-closed guard, not dead code. It is proven
  reachable only by construction-time argument, and its *non-triggering* under
  the worst orderings is proven empirically (see Consequences).
- `stackHighWater` is exposed in `stats()` -- the same sizing signal `stats()`
  already gives for pairs (`highWaterMark`), now for the traversal frontier.

### Consequences

- qa asserts stack `.length` is **identical before and after** a full collect on
  the adversarial monotone-insert order (bvh's own `queryStack` assertion shape),
  and drives all-identical-boxes / all-at-one-point corpora to push the frontier
  to its widest, asserting the high-water stays strictly under the allocated cap.
- If a real scene ever legitimately needs a bigger stack than the bound predicts,
  that is a bound bug, and it surfaces as a loud throw with a remedy, never as a
  silent allocation. Fail closed on the unverified state; `null` is not zero.

---

## E2 -- `collectPairs` reports FAT-bound pairs; ship `narrow()` for the tight answer

### Context

The tree stores *fattened* boxes (bvh fattens on insert to make refit cheap). A
traversal reads what the tree holds. So a pair whose fat boxes overlap but whose
tight boxes do not is a **correct** broadphase report -- conservative, never
missing a real overlap, occasionally reporting a near-miss. This is textbook and
it is what every real broadphase does. The hazard is a caller who fires damage or
a pickup on `onEnter` without a tight recheck: they get off-by-a-margin bugs, and
they will report it as "lite-overlap is wrong" when it is doing exactly its job.

### Decision

`collectPairs(tree)` reports the **fat-bound** pair set. Document the conservatism
loudly at the API door (the caller must tight-recheck before acting on geometry).

**`narrow` takes the caller's TIGHT boxes, NOT the tree** -- corrected after O1
found the tree cannot answer the tight question. bvh 2.0 stores only *fattened*
boxes: `getBounds` is documented to return "the fattened box from the last
insert/re-insert ... not the caller's original tight box," and `bboxes` is the
same fat data. A `narrow(tree, a, b)` reading tree data therefore re-asks the
*fat* predicate the traversal already applied -- for a reported pair it is always
true, so it filters nothing. The tight boxes exist only where they were created:
with the caller, before fattening. So the recheck must be fed those.

Ship **`narrow(boxA, boxB) -> boolean`**: a pure tight AABB-overlap test on two
caller-supplied `Float32Array(4)` boxes (`[minX, minY, maxX, maxY]`), zero
allocation, zero dependency (so a caller need not pull in lite-aabb for the one
predicate). It does not touch the tree and needs no leaf-id-to-node map.

**The oracle is defined by this decision and must not be conflated:**

- The differential correctness oracle for `collectPairs` is the **fat-box overlap
  set** -- the same boxes the tree holds, compared by the same predicate. A
  correct traversal equals this set exactly. Comparing `collectPairs` against a
  *tight* brute-force set would flag a correct traversal as over-reporting.
- The committed **1,543** brute-force fixture is a **tight**-overlap number. It is
  therefore the oracle for `collectPairs` **post-filtered by `narrow(tightA,
  tightB)`** on the caller's own tight boxes -- which the differential test owns,
  because it generated the tight boxes before fattening them into the tree. This
  is now physically satisfiable; the earlier `narrow(tree, a, b)` framing was not.
  Two oracles, two purposes; a test that swaps them makes a correct build look
  broken or masks a real miss.

### Consequences

- `narrow` allocates nothing and imports nothing -- it reads the two argument
  boxes directly. The caller keeps its tight geometry (it always has it) and
  passes the two boxes for a pair it cares about after `collectPairs` flags it.
- The README/llms.txt state the fat-vs-tight contract as a first-class fact, with
  the "recheck with YOUR tight boxes before you act" warning next to
  `collectPairs`, not buried -- and the reason (the tree holds only fat boxes).
- O3's swept path later reuses this exact split (broadphase question -> boolean),
  so the contract is set once here.

---

## E3 -- `collectPairs` feeds `add()` only; the caller owns `begin()`/`end()`

### Context

Two shapes were available: `collectPairs` runs the whole frame
(`begin();...add...;end()`) as a one-call convenience, or it only calls `add()`
and leaves the frame boundary to the caller. The choice decides whether a caller
can feed the same frame's delta from more than one source.

### Decision

`collectPairs(tree)` calls **`add(lo, hi)` only**. The caller owns `begin()` and
`end()`. One frame, one delta, regardless of how many sources fed it.

### Consequences

- A caller can mix a tree traversal with manual `add()` calls (a second non-bvh
  index, a hand-fed trigger volume) inside one `begin()/end()` and get a single
  unified enter/stay/exit delta. This is the composition the whole package is for.
- O2 (filters) and O3 (swept) layer on without a second frame model: they add
  more ways to feed `add`, they do not add more frame owners.
- `collectPairs` is structurally identical to the O0 caller-fed N-query path --
  which is precisely why that path is the differential oracle for the traversal
  (same table, same lifecycle, different source; the sets must match).
- The one caller footgun -- calling `collectPairs` outside a `begin()/end()`
  bracket -- is the same footgun as calling `add` outside one, already the O0
  contract. No new failure mode.

---

## E4 -- The self-pair rule, and the degenerate-tree contract

### Context

The 94-vs-1,543 bug has a single cause, and it is worth naming so no reviewer ever
has to rediscover it. The traversal has two kinds of work item: a **self-pair**
`(n, n)` (descend a node against itself) and a **cross-pair** `(a, b)`, `a != b`
(test two distinct nodes). The bug is emitting, for a self-pair, only the
cross term `(L, R)` and forgetting the self terms `(L, L)` and `(R, R)`. That
keeps exactly the pairs that straddle the root's split and drops every pair that
lives entirely inside one subtree -- which is most of them. It does not throw.

### Decision

The traversal is pinned to this shape:

```
seed: if root is internal, push self-pair (root, root); else zero pairs.

pop self-pair (n, n):   // n is internal by construction
    L = children[n*2]; R = children[n*2 + 1]
    if L internal: push self-pair  (L, L)
    if R internal: push self-pair  (R, R)
    push cross-pair (L, R)

pop cross-pair (a, b):
    if not overlaps(a, b): prune (drop it)
    else if a and b both leaves: add(userData[a], userData[b])   // canonicalized in add
    else: descend the TALLER node (heights[a] vs heights[b]; tie -> descend a),
          replacing (a, b) with (child0-of-taller, b) and (child1-of-taller, b)
```

**Leaf test** is `children[n*2] === -1`, cross-checked against `heights[n] === 0`
and `userData[n] !== -1`; a candidate that a caller could reach where these three
signals disagree is a corrupt tree and a **fail-closed throw**, not a silent skip.
`add`'s existing canonicalization and dedup make "each pair once" belt-and-braces
even if the descent ever double-visits.

**Duplicate-userData across distinct leaves is also fail-closed (added O1, found
by qa).** The per-node three-signal check above is blind to a *cross-node*
violation: two DISTINCT leaf nodes that carry the SAME `userData` id. Each node is
internally consistent, so the per-node guard passes -- but when those two leaves
overlap, the leaf-leaf candidate is `(id, id)`, which `add` rejects as a self-pair
(D1), and the real overlap is **silently dropped**. That is precisely the
worst-failure-mode this session exists to prevent (a missed collision that nothing
reports). At a leaf-leaf emit the two nodes are always distinct indices by
construction, so `userData[a] === userData[b]` is unambiguous proof of a
duplicate-id violation. The traversal therefore **throws** a corrupt-tree error
naming both node ids, rather than emitting `add(id, id)` into the silent-drop.
Cost is one integer compare on a path that already loads both ids. Note the
asymmetry with the caller-fed door: `add(id, id)` remains a legitimate silent
no-op ("does entity `id` overlap itself" -> no), because there the two ids are the
caller's assertion of identity; in the traversal, two distinct nodes claiming one
id is a data-integrity fault only the traversal can see.

Degenerate trees are each pinned by a named test: empty tree (no root) -> zero
pairs; one leaf -> zero pairs; two leaves -> zero or one pair by their boxes;
all leaves identical -> the full N*(N-1)/2 set; all leaves at one point; leaves in
a single row. These are the inputs where an off-by-one in the descent or the seed
shows up.

### Consequences

- The descent-the-taller rule keeps the frontier bounded (E1) and guarantees each
  cross relationship is expanded from one side only, so no pair is found twice by
  construction (independent of `add`'s dedup safety net).
- The self-pair emission is the line a reviewer checks first. It is commented in
  the source as "the 94-vs-1,543 line."

---

## Summary of load-bearing couplings (do not change one without the others)

- **E2 defines the oracle.** Fat pairs mean the differential test compares against
  the fat-box set; the tight 1,543 fixture only applies after `narrow(tightA,
  tightB)` on the caller's own tight boxes. `narrow` takes boxes, not the tree,
  because the tree stores no tight box. Changing E2 to tight-bound pairs would
  change the hot path AND both oracles at once.
- **E1 depends on E4's descent rule.** The stack bound is only valid for
  "descend the taller node, expand from one side"; a different descent (e.g.
  descend both, or descend by box area) invalidates the bound and the no-grow
  proof. The stack contract and the traversal shape are one decision in two parts.
- **E3 is why the O0 path is the oracle.** `collectPairs` feeding `add` into a
  caller-owned frame is what makes it interchangeable with the N-query path; that
  interchangeability IS the differential test. A frame-owning `collectPairs` would
  need its own separate oracle.
- **C1 (from 0001) still holds:** FORMAT_VERSION agreement with bvh is a test, not
  a runtime import. O1 now actually imports bvh in `t8-cross.mjs` to traverse a
  live tree -- but as a devDependency for the differential test, never a runtime
  dependency. The three-way FORMAT equality assertion is the guard that this
  traversal is reading the layout it thinks it is.
