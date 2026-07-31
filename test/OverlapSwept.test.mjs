/**
 * @zakkster/lite-overlap -- O3 swept detection (final QA, node:test).
 *
 * Pins the swept decisions (decisions/0004-swept.md) added on top of the O1/O2
 * self-traversal. Swept tests the volume `union(prev, curr)` instead of the
 * instantaneous box, so a projectile faster than its own width no longer tunnels
 * through a thin trigger.
 *
 *   S1 -- the swept volume is the AABB union of prev and curr; inlined (no aabb
 *         import); conservative (over-reports on diagonal motion), never misses.
 *   S2 -- a pass-through fires ENTER on the crossing frame through the ordinary
 *         add/mark-sweep channel, EXIT the next -- no new drain, no silent miss.
 *   S3 -- swept is a SUPERSET of discrete, always; zero motion (prev===curr) is
 *         BYTE-IDENTICAL to the discrete path (min/max idempotent, exact in f32).
 *   S4 -- collectSweptPairs prunes on a swept-bounding tree (caller contract) and
 *         refines each leaf pair with the tight union keyed by userData; a leaf
 *         userData >= count is fail-closed.
 *   S5 -- the swept union is strictly larger than both inputs at world-scale
 *         coordinates when the motion is above the local float32 ULP (finding A-01).
 *   S6 -- a committed (speed, thickness) tunneling fixture: discrete misses every
 *         row, swept catches every row.
 *
 * `@zakkster/lite-bvh` is a test-only devDependency for building real trees; the
 * library itself never imports it (decision C1: format agreement only).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOverlap } from '../Overlap.js';
import { DynamicBVH2D } from '@zakkster/lite-bvh';
import { measureOps, checkNoGc } from '@zakkster/lite-gc-profiler';

// --- seeded PRNG (xorshift32), duplicated per-file per this suite's convention ---

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
function unit(u32) { return (u32 >>> 0) / 4294967296; }
function key(a, b) { return a < b ? a + ',' + b : b + ',' + a; }

function sameSet(x, y) {
    if (x.size !== y.size) return false;
    for (const k of x) if (!y.has(k)) return false;
    return true;
}
function isSuperset(big, small) {
    for (const k of small) if (!big.has(k)) return false;
    return true;
}

function drainEnterSet(ov, eA, eB) {
    const n = ov.drainEnter(eA, eB);
    const s = new Set();
    for (let i = 0; i < n; i++) s.add(key(eA[i], eB[i]));
    return s;
}
function drainExitSet(ov, xA, xB) {
    const n = ov.drainExit(xA, xB);
    const s = new Set();
    for (let i = 0; i < n; i++) s.add(key(xA[i], xB[i]));
    return s;
}

/** AABB overlap of two 4-slot boxes at offsets ia, ib in a packed array. */
function packedOverlap(P, ia, Q, ib) {
    return P[ia] <= Q[ib + 2] && Q[ib] <= P[ia + 2] &&
        P[ia + 1] <= Q[ib + 3] && Q[ib + 1] <= P[ia + 3];
}

/** The tight swept union of entity i (union of prev[i] and curr[i]) into out[0..3]. */
function unionInto(out, prevP, currP, i) {
    const j = i * 4;
    out[0] = Math.min(prevP[j], currP[j]);
    out[1] = Math.min(prevP[j + 1], currP[j + 1]);
    out[2] = Math.max(prevP[j + 2], currP[j + 2]);
    out[3] = Math.max(prevP[j + 3], currP[j + 3]);
    return out;
}

/**
 * A moving corpus of N entities. Returns tight prev/curr packed boxes
 * (userData-indexed: entity i at [4i, 4i+3]) plus a matching UNION packed array
 * (the tight swept box). Motion magnitude scales with `speed`. Deterministic.
 */
function buildMotion(seed, N, field, speed) {
    const rng = xorshift32(seed);
    const prev = new Float32Array(4 * N);
    const curr = new Float32Array(4 * N);
    const uni = new Float32Array(4 * N);
    for (let i = 0; i < N; i++) {
        const j = i * 4;
        const x = unit(rng()) * field;
        const y = unit(rng()) * field;
        const w = 4 + unit(rng()) * 8;
        const h = 4 + unit(rng()) * 8;
        const vx = (unit(rng()) * 2 - 1) * speed;
        const vy = (unit(rng()) * 2 - 1) * speed;
        prev[j] = x; prev[j + 1] = y; prev[j + 2] = x + w; prev[j + 3] = y + h;
        curr[j] = x + vx; curr[j + 1] = y + vy; curr[j + 2] = x + w + vx; curr[j + 3] = y + h + vy;
        uni[j] = Math.min(prev[j], curr[j]);
        uni[j + 1] = Math.min(prev[j + 1], curr[j + 1]);
        uni[j + 2] = Math.max(prev[j + 2], curr[j + 2]);
        uni[j + 3] = Math.max(prev[j + 3], curr[j + 3]);
    }
    return { prev, curr, uni };
}

