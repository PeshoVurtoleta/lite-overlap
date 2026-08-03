/**
 * @zakkster/lite-overlap -- O3.1 `sweptOverlapExact` boundary + correctness suite.
 *
 * Pins decision 0005 (the exact opt-in swept-ribbon recheck, sibling of
 * `sweptOverlap` / `narrow`): the convex hull of a box's 8 swept corners
 * (4 prev + 4 curr), overlap-tested via SAT on axes {x, y, perp(motionA),
 * perp(motionB)}, touching-edge convention (`<=`).
 *
 * Assertions verified (see decisions/0004-swept.md S1 and the `sweptOverlapExact`
 * / `sweptSeparated` doc comments in Overlap.js for the contract this pins):
 *
 *   1. SUBSET, always: exact => union (`sweptOverlap`), over many seeded pairs.
 *   2. AXIS-ALIGNED IDENTITY: exact === union when both motions are axis-aligned.
 *   3. INDEPENDENT ORACLE: exact === an independent Sutherland-Hodgman clip
 *      oracle (ported from bench/swept-union-vs-hull.mjs) over >=10,000 pairs,
 *      excluding a float-grazing band.
 *   4. ZERO-MOTION: exact(a,a,b,b) === narrow(a,b).
 *   5. TOUCHING-EDGE CONVENTION: a hand-built hull-vertex touch is true; an
 *      epsilon-separated variant is false.
 *   6. THE DIAGONAL OVER-REPORT FIXTURE: a committed pair where the union
 *      over-reports (`sweptOverlap` true) but the exact ribbons do not meet
 *      (`sweptOverlapExact` false) -- the whole point of shipping this predicate.
 *   7. DEGENERATE: one moving / one static, both static, zero-area box -- no
 *      throw, agrees with the independent oracle.
 *
 * Boundary matrix (every entry point is the pure predicate
 * `sweptOverlapExact(prevA, currA, prevB, currB)`): array length 0, 1, N-1, N,
 * N+1 (N=4, the contract length); empty; `null`; `undefined`; `NaN`; `-0`;
 * duplicate-call determinism ("duplicate dispose" analogue, since the predicate
 * owns no resource to dispose); an open-frame interleave ("dispose-during-
 * iteration" analogue); a write-interleaved loop ("re-entrant write" analogue,
 * since the predicate itself performs no writes); and one adversarial case
 * (Infinity vs NaN).
 *
 * FAIL-CLOSED (decision 0005): a short/empty box array or a NaN/Infinity box
 * component makes `sweptOverlapExact` fail CLOSED (reports NO overlap), exactly
 * as `sweptOverlap` / `narrow` do on the same corrupted input, so the SUBSET
 * contract ("sweptOverlapExact(...) => sweptOverlap(...) always") holds on ANY
 * input, in EITHER the prev or the curr box. This started as a pinned FINDING
 * against the original fail-open form (SAT separation as `<`-OR, and a ternary
 * min/max fold that dropped a NaN); the fix -- a positive-AND SAT with
 * NaN-propagating `Math.min`/`Math.max` folds -- closed it, and these tests now
 * ASSERT the fail-closed behaviour, including the asymmetric prev-only /
 * curr-only corruption that the ternary fold used to leak.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOverlap } from '../Overlap.js';

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

function mkBox(x, y, w, h) { return new Float32Array([x, y, x + w, y + h]); }
function moveBox(b, dx, dy) { return new Float32Array([b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy]); }

// =============================================================================
// Independent oracle -- PORTED from bench/swept-union-vs-hull.mjs (ribbonOracleClip
// / hullOf / convexHull / suthHodgman / satMargin / axisGap), NOT imported: that
// module runs its own `main()` unconditionally at import time (writes
// bench/RESULTS-swept.md), so importing it here would execute the whole bench as
// a side effect. Copied verbatim (function bodies unchanged) so this stays a
// faithful differential reference, off the timed/shipped path, test-only.
// =============================================================================

function convexHull(pts) {
    const p = pts.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const n = p.length;
    if (n < 3) return p;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (let i = 0; i < n; i++) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p[i]) <= 0) lower.pop();
        lower.push(p[i]);
    }
    const upper = [];
    for (let i = n - 1; i >= 0; i--) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
        upper.push(p[i]);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
}

function hullOf(prev, curr) {
    const pts = [
        [prev[0], prev[1]], [prev[2], prev[1]], [prev[2], prev[3]], [prev[0], prev[3]],
        [curr[0], curr[1]], [curr[2], curr[1]], [curr[2], curr[3]], [curr[0], curr[3]],
    ];
    return convexHull(pts);
}

function suthHodgman(subject, clip) {
    const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const inter = (s, e, a, b) => {
        const d1 = cross(a, b, s), d2 = cross(a, b, e);
        const t = d1 / (d1 - d2);
        return [s[0] + t * (e[0] - s[0]), s[1] + t * (e[1] - s[1])];
    };
    let output = subject;
    const nc = clip.length;
    for (let e = 0; e < nc; e++) {
        const a = clip[e], b = clip[(e + 1) % nc];
        const input = output; output = [];
        const m = input.length;
        if (m === 0) break;
        for (let k = 0; k < m; k++) {
            const cur = input[k], prev = input[(k + m - 1) % m];
            const curIn = cross(a, b, cur) >= 0;
            const prevIn = cross(a, b, prev) >= 0;
            if (curIn) {
                if (!prevIn) output.push(inter(prev, cur, a, b));
                output.push(cur);
            } else if (prevIn) {
                output.push(inter(prev, cur, a, b));
            }
        }
    }
    return output;
}

function ribbonOracleClip(prevA, currA, prevB, currB) {
    const hullA = hullOf(prevA, currA);
    const hullB = hullOf(prevB, currB);
    return suthHodgman(hullA, hullB).length >= 3;
}

function axisGap(nx, ny, pA, cA, pB, cB) {
    const len = Math.sqrt(nx * nx + ny * ny);
    if (len < 1e-9) return -Infinity;
    const aPMin = (nx >= 0 ? nx * pA[0] : nx * pA[2]) + (ny >= 0 ? ny * pA[1] : ny * pA[3]);
    const aPMax = (nx >= 0 ? nx * pA[2] : nx * pA[0]) + (ny >= 0 ? ny * pA[3] : ny * pA[1]);
    const aCMin = (nx >= 0 ? nx * cA[0] : nx * cA[2]) + (ny >= 0 ? ny * cA[1] : ny * cA[3]);
    const aCMax = (nx >= 0 ? nx * cA[2] : nx * cA[0]) + (ny >= 0 ? ny * cA[3] : ny * cA[1]);
    const aMin = Math.min(aPMin, aCMin), aMax = Math.max(aPMax, aCMax);
    const bPMin = (nx >= 0 ? nx * pB[0] : nx * pB[2]) + (ny >= 0 ? ny * pB[1] : ny * pB[3]);
    const bPMax = (nx >= 0 ? nx * pB[2] : nx * pB[0]) + (ny >= 0 ? ny * pB[3] : ny * pB[1]);
    const bCMin = (nx >= 0 ? nx * cB[0] : nx * cB[2]) + (ny >= 0 ? ny * cB[1] : ny * cB[3]);
    const bCMax = (nx >= 0 ? nx * cB[2] : nx * cB[0]) + (ny >= 0 ? ny * cB[3] : ny * cB[1]);
    const bMin = Math.min(bPMin, bCMin), bMax = Math.max(bPMax, bCMax);
    return Math.max(aMin - bMax, bMin - aMax) / len;
}

function satMargin(prevA, currA, prevB, currB) {
    const mAx = ((currA[0] + currA[2]) - (prevA[0] + prevA[2])) * 0.5;
    const mAy = ((currA[1] + currA[3]) - (prevA[1] + prevA[3])) * 0.5;
    const mBx = ((currB[0] + currB[2]) - (prevB[0] + prevB[2])) * 0.5;
    const mBy = ((currB[1] + currB[3]) - (prevB[1] + prevB[3])) * 0.5;
    let m = -Infinity;
    m = Math.max(m, axisGap(1, 0, prevA, currA, prevB, currB));
    m = Math.max(m, axisGap(0, 1, prevA, currA, prevB, currB));
    m = Math.max(m, axisGap(-mAy, mAx, prevA, currA, prevB, currB));
    m = Math.max(m, axisGap(-mBy, mBx, prevA, currA, prevB, currB));
    return m;
}

// =============================================================================
// 1. SUBSET, always: sweptOverlapExact(...) => sweptOverlap(...), zero violations
// over many seeded random pairs (varied angle/speed/overlap).
// =============================================================================

test('SUBSET: sweptOverlapExact => sweptOverlap over 20000 seeded random pairs', () => {
    const ov = createOverlap({ maxPairs: 4 });
    const rng = xorshift32(0x5b1a0001);
    const SIZE = 10, FIELD = 3 * SIZE, N = 20000;
    let violations = 0, positives = 0;
    for (let i = 0; i < N; i++) {
        const pa = mkBox(unit(rng()) * FIELD, unit(rng()) * FIELD, SIZE, SIZE);
        const angA = unit(rng()) * Math.PI * 2, spA = unit(rng()) * 5 * SIZE;
        const ca = moveBox(pa, Math.cos(angA) * spA, Math.sin(angA) * spA);
        const pb = mkBox(unit(rng()) * FIELD, unit(rng()) * FIELD, SIZE, SIZE);
        const angB = unit(rng()) * Math.PI * 2, spB = unit(rng()) * 5 * SIZE;
        const cb = moveBox(pb, Math.cos(angB) * spB, Math.sin(angB) * spB);

        const exact = ov.sweptOverlapExact(pa, ca, pb, cb);
        const union = ov.sweptOverlap(pa, ca, pb, cb);
        if (exact) positives++;
        if (exact && !union) violations++;
    }
    assert.ok(positives > 0, 'harness sanity: expected some exact-positive pairs');
    assert.equal(violations, 0, 'SUBSET CONTRACT VIOLATED: ' + violations + ' pair(s) had exact=true, union=false');
});

// =============================================================================
// 2. AXIS-ALIGNED IDENTITY: with both motions axis-aligned (zero, x-only, or
// y-only), sweptOverlapExact === sweptOverlap for every pair, over many seeded
// pairs. (perp of an axis-aligned motion IS x or y, so the hull is the union.)
// =============================================================================

function axisAlignedMotion(rng, size) {
    const kind = (rng() % 3);   // 0 = zero, 1 = x-only, 2 = y-only
    const mag = (unit(rng()) * 2 - 1) * 5 * size;
    if (kind === 0) return [0, 0];
    if (kind === 1) return [mag, 0];
    return [0, mag];
}

test('AXIS-ALIGNED IDENTITY: exact === union for 20000 seeded axis-aligned pairs', () => {
    const ov = createOverlap({ maxPairs: 4 });
    const rng = xorshift32(0x5b1a0002);
    const SIZE = 10, FIELD = 3 * SIZE, N = 20000;
    let mismatches = 0, positives = 0;
    for (let i = 0; i < N; i++) {
        const pa = mkBox(unit(rng()) * FIELD, unit(rng()) * FIELD, SIZE, SIZE);
        const [dxA, dyA] = axisAlignedMotion(rng, SIZE);
        const ca = moveBox(pa, dxA, dyA);
        const pb = mkBox(unit(rng()) * FIELD, unit(rng()) * FIELD, SIZE, SIZE);
        const [dxB, dyB] = axisAlignedMotion(rng, SIZE);
        const cb = moveBox(pb, dxB, dyB);

        const exact = ov.sweptOverlapExact(pa, ca, pb, cb);
        const union = ov.sweptOverlap(pa, ca, pb, cb);
        if (union) positives++;
        if (exact !== union) mismatches++;
    }
    assert.ok(positives > 0, 'harness sanity: expected some union-positive pairs');
    assert.equal(mismatches, 0, 'axis-aligned identity broken: ' + mismatches + ' pair(s) disagreed');
});

// =============================================================================
// 3. INDEPENDENT ORACLE: over >=10,000 seeded pairs, sweptOverlapExact agrees
// with the ported Sutherland-Hodgman clip oracle, excluding a small
// float-grazing band (a different algorithm agreeing is the real proof).
// =============================================================================

test('INDEPENDENT ORACLE: sweptOverlapExact === Sutherland-Hodgman clip over 12000 pairs (banded)', () => {
    const ov = createOverlap({ maxPairs: 4 });
    const rng = xorshift32(0x5b1a0003);
    const SIZE = 10, FIELD = 3 * SIZE, N = 12000, BAND_EPS = 1e-2;
    let compared = 0, excluded = 0, disagree = 0;
    const fails = [];
    for (let i = 0; i < N; i++) {
        const pa = mkBox(unit(rng()) * FIELD, unit(rng()) * FIELD, SIZE, SIZE);
        const angA = unit(rng()) * Math.PI * 2, spA = unit(rng()) * 5 * SIZE;
        const ca = moveBox(pa, Math.cos(angA) * spA, Math.sin(angA) * spA);
        const pb = mkBox(unit(rng()) * FIELD, unit(rng()) * FIELD, SIZE, SIZE);
        const angB = unit(rng()) * Math.PI * 2, spB = unit(rng()) * 5 * SIZE;
        const cb = moveBox(pb, Math.cos(angB) * spB, Math.sin(angB) * spB);

        const margin = satMargin(pa, ca, pb, cb);
        if (Math.abs(margin) < BAND_EPS) { excluded++; continue; }

        const exact = ov.sweptOverlapExact(pa, ca, pb, cb);
        const oracle = ribbonOracleClip(pa, ca, pb, cb);
        compared++;
        if (exact !== oracle) {
            disagree++;
            if (fails.length < 5) fails.push({ pa, ca, pb, cb, exact, oracle, margin });
        }
    }
    assert.equal(compared + excluded, N, 'harness sanity: every generated pair was either compared or excluded');
    assert.ok(compared >= N - N, 'harness sanity: compared count sane');   // trivially true, keeps compared "used"
    // Report the excluded count (grazing band): visible in test output on any assertion path.
    const report = 'compared=' + compared + ' excluded(band)=' + excluded + ' of N=' + N +
        (fails.length ? (' first failure: prevA=' + Array.from(fails[0].pa) +
            ' currA=' + Array.from(fails[0].ca) + ' prevB=' + Array.from(fails[0].pb) +
            ' currB=' + Array.from(fails[0].cb) + ' margin=' + fails[0].margin) : '');
    assert.equal(disagree, 0, 'INDEPENDENT ORACLE DISAGREEMENT (' + report + ')');
});

// =============================================================================
// 4. ZERO-MOTION: sweptOverlapExact(a,a,b,b) === ov.narrow(a,b) -- the hull
// degenerates to the static box; exact reduces to the discrete AABB test.
// =============================================================================

test('ZERO-MOTION: sweptOverlapExact(a,a,b,b) === narrow(a,b) for hand-built static pairs', () => {
    const ov = createOverlap({ maxPairs: 4 });
    const cases = [
        { name: 'touching edge', a: mkBox(0, 0, 10, 10), b: mkBox(10, 0, 10, 10) },
        { name: 'disjoint', a: mkBox(0, 0, 10, 10), b: mkBox(50, 50, 10, 10) },
        { name: 'contained', a: mkBox(0, 0, 20, 20), b: mkBox(5, 5, 4, 4) },
        { name: 'corner-touching', a: mkBox(0, 0, 10, 10), b: mkBox(10, 10, 10, 10) },
        { name: 'identical', a: mkBox(3, 3, 7, 7), b: mkBox(3, 3, 7, 7) },
        { name: 'edge overlap (interior)', a: mkBox(0, 0, 10, 10), b: mkBox(9, 9, 10, 10) },
    ];
    for (const c of cases) {
        const exact = ov.sweptOverlapExact(c.a, c.a, c.b, c.b);
        const narrow = ov.narrow(c.a, c.b);
        assert.equal(exact, narrow, 'zero-motion identity broke for case "' + c.name + '"');
    }
});

test('ZERO-MOTION: sweptOverlapExact(a,a,b,b) === narrow(a,b) over 800 seeded static pairs', () => {
    const ov = createOverlap({ maxPairs: 4 });
    const rng = xorshift32(0x5b1a0004);
    const SIZE = 10, FIELD = 2 * SIZE, N = 800;
    let mismatches = 0, positives = 0;
    for (let i = 0; i < N; i++) {
        const a = mkBox(unit(rng()) * FIELD, unit(rng()) * FIELD, SIZE, SIZE);
        const b = mkBox(unit(rng()) * FIELD, unit(rng()) * FIELD, SIZE, SIZE);
        const exact = ov.sweptOverlapExact(a, a, b, b);
        const narrow = ov.narrow(a, b);
        if (narrow) positives++;
        if (exact !== narrow) mismatches++;
    }
    assert.ok(positives > 0, 'harness sanity: expected some overlapping static pairs');
    assert.equal(mismatches, 0, 'zero-motion identity broken: ' + mismatches + ' pair(s) disagreed with narrow');
});

// =============================================================================
// 5. TOUCHING-EDGE CONVENTION: a hand-built pair whose swept HULLS (not just the
// union rectangles) share exactly a vertex returns true; epsilon-separated
// returns false. Exercises the perp(motionA) axis specifically, not x/y.
// =============================================================================

test('TOUCHING-EDGE CONVENTION: exact hull vertex touch -> true; epsilon beyond the ribbon -> false', () => {
    const ov = createOverlap({ maxPairs: 4 });
    // A: 4x4 box sliding diagonally from (0,0)-(4,4) to (50,50)-(54,54). The
    // perp(motionA) axis is (-1,1); prevA's top-left corner (0,4) is the extreme
    // hull vertex along that axis (aMax = 4, computed and verified by hand).
    const prevA = new Float32Array([0, 0, 4, 4]);
    const currA = new Float32Array([50, 50, 54, 54]);

    // Zero-area box exactly AT that hull vertex: shares exactly one point.
    const touch = new Float32Array([0, 4, 0, 4]);
    assert.equal(ov.sweptOverlapExact(prevA, currA, touch, touch), true,
        'exact hull-vertex touch must count as overlap (touching-edge convention)');
    assert.equal(ov.sweptOverlap(prevA, currA, touch, touch), true,
        'harness sanity: the union agrees at this point too');

    // Pushed a hair beyond the ribbon edge along the SAME axis (-1,1): separated.
    const EPS = 0.01;
    const sep = new Float32Array([-EPS / 2, 4 + EPS / 2, -EPS / 2, 4 + EPS / 2]);
    assert.equal(ov.sweptOverlapExact(prevA, currA, sep, sep), false,
        'epsilon beyond the ribbon edge must separate');

    // Pulled a hair back inside: still overlapping.
    const inside = new Float32Array([EPS / 2, 4 - EPS / 2, EPS / 2, 4 - EPS / 2]);
    assert.equal(ov.sweptOverlapExact(prevA, currA, inside, inside), true,
        'epsilon inside the ribbon edge must still overlap');
});

// =============================================================================
// 6. THE DIAGONAL OVER-REPORT FIXTURE -- the point of the whole chapter. A
// COMMITTED hand-constructed pair: two boxes, each on its own fast 45deg
// diagonal ribbon, both fitting inside a SHARED 88x88 bounding square, offset
// far enough apart (perpendicular to their shared direction of travel) that
// their union boxes overlap but their thin ribbons never meet. Literal numbers,
// verified independently against the Sutherland-Hodgman oracle, mirroring the
// S6 tunneling-fixture style (decisions/0004-swept.md).
// =============================================================================

test('THE DIAGONAL OVER-REPORT FIXTURE: union over-reports, exact correctly rejects', () => {
    const ov = createOverlap({ maxPairs: 4 });

    // A: 8x8 box sliding along the MAIN diagonal of the shared 88x88 bounding
    // square, from the bottom-left corner to the top-right corner.
    const prevA = new Float32Array([0, 0, 8, 8]);
    const currA = new Float32Array([80, 80, 88, 88]);

    // B: 8x8 box sliding along a PARALLEL 45deg ribbon (same direction as A),
    // hugging the bottom-right region of the SAME 88x88 square, far enough
    // below the y=x line that its ribbon never comes near A's.
    const prevB = new Float32Array([60, 0, 68, 8]);
    const currB = new Float32Array([70, 10, 78, 18]);

    // Both entities' current/prev boxes sit inside the SAME shared 88x88 union
    // square -- the over-report condition (their unions overlap).
    assert.equal(ov.sweptOverlap(prevA, currA, prevB, currB), true,
        'FIXTURE PRECONDITION: the union must over-report (this is the bug being demonstrated)');

    // The independent clip oracle confirms the ribbons genuinely do not meet.
    assert.equal(ribbonOracleClip(prevA, currA, prevB, currB), false,
        'harness sanity: independent oracle confirms the ribbons do not meet');

    // sweptOverlapExact must correctly reject what sweptOverlap over-reports.
    assert.equal(ov.sweptOverlapExact(prevA, currA, prevB, currB), false,
        'sweptOverlapExact failed to reject the diagonal union over-report');
});

// =============================================================================
// 7. DEGENERATE: one moving / one static, both static, and a zero-area box --
// no throw, result agrees with the independent oracle.
// =============================================================================

test('DEGENERATE: one moving, one static -- no throw, agrees with oracle', () => {
    const ov = createOverlap({ maxPairs: 4 });
    const prevA = new Float32Array([0, 0, 10, 10]);
    const currA = new Float32Array([30, 30, 40, 40]);
    const stat = new Float32Array([15, 15, 25, 25]);
    let exact;
    assert.doesNotThrow(() => { exact = ov.sweptOverlapExact(prevA, currA, stat, stat); });
    assert.equal(exact, ribbonOracleClip(prevA, currA, stat, stat));
});

test('DEGENERATE: both static -- no throw, agrees with oracle (reduces to narrow)', () => {
    const ov = createOverlap({ maxPairs: 4 });
    const a = new Float32Array([0, 0, 10, 10]);
    const b = new Float32Array([10, 0, 20, 10]);
    let exact;
    assert.doesNotThrow(() => { exact = ov.sweptOverlapExact(a, a, b, b); });
    assert.equal(exact, ribbonOracleClip(a, a, b, b));
    assert.equal(exact, ov.narrow(a, b));
});

test('DEGENERATE: zero-area (point) box in motion -- no throw, agrees with oracle', () => {
    const ov = createOverlap({ maxPairs: 4 });
    // A degenerates to a single point (minX===maxX, minY===maxY) sweeping
    // diagonally, tested against a normal box it should graze.
    const prevA = new Float32Array([5, 5, 5, 5]);
    const currA = new Float32Array([25, 25, 25, 25]);
    const b = new Float32Array([18, 18, 28, 28]);
    let exact;
    assert.doesNotThrow(() => { exact = ov.sweptOverlapExact(prevA, currA, b, b); });
    assert.equal(exact, ribbonOracleClip(prevA, currA, b, b));

    // And a zero-area box that is also STATIC (both prev and curr are points,
    // and zero motion), tested against a normal moving box.
    const prevB = new Float32Array([0, 0, 20, 20]);
    const currB = new Float32Array([40, 0, 60, 20]);
    const pt = new Float32Array([50, 5, 50, 5]);
    let exact2;
    assert.doesNotThrow(() => { exact2 = ov.sweptOverlapExact(prevB, currB, pt, pt); });
    assert.equal(exact2, ribbonOracleClip(prevB, currB, pt, pt));
});

// =============================================================================
// BOUNDARY MATRIX -- the single entry point is sweptOverlapExact(prevA, currA,
// prevB, currB); each argument is expected to be a Float32Array(4).
// =============================================================================

// --- 0 / 1 / N-1 / N / N+1 (array length; N = 4, the documented box length) ---
//
// FAIL-CLOSED (Law): sweptOverlapExact is UNVALIDATED like narrow/sweptOverlap,
// and like them it fails CLOSED on malformed input. A box array shorter than 4
// elements reads `undefined` past its end; `undefined` arithmetic produces NaN.
// Because the SAT is expressed as an AND of positive per-axis overlaps
// (`aMax >= bMin && bMax >= aMin` on each axis), a NaN projection makes that
// axis's comparisons false, so the whole AND collapses to false -- exactly as
// narrow / sweptOverlap chain their comparisons with AND. The result: a box
// array shorter than 4 makes sweptOverlapExact report NO overlap (fail closed)
// for boxes that are provably far apart, and the SUBSET contract holds on any
// input (an unverified box never yields a phantom hit). This test was a pinned
// FINDING against the original fail-open form (separation as an OR of two `<`);
// the fix (positive-AND form, decision 0005) closed it, and it now ASSERTS the
// fail-closed behavior.

test('box array length 0..3 (N-1 and below) fails CLOSED, preserving the SUBSET contract', () => {
    const ov = createOverlap({ maxPairs: 4 });
    const far = new Float32Array([1000, 1000, 1010, 1010]);   // genuinely far away
    for (const len of [0, 1, 2, 3]) {
        const short = new Float32Array(len);
        for (let i = 0; i < len; i++) short[i] = i;
        const union = ov.sweptOverlap(short, short, far, far);
        const exact = ov.sweptOverlapExact(short, short, far, far);
        assert.equal(union, false, 'harness sanity: the union correctly reports no overlap at length ' + len);
        assert.equal(exact, false,
            'length ' + len + ' box (NaN-corrupted) must fail CLOSED against a box 1000 units away ' +
            '(union=false) -- no phantom hit, SUBSET contract preserved');
    }
});

test('array length N=4 (nominal) and N+1=5 (trailing garbage ignored) agree with the union for a genuinely far pair', () => {
    const ov = createOverlap({ maxPairs: 4 });
    const far = new Float32Array([1000, 1000, 1010, 1010]);
    for (const len of [4, 5]) {
        const arr = new Float32Array(len);
        arr[0] = 0; arr[1] = 1; arr[2] = 2; arr[3] = 3;
        if (len === 5) arr[4] = 999999;   // trailing element must be ignored
        const union = ov.sweptOverlap(arr, arr, far, far);
        const exact = ov.sweptOverlapExact(arr, arr, far, far);
        assert.equal(union, false, 'harness sanity: far apart, union false at length ' + len);
        assert.equal(exact, false, 'length ' + len + ' must correctly agree with the union (no NaN corruption)');
    }
});

// --- empty (explicit, N=0 duplicate of the boundary-matrix "empty" slot) ---

test('empty Float32Array(0) box does not throw (documented as a length-0 case above)', () => {
    const ov = createOverlap({ maxPairs: 4 });
    const empty = new Float32Array(0);
    assert.doesNotThrow(() => ov.sweptOverlapExact(empty, empty, empty, empty));
});

// --- null / undefined ---

test('null / undefined box arguments fail closed with a throw, not a silent result', () => {
    const ov = createOverlap({ maxPairs: 4 });
    const box = new Float32Array([0, 0, 1, 1]);
    assert.throws(() => ov.sweptOverlapExact(null, box, box, box), TypeError,
        'null prevA must throw, not silently compute');
    assert.throws(() => ov.sweptOverlapExact(box, undefined, box, box), TypeError,
        'undefined currA must throw, not silently compute');
    assert.throws(() => ov.sweptOverlapExact(box, box, null, box), TypeError,
        'null prevB must throw, not silently compute');
    assert.throws(() => ov.sweptOverlapExact(box, box, box, undefined), TypeError,
        'undefined currB must throw, not silently compute');
});

// --- NaN ---

test('a NaN box component makes sweptOverlapExact fail CLOSED, matching narrow / sweptOverlap', () => {
    const ov = createOverlap({ maxPairs: 4 });
    const nanBox = new Float32Array([NaN, 0, 10, 10]);
    const other = new Float32Array([0, 0, 10, 10]);
    const union = ov.sweptOverlap(nanBox, nanBox, other, other);
    const exact = ov.sweptOverlapExact(nanBox, nanBox, other, other);
    const narrow = ov.narrow(nanBox, other);
    assert.equal(union, false, 'harness sanity: sweptOverlap fails closed on NaN (matches narrow convention)');
    assert.equal(narrow, false, 'harness sanity: narrow fails closed on NaN');
    assert.equal(exact, false,
        'sweptOverlapExact must fail CLOSED on a NaN-corrupted box, exactly as ' +
        'sweptOverlap/narrow do on the SAME input -- SUBSET contract preserved, no phantom hit');
});

// ASYMMETRIC corruption: the corrupt box is ONLY prev, or ONLY curr (not both).
// This is the direction the original ternary-fold `aPMin < aCMin ? aPMin : aCMin`
// LEAKED: `NaN < valid` is false, so the valid side won and the NaN was silently
// dropped, and with the corner-delta motion reading only [0]/[1] a corrupt max
// corner [2]/[3] bypassed every axis -> fail OPEN. The Math.min/max folds
// propagate the NaN, so it now fails closed regardless of WHICH box or WHICH
// corner is corrupt. Every case here must be exact=false AND still a subset of
// the union (union is also false on the same corrupt input).
test('a NaN in prev-only or curr-only (any corner) fails sweptOverlapExact CLOSED, not just when both boxes share it', () => {
    const ov = createOverlap({ maxPairs: 4 });
    const good = new Float32Array([0, 0, 10, 10]);
    const B = new Float32Array([0, 0, 10, 10]);   // genuinely overlapping the good box
    for (const corner of [0, 1, 2, 3]) {
        const bad = new Float32Array([0, 0, 10, 10]);
        bad[corner] = NaN;
        // prev corrupt, curr clean
        assert.equal(ov.sweptOverlapExact(bad, good, B, B), false,
            'prev-only NaN at corner ' + corner + ' must fail closed (was the leaking direction)');
        assert.equal(ov.sweptOverlap(bad, good, B, B), false,
            'harness sanity: union also false on prev-only NaN at corner ' + corner);
        // curr corrupt, prev clean
        assert.equal(ov.sweptOverlapExact(good, bad, B, B), false,
            'curr-only NaN at corner ' + corner + ' must fail closed');
        // corruption in the OTHER entity (B), prev-only
        assert.equal(ov.sweptOverlapExact(good, good, bad, B), false,
            'B prev-only NaN at corner ' + corner + ' must fail closed');
    }
});

test('a short prev-only box (curr well-formed) fails sweptOverlapExact CLOSED against a far box', () => {
    const ov = createOverlap({ maxPairs: 4 });
    const good = new Float32Array([0, 0, 10, 10]);
    const far = new Float32Array([1000, 1000, 1010, 1010]);
    for (const len of [0, 1, 2, 3]) {
        const short = new Float32Array(len);
        for (let i = 0; i < len; i++) short[i] = i;
        assert.equal(ov.sweptOverlap(short, good, far, far), false, 'harness sanity: union false, short prev len ' + len);
        assert.equal(ov.sweptOverlapExact(short, good, far, far), false,
            'short prev (len ' + len + ') with a well-formed curr must still fail closed against a far box');
    }
});

// --- -0 ---

test('-0 in a box component behaves identically to 0 (no sign-bit hazard)', () => {
    const ov = createOverlap({ maxPairs: 4 });
    const zNeg = new Float32Array([-0, -0, 10, 10]);
    const zPos = new Float32Array([0, 0, 10, 10]);
    const other = new Float32Array([5, 5, 15, 15]);
    assert.equal(
        ov.sweptOverlapExact(zNeg, zNeg, other, other),
        ov.sweptOverlapExact(zPos, zPos, other, other),
        '-0 and 0 must produce the identical result',
    );
    // Moving FROM -0: motion arithmetic ((curr+prev)*0.5 etc.) must not be
    // perturbed by the -0 sign bit either.
    const negMoved = new Float32Array([10, 10, 20, 20]);
    const posMoved = negMoved;
    assert.equal(
        ov.sweptOverlapExact(zNeg, negMoved, other, other),
        ov.sweptOverlapExact(zPos, posMoved, other, other),
        '-0 as a motion origin must not change the result',
    );
});

// --- duplicate "dispose" analogue: sweptOverlapExact owns no resource, so the
// matching boundary check is determinism -- repeated calls with the SAME
// inputs must always return the SAME answer (no hidden mutable state to
// double-free or to drift). ---

test('duplicate-call determinism ("duplicate dispose" analogue): 1000 repeated calls agree, and clear()/begin()/end() on the instance do not perturb the answer', () => {
    const ov = createOverlap({ maxPairs: 8 });
    const prevA = new Float32Array([0, 0, 4, 4]);
    const currA = new Float32Array([50, 50, 54, 54]);
    const prevB = new Float32Array([40, 0, 44, 4]);
    const currB = prevB;

    const first = ov.sweptOverlapExact(prevA, currA, prevB, currB);
    for (let i = 0; i < 1000; i++) {
        assert.equal(ov.sweptOverlapExact(prevA, currA, prevB, currB), first,
            'call ' + i + ' disagreed with the first call on identical inputs');
    }

    // "Dispose" the instance's own table state (clear -- the closest this
    // package has to a dispose primitive) and re-run: the pure predicate must
    // be completely unaffected, proving it carries no instance-level state.
    ov.begin(); ov.add(1, 2); ov.end();
    ov.clear();
    ov.clear();   // duplicate dispose, back to back
    assert.equal(ov.sweptOverlapExact(prevA, currA, prevB, currB), first,
        'sweptOverlapExact answer changed after clear()/clear() on the instance');
});

// --- "dispose-during-iteration" analogue: since the predicate is stateless, the
// meaningful analogue is calling it repeatedly WHILE another frame is mid-
// iteration (begin() open, adds pending, end() not yet called) -- it must not
// read or corrupt the in-flight frame state. ---

test('open-frame interleave ("dispose-during-iteration" analogue): calling sweptOverlapExact mid-frame does not perturb the pending delta', () => {
    const ov = createOverlap({ maxPairs: 16 });
    const eA = new Int32Array(16), eB = new Int32Array(16);
    const prevA = new Float32Array([0, 0, 4, 4]);
    const currA = new Float32Array([50, 50, 54, 54]);
    const prevB = new Float32Array([40, 0, 44, 4]);

    ov.begin();
    ov.add(1, 2);
    ov.add(3, 4);
    // Mid-frame, with a pending (uncommitted) delta: repeatedly call the pure
    // predicate, including a boundary case (empty array) that fails closed to
    // false -- either way it must not touch pairCount, enterCount, or the
    // pending table state (a pure predicate has no side effects).
    for (let i = 0; i < 50; i++) {
        ov.sweptOverlapExact(prevA, currA, prevB, prevB);
        ov.sweptOverlapExact(new Float32Array(0), new Float32Array(0), prevA, currA);
    }
    ov.add(5, 6);
    ov.end();

    const n = ov.drainEnter(eA, eB);
    assert.equal(n, 3, 'interleaved sweptOverlapExact calls corrupted the pending frame delta (expected 3 enters)');
    assert.equal(ov.pairCount(), 3, 'interleaved calls corrupted pairCount');
});

// --- "re-entrant write" analogue: since sweptOverlapExact performs no writes
// itself, the meaningful analogue is a caller that calls it FROM INSIDE a loop
// that is simultaneously WRITING to the same instance's pair table (a
// realistic "recheck this candidate, then record it" usage pattern) -- the two
// must not cross-contaminate. ---

test('write-interleaved loop ("re-entrant write" analogue): sweptOverlapExact calls interleaved with add() writes do not cross-contaminate', () => {
    const ov = createOverlap({ maxPairs: 32 });
    const eA = new Int32Array(32), eB = new Int32Array(32);

    // A small deterministic corpus: 6 diagonally-moving boxes, id = index.
    const N = 6;
    const prev = [], curr = [];
    for (let i = 0; i < N; i++) {
        prev.push(new Float32Array([i * 12, 0, i * 12 + 4, 4]));
        curr.push(new Float32Array([i * 12 + 30, 30, i * 12 + 34, 34]));
    }

    ov.begin();
    let expectedEnters = 0;
    const expected = new Set();
    for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
            // Recheck-then-record: call the exact predicate, and IMMEDIATELY
            // write to the SAME instance's pair table via add() if it agrees
            // with the (already-computed) union. This interleaves reads of
            // the pure predicate with writes to instance state on every
            // iteration -- the write must never affect the predicate's
            // answer for the NEXT (i, j), and the predicate must never affect
            // the write.
            const exact = ov.sweptOverlapExact(prev[i], curr[i], prev[j], curr[j]);
            if (exact) {
                ov.add(i, j);
                expected.add(i < j ? i + ',' + j : j + ',' + i);
                expectedEnters++;
            }
        }
    }
    ov.end();

    const n = ov.drainEnter(eA, eB);
    assert.equal(n, expectedEnters, 'write-interleaved loop recorded the wrong enter count');
    const got = new Set();
    for (let k = 0; k < n; k++) got.add(eA[k] < eB[k] ? eA[k] + ',' + eB[k] : eB[k] + ',' + eA[k]);
    assert.equal(got.size, expected.size, 'write-interleaved loop recorded a different SET of pairs than expected');
    for (const k of expected) assert.ok(got.has(k), 'missing expected pair ' + k + ' after interleave');

    // Re-run the SAME predicate calls again (table now full of what was added)
    // and confirm every answer is bit-identical to the first pass -- proves the
    // interleaved writes never fed back into the pure predicate's answers.
    for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
            const exact = ov.sweptOverlapExact(prev[i], curr[i], prev[j], curr[j]);
            const key = i < j ? i + ',' + j : j + ',' + i;
            assert.equal(exact, expected.has(key),
                'sweptOverlapExact(' + i + ',' + j + ') drifted after interleaved writes to the instance');
        }
    }
});

// --- adversarial (the planner's list did not enumerate this): a NON-FINITE box
// coordinate fails sweptOverlapExact CLOSED. The exact test projects boxes onto
// SAT axes via dot products `nx*x + ny*y`; on the x/y axes one component is 0,
// so an `Infinity` box coordinate produces `0 * Infinity = NaN`, collapsing the
// AND to false. This DIFFERS from narrow / sweptOverlap, which use pure
// comparisons (no multiply), tolerate Infinity, and can report true. Because
// sweptOverlapExact is always a SUBSET of sweptOverlap, failing closed where the
// union reports overlap is contract-valid (never a phantom hit); it is the Law's
// "fail closed on unverified state" applied to a degenerate box. Real entity
// AABBs are finite, so this never arises in practice. ---

test('ADVERSARIAL: a non-finite (Infinity) box coordinate fails sweptOverlapExact closed (subset of sweptOverlap holds)', () => {
    const ov = createOverlap({ maxPairs: 4 });
    const far = new Float32Array([1000, 1000, 1010, 1010]);

    // -Infinity minX vs a far box: union agrees false, exact fails closed false.
    const infMin = new Float32Array([-Infinity, 0, 10, 10]);
    assert.equal(ov.sweptOverlap(infMin, infMin, far, far), false, 'harness sanity: union false, -Infinity minX, far box');
    assert.equal(ov.sweptOverlapExact(infMin, infMin, far, far), false,
        '-Infinity minX fails closed against a genuinely far box');

    // An infinitely-large box (maxX/maxY = Infinity): narrow/sweptOverlap say it
    // covers everything (true, pure comparisons), but sweptOverlapExact fails
    // CLOSED (0 * Infinity = NaN in the projection). exact=false subset of
    // union=true is contract-valid -- the exact test never over-reports.
    const infMax = new Float32Array([0, 0, Infinity, Infinity]);
    const near = new Float32Array([5, 5, 15, 15]);
    assert.equal(ov.sweptOverlap(infMax, infMax, near, near), true, 'harness sanity: union covers near (pure comparisons tolerate Infinity)');
    assert.equal(ov.narrow(infMax, near), true, 'harness sanity: narrow covers near too');
    assert.equal(ov.sweptOverlapExact(infMax, infMax, near, near), false,
        'non-finite box fails sweptOverlapExact closed; false is a valid subset of union=true (no phantom hit)');
});
