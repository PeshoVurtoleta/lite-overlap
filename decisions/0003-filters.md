# 0003 -- Layers, filters, and the subtree-mask question decided on evidence

- **Status:** ACCEPTED -- shipped in v1.2.0 and proven by the test suite (F2
  results-preserving corpus, the F3 rotation adversary, F4 exit-on-disable, and
  the fail-closed validation matrix; 90 tests green, torture gate `ok`, control
  still trips). Implementation note: F1's `layerOf` and F4's enabled bit are
  PACKED into one `userData`-keyed `Int32Array` (`entityState`: layer in bits
  0..4, disabled in bit 5), so the leaf-leaf filter reads one slot per endpoint;
  and the array grows lazily-once on the cold setter path (optional `maxEntityId`
  pre-sizes it and makes it fail-closed) -- the same "the door has no such bound
  at construction" resolution O1 used for the traversal stack.
- **Date:** 2026-07-31
- **Session:** O2 (v1.2.0), shipped
- **Scope:** the pre-code decisions the ROADMAP (O2 TASKS) requires on the record
  before filtering exists. F1 where layer state lives; F2 the collision matrix;
  F3 **the session's one real design risk** -- whether a subtree-layer mask can
  stay correct under bvh rotations, now decided with source evidence rather than
  deferred; F4 mid-flight filter changes and the exit contract.

This is the PRE-CODE gate for O2. It builds on `0001-pair-identity.md` (the pair
table, the `add` door) and `0002-traversal.md` (the fat-bound self-traversal, the
E4 leaf-leaf emit site). O2 adds a *filter* between "the traversal found a
candidate" and "`add` records it"; it does NOT touch the O0 structure or the O1
descent shape. Repo-only record, never shipped in `files[]`.

The roadmap states the risk once: filtering during descent is strictly cheaper
than filtering after, and the real win -- pruning whole non-interacting subtrees
-- needs a per-node union-of-layers mask. But the node arrays belong to bvh and
are `readonly`, so that mask would live in a parallel array owned by lite-overlap,
keyed by node id. **The question the roadmap forces up front: can that array stay
correct when bvh reshapes the tree via rotation?** F3 answers it from the bvh 2.0
source, not from a guess.

---

## F1 -- Layer/enabled state is keyed by `userData` (entity id), never by node id

### Context

There are two things one could key filter state on: the **entity id** (`userData`,
the stable value the caller assigned at `insertLeaf`) or the **node id** (the
free-list slot the entity currently occupies in the tree). They look
interchangeable until the tree rotates.

### Decision

All caller-facing filter state is keyed by **`userData`** -- the entity id:

- `setLayer(userData, layerIndex)` writes `layerOf[userData] = layerIndex`.
- `setEnabled(userData, bool)` writes an enabled bit for that entity.

`layerOf` is an `Int32Array` owned by lite-overlap, sized to the caller's id
space (a documented `maxEntityId` at `createOverlap`, or grown only at cold
config time, never mid-frame). At the leaf-leaf candidate the traversal already
holds `userData[a]` and `userData[b]` (0002 E4); the filter reads
`layerOf[userData[a]]` and `layerOf[userData[b]]` -- two loads, one matrix test,
zero allocation, on a path that already loaded both ids.

### Consequences

- **Rotation-immune by construction.** A rotation (F3) relinks node ids but never
  changes an entity's `userData`. State keyed by `userData` cannot go stale when
  the tree reshapes -- the whole hazard of F3 simply does not touch F1. This is
  the reason the decision is worth stating explicitly rather than assuming.
- The caller thinks in entities, not nodes -- they never see a node id anyway
  (bvh returns one from `insertLeaf`, but the *layer* of a thing is a property of
  the thing, not of its current tree slot).
- Interaction with 0002 E4's duplicate-userData throw: two distinct leaves sharing
  a `userData` id is still a fail-closed corruption throw at the leaf-leaf emit,
  and it is checked **before** the filter -- a data-integrity fault is a fault
  whether or not the layer matrix would have masked the pair. Filtering must never
  hide a corrupt tree.

---

## F2 -- The collision matrix is a symmetric 32-bit mask table; `shouldTest` is one AND

### Context

"Player tests against pickups, pickups do not test against each other" is a
per-layer-pair boolean. 32 layers is the universal convention (Unity, Box2D) and
fits a bitmask row in one int32.

### Decision