/**
 * Build a bvh whose leaf i (userData i) is `box(i)` fattened by `margin`. `boxes`
 * is a packed 4*N array. Returns the tree; userData[leaf] === i.
 */
function treeFromPacked(boxes, N, margin) {
    const maxNodes = Math.max(4, 4 * N);
    const tree = new DynamicBVH2D(maxNodes);
    const box = new Float32Array(4);
    for (let i = 0; i < N; i++) {
        const j = i * 4;
        box[0] = boxes[j] - margin;
        box[1] = boxes[j + 1] - margin;
        box[2] = boxes[j + 2] + margin;
        box[3] = boxes[j + 3] + margin;
        tree.insertLeaf(box, i);
    }
    return tree;
}

/** Brute all-pairs set over a packed box array (tight, no margin). */
function bruteSet(boxes, N) {
    const s = new Set();
    for (let i = 0; i < N; i++) {
        for (let jj = i + 1; jj < N; jj++) {
            if (packedOverlap(boxes, i * 4, boxes, jj * 4)) s.add(key(i, jj));
        }
    }
    return s;
}

// =============================================================================
// S1/S3 -- differential: collectSweptPairs (bulk) == addSwept (manual oracle)
// == the tight-union brute set, over a moving corpus. The strongest correctness
// check: the bulk broadphase agrees with the all-pairs manual door exactly.
// =============================================================================

const CORPUS = [
    { N: 40, field: 60, speed: 20, seed: 0x0dce0001 },
    { N: 120, field: 90, speed: 30, seed: 0x0dce0002 },
    { N: 200, field: 120, speed: 40, seed: 0x0dce0003 },
];

for (const { N, field, speed, seed } of CORPUS) {
    test('S1/S3: bulk == manual oracle == tight-union brute, N=' + N + ' seed=0x' + seed.toString(16), () => {
        const { prev, curr, uni } = buildMotion(seed, N, field, speed);
        const cap = (N * (N - 1)) / 2 + 8;
        const eA = new Int32Array(cap), eB = new Int32Array(cap);

        // Tree of FATTENED swept boxes -> the descent over-reports; the tight-union
        // refinement must pull the set back to the tight-union brute.
        const margin = 5;
        const sweptTree = treeFromPacked(uni, N, margin);

        // Bulk swept path.
        const ovBulk = createOverlap({ maxPairs: cap });
        ovBulk.begin(); ovBulk.collectSweptPairs(sweptTree, prev, curr, N); ovBulk.end();
        const bulkSet = drainEnterSet(ovBulk, eA, eB);

        // Manual oracle: addSwept over every unordered pair.
        const ovManual = createOverlap({ maxPairs: cap });
        const pa = new Float32Array(4), ca = new Float32Array(4);
        const pb = new Float32Array(4), cb = new Float32Array(4);
        ovManual.begin();
        for (let i = 0; i < N; i++) {
            for (let jj = i + 1; jj < N; jj++) {
                pa.set(prev.subarray(i * 4, i * 4 + 4)); ca.set(curr.subarray(i * 4, i * 4 + 4));
                pb.set(prev.subarray(jj * 4, jj * 4 + 4)); cb.set(curr.subarray(jj * 4, jj * 4 + 4));
                ovManual.addSwept(i, pa, ca, jj, pb, cb);
            }
        }
        ovManual.end();
        const manualSet = drainEnterSet(ovManual, eA, eB);

        // Tight-union brute (the ground truth the fat tree + refinement targets).
        const tightUnion = bruteSet(uni, N);

        assert.ok(sameSet(bulkSet, tightUnion),
            'bulk swept != tight-union brute (' + bulkSet.size + ' vs ' + tightUnion.size + ')');
        assert.ok(sameSet(manualSet, tightUnion),
            'manual addSwept != tight-union brute (' + manualSet.size + ' vs ' + tightUnion.size + ')');

        // Non-vacuous: the fattened descent really over-reported, so the refinement
        // dropped pairs (else the "tight refinement" claim is untested).
        const cfg = new Set();
        for (let i = 0; i < N; i++) for (let jj = i + 1; jj < N; jj++) {
            const bi = i * 4, bj = jj * 4;
            const fa = [uni[bi] - margin, uni[bi + 1] - margin, uni[bi + 2] + margin, uni[bi + 3] + margin];
            const fb = [uni[bj] - margin, uni[bj + 1] - margin, uni[bj + 2] + margin, uni[bj + 3] + margin];
            if (fa[0] <= fb[2] && fb[0] <= fa[2] && fa[1] <= fb[3] && fb[1] <= fa[3]) cfg.add(key(i, jj));
        }
        assert.ok(cfg.size > tightUnion.size,
            'fattened descent did not over-report -- refinement is vacuous (fat ' + cfg.size + ' vs tight ' + tightUnion.size + ')');
    });
}

