/**
 * Tier T3 -- adversarial open-addressing (decision D1/D2).
 *
 * The pair table is a linear-probe open-addressed hash over Int32Arrays. Its
 * worst case is a full COLLISION CHAIN: many pairs whose hashes land on one home
 * slot, so every probe walks the whole cluster. This tier MINES that case by
 * replicating the table's own hash, then proves under it:
 *
 *   - termination: the probe never loops forever on a saturated cluster;
 *   - correctness: all colliders are stored and retrievable (each re-add is a
 *     stay, not a duplicate enter);
 *   - a PINNED probe bound: K colliders on one home give probeHighWater exactly
 *     K-1, and that stays strictly below capacity -- so a hash change that
 *     quietly worsened clustering would move this number and fail the tier;
 *   - backward-shift healing: exit half the chain, and the survivors stay
 *     correct and the freed slots reusable -- tombstones would rot here.
 *
 * The hash constants are copied from Overlap.js (D1). If they change there
 * without changing here, the mined home slots stop colliding and the pinned
 * probeHighWater drops -- a loud, intentional coupling.
 */

import { createOverlap } from '../../Overlap.js';

const TIER = 'T3';
const HASH_A = 73856093;
const HASH_B = 19349663;

function homeOf(lo, hi, mask) {
    return ((Math.imul(lo, HASH_A) ^ Math.imul(hi, HASH_B)) >>> 0) & mask;
}
function key(a, b) { return a < b ? a + ',' + b : b + ',' + a; }

export function run(h) {
    const maxPairs = 400;
    const ov = createOverlap({ maxPairs });
    const capacity = ov.stats().capacity;
    const mask = capacity - 1;

    // --- mine the fullest collision bucket ----------------------------------
    // Scan a square of (lo,hi) ids, group by home slot, take the fullest group.
    const LIM = 640;
    const buckets = new Map();               // home -> array of [lo,hi]
    for (let lo = 0; lo < LIM; lo++) {
        for (let hi = lo + 1; hi < LIM; hi++) {
            const hm = homeOf(lo, hi, mask);
            let arr = buckets.get(hm);
            if (arr === undefined) { arr = []; buckets.set(hm, arr); }
            arr.push(lo, hi);
        }
    }
    let best = null, bestLen = 0;
    for (const arr of buckets.values()) {
        if (arr.length > bestLen) { bestLen = arr.length; best = arr; }
    }
    // Keep the chain under 0.66 load and under maxPairs; require a meaningful K.
    const room = Math.min(Math.floor(capacity * 0.66), maxPairs);
    const K = Math.min(best.length / 2, room) | 0;
    if (K < 64) h.fail(TIER, 'mining underpowered: only ' + K + ' colliders (raise LIM)', {});

    const loA = new Int32Array(K), hiA = new Int32Array(K);
    for (let i = 0; i < K; i++) { loA[i] = best[i * 2]; hiA[i] = best[i * 2 + 1]; }
    // Cross-check the mining actually produced one shared home.
    const h0 = homeOf(loA[0], hiA[0], mask);
    for (let i = 1; i < K; i++) {
        if (homeOf(loA[i], hiA[i], mask) !== h0) h.fail(TIER, 'mined pair ' + i + ' not on shared home', { op: i });
    }

    const eA = new Int32Array(maxPairs), eB = new Int32Array(maxPairs);
    const xA = new Int32Array(maxPairs), xB = new Int32Array(maxPairs);

    // --- frame A: insert the whole chain ------------------------------------
    ov.begin();
    for (let i = 0; i < K; i++) ov.add(loA[i], hiA[i]);
    ov.end();
    const enA = ov.drainEnter(eA, eB);
    h.assertEq(TIER, enA, K, 'chain: all colliders enter');
    h.assertEq(TIER, ov.pairCount(), K, 'chain: pairCount == K');
    // K colliders on one home => the last insert probed exactly K-1 slots.
    h.assertEq(TIER, ov.stats().probeHighWater, K - 1, 'chain: probeHighWater == K-1 (pinned)');
    if (ov.stats().probeHighWater >= capacity) h.fail(TIER, 'probe reached capacity -- runaway', {});

    // Every member re-adds as a STAY (found through the full probe), not a dup.
    ov.begin();
    for (let i = 0; i < K; i++) ov.add(hiA[i], loA[i]);   // order flipped: same slot
    // no end() yet -- check no spurious enter mid-frame
    const enStay = ov.drainEnter(eA, eB);
    h.assertEq(TIER, enStay, 0, 'chain: re-add is stay, not enter');
    ov.end();
    h.assertEq(TIER, ov.pairCount(), K, 'chain: pairCount stable after stay frame');

    // --- backward-shift healing: exit half the chain ------------------------
    const keep = (K + 1) >> 1, drop = K - keep;
    ov.begin();
    for (let i = 0; i < keep; i++) ov.add(loA[i], hiA[i]);   // touch only the keepers
    ov.end();
    const exB = ov.drainExit(xA, xB);
    h.assertEq(TIER, exB, drop, 'heal: dropped half exits');
    h.assertEq(TIER, ov.pairCount(), keep, 'heal: pairCount == keep');
    // The survivors must all still be findable after the shift (all stay).
    ov.begin();
    for (let i = 0; i < keep; i++) ov.add(loA[i], hiA[i]);
    const enHeal = ov.drainEnter(eA, eB);
    h.assertEq(TIER, enHeal, 0, 'heal: survivors all found (0 spurious enter)');
    ov.end();

    // --- freed slots reusable: re-add the dropped half ----------------------
    ov.begin();
    for (let i = 0; i < K; i++) ov.add(loA[i], hiA[i]);      // keepers stay, drops re-enter
    ov.end();
    const enBack = ov.drainEnter(eA, eB);
    h.assertEq(TIER, enBack, drop, 'reuse: dropped half re-enters into healed slots');
    h.assertEq(TIER, ov.pairCount(), K, 'reuse: full chain restored');
}