A `Int32Array(32)` where row `i` is a bitmask of the layers `i` interacts with.
`shouldTest(layerA, layerB)` is `(matrix[layerA] >>> layerB) & 1`. The public
setter sets **both** `(a,b)` and `(b,a)` in one call, so the matrix is symmetric
**by construction** -- an asymmetric matrix is unrepresentable, not merely
discouraged (a caller who could set `(a,b)` without `(b,a)` would get pairs whose
appearance depends on which node the descent reached first -- a heisenbug).

### Consequences

- Default matrix state is a recorded decision, not an accident: **all-pairs-enabled**
  (every layer tests every layer) so that a caller who never touches layers gets
  exactly the O1 behavior. Filtering is opt-in; the unfiltered set is the identity.
- qa asserts symmetry holds after an arbitrary fuzz of set/clear calls, and that
  the filtered pair set equals the unfiltered set post-filtered in JS over the
  corpus -- filtering changes cost, never results (the roadmap's O2 invariant).

---

## F3 -- Incremental subtree masking is REJECTED; subtree pruning, if shipped, is rebuilt per frame

### Context -- the evidence

bvh 2.0 keeps the tree balanced with Box2D-style single rotations in `_balance`,
called from `_refit` on **every** `insertLeaf` and `updateLeaf`. The source
(`Bvh.js` `_balance`, lines ~882-975) shows a rotation is a **relink of existing
node ids**, not a reallocation:

```
// Rotate C up: C takes A's place, A becomes C's left child.
this.children[cC]   = iA;
this.parents[iC]    = this.parents[iA];
this.parents[iA]    = iC;
...
this.children[cA + 1] = iG;   // A GAINS grandchild iG
this._combine(iA, iB, iG);    // A's box recomputed from its NEW children
```

Nodes `iA`, `iB`, `iC`, `iF`, `iG` all keep their ids, boxes, and `userData`.
What changes is **which leaves descend from a given internal node**: after the
rotation, node `iA` no longer has subtree `iC` beneath it and has gained `iG`. So
any per-node "union of the layers of my descendants" mask computed for `iA`
*before* the rotation is **wrong after it** -- `iA` now covers a different leaf
set.

And the decisive fact: `_balance` runs **inside** `_refit`, entirely within bvh,
with **no callback, event, or dirty-flag exposed to an outside observer**.
lite-overlap imports bvh's data, not its control flow. It cannot see a rotation
happen. Therefore a node-keyed union mask maintained *incrementally* from outside
-- updated on the caller's `setLayer` and assumed stable otherwise -- silently
decays every time the caller moves an entity enough to trigger a refit rotation.
The failure mode is the worst one available: a stale subtree mask prunes a subtree
whose true layer set *would* have interacted, and the pair is **silently missed**.
Nothing throws. This is the AR-01 / 94-vs-1543 shape one more time.

### Decision

**Reject incrementally-maintained, cross-frame-cached subtree masks.** They cannot
be kept correct from outside bvh without a hook bvh does not provide, and the
roadmap's own instruction is explicit: "if it cannot be maintained from outside
without hooks, reject subtree masking, record why, and keep leaf-level filtering."

**Leaf-level filtering (F1 + F2) is the guaranteed deliverable** and is trivially
correct: the mask test happens at the leaf-leaf candidate, keyed by stable
`userData`, with no node-keyed state to go stale.

**Subtree pruning is admissible only in one correct form: rebuilt every frame,
never cached across frames.** If the bench justifies it, `collectPairs` may, at
its very start, do one bottom-up O(nodeCount) pass over the current SoA computing
`subtreeLayers[node] = subtreeLayers[left] | subtreeLayers[right]` (leaves seed
from `layerOf[userData[node]]`), into a lite-overlap-owned `Int32Array(maxNodes)`
allocated once at construction. Because it is recomputed from the *authoritative
current topology* on every collect, a rotation between frames cannot make it
stale -- there is nothing to invalidate. During descent, a cross-pair `(a,b)` is
pruned early if `(subtreeLayers[a] & interactMaskOf(subtreeLayers[b])) == 0`. The
pass is zero-allocation (buffer pre-owned) and its cost is bounded by node count,
paid once per frame, not per candidate.

**What is deferred to the build session (decide with the bench in hand):** whether
to ship that per-frame rebuild at all, or leaf-level filtering alone. The rebuild
is O(nodes) of *unconditional* work added to every collect; it pays off only when
it prunes more work than it costs -- i.e. scenes with many entities across many
non-interacting layers. If the O2 bench shows leaf-level filtering already
recovers most of the win on realistic layer counts, the rebuild is dead weight and
is not shipped. Either way the correctness story is settled here: **no cached
node-keyed state, ever.**

### Consequences

- The assertion the roadmap demands is now precise: subtree masking "ships with a
  correctness proof under rotation, or is rejected in the ledger with the reason."
  It is rejected *in its incremental form* here, with the reason (relink-without-
  hook). The only admissible form carries its correctness proof trivially: it holds
  no state across the event that could break it.
- qa gets a specific adversarial test: build a scene, snapshot the pair set, then
  drive `updateLeaf` motion that is *known to trigger rotations* (monotone drift on
  one axis -- the same adversarial order 0002 E1 uses), and assert the filtered
  pair set still equals the brute-force filtered oracle every frame. A cached-mask
  implementation fails this; the per-frame-rebuild and leaf-level forms pass it.
- F1's `userData` keying is what makes leaf-level filtering immune; F3's rejection
  is what stops a "clever optimization" from reintroducing node-keyed staleness.
  The two decisions are one guard in two halves.

---

## F4 -- A pair that becomes filtered or disabled exits through the normal sweep, not a special path

### Context

The roadmap names the failure users actually report: "my exit never fired." It
happens when an entity is disabled or a layer is changed such that a live pair
should end, but the pair just *vanishes* from reporting without an exit event --
leaving a phantom live pair, or firing nothing at all.

### Decision

Filtering is applied **at collect time**, inside `collectPairs`, before `add`. A
pair that becomes filtered is therefore simply **not re-stamped** this frame -- and
0001's lifecycle already turns "a live pair not touched this frame" into an
**exit** at `end()`. No special-case exit code, no separate "fire exits for
entity X" routine: the existing mark-sweep is the mechanism.

The contract the caller must know, stated once: **filter state is read during
`collectPairs`; change it before the frame's collect, not after.** `setLayer` /
`setEnabled` called before `collect` take effect that frame (the now-filtered pair
exits at that frame's `end()`); called after `collect` they take effect next
frame. This is the same "state is sampled at collect" rule the whole package runs
on, applied to layers.

`setEnabled(userData, false)` is exactly a filter that removes *all* of an
entity's pairs: at the leaf-leaf candidate, a disabled endpoint fails
`shouldTest` unconditionally, so none of its pairs re-stamp, so all of them exit
at the next `end()` -- "fires exit for every live pair of that entity, exactly
once," as the roadmap requires, with zero new code beyond the enabled-bit check.

### Consequences

- The invariant "a disabled entity generates no pairs and fires exit for its live
  pairs on the frame it is disabled" is a *derived* property of F4 + the O0
  sweep, asserted by qa (disable an entity with K live pairs before a collect;
  assert exactly K exits that frame and 0 thereafter). It is not a feature that can
  drift out of sync with the lifecycle, because it *is* the lifecycle.
- No re-entrancy hazard: filter setters are cold-path writes to `layerOf` /
  enabled bits between frames; they never mutate the table mid-sweep. The
  lite-signal-dom SD-01 failure shape is structurally absent.

---

## Summary of load-bearing couplings (do not change one without the others)

- **F1 keys on `userData`; F3 forbids keying on node id.** These are the same
  decision: entity-keyed state is rotation-immune, node-keyed cached state is not.
  Any future optimization that wants per-node state must prove it holds nothing
  across a `_refit`, or it reintroduces the silent-miss.
- **F4 has no exit code of its own.** It rides the 0001 mark-sweep. Changing O2 to
  filter *after* collect (post-filtering the emitted set) would break F4 -- a
  post-filtered pair was already stamped, so it would not exit. Filter-at-collect
  is what makes exit automatic. The "filter during descent, not after" performance
  decision and the "exit fires correctly" correctness decision are the same choice.
- **The alloc gates from O0/O1 must stay green with filtering active** -- the
  matrix test and the (optional) per-frame subtree pass are both zero-allocation
  over pre-owned buffers. A filter that allocates is not shippable in this package,
  full stop.
- **C1 still holds:** FORMAT_VERSION agreement with bvh is a test, not a runtime
  import. F3 reads bvh's rotation *behavior* to justify a design decision; it does
  not depend on bvh internals at runtime -- lite-overlap still consumes only the
  readonly SoA it already consumes.