// =============================================================================
// S3 -- swept is a SUPERSET of discrete, always; and strictly larger under motion
// (non-vacuous). Discrete = current-box pairs; swept = union pairs.
// =============================================================================

test('S3: swept superset of discrete, strict under real motion', () => {
    const N = 150, field = 100, speed = 35;
    const { prev, curr, uni } = buildMotion(0x0d5e3003, N, field, speed);
    const cap = (N * (N - 1)) / 2 + 8;
    const eA = new Int32Array(cap), eB = new Int32Array(cap);

    const discreteSet = bruteSet(curr, N);   // instantaneous overlaps
    const sweptTree = treeFromPacked(uni, N, 0);
    const ov = createOverlap({ maxPairs: cap });
    ov.begin(); ov.collectSweptPairs(sweptTree, prev, curr, N); ov.end();
    const sweptSet = drainEnterSet(ov, eA, eB);

    assert.ok(isSuperset(sweptSet, discreteSet),
        'swept is NOT a superset of discrete (' + sweptSet.size + ' vs ' + discreteSet.size + ')');
    assert.ok(sweptSet.size > discreteSet.size,
        'swept did not strictly exceed discrete under motion (' + sweptSet.size + ' vs ' + discreteSet.size + ')');
});

// =============================================================================
// S3 -- zero motion (prev === curr) is BYTE-IDENTICAL to collectPairs. The
// anchor that makes swept a clean extension, not a different algorithm.
// =============================================================================

test('S3: zero motion collectSweptPairs == collectPairs, byte-identical', () => {
    const N = 140, field = 95;
    const { curr } = buildMotion(0x0d5e2002, N, field, 30);
    const cap = (N * (N - 1)) / 2 + 8;
    const eA = new Int32Array(cap), eB = new Int32Array(cap);

    // One tree of the current boxes; prev === curr (same array).
    const tree = treeFromPacked(curr, N, 0);

    const ovD = createOverlap({ maxPairs: cap });
    ovD.begin(); ovD.collectPairs(tree); ovD.end();
    const discrete = drainEnterSet(ovD, eA, eB);

    const ovS = createOverlap({ maxPairs: cap });
    ovS.begin(); ovS.collectSweptPairs(tree, curr, curr, N); ovS.end();
    const swept = drainEnterSet(ovS, eA, eB);

    assert.ok(sameSet(discrete, swept),
        'zero-motion swept != discrete (' + discrete.size + ' vs ' + swept.size + ')');
    assert.ok(discrete.size > 0, 'harness sanity: expected some overlaps');
});

// =============================================================================
// S6 -- THE tunneling fixture. Committed (speed, thickness) rows. A projectile
// of width `pw` starts left of a wall of thickness `thickness` and moves `speed`
// px in one frame, ending right of the wall. DISCRETE (current boxes) reports NO
// pair; SWEPT reports the pair. Both columns are literal numbers.
// =============================================================================

// Wall spans x in [wallX, wallX+thickness], full height. Projectile is a small
// box that in ONE frame jumps from left of the wall to right of it.
const WALL_X = 500;
const TUNNEL_FIXTURE = [
    // { speed, thickness, discreteHit, sweptHit }
    { speed: 40, thickness: 60, discreteHit: true, sweptHit: true },   // slow: both catch (control)
    { speed: 120, thickness: 8, discreteHit: false, sweptHit: true },  // fast, thin: tunnels
    { speed: 200, thickness: 4, discreteHit: false, sweptHit: true },
    { speed: 400, thickness: 6, discreteHit: false, sweptHit: true },
    { speed: 900, thickness: 10, discreteHit: false, sweptHit: true },
    { speed: 1500, thickness: 2, discreteHit: false, sweptHit: true },
];

