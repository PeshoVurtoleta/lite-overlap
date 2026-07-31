/**
 * @zakkster/lite-overlap
 * Persistent overlap events over a dynamic BVH (2D), zero allocation per frame.
 *
 * Turns a per-frame set of overlapping pairs into a per-frame *delta* -- enter
 * (just started overlapping), stay (still touching), exit (just stopped).
 *
 * O0 ships the data structure and the lifecycle ONLY. **Candidate pairs come
 * from the caller** via `add(a, b)` -- fed today from N `bvh.query()` calls.
 * O1 replaces that source with a single tree self-traversal, not the structure.
 *
 * Compatible with the `userData` id contract of `@zakkster/lite-bvh`: an id is a
 * non-negative int32 in `[0, 2^31-1]`. `-1` is reserved as the empty-slot
 * sentinel and must never be passed to `add`.
 */

/** Package version string (three-place sync: package.json, Overlap.js, llms.txt). */
export const VERSION: string;

/**
 * Version of the shared FORMAT contract (see `@zakkster/lite-aabb` FORMAT.md),
 * NOT the package version. lite-aabb and lite-bvh export the identical constant;
 * lite-overlap is the third participant. Copied inline (no runtime dependency on
 * the peers); agreement is enforced by the conformance test, which imports both
 * peers and asserts all three are equal. Compared for equality, never synced to
 * semver.
 */
export const FORMAT_VERSION: number;

/** Diagnostic snapshot returned by {@link Overlap.stats}. */
export interface OverlapStats {
    /** Live pairs currently in the table. */
    readonly pairCount: number;
    /** Live pairs that did not enter this frame (`pairCount - enters`). */
    readonly stayCount: number;
    /** Table capacity: `nextPow2(ceil(maxPairs / 0.7))`. Fixed at construction. */
    readonly capacity: number;
    /** `pairCount / capacity`. Stays below the 0.7 target under the logical cap. */
    readonly loadFactor: number;
    /** Longest probe distance ever observed. Bounded under 0.7 load. */
    readonly probeHighWater: number;
    /** Max `pairCount` ever observed -- the number to size `maxPairs` from. */
    readonly highWaterMark: number;
    /**
     * High-water mark of the O1 self-traversal frontier, in pending node-pairs
     * (the widest the `collectPairs` stack ever got). Same sizing-signal role as
     * `highWaterMark` for pairs. `0` until `collectPairs` has run. Bounded well
     * under the stack cap by the E1 no-grow contract.
     */
    readonly stackHighWater: number;
    /**
     * Plain-number frame counter, incremented by `begin()`. Exact to 2^53
     * (~4.7M years at 60 fps) and NEVER written into a typed array, so it never
     * truncates. Correctness never depends on it; it is telemetry only. The
     * exit-detection tag is a separate 1-bit value (decision D3).
     */
    readonly epoch: number;
}

/**
 * The readonly SoA view `collectPairs` traverses. Structural, so no
 * runtime or type dependency on `@zakkster/lite-bvh` is created -- a
 * `@zakkster/lite-bvh` `DynamicBVH2D` satisfies it by shape (format agreement
 * only, decision C1). Node `n`: box at `bboxes[n*4 .. n*4+3]` =
 * `[minX, minY, maxX, maxY]`; `children[n*2 .. n*2+1]` = `[left, right]`, both
 * `-1` at a leaf; `heights[n]` = subtree height (`0` at a leaf); `userData[n]` =
 * leaf id (`>= 0`, `-1` at an internal node).
 */
export interface BvhTreeView {
    readonly bboxes: Float32Array;
    readonly children: Int32Array;
    readonly heights: Int32Array;
    readonly userData: Int32Array;
    /** Root node id, or `-1` if the tree is empty. */
    readonly root: number;
    /** Hard cap on total nodes -- the O1 stack is sized from this. */
    readonly maxNodes: number;
}

/** Options for {@link createOverlap}. */
export interface CreateOverlapOptions {
    /**
     * Hard cap on live pairs. Every buffer is sized from this at construction.
     * A new pair past the cap throws atomically (the table is left unchanged and
     * remains usable); read `stats().highWaterMark` to size it. Positive integer.
     */
    maxPairs: number;

