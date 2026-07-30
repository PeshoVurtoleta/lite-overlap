# 0001 -- Pair identity, table, mark-sweep, and capacity

- **Status:** accepted
- **Date:** 2026-07-30
- **Session:** O0 (v1.0.0)
- **Scope:** the four pre-code decisions the ROADMAP (O0 TASKS) requires on the
  record before `Overlap.js` exists, plus two contract clarifications
  (FORMAT_VERSION check site, `clear()` semantics) settled in the same pass.

This is the PRE-CODE gate. The pair table, the lifecycle, and every test in O0
stand on the four decisions below. It is a repo-only record: it is NOT shipped in
the npm tarball (`files[]`).

The package's whole identity is "a set of overlapping pairs turned into a
per-frame delta, with zero allocation." Every decision here exists to keep that
true under adversarial input and long runs. Where the ROADMAP's letter and the
suite Law disagree, the Law wins and the deviation is named.

---

## D1 -- Pair keys are two parallel `Int32Array`s, never one packed number

### Context

A pair is two `userData` ids. bvh guarantees each `userData` is a non-negative
int32, range `[0, 2^31-1]`. Two of them is **62 bits of identity**. A JS number
holds exact integers only to **2^53**, so any scheme that packs both ids into one
number either imposes an undocumented ~2^26 ceiling per id or silently loses
precision above it -- and the silence is the whole problem.

Three precedents, all from this ecosystem:

- **lite-arena AR-01** -- a signed handle in a `Uint32Array`; the compare failed
  above generation 2048 and every component operation broke silently. The lesson:
  a value that outgrows its storage width corrupts *quietly*.
- **lite-audio AU-01** -- `busIndex * 2^32 + poolHandle` is exact to 2^53 but
  leaves SMI range, so the packed key is a heap-boxed double. Measured at 57x the
  allocation of an SMI. The lesson: even an *exact* pack can cost allocation.
- **lite-bvh** -- solved it the right way by keeping `userData` inside int32 and
  never packing. We are the third participant; we inherit that discipline.

### Decision

Store each pair as two parallel `Int32Array` slots, `slotKeyA` and `slotKeyB`,
**canonically ordered `a < b`**, so `(a, b)` and `(b, a)` are the same slot by
construction. `-1` is the empty-slot sentinel in `slotKeyA` (safe: every real
`userData` is `>= 0`). No packed key exists anywhere -- no ceiling, no precision
loss, no boxing, no sign hazard. The hash mixes both ids with `Math.imul` (which
stays int32) and masks to a small SMI index; the *stored identity* is the two
raw ids, compared directly.

### Consequences

- `add(a, b)` canonicalizes to `lo < hi` before hashing, so order-invariance is
  structural, not a runtime check.
- Reject `a === b` (a pair with itself is not a pair) at the `add` door.
- Any id in `[0, 2^31-1]` is representable; there is no documented pair-id
  ceiling to leak into the README.

---

## D2 -- The table is open-addressed over typed arrays, not a `Map`

### Context

A trigger system iterates its whole pair set every frame -- the one access
pattern a number-keyed `Map` charges for: `for...of` allocates a fresh iterator,
and rehash on growth allocates. In a package whose identity is 0 B/frame, a `Map`
is disqualified before correctness even enters.

The remaining choice is the deletion strategy. A trigger set churns every frame
(pairs enter and exit constantly), and **tombstones degrade under exactly that
load** -- deleted slots accumulate, probe chains lengthen, and the table needs a
periodic rebuild (an allocation) to recover.

### Decision

Linear probing over `Int32Array` buffers, **power-of-2 capacity**, **bitmask
index** (`hash & (capacity - 1)`), sized from `maxPairs` at load factor **0.7**:
`capacity = nextPow2(ceil(maxPairs / 0.7))`. Deletion is **backward-shift**, not
tombstones: on remove, walk forward and pull back any entry whose ideal slot is
`<=` the hole, closing the gap so the table is always tombstone-free and probe
lengths stay bounded with no rebuild. Capacity is fixed at construction.

Load factor strictly below 1 guarantees a free slot always exists below the
`maxPairs` logical limit, so every probe loop terminates without a full-table
guard.

### Consequences

- No iterator, no rehash, no tombstone compaction -- nothing on the frame path
  allocates.
- Backward-shift deletion is the exact property that licenses D3's 1-bit tag
  (see below): because every exit *removes* its slot, no slot ever survives a
  frame untouched.
- `stats()` exposes `probeHighWater`; a test pins it bounded under 0.7 load so a
  future hash change cannot quietly lengthen probe chains.

---

## D3 -- Exit detection is a mark-sweep with a 1-bit alternating tag