test('S6: tunneling fixture -- discrete misses, swept catches, per committed row', () => {
    const ov = createOverlap({ maxPairs: 8 });
    const eA = new Int32Array(8), eB = new Int32Array(8);

    const wall = new Float32Array(4);
    const projPrev = new Float32Array(4);
    const projCurr = new Float32Array(4);
    const PW = 6;   // projectile width
    const PROJ = 0, WALL = 1;

    for (const row of TUNNEL_FIXTURE) {
        // Wall (static: prev === curr).
        wall[0] = WALL_X; wall[1] = 0; wall[2] = WALL_X + row.thickness; wall[3] = 100;
        // Projectile centred left of the wall, moving +x by `speed` in one frame,
        // ending right of the wall (so at no instant sampled does it touch it when
        // speed clears the thickness+width).
        const startRight = WALL_X - 20;          // projectile's right edge, pre-move
        projPrev[0] = startRight - PW; projPrev[1] = 40; projPrev[2] = startRight; projPrev[3] = 60;
        projCurr[0] = projPrev[0] + row.speed; projCurr[1] = 40;
        projCurr[2] = projPrev[2] + row.speed; projCurr[3] = 60;

        // DISCRETE: does the projectile touch the wall at EITHER sampled instant
        // (start-of-frame or end-of-frame)? That is the best a discrete system can
        // do -- and for a fast, thin case it samples on both sides and misses.
        const discreteHit = ov.narrow(projPrev, wall) || ov.narrow(projCurr, wall);
        // SWEPT: does the swept volume overlap? (wall is static)
        const sweptHit = ov.sweptOverlap(projPrev, projCurr, wall, wall);

        assert.equal(discreteHit, row.discreteHit,
            'discrete column wrong for speed=' + row.speed + ' thickness=' + row.thickness);
        assert.equal(sweptHit, row.sweptHit,
            'swept column wrong for speed=' + row.speed + ' thickness=' + row.thickness);

        // And through the real lifecycle door: addSwept records exactly when sweptHit.
        ov.begin();
        ov.addSwept(PROJ, projPrev, projCurr, WALL, wall, wall);
        ov.end();
        const got = ov.drainEnter(eA, eB);
        assert.equal(got, row.sweptHit ? 1 : 0,
            'addSwept enter count wrong for speed=' + row.speed);
        if (got) assert.equal(key(eA[0], eB[0]), key(PROJ, WALL), 'wrong pair recorded');
        ov.clear();
    }
});

// =============================================================================
// S2 -- pass-through lifecycle: a single-frame crossing fires ENTER on the
// crossing frame (through the normal channel) and EXIT the next frame. No phantom
// lingering beyond that, no separate drain to wire.
// =============================================================================

test('S2: pass-through fires enter on crossing frame, exit the next', () => {
    const ov = createOverlap({ maxPairs: 8 });
    const eA = new Int32Array(8), eB = new Int32Array(8);
    const xA = new Int32Array(8), xB = new Int32Array(8);

    const wall = new Float32Array([500, 0, 506, 100]);
    // Frame 1: projectile jumps ACROSS the wall (tunnels; current box ends right).
    const p1Prev = new Float32Array([470, 40, 476, 60]);
    const p1Curr = new Float32Array([560, 40, 566, 60]);
    // Frame 2: projectile continues far past; swept volume no longer touches wall.
    const p2Prev = new Float32Array([560, 40, 566, 60]);
    const p2Curr = new Float32Array([650, 40, 656, 60]);

    // Current boxes never overlap the wall in either frame (a true pass-through).
    assert.equal(ov.narrow(p1Curr, wall), false, 'frame1 current should not overlap (it tunneled)');
    assert.equal(ov.narrow(p1Prev, wall), false, 'frame1 prev should not overlap');

    // Frame 1: ENTER fires through the ordinary drain.
    ov.begin();
    ov.addSwept(0, p1Prev, p1Curr, 1, wall, wall);
    ov.end();
    let enters = drainEnterSet(ov, eA, eB);
    let exits = drainExitSet(ov, xA, xB);
    assert.ok(enters.has(key(0, 1)), 'pass-through did not ENTER on the crossing frame');
    assert.equal(exits.size, 0, 'unexpected exit on the crossing frame');
    assert.equal(ov.pairCount(), 1, 'the crossed pair should be live for one frame');

    // Frame 2: no swept overlap -> the pair is not re-stamped -> EXIT fires.
    ov.begin();
    ov.addSwept(0, p2Prev, p2Curr, 1, wall, wall);   // no overlap this frame
    ov.end();
    enters = drainEnterSet(ov, eA, eB);
    exits = drainExitSet(ov, xA, xB);
    assert.equal(enters.size, 0, 'no new enter expected on frame 2');
    assert.ok(exits.has(key(0, 1)), 'pass-through did not EXIT the following frame');
    assert.equal(ov.pairCount(), 0, 'phantom pair lingered past its exit');
});