    /**
     * Optional cap on the entity-id space of the O2 filter arrays (`setLayer` /
     * `setEnabled`). When given, those arrays are sized once to `maxEntityId + 1`
     * and any `userData` above it fails closed. When omitted, they grow
     * lazily-once on the cold config path the first time a larger id is filtered
     * -- never on a frame path -- so `createOverlap({ maxPairs })` stays valid and
     * a caller who never filters allocates no filter storage beyond the empty
     * defaults. Non-negative integer.
     */
    maxEntityId?: number;
}

/**
 * A pair-lifecycle instance owning one open-addressed pair table. All buffers
 * are allocated at construction; no method allocates on any frame path.
 *
 * The frame cycle is `begin()` -> zero or more `add(a, b)` -> `end()`. After
 * `end()`, read the delta with `drainEnter` / `drainExit` (non-destructive until
 * the next `begin()`).
 */
export interface Overlap {
    /**
     * Open a frame: flip the internal tag so every slot's stamp is now stale,
     * bump the telemetry epoch, and clear the enter/exit staging. O(1).
     */
    begin(): void;

    /**
     * Report a candidate overlapping pair for this frame. Order-invariant --
     * `add(a, b)` and `add(b, a)` are one pair -- and idempotent within a frame:
     * adding the same pair twice yields a single enter. `a === b` is rejected
     * (a no-op). `a` and `b` must be non-negative int32 ids; passing `-1` (the
     * empty-slot sentinel) is undefined behaviour.
     *
     * @throws if a new distinct pair would exceed `maxPairs`. The throw is
     *   atomic (reserve-before-mutate): no slot is written, `pairCount()` is
     *   unchanged, and the table stays usable -- a later exit then `add`
     *   succeeds. The message names the cap and the remedy.
     */
    add(a: number, b: number): void;

    /**
     * Close the frame: one linear table scan emits an exit for every pair
     * present last frame but not touched this frame, and removes it. O(capacity).
     */
    end(): void;

    /**
     * O1 -- iterative BVH self-traversal. Reads `tree`'s readonly SoA and feeds
     * every FAT-box-overlapping leaf pair straight to {@link add}. Feeds `add`
     * ONLY: the caller owns the frame -- call it between your own `begin()` and
     * `end()`, optionally alongside manual `add` calls from other sources; one
     * frame yields one unified enter/stay/exit delta (decision E3). Zero
     * allocation on the traversal; the node-pair stack is pre-sized once from
     * `tree.maxNodes` and never grows mid-traversal (fail-closed throw on
     * overflow -- decision E1).
     *
     * The reported pairs are **FAT-bound** (conservative broadphase): a pair may
     * be reported whose *tight* boxes do not overlap, because the tree stores only
     * FATTENED boxes. Before acting on geometry (damage, pickups), recheck each
     * pair with **your own tight boxes** via {@link narrow} -- the tree cannot
     * answer the tight question. The differential oracle for this raw set is the
     * fat-box N-query set, NOT a tight brute-force set (decision E2).
     *
     * @throws on a corrupt tree -- a reached node whose `children` / `heights` /
     *   `userData` disagree on leaf status is a fail-closed error, not a silent
     *   skip (decision E4). Also throws (atomically) if a new pair would exceed
     *   `maxPairs`, exactly as {@link add} does.
     */
    collectPairs(tree: BvhTreeView): void;

    /**
     * O1 -- the TIGHT recheck (decision E2). Pure, zero-allocation boolean AABB
     * overlap of two caller-supplied **tight** boxes, each a `Float32Array(4)`
     * `[minX, minY, maxX, maxY]`. Does NOT touch the tree and imports nothing.
     *
     * Takes YOUR OWN tight boxes, not the tree's: {@link collectPairs} reports
     * FAT-bound pairs because bvh stores only fattened boxes, so a recheck reading
     * tree data would re-ask the same fat predicate and filter nothing. The tight
     * boxes exist only with the caller, before fattening -- pass them here for a
     * pair {@link collectPairs} flagged that you are about to act on.
     *
     * @param boxA tight box `[minX, minY, maxX, maxY]`.
     * @param boxB tight box `[minX, minY, maxX, maxY]`.
     * @returns whether the two tight boxes overlap (touching edges count).
     */
    narrow(boxA: Float32Array, boxB: Float32Array): boolean;