### Context

Exit is a frame-over-frame delta: a pair present last frame and absent this frame
has stopped overlapping. The ecosystem pattern (lite-signal-dom's `keyed`
reconciler) is an epoch mark-sweep: stamp each touched entry with the current
frame's mark, then sweep entries whose mark is stale.

The ROADMAP names a hazard: an int32 epoch counter at 60 fps "wraps in ~414
days," and a pair untouched across the wrap "looks current and its exit never
fires -- the AR-01 failure shape, one wrap later." It demands a policy.

**We reject the premise that a wide monotonic counter is needed at all.** The
mark-sweep asks exactly one question -- *was this slot touched in the current
frame?* -- which is binary. A 32-bit counter is a 32-bit answer to a 1-bit
question, and the wraparound is the tax on that over-provisioning.

#### The failure mode, named precisely

For the record, because a test written against the wrong description passes while
the bug ships: the epoch counter is a JS **double** and never wraps *as a
number*. The break is narrower -- the double is **written into an `Int32Array`**.
At `epoch === 2^31` the store truncates to `-2^31`, the read-back mis-compares
against the double `2^31`, and **every slot stamped that frame reads as
untouched**. From frame 2^31 (~414 days) onward it is not a one-frame glitch: it
is every pair exiting and re-entering every frame, permanently. Nothing throws
(silent, like AR-01), but the symptom is loud mass double-fire. The trigger is
**typed-array truncation on write**, not "the counter goes negative."

### Decision

**A 1-bit alternating tag.** `begin()` does `tag ^= 1`. `add` stamps
`slotTag[i] = tag`. `end()` removes every occupied slot with `slotTag[i] !== tag`
(emitting exit as it removes).

This is correct -- provably, from the invariant D2 already guarantees:

> **Invariant.** At the start of any `end()`, every occupied slot carries either
> the current tag or the immediately-previous tag, never older.

**Proof.** A slot survives a sweep only if it was touched that frame; otherwise
D2's backward-shift removal deletes it. So any slot present at the end of frame
`F-1` was stamped `tag_{F-1}`. Entering frame `F` it is either re-stamped
`tag_F` (touched) or keeps `tag_{F-1}` (untouched, and this frame's sweep removes
it). Since `tag_F = !tag_{F-1}`, the test `slotTag != tag` selects exactly the
untouched set. No slot can carry a two-frame-old tag, because no slot survives a
frame untouched. QED.

Consequences of the invariant: **there is no boundary, so there is no boundary
policy, no O(N) rebase pass, and no wrap to survive.** The tag is a plain `0`/`1`
in an `Int32Array` and never grows.

The four lifecycle cases the tag distinguishes:

| In `add`, probe result | Meaning | Action |
| --- | --- | --- |
| miss | new pair this frame | insert, stamp `tag`, stage **enter** |
| hit, `slotTag != tag` | present last frame, first touch now | stamp `tag`, it is a **stay** |
| hit, `slotTag == tag` | already touched this frame | **dup no-op** (idempotent) |
| in `end`, `slotTag != tag` | untouched this frame | emit **exit**, remove (D2) |

#### Rejected alternatives

- **Int32 epoch + fail-closed sweep-and-rebase on wrap.** *Correct*, and it was
  the front-runner. Rejected because it pays 32 bits per slot, a once-per-414-day
  O(capacity) rebase, and a fiddly boundary test to solve a problem the tag
  designs out of existence. Its only genuine advantage -- a monotonic per-slot
  epoch a later session might read -- is not needed by O0, and if O1/O3 ever need
  frame numbers the telemetry counter below supplies them without coupling
  correctness to a wrapping value.
- **Float64Array epoch** (exact to 2^53 ~ 4.7M years, never wraps). Rejected: it
  drops an f64 array into an otherwise all-`Int32Array` structure, and it dodges
  rather than resolves the long-run question.

#### Telemetry

The tag carries no frame number, which `stats()` still wants. Recover it with a
**plain `number` frame counter**, incremented in `begin()` and **never written
into a typed array** -- so it is never truncated, exact to 2^53 (~4.7M years),
and reported as `stats().epoch`. Correctness never depends on it.

### Consequences

- `slotTag` is `Int32Array(capacity)` holding only `0`/`1`. No wrap code, no
  rebase, no boundary special-case anywhere in the hot or cold path.
- The correctness of the tag is *entirely* downstream of D2's remove-on-exit;
  the two decisions are load-bearing together and must not be changed
  independently.
- Test obligation shifts from "assert a recovery fires at the boundary" to
  "assert the impossibility": a long-run / forced-state fuzz asserts no missed
  and no spurious exit across many thousands of tag flips, and the `Set<string>`
  oracle differential is the backstop.

