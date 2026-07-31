/**
 * @zakkster/lite-overlap -- Persistent overlap events over a dynamic BVH.
 *
 * Turns a per-frame set of overlapping pairs into a per-frame *delta*:
 * who just started overlapping (enter), who is still touching (stay), who
 * just stopped (exit) -- with zero allocation per frame.
 *
 * O0 ships the data structure and the lifecycle ONLY. Candidate pairs come
 * from the caller via `add(a, b)` (fed today from N `bvh.query()` calls).
 * O1 replaces the source with a single self-traversal, not the structure.
 *
 * The design decisions this file stands on are recorded in
 * `decisions/0001-pair-identity.md` (repo-only, not shipped):
 *   D1  pair keys are two parallel Int32Arrays, canonically ordered a < b.
 *   D2  open-addressed linear probe over Int32Array, backward-shift deletion.
 *   D3  exit detection is a 1-BIT ALTERNATING TAG, not a wide epoch counter.
 *   D4  capacity exhaustion is atomic: reserve-before-mutate throw.
 *   C1  FORMAT_VERSION is inline; conformance is a test, not a runtime import.
 *   C2  clear() is silent and single-purpose; teardown exits go via an empty frame.
 * O1 (self-traversal) decisions are in `decisions/0002-traversal.md`.
 * O2 (layers/filters) decisions are in `decisions/0003-filters.md`:
 *   F1  filter state is keyed by `userData` (entity id), never by node id --
 *       rotation-immune, since a refit relinks node ids but never touches userData.
 *   F2  a symmetric 32-bit collision matrix; `shouldTest` is one AND. Default is
 *       all-pairs-enabled, so an unfiltered instance is the exact O1 identity.
 *   F3  NO cached node-keyed subtree masks (they go stale silently under bvh
 *       rotations, which expose no hook) -- leaf-level filtering only.
 *   F4  filter at collect time, before `add`: a now-filtered pair is simply not
 *       re-stamped and exits through the normal O0 mark-sweep -- no special path.
 *
 * Zero runtime dependencies. ASCII-only source.
 *
 * @license MIT
 * @author Zahary Shinikchiev
 */

/** Package version. Keep in sync with package.json and llms.txt (three-place sync). */
export const VERSION = '1.2.0';

/**
 * The version of the shared FORMAT contract (see @zakkster/lite-aabb FORMAT.md),
 * NOT the package version. lite-aabb and lite-bvh export the identical constant;
 * lite-overlap is the third participant. Copied inline (no runtime dep on the
 * peers, per decision C1); agreement is enforced by the conformance test. It is
 * an integer compared for equality, on a separate axis from `VERSION` -- do not
 * sync it to semver.
 */
export const FORMAT_VERSION = 1;

/** Open-addressing target load factor. Strictly below 1 (decision D2). */
const LOAD_FACTOR = 0.7;

/** Hash mix constants (Math.imul keeps the product int32; decision D1). */
const HASH_A = 73856093;
const HASH_B = 19349663;

/** Empty-slot sentinel in slotKeyA. Safe: every real userData is >= 0 (D1). */
const EMPTY = -1;

/**
 * Entity-state packing (O2, decision F1). The per-entity filter state -- its
 * layer AND its enabled bit -- is packed into ONE `userData`-keyed Int32Array
 * slot: layer in bits 0..4, the disabled flag in bit 5. So the leaf-leaf filter
 * reads a SINGLE slot per endpoint (bytes in a hot body, not instructions), and
 * the default value `0` means layer 0 + enabled -- an entity nobody has touched
 * is the O1 identity. Highest layer index is 31 (32 layers, the Unity/Box2D
 * convention, one bitmask row per layer in the collision matrix).
 */
const LAYER_MASK = 31;      // bits 0..4: layer index in [0, 31].
const DISABLED_BIT = 32;    // bit 5: set => entity disabled (F4). 0 => enabled.
const MAX_LAYER = 31;

/**
 * Smallest power of two >= n (n >= 1). Used once, at construction.
 * @param {number} n
 * @returns {number}
 */
function nextPow2(n) {
    if (n < 1) return 1;
    n = n - 1;
    n |= n >> 1;
    n |= n >> 2;
    n |= n >> 4;
    n |= n >> 8;
    n |= n >> 16;
    return (n + 1) >>> 0;
}

