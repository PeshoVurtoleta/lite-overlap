/**
 * @zakkster/lite-overlap -- targeted adversarial test for backward-shift
 * deletion DURING end()'s linear scan, on probe clusters that straddle the
 * table's wraparound boundary (home index near `capacity-1`, chain wrapping
 * through `0`).
 *
 * The inline review argued end()'s "remove, do NOT advance, re-examine slot i"
 * shift is correct because end() only ever relocates entries that are still
 * CURRENT (backward-shift only pulls back live entries, and end() has already
 * decided their fate is "stay" before it can shift into a hole opened by a
 * removal at a lower index -- see Overlap.js removeAt() ~line 127 and end()
 * ~line 210). That argument was reasoned, not exhaustively fuzzed against
 * clusters engineered to wrap. This file is that fuzz.
 *
 * Construction (decision D2's hash, mirrored here -- NOT imported, since it is
 * not exported; mirroring is the only way to pick adversarial ids without
 * guessing):
 *
 *   home(lo, hi) = (Math.imul(lo, 73856093) ^ Math.imul(hi, 19349663)) >>> 0
 *                  & (capacity - 1)
 *
 * For maxPairs 5 / 11 / 22 the table lands on capacity 8 / 16 / 32 exactly
 * (asserted, not assumed, at the top of every scenario). For each capacity a
 * pool of `maxPairs` distinct id pairs is mined so every pair's home falls in
 * a 6-slot window straddling the wrap boundary: { capacity-3, capacity-2,
 * capacity-1, 0, 1, 2 }. Any table churn restricted to that pool is forced,
 * by pigeonhole, to build probe chains that physically cross the capacity-1
 * -> 0 seam -- there is no public API to inspect the physical slot a pair
 * lands in, so exhaustive single-member removal (below) covers every possible
 * placement instead of guessing one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOverlap } from '../Overlap.js';

// --- mirror of Overlap.js's internal hash (D1/D2) -- test-time id mining only,
// never used to fake a result. ------------------------------------------------
const HASH_A = 73856093;
const HASH_B = 19349663;
function home(lo, hi, mask) {
    return (Math.imul(lo, HASH_A) ^ Math.imul(hi, HASH_B)) >>> 0 & mask;
}

function key(a, b) {
    return a < b ? a + ',' + b : b + ',' + a;
}

// Mine `count` distinct (lo,hi) pairs whose home falls in a 6-slot window
// straddling the capacity-1 -> 0 wrap. One pair per increasing `lo` where
// possible, so the pool is not degenerately all-share-one-id.
function mineWrapPool(capacity, count) {
    const mask = capacity - 1;
    const window = new Set([
        (mask - 2) & mask, (mask - 1) & mask, mask, 0, 1, 2,
    ]);
    const pool = [];
    const seen = new Set();
    let lo = 0;
    while (pool.length < count && lo < 20000) {
        for (let d = 1; d < 4000 && pool.length < count; d++) {
            const hi = lo + d;
            if (window.has(home(lo, hi, mask))) {
                const k = key(lo, hi);
                if (!seen.has(k)) {
                    seen.add(k);
                    pool.push([lo, hi]);
                    break;
                }
            }
        }
        lo++;
    }
    if (pool.length < count) {
        throw new Error('mineWrapPool: could not mine ' + count + ' wrap-window ids for capacity ' + capacity);
    }
    // Confirm at least 3 distinct pairs share the SAME home exactly at
    // capacity-1 -- the tightest possible wrap-forcing construction (insert
    // order then guarantees the 2nd/3rd land at physical slot 0 / 1 by
    // collision, not luck).
    const atBoundary = pool.filter(([a, b]) => home(a, b, mask) === mask);
    if (atBoundary.length < 2) {
        throw new Error('mineWrapPool: fewer than 2 pairs collide exactly at home=capacity-1 for capacity ' + capacity);
    }
    return pool;
}

const SCENARIOS = [
    { maxPairs: 5, capacity: 8 },
    { maxPairs: 11, capacity: 16 },
    { maxPairs: 22, capacity: 32 },
];

// =============================================================================
// PART A -- exhaustive single-member removal while the rest of a wrap-forced
// cluster persists. Since there is no API to inspect physical slot placement,
// removing every pool member one at a time (while holding the others live)
// guarantees, by pigeonhole, that whichever member is physically stored at the
// wrap-straddling slot gets removed in some iteration of this loop -- no exit
// dropped, no phantom pair survives, for EVERY possible layout.
// =============================================================================

for (const { maxPairs, capacity } of SCENARIOS) {
    test('wrap-cluster exhaustive single removal, capacity ' + capacity, () => {
        const pool = mineWrapPool(capacity, maxPairs);

        for (let k = 0; k < pool.length; k++) {
            const ov = createOverlap({ maxPairs });
            assert.equal(ov.stats().capacity, capacity, 'capacity matches the mined window');
            const eA = new Int32Array(maxPairs), eB = new Int32Array(maxPairs);
            const xA = new Int32Array(maxPairs), xB = new Int32Array(maxPairs);

            // Frame 1: the whole cluster enters at once (forces the wrap-crossing
            // probe chain by construction: every id is in the mined window).
            ov.begin();
            for (const [a, b] of pool) ov.add(a, b);
            ov.end();
            assert.equal(ov.drainEnter(eA, eB), pool.length, 'k=' + k + ': whole cluster enters');
            assert.equal(ov.pairCount(), pool.length, 'k=' + k + ': cluster fully live');

            // Frame 2: re-add everything EXCEPT member k -- member k vanishes.
            // This is the exact op that runs removeAt() DURING end()'s linear
            // scan on a table whose live entries were forced across the seam.
            ov.begin();
            for (let i = 0; i < pool.length; i++) {
                if (i === k) continue;
                ov.add(pool[i][0], pool[i][1]);
            }
            ov.end();

            const en = ov.drainEnter(eA, eB);
            const ex = ov.drainExit(xA, xB);
            assert.equal(en, 0, 'k=' + k + ': no phantom enter on a pure vanish frame');
            assert.equal(ex, 1, 'k=' + k + ': exactly one exit (the vanished member)');
            assert.equal(key(xA[0], xB[0]), key(pool[k][0], pool[k][1]), 'k=' + k + ': the exit is member k, not a neighbour');
            assert.equal(ov.pairCount(), pool.length - 1, 'k=' + k + ': pairCount reflects exactly one loss');
            assert.equal(ov.stayCount(), pool.length - 1, 'k=' + k + ': every survivor is a stay, none dropped');

            // Frame 3: steady state -- re-add every survivor again. If removeAt's
            // backward-shift corrupted a neighbour while crossing the wrap (moved
            // it to the wrong slot, duplicated it, or orphaned it so a fresh add()
            // treats it as new), this is where it would surface as a spurious
            // enter/exit or a wrong pairCount.
            ov.begin();
            for (let i = 0; i < pool.length; i++) {
                if (i === k) continue;
                ov.add(pool[i][0], pool[i][1]);
            }
            ov.end();
            assert.equal(ov.drainEnter(eA, eB), 0, 'k=' + k + ': steady state after the wrap-shift -- no spurious enter');
            assert.equal(ov.drainExit(xA, xB), 0, 'k=' + k + ': steady state after the wrap-shift -- no spurious exit');
            assert.equal(ov.pairCount(), pool.length - 1, 'k=' + k + ': pairCount still correct post-shift');

            // Frame 4: the vanished member returns -- must be a fresh enter
            // (never mistaken for a still-live neighbour occupying its old
            // physical slot after the backward-shift moved things around).
            ov.begin();
            for (const [a, b] of pool) ov.add(a, b);
            ov.end();
            assert.equal(ov.drainEnter(eA, eB), 1, 'k=' + k + ': the returning member is exactly one fresh enter');
            assert.equal(ov.pairCount(), pool.length, 'k=' + k + ': full cluster live again, no phantom duplicate');
        }
    });
}

// =============================================================================
// PART B -- randomized fuzz restricted to the wrap-window pool, many frames,
// against a Set<string> oracle. Seed printed on failure and replayable via
// OVERLAP_WRAP_SEED=<seed>.
// =============================================================================

function xorshift32(seed) {
    let s = seed >>> 0;
    if (s === 0) s = 0x1a2b3c4d;
    return function next() {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        return s >>> 0;
    };
}

for (const { maxPairs, capacity } of SCENARIOS) {
    test('wrap-cluster fuzz vs Set<string> oracle, capacity ' + capacity, () => {
        const SEED = (process.env.OVERLAP_WRAP_SEED
            ? (parseInt(process.env.OVERLAP_WRAP_SEED, 10) >>> 0)
            : (0xC001C0DE ^ capacity)) >>> 0;
        const rng = xorshift32(SEED);
        const pool = mineWrapPool(capacity, maxPairs);
        const FRAMES = 6000;

        const ov = createOverlap({ maxPairs });
        assert.equal(ov.stats().capacity, capacity);
        const eA = new Int32Array(maxPairs), eB = new Int32Array(maxPairs);
        const xA = new Int32Array(maxPairs), xB = new Int32Array(maxPairs);

        // Oracle tracks which pool INDICES are live (pool is closed under the
        // whole run -- every id used comes from the mined wrap-window set).
        let prevLive = new Set();
        const curLive = new Set();

        for (let frame = 0; frame < FRAMES; frame++) {
            curLive.clear();
            // Persist ~70% of last frame's live members.
            for (const idx of prevLive) {
                if ((rng() % 100) < 70) curLive.add(idx);
            }
            // Appear a handful of NOT-currently-live pool members (bounded by
            // pool.length, so pairCount can reach maxPairs exactly but never
            // overflow it -- this test is about the wrap, not D4's throw).
            const tries = 1 + (rng() % 4);
            for (let t = 0; t < tries; t++) {
                const idx = rng() % pool.length;
                if (!curLive.has(idx)) curLive.add(idx);
            }

            const oracleEnter = new Set();
            const oracleExit = new Set();
            for (const idx of curLive) if (!prevLive.has(idx)) oracleEnter.add(idx);
            for (const idx of prevLive) if (!curLive.has(idx)) oracleExit.add(idx);
            const oracleStay = curLive.size - oracleEnter.size;

            ov.begin();
            for (const idx of curLive) {
                const [a, b] = pool[idx];
                if ((rng() & 1) === 0) ov.add(a, b); else ov.add(b, a);
                if ((rng() % 6) === 0) ov.add(a, b); // in-frame duplicate
            }
            ov.end();

            const en = ov.drainEnter(eA, eB);
            const ex = ov.drainExit(xA, xB);

            if (en !== oracleEnter.size || ex !== oracleExit.size ||
                ov.pairCount() !== curLive.size || ov.stayCount() !== oracleStay) {
                assert.fail(
                    'wrap-fuzz mismatch capacity=' + capacity + ' frame=' + frame + ' SEED=' + SEED +
                    ' | enter got/exp ' + en + '/' + oracleEnter.size +
                    ' exit got/exp ' + ex + '/' + oracleExit.size +
                    ' pairCount got/exp ' + ov.pairCount() + '/' + curLive.size +
                    ' stay got/exp ' + ov.stayCount() + '/' + oracleStay,
                );
            }

            // Set-identity: no phantom pair, no dropped exit.
            const gotEnterKeys = new Set();
            for (let i = 0; i < en; i++) gotEnterKeys.add(key(eA[i], eB[i]));
            for (const idx of oracleEnter) {
                const kk = key(pool[idx][0], pool[idx][1]);
                if (!gotEnterKeys.has(kk)) {
                    assert.fail('dropped enter ' + kk + ' capacity=' + capacity + ' frame=' + frame + ' SEED=' + SEED);
                }
            }
            const gotExitKeys = new Set();
            for (let i = 0; i < ex; i++) gotExitKeys.add(key(xA[i], xB[i]));
            for (const idx of oracleExit) {
                const kk = key(pool[idx][0], pool[idx][1]);
                if (!gotExitKeys.has(kk)) {
                    assert.fail('dropped exit ' + kk + ' capacity=' + capacity + ' frame=' + frame + ' SEED=' + SEED);
                }
            }

            prevLive = new Set(curLive);
        }
    });
}