---

## D4 -- Capacity exhaustion is atomic and carries its remedy

### Context

Two precedents point opposite ways; the good one is in this ecosystem:

- **lite-bvh B-01** (fixed in 1.0.2): `insertLeaf` allocated the leaf, then the
  parent, and the second throw left a node consumed and orphaned with
  `nodeCount` corrupted. A throw *mid-mutation* left the structure broken.
- **lite-signal-gsap**: the 65th tween throws `"proxy pool exhausted (64). Use
  configure({ growthPolicy: 'grow' })"` -- and `liveTweens` stays exactly 64,
  the pool restores on the next `killTweensOf`, the next call succeeds. The throw
  is atomic and the message carries the fix.

### Decision

Copy lite-signal-gsap. `maxPairs` is a fixed logical cap. `add` **reserves before
it mutates**: on a probe miss (a new pair), check `pairCount >= maxPairs` and
throw *before* writing any slot. The table is left byte-unchanged; `pairCount()`
is unchanged; the table remains fully usable -- a later remove (a pair exiting)
then add succeeds. The message names the cap and the fix:

```
lite-overlap: pair table full (4096). Raise maxPairs.
```

### Consequences

- A capacity throw is atomic by construction: the only write on the new-pair path
  happens after the reserve check passes.
- The B-01 test shape is applied before the bug can exist: the `maxPairs+1`-th
  distinct pair throws at the boundary, `pairCount()` is unchanged, and
  remove-then-add afterward succeeds.
- `stats().highWaterMark` reports the maximum `pairCount` ever observed -- the
  single number a user reads to size `maxPairs`. This is the lite-signal-gsap
  `stats()` win: the pool tells you how big it needed to be.

---

## Contract clarifications settled in the same pass

### C1 -- FORMAT_VERSION is checked in the conformance test, not at construction

The ROADMAP (O0 TASKS) says *"Assert `FORMAT_VERSION` equality against both peers
**at construction**."* Taken literally that requires `import`ing lite-aabb and
lite-bvh at runtime -- a **runtime dependency**, which the Law forbids and which
lite-bvh itself does not do. `Bvh.d.ts` is explicit: *"Copied inline (no runtime
dep on lite-aabb); agreement is enforced by the conformance test."*

**Resolution (follow the bvh precedent, Law over roadmap letter):** `Overlap.js`
exports `FORMAT_VERSION = 1` as an inline constant and imports no peer. The
conformance **test** imports both peers and asserts
`1 === AABB_FORMAT_VERSION === BVH_FORMAT_VERSION`, failing loud with all three
numbers named. lite-overlap is the third participant in FORMAT_VERSION 1; the
agreement is proven by test, at zero runtime cost.

### C2 -- `clear()` is silent and single-purpose; teardown exits go through an empty frame

Scene teardown wants silence; a level reset may want exit triggers. We ship **one**
behavior: `clear()` resets the table without reallocating and **emits nothing**,
matching `bvh.clear()`.

A `{ emitExits: true }` flag was considered and **deferred, not shipped**, for two
reasons:

1. **The "use-after-free" argument for it is a category error.** `drainExit`
   writes int32 `userData` ids into a caller `Int32Array`; it dereferences
   nothing and calls nothing. A stale id is a number, and a caller looking it up
   after the entity is gone gets a fail-closed miss (null is not zero), not a
   crash. There is no pointer hazard to protect against.
2. **It is redundant with the tested path.** A level reset that wants the exits
   runs one empty frame -- `begin(); /* add nothing */; end();` -- which fires
   exit for every live pair through the normal, oracle-checked lifecycle, leaving
   the table empty for a silent `clear()`. Shipping `emitExits` would add a second
   code path doing what an empty frame already does, and a `clear()` that staged
   exits would impose a drain-obligation post-condition (drain or the entries
   bleed into next frame's `drainExit`).

If a future caller genuinely cannot spend one frame cycle (mid-frame teardown, or
a clear before the first `begin()`), the flag is added then, against a real need.
For O0, `clear()` stays silent, single-purpose, and obligation-free.

---

## Summary of load-bearing couplings

- **D1 + hashing**: raw two-id identity; `Math.imul` mix keeps the index an SMI.
- **D2 + D3**: backward-shift removal on every exit is *what makes the 1-bit tag
  correct*. Neither may be changed without re-proving the D3 invariant.
- **D4**: reserve-before-mutate is what makes a capacity throw atomic.
- **C1**: inline `FORMAT_VERSION`, test-time conformance -- zero runtime deps
  preserved.
- **C2**: `clear()` silent; teardown exits via an empty begin/end frame.