/**
 * Create an overlap instance owning one pair table. Every buffer is allocated
 * here, once; nothing allocates on any frame path afterwards.
 *
 * `maxEntityId` (O2, optional) caps the `userData`-keyed filter arrays: when
 * given, `setLayer` / `setEnabled` fail closed above it and no filter buffer ever
 * grows; when omitted, those arrays grow lazily-once on the cold config path the
 * first time a larger id is filtered (never on a frame path), exactly as the O1
 * traversal stack grows from `tree.maxNodes` -- the door carries no such bound at
 * construction, so it is discovered late and sized cold, never mid-frame.
 *
 * @param {{ maxPairs: number, maxEntityId?: number }} options
 * @returns {import('./Overlap.js').Overlap}
 */
export function createOverlap(options) {
    if (options === null || typeof options !== 'object') {
        throw new TypeError('lite-overlap: createOverlap(options) requires an options object with { maxPairs }.');
    }
    // Fail closed on an unknown option key with a did-you-mean hint (suite Law).
    for (const key in options) {
        if (key !== 'maxPairs' && key !== 'maxEntityId') {
            throw new Error('lite-overlap: unknown option "' + key + '". Expected "maxPairs" or "maxEntityId".');
        }
    }
    const maxPairs = options.maxPairs;
    if (typeof maxPairs !== 'number' || !Number.isInteger(maxPairs) || maxPairs < 1) {
        throw new RangeError('lite-overlap: maxPairs must be a positive integer, got ' + String(maxPairs) + '.');
    }
    // O2 filter-array cap (optional). Present => fixed size, fail-closed above it;
    // absent => the arrays grow lazily-once on the cold setLayer/setEnabled path.
    const hasEntityCap = options.maxEntityId !== undefined;
    const entityCap = hasEntityCap ? options.maxEntityId : -1;
    if (hasEntityCap && (typeof entityCap !== 'number' || !Number.isInteger(entityCap) || entityCap < 0)) {
        throw new RangeError('lite-overlap: maxEntityId must be a non-negative integer, got ' + String(entityCap) + '.');
    }

    // Capacity is a power of two sized from maxPairs at load factor 0.7 (D2), so
    // a free slot always exists below the maxPairs logical cap and every probe
    // loop terminates without a full-table guard.
    const capacity = nextPow2(Math.ceil(maxPairs / LOAD_FACTOR));
    const mask = capacity - 1;

    // Parallel key arrays: identity is the two raw ids, never a packed number (D1).
    const slotKeyA = new Int32Array(capacity);
    const slotKeyB = new Int32Array(capacity);
    // A single alternating bit per slot (D3): 0 or 1, never grows, never wraps.
    const slotTag = new Int32Array(capacity);
    slotKeyA.fill(EMPTY);

    // Per-frame staging buffers for the delta. Bounded by maxPairs: a frame can
    // enter at most maxPairs new pairs and exit at most maxPairs old ones.
    const enterA = new Int32Array(maxPairs);
    const enterB = new Int32Array(maxPairs);
    const exitA = new Int32Array(maxPairs);
    const exitB = new Int32Array(maxPairs);

    // The capacity-exhaustion message is built ONCE at construction (D4), so the
    // hot add() body carries no string bytes -- the throw path just re-throws it.
    const FULL_MSG = 'lite-overlap: pair table full (' + maxPairs + '). Raise maxPairs.';

    let tag = 0;              // the 1-bit alternating tag (D3).
    let pairCount = 0;        // live pairs currently in the table.
    let enterCount = 0;       // pairs staged as enter this frame.
    let exitCount = 0;        // pairs staged as exit this frame.
    let probeHighWater = 0;   // longest probe distance ever observed.
    let highWaterMark = 0;    // max pairCount ever observed (D4: sizing signal).
    let frameCounter = 0;     // plain-number epoch telemetry (D3): never stored typed.

    /**
     * Backward-shift deletion at slot `i` (decision D2). Empties `i`, then walks
     * forward pulling any entry whose home slot lies outside the cyclic hole
     * range back into the gap, so the table stays tombstone-free and probe
     * chains stay bounded. No allocation.
     * @param {number} i
     */
    function removeAt(i) {
        slotKeyA[i] = EMPTY;
        let j = i;
        for (;;) {
            j = (j + 1) & mask;
            const ka = slotKeyA[j];
            if (ka === EMPTY) return;
            const home = (Math.imul(ka, HASH_A) ^ Math.imul(slotKeyB[j], HASH_B)) >>> 0 & mask;
            // Keep the entry where it is if its home lies cyclically in (i, j];
            // otherwise it can move back to fill the hole at i.
            if (i <= j) {
                if (i < home && home <= j) continue;
            } else {
                if (i < home || home <= j) continue;
            }
            slotKeyA[i] = ka;
            slotKeyB[i] = slotKeyB[j];
            slotTag[i] = slotTag[j];
            slotKeyA[j] = EMPTY;
            i = j;
        }
    }

    /**
     * Core pair insertion -- the O0 hot body, extracted verbatim so the O1
     * self-traversal (`collectPairs`, decision E3) feeds the SAME code path the
     * caller-fed `add` does. That shared implementation is exactly what makes the
     * N-query path a valid differential oracle for the traversal: same table,
     * same lifecycle, one insertion routine. HOT BODY: one hash, one probe loop,
     * one tag write. No string / object / closure. Order-invariant (canonicalizes
     * lo < hi), idempotent within a frame, rejects `a === b`.
     * @param {number} a
     * @param {number} b
     */
    function addPair(a, b) {
        if (a === b) return;
        let lo, hi;
        if (a < b) { lo = a; hi = b; } else { lo = b; hi = a; }

        let i = (Math.imul(lo, HASH_A) ^ Math.imul(hi, HASH_B)) >>> 0 & mask;
        let probe = 0;
        for (;;) {
            const ka = slotKeyA[i];
            if (ka === EMPTY) {
                // Miss: a new pair this frame. Reserve before mutating (D4).
                if (pairCount >= maxPairs) throw new Error(FULL_MSG);
                slotKeyA[i] = lo;
                slotKeyB[i] = hi;
                slotTag[i] = tag;
                pairCount++;
                if (pairCount > highWaterMark) highWaterMark = pairCount;
                enterA[enterCount] = lo;
                enterB[enterCount] = hi;
                enterCount++;
                if (probe > probeHighWater) probeHighWater = probe;
                return;
            }
            if (ka === lo && slotKeyB[i] === hi) {
                // Hit: present already. Stamp if first touch this frame (stay),
                // else a duplicate add within the frame is a no-op.
                if (slotTag[i] !== tag) slotTag[i] = tag;
                if (probe > probeHighWater) probeHighWater = probe;
                return;
            }
            i = (i + 1) & mask;
            probe++;
        }
    }

    // --- O1 self-traversal state (decisions 0002 E1/E4) -----------------------
    //
    // The traversal stack is an explicit Int32Array of node-pairs (2 int32 per
    // pair). E1 is a NO-GROW contract: reserve-before-push, throw on overflow,
    // NEVER `new Int32Array` mid-traversal. The buffer is sized ONCE per tree
    // node-count on the cold path (`ensureStack`, called at the top of
    // `collectPairs` before the loop) and reused across every later collect on a
    // same-or-smaller tree, so the 200k-collect alloc gate sees zero growth.
    //
    // NOTE (spec deviation, flagged in the O1 report): decision E1 says "size the
    // stack from maxNodes at construction". The O0 door `createOverlap({maxPairs})`
    // has no maxNodes -- the tree, and thus its maxNodes, only arrives at
    // `collectPairs(tree)`. Adding a required maxNodes option would break every
    // shipped O0 caller. Resolution that preserves BOTH the O0 door and E1's real
    // guarantee (never allocate mid-traversal): allocate lazily-once keyed on
    // tree.maxNodes, grow only between traversals (cold), never inside the loop.
    let traversalStack = null;    // Int32Array, lazily sized; never grows mid-loop.
    let stackOverflowMsg = '';    // built once per size on the cold path (not hot).
    let stackHwSlots = 0;         // traversal frontier high-water, in int32 slots.

    // Corruption message base, built ONCE (E4 fail-closed). The offending node id
    // is appended only on the throw (cold, terminal), never on the hot path.
    const CORRUPT_MSG = 'lite-overlap: corrupt tree, leaf signals (children/height/userData) disagree at node ';

    // Cold-path base for the duplicate-userData fault (E4), built ONCE like
    // CORRUPT_MSG. The two node ids and the shared id are concatenated only on the
    // throw (terminal), never on the passing hot path.
    const DUP_ID_MSG = 'lite-overlap: corrupt tree -- distinct leaves ';

    /**
     * Cold path. (Re)size the node-pair stack for a tree of `maxNodes` nodes.
     * Allocates only when the current buffer is missing or too small; on a stable
     * tree this runs its allocation exactly once, ever.
     *
     * STACK BOUND DERIVATION (E1 -- conservative, holds for ANY tree shape).
     * The stack holds the live frontier of pending node-pairs, not a root-to-leaf
     * path. Let H be the tree height. Two kinds of pending item, and at most one
     * cross-recursion is ever in progress at a time:
     *
     *   - SELF-pairs: the self-descent is a binary DFS over internal nodes; the
     *     pending siblings along the active spine number at most H + 1.
     *   - CROSS-pairs: when a self-pair (n,n) is popped, its cross seed (L,R) is
     *     pushed LAST, so it is popped FIRST and its cross-recursion runs to
     *     completion before any self-pair beneath it is touched (a cross descent
     *     never pushes a self-pair). Each cross descent replaces (a,b) with two
     *     pairs whose height-sum h(a)+h(b) is strictly smaller, so that recursion
     *     nests at most 2H-2 deep, leaving at most 2H-1 pending.
     *
     *   => simultaneous pending pairs <= (H + 1) + (2H - 1) = 3H.
     *
     * A structurally-degenerate binary tree has H <= leafCount - 1, and with
     * nodeCount = 2*leafCount - 1 <= maxNodes we get leafCount <= (maxNodes+1)/2,
     * hence 3H <= 1.5*maxNodes - 1.5. We allocate `2 * maxNodes` PAIRS
     * (`4 * maxNodes` int32 slots) -- above that worst case with margin, so the
     * overflow throw is unreachable for a well-formed tree and is a genuine
     * fail-closed corruption guard, not dead code. bvh rotations keep real height
     * at O(log n) (~13 at N=2000), so this cap is enormously slack in practice;
     * over-allocating a few int32 slots at setup is free, a mid-frame alloc is not.
     * @param {number} maxNodes
     */
    function ensureStack(maxNodes) {
        const pairsBound = maxNodes * 2;   // >= 3H with margin (see derivation).
        const slots = pairsBound * 2;      // 2 int32 per pending pair.
        if (traversalStack === null || traversalStack.length < slots) {
            traversalStack = new Int32Array(slots);
            // D4-shaped remedy message, built here on the cold path (not the hot
            // body): names the cap and the fix. Never allocated per push.
            stackOverflowMsg = 'lite-overlap: traversal stack overflow (' +
                pairsBound + '). Raise maxNodes/maxPairs.';
        }
    }

    // --- O2 filter state (decisions 0003 F1/F2) -------------------------------
    //
    // The 32x32 collision matrix (F2): row `i` is a bitmask of the layers `i`
    // interacts with. `shouldTest(a, b)` is `(matrix[a] >>> b) & 1`. Default is
    // ALL bits set -- every layer tests every layer -- so an instance whose
    // layers are never touched reports exactly the O1 set (unfiltered identity).
    const matrix = new Int32Array(32);
    matrix.fill(-1);   // -1 = all 32 bits set (F2 default: all-pairs-enabled).

    // The userData-keyed packed entity state (F1): layer | disabled, one slot per
    // entity id. Pre-sized when capped; otherwise length 0 and grown cold-once by
    // growEntity below. Default 0 (layer 0 + enabled) is the O1 identity, so an
    // id never assigned still filters correctly whether or not the array reaches it.
    let entityState = hasEntityCap ? new Int32Array(entityCap + 1) : new Int32Array(0);

    // Latch: false => collectPairs runs the exact O1 leaf-leaf emit with ZERO
    // filter overhead and byte-identical results; the first setLayer/setInteract/
    // setEnabled flips it. Filtering is opt-in; the unfiltered set is the identity.
    let filtersActive = false;

    /**
     * Cold config path. Ensure the packed entity-state array covers id `id`,
     * growing to the next power of two >= id+1 and copying (the new region
     * zero-fills to layer 0 + enabled). Only reached on an UNCAPPED instance --
     * a capped one fail-closes above `entityCap` instead of growing. Never called
     * on any frame path; mirrors ensureStack's lazily-once sizing.
     * @param {number} id
     */
    function growEntity(id) {
        if (id < entityState.length) return;
        const grown = new Int32Array(nextPow2(id + 1));
        grown.set(entityState);
        entityState = grown;
    }

    /**
     * Cold path. Resolve an entity id to a writable slot for a filter setter:
     * validate it is a non-negative integer, then either fail closed above the
     * cap (capped instance) or grow to reach it (uncapped). Returns nothing; the
     * caller writes `entityState[id]` after this succeeds.
     * @param {number} id
     * @param {string} who setter name, for the error message.
     */
    function reachEntity(id, who) {
        if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) {
            throw new RangeError('lite-overlap: ' + who + ' requires a non-negative integer userData, got ' + String(id) + '.');
        }
        if (hasEntityCap) {
            if (id > entityCap) {
                throw new RangeError('lite-overlap: userData ' + id + ' exceeds maxEntityId (' + entityCap + '). Raise maxEntityId.');
            }
        } else {
            growEntity(id);
        }
    }

    /**
     * Cold path. Validate a layer index is an integer in [0, 31] (F2).
     * @param {number} v
     * @param {string} who
     */
    function checkLayer(v, who) {
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_LAYER) {
            throw new RangeError('lite-overlap: ' + who + ' must be an integer in [0, 31], got ' + String(v) + '.');
        }
    }

    return {
        /**
         * Open a frame. Flips the tag (so every slot's stamp is now stale),
         * bumps the telemetry epoch, and clears the delta staging. O(1).
         */
        begin() {
            tag ^= 1;
            frameCounter++;
            enterCount = 0;
            exitCount = 0;
        },

        /**
         * Report a candidate overlapping pair for this frame. HOT BODY: one
         * hash, one probe loop, one tag write. No string / object / closure.
         * Order-invariant (canonicalizes lo < hi) and idempotent within a frame.
         * `a === b` is rejected. `a` and `b` must be non-negative int32 ids.
         *
         * This is the raw primitive door and is UNFILTERED by design: O2 layer /
         * enabled filtering (F4) is applied inside `collectPairs`, before it reaches
         * this method. A caller feeding pairs manually owns its own filtering; keep
         * `add` pure so it stays the differential oracle for the traversal.
         * @param {number} a
         * @param {number} b
         */
        add(a, b) {
            addPair(a, b);
        },

        /**
         * Close the frame. One linear scan of the table: every occupied slot
         * still carrying the previous tag was untouched this frame -- stage its
         * exit and remove it (backward-shift, D2). O(capacity), no allocation.
         */
        end() {
            const t = tag;
            let i = 0;
            while (i < capacity) {
                if (slotKeyA[i] !== EMPTY && slotTag[i] !== t) {
                    exitA[exitCount] = slotKeyA[i];
                    exitB[exitCount] = slotKeyB[i];
                    exitCount++;
                    pairCount--;
                    removeAt(i);
                    // Do NOT advance: removeAt may have shifted an unvisited
                    // (possibly stale) entry into slot i; re-examine it.
                } else {
                    i++;
                }
            }
        },

        /**
         * O1 -- iterative BVH self-traversal (decision 0002 E4). Reads the tree's
         * readonly SoA and feeds every FAT-box-overlapping leaf pair to `add`
         * (E3: this feeds `add` only -- the CALLER owns begin()/end(); one frame,
         * one delta, however many sources feed it). Does NOT import bvh: the tree
         * is a plain argument, format agreement only (C1). Zero allocation on the
         * traversal: the node-pair stack is the pre-sized buffer, no closure and
         * no object per node-pair.
         *
         * FAT vs TIGHT (E2): the pairs reported here are FAT-bound -- conservative
         * broadphase, because the tree stores only FATTENED boxes. A caller acting
         * on geometry (damage, pickup) MUST recheck each pair with ITS OWN tight
         * boxes first -- call `narrow(yourTightA, yourTightB)`; the tree cannot
         * answer the tight question. Comparing this raw set against a TIGHT
         * brute-force set flags a correct traversal as over-reporting -- do not.
         * The differential oracle is the fat-box N-query set (same boxes, same
         * predicate).
         *
         * FILTERING (O2, decisions F1/F2/F4): if any of `setLayer` / `setInteract`
         * / `setEnabled` has been called, each leaf-leaf candidate is mask-tested
         * (by the two endpoints' `userData`-keyed layers, and their enabled bits)
         * before `add`. Filtering changes COST, never results relative to the
         * post-filtered unfiltered set: a filtered-out pair is not re-stamped and
         * exits at `end()` through the normal sweep. State is sampled here, at
         * collect -- set filters BEFORE the frame's `collectPairs`, not after. With
         * no filters configured this runs the exact O1 emit (identity).
         *
         * @param {{ bboxes: Float32Array, children: Int32Array, heights: Int32Array,
         *   userData: Int32Array, root: number, maxNodes: number }} tree
         */
        collectPairs(tree) {
            // Read the SoA members into locals ONCE (hot-path law: no repeated
            // property loads inside the loop).
            const bboxes = tree.bboxes;
            const children = tree.children;
            const heights = tree.heights;
            const userData = tree.userData;
            const root = tree.root;

            // Cold: size the stack for this tree. Never inside the loop below.
            ensureStack(tree.maxNodes);
            const stack = traversalStack;
            const cap = stack.length;   // slots

            // O2 filter locals, hoisted ONCE (hot-path law). When filtering was
            // never configured, `fActive` is false and the leaf-leaf emit runs the
            // exact O1 path -- no filter loads, byte-identical set (F2 identity).
            const fActive = filtersActive;
            const eState = entityState;
            const eLen = eState.length;
            const mtx = matrix;

            if (root < 0) return;       // empty tree -> zero pairs (E4).

            // Seed / single-leaf, with the root's fail-closed leaf cross-check (E4).
            const rootLeaf = children[root * 2] === -1;
            if (rootLeaf !== (heights[root] === 0) || rootLeaf !== (userData[root] !== -1)) {
                throw new Error(CORRUPT_MSG + root);
            }
            if (rootLeaf) return;       // single leaf -> zero pairs (E4).

            let sp = 0;
            stack[sp++] = root; stack[sp++] = root;   // self-pair (root, root).

            while (sp > 0) {
                if (sp > stackHwSlots) stackHwSlots = sp;
                const b = stack[--sp];
                const a = stack[--sp];

                if (a === b) {
                    // ---- SELF-PAIR (n, n): n is internal by construction. ----
                    const n2 = a * 2;
                    const L = children[n2];
                    const R = children[n2 + 1];
                    // Reserve the worst case up front: up to 3 pairs = 6 slots
                    // ((L,L), (R,R), (L,R)). Reserve-before-push, throw on overflow
                    // (E1); never grow. The message is pre-built (cold).
                    if (sp + 6 > cap) throw new Error(stackOverflowMsg);
                    // Fail-closed leaf cross-check of L and R (E4).
                    const Lleaf = children[L * 2] === -1;
                    if (Lleaf !== (heights[L] === 0) || Lleaf !== (userData[L] !== -1)) throw new Error(CORRUPT_MSG + L);
                    const Rleaf = children[R * 2] === -1;
                    if (Rleaf !== (heights[R] === 0) || Rleaf !== (userData[R] !== -1)) throw new Error(CORRUPT_MSG + R);
                    // *** THE 94-vs-1,543 LINE (E4) ***: a self-pair MUST re-emit
                    // the self-pairs of its INTERNAL children, not only the cross
                    // term. Dropping (L,L)/(R,R) keeps only root-straddling pairs
                    // and silently loses every pair living inside one subtree --
                    // 94 pairs instead of 1,543, and nothing throws. Emit them.
                    if (!Lleaf) { stack[sp++] = L; stack[sp++] = L; }   // (L, L)
                    if (!Rleaf) { stack[sp++] = R; stack[sp++] = R; }   // (R, R)
                    stack[sp++] = L; stack[sp++] = R;                    // cross (L, R)
                } else {
                    // ---- CROSS-PAIR (a, b): fat-box AABB overlap (E4). -------
                    const a4 = a * 4;
                    const b4 = b * 4;
                    if (bboxes[a4] <= bboxes[b4 + 2] && bboxes[b4] <= bboxes[a4 + 2] &&
                        bboxes[a4 + 1] <= bboxes[b4 + 3] && bboxes[b4 + 1] <= bboxes[a4 + 3]) {
                        const aLeaf = children[a * 2] === -1;
                        if (aLeaf !== (heights[a] === 0) || aLeaf !== (userData[a] !== -1)) throw new Error(CORRUPT_MSG + a);
                        const bLeaf = children[b * 2] === -1;
                        if (bLeaf !== (heights[b] === 0) || bLeaf !== (userData[b] !== -1)) throw new Error(CORRUPT_MSG + b);
                        if (aLeaf && bLeaf) {
                            // Both leaves overlap: a candidate pair. The two nodes
                            // are distinct indices by construction (E4), so equal
                            // userData is a data-integrity fault -- two distinct
                            // leaves sharing an id. FAIL CLOSED: without this,
                            // add(id, id) is rejected as a self-pair (D1) and the
                            // real collision is SILENTLY dropped -- the exact
                            // missed-collision failure this session prevents.
                            if (userData[a] === userData[b]) {
                                throw new Error(DUP_ID_MSG + a + ' and ' + b +
                                    ' share userData ' + userData[a] + '. Leaf userData must be unique.');
                            }
                            const ua = userData[a];
                            const ub = userData[b];
                            // O2 FILTER (F1/F2/F4), applied HERE -- at collect,
                            // before add. The dup-userData throw above runs FIRST:
                            // filtering must never mask a corrupt tree (F1). A pair
                            // that fails the filter is simply not re-stamped this
                            // frame, so the O0 sweep exits it at end() -- no special
                            // exit path (F4). An id beyond eLen reads the default 0
                            // (layer 0 + enabled), the O1 identity.
                            if (fActive) {
                                const sa = ua < eLen ? eState[ua] : 0;
                                const sb = ub < eLen ? eState[ub] : 0;
                                if ((sa & DISABLED_BIT) === 0 && (sb & DISABLED_BIT) === 0 &&
                                    ((mtx[sa & LAYER_MASK] >>> (sb & LAYER_MASK)) & 1) === 1) {
                                    addPair(ua, ub);   // dedups, canonicalizes lo < hi (D1/E3).
                                }
                            } else {
                                addPair(ua, ub);   // O1 identity: dedups, canonicalizes lo < hi.
                            }
                        } else {
                            if (sp + 4 > cap) throw new Error(stackOverflowMsg);
                            // Descend the TALLER node (tie -> a). The taller is
                            // internal by construction: a leaf has height 0, which
                            // cannot be strictly tallest unless the other is a leaf
                            // too (handled above). Expand from ONE side only, so
                            // no cross relationship is visited twice (E4 / E1).
                            if (heights[a] >= heights[b]) {
                                const c2 = a * 2;
                                const c0 = children[c2];
                                const c1 = children[c2 + 1];
                                stack[sp++] = c0; stack[sp++] = b;
                                stack[sp++] = c1; stack[sp++] = b;
                            } else {
                                const c2 = b * 2;
                                const c0 = children[c2];
                                const c1 = children[c2 + 1];
                                stack[sp++] = a; stack[sp++] = c0;
                                stack[sp++] = a; stack[sp++] = c1;
                            }
                        }
                    }
                    // miss -> prune (drop the pair).
                }
            }
        },

        /**
         * O1 -- the TIGHT recheck (decision E2). Pure boolean AABB overlap of two
         * caller-supplied TIGHT boxes, each a `Float32Array(4)`
         * `[minX, minY, maxX, maxY]`. Zero allocation, does NOT touch the tree,
         * imports nothing (a caller need not pull in lite-aabb for the one
         * predicate).
         *
         * WHY THE CALLER'S BOXES, not the tree's: `collectPairs` reports FAT-bound
         * pairs (conservative broadphase) because bvh stores only FATTENED boxes
         * (`bboxes` / `getBounds` are the fat box, never the caller's original
         * tight box). A recheck reading tree data would re-ask the SAME fat
         * predicate -- always true for a reported pair, filtering nothing. The
         * tight boxes exist only where they were created: with the caller, before
         * fattening. So the caller passes them here for a pair it cares about.
         *
         * @param {Float32Array} boxA tight box `[minX, minY, maxX, maxY]`.
         * @param {Float32Array} boxB tight box `[minX, minY, maxX, maxY]`.
         * @returns {boolean} whether the two tight boxes overlap (touching counts).
         */
        narrow(boxA, boxB) {
            return boxA[0] <= boxB[2] && boxB[0] <= boxA[2] &&
                boxA[1] <= boxB[3] && boxB[1] <= boxA[3];
        },

        /**
         * O2 -- assign an entity to a collision layer (decision F1). Cold config
         * path: keyed by `userData`, so it survives bvh rotations (a refit relinks
         * node ids, never userData -- F3). Default layer is 0; every entity starts
         * there. On an uncapped instance the backing array grows here if needed
         * (never on a frame path); on a capped one, `userData > maxEntityId` throws.
         * @param {number} userData non-negative int32 entity id.
         * @param {number} layerIndex integer in [0, 31].
         */
        setLayer(userData, layerIndex) {
            checkLayer(layerIndex, 'layer');
            reachEntity(userData, 'setLayer(userData, layer)');
            // Preserve the disabled bit; replace only the layer bits (F1 packing).
            entityState[userData] = (entityState[userData] & ~LAYER_MASK) | layerIndex;
            filtersActive = true;
        },

        /**
         * O2 -- set whether two layers interact (decision F2). Writes BOTH `(a,b)`
         * and `(b,a)`, so the matrix is symmetric by construction -- an asymmetric
         * rule (a pair whose appearance depends on which node the descent reached
         * first) is unrepresentable. Default is all-pairs-enabled.
         * @param {number} layerA integer in [0, 31].
         * @param {number} layerB integer in [0, 31].
         * @param {boolean} enabled true => the two layers test each other.
         */
        setInteract(layerA, layerB, enabled) {
            checkLayer(layerA, 'layerA');
            checkLayer(layerB, 'layerB');
            if (typeof enabled !== 'boolean') {
                throw new TypeError('lite-overlap: setInteract(a, b, enabled) requires a boolean enabled, got ' + typeof enabled + '.');
            }
            const bitB = 1 << layerB;
            const bitA = 1 << layerA;
            if (enabled) {
                matrix[layerA] |= bitB;
                matrix[layerB] |= bitA;
            } else {
                matrix[layerA] &= ~bitB;
                matrix[layerB] &= ~bitA;
            }
            filtersActive = true;
        },

        /**
         * O2 -- enable or disable an entity (decision F4). A disabled entity fails
         * `shouldTest` unconditionally at every leaf-leaf candidate, so none of its
         * pairs re-stamp this frame and ALL of them exit at the next `end()` via
         * the ordinary O0 mark-sweep -- "fires exit for every live pair of that
         * entity, exactly once" with no special-case exit path. Cheaper and clearer
         * than removing the leaf from the tree and re-inserting it. Set it BEFORE
         * the frame's `collectPairs`; state is sampled at collect (F4).
         * @param {number} userData non-negative int32 entity id.
         * @param {boolean} enabled false => generate no pairs for this entity.
         */
        setEnabled(userData, enabled) {
            if (typeof enabled !== 'boolean') {
                throw new TypeError('lite-overlap: setEnabled(userData, enabled) requires a boolean enabled, got ' + typeof enabled + '.');
            }
            reachEntity(userData, 'setEnabled(userData, enabled)');
            if (enabled) entityState[userData] &= ~DISABLED_BIT;
            else entityState[userData] |= DISABLED_BIT;
            filtersActive = true;
        },

        /**
         * Copy this frame's enter ids into caller buffers (bvh query(out)
         * convention). Non-destructive; returns the number written, capped at
         * the shorter of the two out buffers.
         * @param {Int32Array} outA
         * @param {Int32Array} outB
         * @returns {number}
         */
        drainEnter(outA, outB) {
            let n = enterCount;
            if (n > outA.length) n = outA.length;
            if (n > outB.length) n = outB.length;
            for (let k = 0; k < n; k++) {
                outA[k] = enterA[k];
                outB[k] = enterB[k];
            }
            return n;
        },

        /**
         * Copy this frame's exit ids into caller buffers. Non-destructive;
         * returns the number written, capped at the shorter out buffer.
         * @param {Int32Array} outA
         * @param {Int32Array} outB
         * @returns {number}
         */
        drainExit(outA, outB) {
            let n = exitCount;
            if (n > outA.length) n = outA.length;
            if (n > outB.length) n = outB.length;
            for (let k = 0; k < n; k++) {
                outA[k] = exitA[k];
                outB[k] = exitB[k];
            }
            return n;
        },

        /** Live pairs currently in the table. */
        pairCount() {
            return pairCount;
        },

        /** Live pairs that did not enter this frame (pairCount - enters). */
        stayCount() {
            return pairCount - enterCount;
        },

        /**
         * Diagnostic snapshot (cold path; allocates one plain object by design).
         * `highWaterMark` is the number to size `maxPairs` from; `epoch` is the
         * plain-number frame counter (exact to 2^53, never truncated).
         * @returns {import('./Overlap.js').OverlapStats}
         */
        stats() {
            return {
                pairCount,
                stayCount: pairCount - enterCount,
                capacity,
                loadFactor: pairCount / capacity,
                probeHighWater,
                highWaterMark,
                stackHighWater: stackHwSlots >> 1,   // slots -> pending node-pairs.
                epoch: frameCounter,
            };
        },

        /**
         * Silently empty the table without reallocating and WITHOUT emitting
         * exits (decision C2). To flush exits on teardown, run one empty frame
         * -- begin(); end(); -- then clear().
         */
        clear() {
            slotKeyA.fill(EMPTY);
            pairCount = 0;
            enterCount = 0;
            exitCount = 0;
        },
    };
}