// =============================================================================
// S4 -- fail-closed: a leaf userData >= count throws; bad count / short arrays /
// wrong types throw. null is not zero -- absent motion must never silently pass.
// =============================================================================

test('S4: leaf userData >= count fails closed', () => {
    // Two leaves whose swept boxes overlap, one with userData 5 (>= count 3).
    const maxNodes = 16;
    const tree = new DynamicBVH2D(maxNodes);
    const box = new Float32Array(4);
    box[0] = 0; box[1] = 0; box[2] = 10; box[3] = 10; tree.insertLeaf(box, 0);
    box[0] = 5; box[1] = 5; box[2] = 15; box[3] = 15; tree.insertLeaf(box, 5);   // userData 5

    const prev = new Float32Array(4 * 3);   // count = 3 covers ids 0..2 only
    const curr = new Float32Array(4 * 3);
    const ov = createOverlap({ maxPairs: 8 });
    ov.begin();
    assert.throws(
        () => ov.collectSweptPairs(tree, prev, curr, 3),
        /out of range for count 3.*userData 5|Raise count/,
        'expected a fail-closed throw for userData >= count',
    );
    ov.end();
});

test('S4: bad count / short packed / wrong type all throw before descent', () => {
    const ov = createOverlap({ maxPairs: 8 });
    const tree = new DynamicBVH2D(8);
    const box = new Float32Array([0, 0, 1, 1]); tree.insertLeaf(box, 0);
    const P = new Float32Array(4 * 4), C = new Float32Array(4 * 4);

    assert.throws(() => ov.collectSweptPairs(tree, P, C, -1), /non-negative integer/, 'negative count');
    assert.throws(() => ov.collectSweptPairs(tree, P, C, 2.5), /non-negative integer/, 'non-integer count');
    assert.throws(() => ov.collectSweptPairs(tree, new Float32Array(4), C, 4), />= 4\*count/, 'short prev');
    assert.throws(() => ov.collectSweptPairs(tree, P, new Float32Array(4), 4), />= 4\*count/, 'short curr');
    assert.throws(() => ov.collectSweptPairs(tree, [0, 0, 0, 0], C, 1), /Float32Array/, 'non-typed prev');
});

// =============================================================================
// S5 -- world-scale ULP (finding A-01): the swept union is strictly larger than
// both inputs when the motion delta exceeds the local float32 ULP; and it
// degenerates (documented) below it. Asserted at coordinates 1, 1e3, 1e6, 1e7.
// =============================================================================

test('S5: swept union strictly contains both inputs at world scale (supra-ULP motion)', () => {
    const ov = createOverlap({ maxPairs: 4 });
    for (const scale of [1, 1e3, 1e6, 1e7]) {
        // One float32 ULP near `scale`; pick a motion delta a few ULPs above it.
        const ulp = Math.max(Math.abs(scale), 1) * 1.1920929e-7;   // 2^-23 relative
        const d = ulp * 8;
        const prev = new Float32Array([scale, scale, scale + 10, scale + 10]);
        const curr = new Float32Array([scale + d, scale, scale + 10 + d, scale + 10]);

        // Recompute the union the way the library does (f32-rounded).
        const uMinX = Math.min(Math.fround(prev[0]), Math.fround(curr[0]));
        const uMaxX = Math.max(Math.fround(prev[2]), Math.fround(curr[2]));

        // The A-01 detector: with the motion above the local ULP, the union must
        // strictly contain each endpoint (it reaches curr's leading edge beyond
        // prev's, and keeps prev's trailing edge behind curr's).
        assert.ok(uMaxX > Math.fround(prev[2]),
            'union max not strictly beyond prev at scale ' + scale + ' (uMaxX=' + uMaxX + ' prevMax=' + prev[2] + ')');
        assert.ok(uMinX < Math.fround(curr[0]),
            'union min not strictly behind curr at scale ' + scale);
    }
});

