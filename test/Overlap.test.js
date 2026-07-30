/**
 * @zakkster/lite-overlap -- unit tests (Node built-in test runner).
 *
 *   npm test            # node --expose-gc --test test/*.test.js
 *
 * Every O0 ASSERTION from the ROADMAP is a concrete test here. The centrepiece
 * is a Set<string> oracle differential over 10k+ seeded frames: the naive
 * string-key implementation the package exists to replace is the ground truth
 * the zero-alloc table is proven against, enter/stay/exit identical every frame.
 * The seed is printed on any failure so a case replays deterministically.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOverlap, VERSION, FORMAT_VERSION } from '../Overlap.js';
import { FORMAT_VERSION as AABB_FORMAT_VERSION } from '@zakkster/lite-aabb';
import { FORMAT_VERSION as BVH_FORMAT_VERSION } from '@zakkster/lite-bvh';

// --- seeded PRNG (xorshift32) ------------------------------------------------

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

// Canonical pair key for the oracle. lo < hi by construction.
function key(a, b) {
    return a < b ? a + ',' + b : b + ',' + a;
}

// =============================================================================
// PACKAGE METADATA
// =============================================================================

test('VERSION is exported and in three-place sync', () => {
    assert.equal(VERSION, '1.1.0');
});

test('FORMAT_VERSION conformance: agrees with both peers (decision C1)', () => {
    assert.equal(FORMAT_VERSION, 1, 'lite-overlap FORMAT contract version is 1');
    assert.equal(
        FORMAT_VERSION, AABB_FORMAT_VERSION,
        'FORMAT skew: lite-overlap=' + FORMAT_VERSION + ' lite-aabb=' + AABB_FORMAT_VERSION,
    );
    assert.equal(
        FORMAT_VERSION, BVH_FORMAT_VERSION,
        'FORMAT skew: lite-overlap=' + FORMAT_VERSION + ' lite-bvh=' + BVH_FORMAT_VERSION,
    );
});

// =============================================================================
// CONSTRUCTION + OPTION VALIDATION (fail closed)
// =============================================================================

test('createOverlap requires an options object', () => {
    assert.throws(() => createOverlap(), TypeError);
    assert.throws(() => createOverlap(null), TypeError);
    assert.throws(() => createOverlap(42), TypeError);
});

test('maxPairs must be a positive integer', () => {
    assert.throws(() => createOverlap({ maxPairs: 0 }), RangeError);
    assert.throws(() => createOverlap({ maxPairs: -1 }), RangeError);
    assert.throws(() => createOverlap({ maxPairs: 1.5 }), RangeError);
    assert.throws(() => createOverlap({ maxPairs: 'x' }), RangeError);
});

test('unknown option key fails closed with a did-you-mean hint', () => {
    assert.throws(
        () => createOverlap({ maxPairs: 8, maxPair: 8 }),
        /unknown option "maxPair".*Did you mean "maxPairs"/,
    );
});

test('capacity is nextPow2(ceil(maxPairs / 0.7)) and load stays below 0.7', () => {
    // maxPairs=1000 -> ceil(1000/0.7)=1429 -> nextPow2 = 2048.
    const ov = createOverlap({ maxPairs: 1000 });
    assert.equal(ov.stats().capacity, 2048);
    assert.ok(1000 / 2048 < 0.7, 'logical cap keeps load below 0.7');
});

// =============================================================================
// ORDER INVARIANCE + IDEMPOTENCE
// =============================================================================

test('add(a,b) and add(b,a) are one pair; double-add yields one enter', () => {
    const ov = createOverlap({ maxPairs: 16 });
    const eA = new Int32Array(16), eB = new Int32Array(16);

    ov.begin();
    ov.add(3, 7);
    ov.add(7, 3); // reversed -- same pair
    ov.add(3, 7); // duplicate -- no-op
    ov.end();

    assert.equal(ov.pairCount(), 1, 'one live pair');
    const n = ov.drainEnter(eA, eB);
    assert.equal(n, 1, 'exactly one enter');
    assert.equal(key(eA[0], eB[0]), '3,7');
});

test('a === b is rejected (a pair with itself is not a pair)', () => {
    const ov = createOverlap({ maxPairs: 16 });
    ov.begin();
    ov.add(5, 5);
    ov.end();
    assert.equal(ov.pairCount(), 0);
    const eA = new Int32Array(16), eB = new Int32Array(16);
    assert.equal(ov.drainEnter(eA, eB), 0, 'no enter staged for a self-pair');
});

// =============================================================================
// LIFECYCLE SHAPES
// =============================================================================

test('appear, persist 100 frames, vanish => exactly one enter and one exit', () => {
    const ov = createOverlap({ maxPairs: 16 });
    const eA = new Int32Array(16), eB = new Int32Array(16);
    const xA = new Int32Array(16), xB = new Int32Array(16);

    let totalEnter = 0, totalExit = 0;
    for (let frame = 0; frame < 102; frame++) {
        ov.begin();
        if (frame < 101) ov.add(2, 9); // present frames 0..100, gone at 101
        ov.end();
        totalEnter += ov.drainEnter(eA, eB);
        totalExit += ov.drainExit(xA, xB);
    }

    assert.equal(totalEnter, 1, 'exactly one enter across the lifetime');
    assert.equal(totalExit, 1, 'exactly one exit across the lifetime');
});

test('vanish then return next frame => exit THEN enter, not a silent stay', () => {
    const ov = createOverlap({ maxPairs: 16 });
    const eA = new Int32Array(16), eB = new Int32Array(16);
    const xA = new Int32Array(16), xB = new Int32Array(16);

    // frame 0: appears
    ov.begin(); ov.add(1, 4); ov.end();
    assert.equal(ov.drainEnter(eA, eB), 1);
    assert.equal(ov.drainExit(xA, xB), 0);

    // frame 1: vanishes -> one exit, no enter
    ov.begin(); ov.end();
    assert.equal(ov.drainExit(xA, xB), 1, 'exit fires on the vanish frame');
    assert.equal(ov.drainEnter(eA, eB), 0);
    assert.equal(key(xA[0], xB[0]), '1,4');

    // frame 2: returns -> one enter (a fresh enter, NOT a stay)
    ov.begin(); ov.add(4, 1); ov.end();
    assert.equal(ov.drainEnter(eA, eB), 1, 'return is a fresh enter');
    assert.equal(ov.drainExit(xA, xB), 0);
    assert.equal(ov.stayCount(), 0, 'a returned pair is not counted as a stay');
});

test('stayCount = pairCount - enters this frame', () => {
    const ov = createOverlap({ maxPairs: 16 });

    ov.begin(); ov.add(1, 2); ov.add(3, 4); ov.end();
    assert.equal(ov.pairCount(), 2);
    assert.equal(ov.stayCount(), 0, 'both are new -> no stays');

    ov.begin(); ov.add(1, 2); ov.add(3, 4); ov.add(5, 6); ov.end();
    assert.equal(ov.pairCount(), 3);
    assert.equal(ov.stayCount(), 2, 'two persisted, one entered');
});

// =============================================================================
// D3 -- the 1-bit tag impossibility: no missed/spurious exit across many flips
// =============================================================================

test('D3: persistent pairs never spuriously exit across 200k tag flips', () => {
    const ov = createOverlap({ maxPairs: 64 });
    const eA = new Int32Array(64), eB = new Int32Array(64);
    const xA = new Int32Array(64), xB = new Int32Array(64);

    // A fixed set re-added every frame. begin() flips the tag every frame, so
    // this is 200k alternations of the 1-bit tag. If the tag ever mis-compared
    // (the AR-01/epoch-truncation failure shape), a persistent pair would
    // spuriously exit and re-enter. It provably cannot (decision D3).
    const FRAMES = 200000;
    for (let frame = 0; frame < FRAMES; frame++) {
        ov.begin();
        ov.add(10, 20);
        ov.add(30, 40);
        ov.add(50, 60);
        ov.end();
        const en = ov.drainEnter(eA, eB);
        const ex = ov.drainExit(xA, xB);
        if (frame === 0) {
            assert.equal(en, 3, 'all three enter on frame 0');
            assert.equal(ex, 0);
        } else if (en !== 0 || ex !== 0) {
            assert.fail('spurious delta at frame ' + frame + ': enter=' + en + ' exit=' + ex);
        }
    }
    assert.equal(ov.pairCount(), 3);
});

test('D3: a per-frame flicker fires exact enter/exit across many flips', () => {
    const ov = createOverlap({ maxPairs: 64 });
    const eA = new Int32Array(64), eB = new Int32Array(64);
    const xA = new Int32Array(64), xB = new Int32Array(64);

    let enters = 0, exits = 0;
    const FRAMES = 20000;
    for (let frame = 0; frame < FRAMES; frame++) {
        ov.begin();
        ov.add(1, 2);                 // persistent anchor
        if ((frame & 1) === 0) ov.add(7, 8); // present on even frames only
        ov.end();
        enters += ov.drainEnter(eA, eB);
        exits += ov.drainExit(xA, xB);
    }
    // anchor: 1 enter. flicker: enters on every even frame after the first
    // even appearance, exits on every odd frame. Over 20000 frames it appears
    // on 10000 even frames and disappears on 10000 odd frames.
    // enters = 1 (anchor) + 10000 (flicker) ; exits = 10000 (flicker, minus the
    // final one which has no following odd frame inside the loop? it does: the
    // last frame is odd (19999) so the frame-19998 appearance exits at 19999).
    assert.equal(enters, 1 + 10000, 'anchor enter plus one enter per even frame');
    assert.equal(exits, 10000, 'one exit per odd frame the flicker was gone');
});

// =============================================================================
// D4 -- capacity exhaustion is atomic and the table stays usable
// =============================================================================

test('table full: throws at the boundary, pairCount unchanged, table still usable', () => {
    const maxPairs = 8;
    const ov = createOverlap({ maxPairs });

    // Fill to exactly maxPairs distinct pairs in one frame.
    ov.begin();
    let id = 0;
    for (let i = 0; i < maxPairs; i++) {
        ov.add(id, id + 1);
        id += 2;
    }
    assert.equal(ov.pairCount(), maxPairs, 'table is exactly full');

    // The (maxPairs+1)-th distinct pair throws with the remedy message.
    assert.throws(
        () => ov.add(1000, 1001),
        /lite-overlap: pair table full \(8\)\. Raise maxPairs\./,
    );
    // Atomic: the throw wrote nothing.
    assert.equal(ov.pairCount(), maxPairs, 'pairCount unchanged after the throw');

    // Re-adding an existing pair (a hit) still works while full.
    ov.add(0, 1);
    assert.equal(ov.pairCount(), maxPairs);

    // Remove-then-add: let one pair exit next frame, then a new pair fits.
    ov.begin();
    // re-add all but the first pair, so pair (0,1) exits.
    id = 2;
    for (let i = 1; i < maxPairs; i++) {
        ov.add(id, id + 1);
        id += 2;
    }
    ov.end();
    assert.equal(ov.pairCount(), maxPairs - 1, 'one pair exited, room freed');

    // Now a fresh pair fits without throwing.
    ov.begin();
    id = 2;
    for (let i = 1; i < maxPairs; i++) {
        ov.add(id, id + 1);
        id += 2;
    }
    ov.add(1000, 1001); // the previously-rejected pair now succeeds
    ov.end();
    assert.equal(ov.pairCount(), maxPairs, 'remove-then-add succeeds; table usable');
});

// =============================================================================
// PROBE HIGH-WATER bounded under 0.7 load
// =============================================================================

test('probe high-water stays bounded under 0.7 load factor', () => {
    const maxPairs = 4096;
    const ov = createOverlap({ maxPairs });
    const rng = xorshift32(0xC0FFEE);

    ov.begin();
    let added = 0;
    const seen = new Set();
    while (added < maxPairs) {
        const a = rng() % 100000;
        const b = rng() % 100000;
        if (a === b) continue;
        const k = key(a, b);
        if (seen.has(k)) continue;
        seen.add(k);
        ov.add(a, b);
        added++;
    }
    ov.end();

    const st = ov.stats();
    assert.ok(st.loadFactor <= 0.7, 'load factor at cap is <= 0.7, got ' + st.loadFactor);
    // A concrete bound so a future hash change cannot quietly lengthen chains.
    // Linear probing at 0.7 load has short chains; this pins it well under any
    // pathological regression.
    assert.ok(
        st.probeHighWater < 40,
        'probe high-water bounded, got ' + st.probeHighWater,
    );
});

// =============================================================================
// clear() -- silent, no realloc, no exits (decision C2)
// =============================================================================

test('clear() empties silently and emits no exits; empty frame flushes exits', () => {
    const ov = createOverlap({ maxPairs: 16 });
    const xA = new Int32Array(16), xB = new Int32Array(16);

    ov.begin(); ov.add(1, 2); ov.add(3, 4); ov.end();
    assert.equal(ov.pairCount(), 2);
    const capBefore = ov.stats().capacity;

    ov.clear();
    assert.equal(ov.pairCount(), 0, 'table emptied');
    assert.equal(ov.stats().capacity, capBefore, 'no realloc: capacity unchanged');
    assert.equal(ov.drainExit(xA, xB), 0, 'clear() stages no exits');

    // The documented teardown-with-exits path: one empty frame, then clear.
    ov.begin(); ov.add(1, 2); ov.add(3, 4); ov.end();
    ov.begin(); ov.end(); // empty frame -> both exit through the normal lifecycle
    assert.equal(ov.drainExit(xA, xB), 2, 'empty frame fires exit for every live pair');
    ov.clear();
    assert.equal(ov.pairCount(), 0);
});

// =============================================================================
// THE ORACLE DIFFERENTIAL -- the whole reason the package exists
// =============================================================================

test('lifecycle matches a Set<string> oracle over 12k fuzzed frames', () => {
    const SEED = (process.env.OVERLAP_SEED
        ? (parseInt(process.env.OVERLAP_SEED, 10) >>> 0)
        : 0x9e3779b9) >>> 0;
    const rng = xorshift32(SEED);

    const N = 48;             // id pool -> up to N*(N-1)/2 distinct pairs
    const MAX_PAIRS = N * N;  // comfortably above any live count
    const FRAMES = 12000;

    const ov = createOverlap({ maxPairs: MAX_PAIRS });
    const eA = new Int32Array(MAX_PAIRS), eB = new Int32Array(MAX_PAIRS);
    const xA = new Int32Array(MAX_PAIRS), xB = new Int32Array(MAX_PAIRS);

    // Oracle: the set of pair keys live LAST frame.
    let prev = new Set();
    // Reusable working array of this frame's pairs (as [a,b] flat pushes).
    const curKeys = new Set();

    for (let frame = 0; frame < FRAMES; frame++) {
        curKeys.clear();

        // Evolve the live set: keep some of last frame's pairs, add some new.
        // Persist ~70% of previous pairs (disappearance), then add new appears.
        for (const k of prev) {
            if ((rng() % 100) < 70) curKeys.add(k);
        }
        const appears = rng() % 12;
        for (let i = 0; i < appears; i++) {
            const a = rng() % N;
            const b = rng() % N;
            if (a === b) continue;
            curKeys.add(key(a, b));
        }

        // Oracle delta.
        const oracleEnter = new Set();
        const oracleExit = new Set();
        for (const k of curKeys) if (!prev.has(k)) oracleEnter.add(k);
        for (const k of prev) if (!curKeys.has(k)) oracleExit.add(k);
        const oracleStay = curKeys.size - oracleEnter.size;

        // Drive the table. Feed pairs in a shuffled-ish order with order flips
        // and occasional duplicates, to exercise canonicalization + idempotence.
        ov.begin();
        for (const k of curKeys) {
            const comma = k.indexOf(',');
            const a = parseInt(k.slice(0, comma), 10);
            const b = parseInt(k.slice(comma + 1), 10);
            if ((rng() & 1) === 0) ov.add(a, b); else ov.add(b, a);
            if ((rng() % 7) === 0) ov.add(b, a); // duplicate within frame
        }
        ov.end();

        // Compare the table's delta to the oracle.
        const en = ov.drainEnter(eA, eB);
        const ex = ov.drainExit(xA, xB);

        const gotEnter = new Set();
        for (let i = 0; i < en; i++) gotEnter.add(key(eA[i], eB[i]));
        const gotExit = new Set();
        for (let i = 0; i < ex; i++) gotExit.add(key(xA[i], xB[i]));

        if (gotEnter.size !== oracleEnter.size || gotExit.size !== oracleExit.size ||
            ov.pairCount() !== curKeys.size || ov.stayCount() !== oracleStay) {
            assert.fail(
                'oracle mismatch at frame ' + frame + ' | SEED=' + SEED +
                ' | enter got/exp ' + gotEnter.size + '/' + oracleEnter.size +
                ' exit got/exp ' + gotExit.size + '/' + oracleExit.size +
                ' pairCount got/exp ' + ov.pairCount() + '/' + curKeys.size +
                ' stay got/exp ' + ov.stayCount() + '/' + oracleStay,
            );
        }
        for (const k of oracleEnter) {
            if (!gotEnter.has(k)) assert.fail('missing enter ' + k + ' frame ' + frame + ' SEED=' + SEED);
        }
        for (const k of oracleExit) {
            if (!gotExit.has(k)) assert.fail('missing exit ' + k + ' frame ' + frame + ' SEED=' + SEED);
        }

        // Advance the oracle.
        prev = new Set(curKeys);
    }
});
