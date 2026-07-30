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
 *
 * Zero runtime dependencies. ASCII-only source.
 *
 * @license MIT
 * @author Zahary Shinikchiev
 */

/** Package version. Keep in sync with package.json and llms.txt (three-place sync). */
export const VERSION = '1.0.0';

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
 * @param {{ maxPairs: number }} options
 * @returns {import('./Overlap.js').Overlap}
 */
export function createOverlap(options) {
    if (options === null || typeof options !== 'object') {
        throw new TypeError('lite-overlap: createOverlap(options) requires an options object with { maxPairs }.');
    }
    // Fail closed on an unknown option key with a did-you-mean hint (suite Law).
    for (const key in options) {
        if (key !== 'maxPairs') {
            throw new Error('lite-overlap: unknown option "' + key + '". Did you mean "maxPairs"?');
        }
    }
    const maxPairs = options.maxPairs;
    if (typeof maxPairs !== 'number' || !Number.isInteger(maxPairs) || maxPairs < 1) {
        throw new RangeError('lite-overlap: maxPairs must be a positive integer, got ' + String(maxPairs) + '.');
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
         * @param {number} a
         * @param {number} b
         */
        add(a, b) {
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