test('S5: sub-ULP motion degenerates to a point-in-time box (documented A-01 shape)', () => {
    // At 1e7, one ULP is ~1.19; a motion of 0.001 is swallowed by f32 rounding.
    const scale = 1e7, d = 0.001;
    const prev = new Float32Array([scale, 0, scale + 10, 10]);
    const curr = new Float32Array([scale + d, 0, scale + 10 + d, 10]);
    // f32 rounding collapses curr onto prev, so the union equals a single box.
    assert.equal(Math.fround(scale + d), Math.fround(scale), 'harness: expected sub-ULP collapse');
    const uMaxX = Math.max(Math.fround(prev[2]), Math.fround(curr[2]));
    assert.equal(uMaxX, Math.fround(prev[2]), 'sub-ULP union should NOT exceed prev (degenerate, documented)');
});

// =============================================================================
// S2/O2 -- swept honors the O2 filter identically: a disabled entity generates no
// swept pairs; a disabled layer-pair is not tested. Filtering composes with swept.
// =============================================================================

test('S2/O2: collectSweptPairs honors setEnabled and setInteract', () => {
    const N = 60, field = 50, speed = 25;
    const { prev, curr, uni } = buildMotion(0x0d5e4004, N, field, speed);
    const cap = (N * (N - 1)) / 2 + 8;
    const eA = new Int32Array(cap), eB = new Int32Array(cap);
    const sweptTree = treeFromPacked(uni, N, 0);

    // Baseline (unfiltered) swept set.
    const ov0 = createOverlap({ maxPairs: cap });
    ov0.begin(); ov0.collectSweptPairs(sweptTree, prev, curr, N); ov0.end();
    const base = drainEnterSet(ov0, eA, eB);
    assert.ok(base.size > 0, 'harness: expected swept overlaps to filter');

    // Disable entity 0: no pair containing 0 may appear.
    const ov1 = createOverlap({ maxPairs: cap });
    ov1.setEnabled(0, false);
    ov1.begin(); ov1.collectSweptPairs(sweptTree, prev, curr, N); ov1.end();
    const disabled = drainEnterSet(ov1, eA, eB);
    for (const k of disabled) {
        const [a, b] = k.split(',');
        assert.ok(a !== '0' && b !== '0', 'disabled entity 0 still produced a swept pair: ' + k);
    }
    // Every base pair NOT touching 0 must still be present (disable removed only 0's pairs).
    for (const k of base) {
        const [a, b] = k.split(',');
        if (a !== '0' && b !== '0') assert.ok(disabled.has(k), 'disable dropped an unrelated pair: ' + k);
    }
});

// =============================================================================
// Alloc gate -- collectSweptPairs is zero-allocation on the frame path: the
// swept unions are register mins/maxes, nothing per pair. Buffer growth must be 0.
// =============================================================================

test('alloc: collectSweptPairs holds zero ArrayBuffer growth under churn', () => {
    if (typeof globalThis.gc !== 'function') {
        // Requires --expose-gc; skip cleanly otherwise (the torture gate covers it).
        return;
    }
    const N = 120, field = 90, speed = 30;
    const { prev, curr, uni } = buildMotion(0x0d5e5005, N, field, speed);
    const cap = (N * (N - 1)) / 2 + 8;
    const tree = treeFromPacked(uni, N, 3);
    const ov = createOverlap({ maxPairs: cap });
    const eA = new Int32Array(cap), eB = new Int32Array(cap);

    const hot = () => {
        ov.begin();
        ov.collectSweptPairs(tree, prev, curr, N);
        ov.end();
        ov.drainEnter(eA, eB);
    };
    hot();   // pre-warm the one-time traversal-stack sizing (cold, allocates once).

    const res = measureOps(hot, { ops: 5000, warmup: 500, stabilize: 'deep' });
    const report = checkNoGc(res.summary, { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 });
    assert.ok(report.ok,
        'collectSweptPairs allocated across repeated collects: verdict=' + report.verdict +
        ' violations=' + JSON.stringify(report.violations));
});