    /**
     * O3 -- swept self-traversal (decisions S1/S4): the tunneling fix. A
     * projectile faster than its own width overlaps a thin trigger at NO sampled
     * instant and tunnels through. This tests the swept volume `union(prev, curr)`
     * instead of the instantaneous box, catching the crossing. Feeds {@link add}
     * and the ordinary lifecycle (decision S2): a pass-through fires ENTER this
     * frame through the normal channel and EXIT the next -- no new drain to wire,
     * no pair silently missed.
     *
     * **Precondition (decision S4, a caller contract):** `tree`'s leaf boxes must
     * BOUND the swept motion -- build them as `fatten(union(prev, curr))` (e.g. via
     * `aabb2.merge` / `mergeAll`). A tree of instantaneous boxes prunes the
     * tunneling pair before the refinement runs. The descent prunes on those
     * swept-bounding boxes, and each surviving leaf pair is refined with the tight
     * `union(prev, curr)` from the packed arrays -- dropping the fattening's
     * over-reports as {@link narrow} does for the discrete path.
     *
     * `prevPacked` / `currPacked` hold the tight prev/curr boxes packed 4 floats
     * per entity, indexed by `userData` (leaf `u` -> `[u*4 .. u*4+3]`) -- the same
     * rotation-stable entity keying the O2 filter uses. The O2 filter applies
     * identically here.
     *
     * Superset + identity (decision S3): every discrete pair is a swept pair (the
     * union contains `curr`); and with `prevPacked === currPacked` (zero motion)
     * this yields the byte-identical set {@link collectPairs} does. Zero allocation
     * on the traversal -- both swept unions are register mins/maxes.
     *
     * @param tree swept-bounding SoA view (see precondition).
     * @param prevPacked tight prev boxes, length `>= 4*count`, `userData`-indexed.
     * @param currPacked tight curr boxes, length `>= 4*count`, `userData`-indexed.
     * @param count entity-id bound; a leaf `userData >= count` throws (fail closed).
     * @throws RangeError if `count` is not a non-negative integer, if a packed
     *   array is shorter than `4*count`, or if a reached leaf's `userData >= count`.
     * @throws TypeError if `prevPacked` / `currPacked` are not `Float32Array`.
     *   Also throws on a corrupt tree and on `maxPairs` exhaustion, like
     *   {@link collectPairs}.
     */
    collectSweptPairs(
        tree: BvhTreeView,
        prevPacked: Float32Array,
        currPacked: Float32Array,
        count: number,
    ): void;

    /**
     * O3 -- the pure swept predicate (decision S1), the swept analog of
     * {@link narrow}. Whether the swept volume of A (the AABB union of its prev and
     * curr tight boxes) overlaps the swept volume of B. Zero allocation; no table,
     * tree, or import.
     *
     * **Conservatism (S1):** the union never misses a real swept overlap but
     * over-reports on diagonal motion (the union is the bounding rectangle of the
     * thin diagonal sweep ribbon). The exact ribbon test is deferred; recheck
     * geometry with your own tight boxes before acting, as after any broadphase.
     *
     * @param prevA A's tight prev box `[minX, minY, maxX, maxY]`.
     * @param currA A's tight curr box.
     * @param prevB B's tight prev box.
     * @param currB B's tight curr box.
     * @returns whether the two swept volumes overlap (touching edges count).
     */
    sweptOverlap(
        prevA: Float32Array,
        currA: Float32Array,
        prevB: Float32Array,
        currB: Float32Array,
    ): boolean;

    /**
     * O3 -- the manual swept pair door (decision S1), the swept analog of
     * {@link add}: supply the two entities' motions and it records the pair iff
     * their swept volumes overlap. The differential ORACLE for
     * {@link collectSweptPairs}. Feeds {@link add} (decision S2), so a pass-through
     * fires ENTER this frame and EXIT the next. UNFILTERED by design, like `add` --
     * the raw primitive stays pure; a caller feeding pairs by hand owns filtering.
     *
     * @param a non-negative int32 entity id.
     * @param prevBoxA A's tight prev box `[minX, minY, maxX, maxY]`.
     * @param currBoxA A's tight curr box.
     * @param b non-negative int32 entity id.
     * @param prevBoxB B's tight prev box.
     * @param currBoxB B's tight curr box.
     * @throws if recording a new pair would exceed `maxPairs`, atomically, like
     *   {@link add}.
     */
    addSwept(
        a: number,
        prevBoxA: Float32Array,
        currBoxA: Float32Array,
        b: number,
        prevBoxB: Float32Array,
        currBoxB: Float32Array,
    ): void;

    /**
     * O2 -- assign an entity to a collision layer (decision F1). Keyed by
     * `userData`, so the assignment survives bvh rotations (a refit relinks node
     * ids but never `userData` -- decision F3). Every entity defaults to layer 0.
     * On an uncapped instance the backing array grows here on the cold path if
     * needed; on a `maxEntityId`-capped one, a `userData` above the cap throws.
     *
     * Filtering is sampled at {@link collectPairs}: call this BEFORE the frame's
     * collect for it to take effect that frame.
     *
     * @param userData non-negative int32 entity id.
     * @param layerIndex integer layer in `[0, 31]`.
     * @throws RangeError if `userData` is not a non-negative integer, if
     *   `layerIndex` is outside `[0, 31]`, or if `userData` exceeds `maxEntityId`.
     */
    setLayer(userData: number, layerIndex: number): void;

    /**
     * O2 -- set whether two layers interact (decision F2). Sets both `(a, b)` and
     * `(b, a)`, so the 32x32 collision matrix is symmetric by construction. The
     * default matrix is all-pairs-enabled, so an instance whose layers are never
     * touched reports exactly the unfiltered ({@link collectPairs}) set.
     *
     * @param layerA integer layer in `[0, 31]`.
     * @param layerB integer layer in `[0, 31]`.
     * @param enabled `true` => the two layers test each other; `false` => never.
     * @throws RangeError if either layer is outside `[0, 31]`.
     * @throws TypeError if `enabled` is not a boolean.
     */
    setInteract(layerA: number, layerB: number, enabled: boolean): void;

    /**
     * O2 -- enable or disable an entity (decision F4). A disabled entity fails the
     * layer test at every candidate, so none of its pairs re-stamp and all of its
     * live pairs fire exit at the next {@link end} through the ordinary mark-sweep
     * -- exactly once each, with no special exit path. Cheaper than removing the
     * leaf from the tree and re-inserting it. Sampled at {@link collectPairs}: set
     * it BEFORE the frame's collect.
     *
     * @param userData non-negative int32 entity id.
     * @param enabled `false` => generate no pairs for this entity.
     * @throws RangeError if `userData` is not a non-negative integer, or exceeds
     *   `maxEntityId`.
     * @throws TypeError if `enabled` is not a boolean.
     */
    setEnabled(userData: number, enabled: boolean): void;

    /**
     * Copy this frame's enter ids into caller buffers, mirroring bvh's
     * `query(out)` convention: `outA[k]` / `outB[k]` receive the k-th entering
     * pair (canonically ordered `outA[k] < outB[k]`). Non-destructive; may be
     * called repeatedly until the next `begin()`.
     *
     * @param outA destination for the low id of each entering pair.
     * @param outB destination for the high id of each entering pair.
     * @returns the number of pairs written, capped at the shorter out buffer.
     */
    drainEnter(outA: Int32Array, outB: Int32Array): number;

    /**
     * Copy this frame's exit ids into caller buffers. Same contract as
     * {@link drainEnter}. Ids are plain int32s -- draining dereferences nothing,
     * so a stale id after its entity is gone is a fail-closed lookup miss in the
     * caller, never a pointer hazard (decision C2).
     *
     * @returns the number of pairs written, capped at the shorter out buffer.
     */
    drainExit(outA: Int32Array, outB: Int32Array): number;

    /** Live pairs currently in the table. */
    pairCount(): number;

    /** Live pairs that did not enter this frame (`pairCount - enters`). */
    stayCount(): number;

    /**
     * Diagnostic snapshot. Cold path: allocates one plain object by design --
     * never call it inside a frame loop.
     */
    stats(): OverlapStats;

    /**
     * Silently empty the table without reallocating and WITHOUT emitting exits
     * (decision C2). To flush exits on teardown, run one empty frame
     * (`begin(); end();`) then `clear()`.
     */
    clear(): void;
}

/**
 * Create an overlap instance. All buffers are allocated here, once; nothing
 * allocates afterwards on any frame path.
 *
 * @throws TypeError if `options` is not an object.
 * @throws if an unknown option key is present (fail closed, with a hint).
 * @throws RangeError if `maxPairs` is not a positive integer.
 */
export function createOverlap(options: CreateOverlapOptions): Overlap;
