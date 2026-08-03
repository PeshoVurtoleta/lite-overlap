/**
 * bench/swept-union-vs-hull.mjs -- the S1 deferral decision (decisions/0004-swept.md).
 *
 * The shipped swept test (`sweptOverlap`) uses the AABB UNION of an entity's
 * prev/curr tight boxes as its swept volume. That union is the tightest
 * AXIS-ALIGNED box containing the whole linear sweep -- it never misses a real
 * swept overlap (a sound broadphase) but it OVER-REPORTS on diagonal motion: a
 * box sliding along x=y sweeps a thin diagonal ribbon, yet its union is the full
 * bounding rectangle of that ribbon. Decision S1 defers the exact ribbon test
 * (`sweptOverlapExact`) until a bench answers two questions with numbers:
 *
 *   1. OVER-REPORT: does the union over-report ENOUGH to matter?
 *   2. COST: how much MORE does the exact hull test cost than the union?
 *
 * This bench measures both, gates the geometry against an independent oracle
 * FIRST (a wrong measurement measures nothing), and prints a pre-registered
 * verdict computed in-code against a fixed rule.
 *
 * Three predicates, all defined inline here (register-only on any TIMED loop;
 * scratch is allocated ONCE at module top, never in a hot body):
 *
 *   unionOverlap   -- the SHIPPED test. AABB union of prev,curr; two unions
 *                     overlap by the touching-edge convention (<=). Mirrors
 *                     Overlap.js `sweptOverlap` (proven identical in gate G0).
 *   sweptExactSAT  -- the CANDIDATE `sweptOverlapExact`. The swept ribbon is the
 *                     convex hull of the box's 8 corners (4 prev + 4 curr): a
 *                     hexagon for diagonal motion, a rectangle for axis-aligned.
 *                     Two hulls are tested by SAT on the ONLY candidate axes:
 *                     x, y, perp(motionA), perp(motionB). Those are exactly the
 *                     edge normals of both swept hulls, so SAT on them is EXACT
 *                     for hull-vs-hull overlap. Register-only: the 8 corners are
 *                     projected inline from box+motion, no array, no sort, no
 *                     hull-point list. This is a time-UNcorrelated geometric
 *                     overlap boolean, NOT time-of-impact (TOI is out of scope).
 *   ribbonOracleClip -- the INDEPENDENT oracle (correctness only, OFF the timed
 *                     loop; may allocate, may be slow). Builds both hulls as
 *                     explicit CCW point lists (monotone-chain convex hull of the
 *                     8 corners) and intersects them by Sutherland-Hodgman
 *                     polygon clipping. A DIFFERENT algorithm from SAT on purpose
 *                     -- SAT-vs-clip is a real differential, not a copy checking
 *                     itself.
 *
 * Not shipped: bench/ is not in package.json files[], so importing ../Overlap.js
 * and node builtins is free. Run: `npm run bench:swept` (or
 * `node bench/swept-union-vs-hull.mjs`). Writes bench/RESULTS-swept.md.
 */

import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createOverlap, VERSION } from '../Overlap.js';

/* ---- protocol ----------------------------------------------------------- */
const SIZE = 14;                       // box edge (matches collect-vs-nquery)
const SEED = 0x1543beef;               // deterministic, same seed family
const WARMUP = 200;                    // passes discarded before timing
const REPS = 11;                       // odd -> clean median
const OVER_N = 2000;                   // boxes per over-report cell (all-pairs count)
const DIFF_PAIRS = 60000;              // G2 differential pairs (>= 50000)
const COST_M = 100000;                 // preallocated cost cases
const BAND_EPS = 1e-2;                 // grazing band (world units, normalized axis)

const ANGLES = [0, 15, 45];            // motion angle in degrees
const SPEEDS = [0.5, 1.5, 4.0];        // speed in box-widths
const DENSITIES = [0.001, 0.002, 0.004];
const DEG = Math.PI / 180;

/* ---- deterministic PRNG (self-contained; no test-harness dep) ----------- */
function xorshift32(s) {
    let x = s >>> 0;
    return function () {
        x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
        return x / 4294967296;
    };
}

/* ======================================================================== *
 *  1. unionOverlap -- the SHIPPED test (mirrors Overlap.js sweptOverlap).   *
 *     Register-only: 8 min/max + 4 compares, no scratch.                    *
 * ======================================================================== */
function unionOverlap(prevA, currA, prevB, currB) {
    const aMinX = Math.min(prevA[0], currA[0]);
    const aMinY = Math.min(prevA[1], currA[1]);
    const aMaxX = Math.max(prevA[2], currA[2]);
    const aMaxY = Math.max(prevA[3], currA[3]);
    const bMinX = Math.min(prevB[0], currB[0]);
    const bMinY = Math.min(prevB[1], currB[1]);
    const bMaxX = Math.max(prevB[2], currB[2]);
    const bMaxY = Math.max(prevB[3], currB[3]);
    return aMinX <= bMaxX && bMinX <= aMaxX &&
        aMinY <= bMaxY && bMinY <= aMaxY;
}

/* ======================================================================== *
 *  2. sweptExactSAT -- the CANDIDATE sweptOverlapExact.                     *
 *     SAT of two swept hulls on axes {x, y, perp(mA), perp(mB)}. Those are  *
 *     exactly the edge normals of both hulls, so the test is EXACT. The 8   *
 *     corners of each hull are projected inline (min/max of the two boxes'  *
 *     projections) -- REGISTER-ONLY, no array, no sort, no hull list.       *
 * ======================================================================== */

/* Overlap along (nx,ny)? Projects all 8 corners of each hull (= min/max of each
 * of the two boxes' 4-corner projections). Positive per-axis overlap
 * `aMax >= bMin && bMax >= aMin` (touching aMax == bMin counts, matching the
 * union convention). This is the FAIL-CLOSED form the library ships
 * (`sweptAxisOverlap`): a NaN projection makes every `>=` false, so the axis is
 * false and the four-axis AND is false -- an unverified box reports no overlap,
 * exactly as narrow / sweptOverlap. Equals `!(aMax<bMin || bMax<aMin)` for all
 * finite inputs, so the measured geometry is unchanged. Zero-length axis (perp
 * of zero motion) projects everything to 0 -> `0>=0 && 0>=0` -> overlaps
 * trivially, which is correct (a still box contributes no ribbon-side normal). */
function axisOverlap(nx, ny, pA, cA, pB, cB) {
    // hull A: min/max of dot over the 8 corners = min/max over the two boxes.
    const aPMin = (nx >= 0 ? nx * pA[0] : nx * pA[2]) + (ny >= 0 ? ny * pA[1] : ny * pA[3]);
    const aPMax = (nx >= 0 ? nx * pA[2] : nx * pA[0]) + (ny >= 0 ? ny * pA[3] : ny * pA[1]);
    const aCMin = (nx >= 0 ? nx * cA[0] : nx * cA[2]) + (ny >= 0 ? ny * cA[1] : ny * cA[3]);
    const aCMax = (nx >= 0 ? nx * cA[2] : nx * cA[0]) + (ny >= 0 ? ny * cA[3] : ny * cA[1]);
    // Math.min/max (NOT a ternary) so a NaN corner propagates and fails the axis
    // closed -- matches Overlap.js sweptAxisOverlap; byte-identical on finite input.
    const aMin = Math.min(aPMin, aCMin);
    const aMax = Math.max(aPMax, aCMax);
    // hull B
    const bPMin = (nx >= 0 ? nx * pB[0] : nx * pB[2]) + (ny >= 0 ? ny * pB[1] : ny * pB[3]);
    const bPMax = (nx >= 0 ? nx * pB[2] : nx * pB[0]) + (ny >= 0 ? ny * pB[3] : ny * pB[1]);
    const bCMin = (nx >= 0 ? nx * cB[0] : nx * cB[2]) + (ny >= 0 ? ny * cB[1] : ny * cB[3]);
    const bCMax = (nx >= 0 ? nx * cB[2] : nx * cB[0]) + (ny >= 0 ? ny * cB[3] : ny * cB[1]);
    const bMin = Math.min(bPMin, bCMin);
    const bMax = Math.max(bPMax, bCMax);
    return aMax >= bMin && bMax >= aMin;
}

function sweptExactSAT(prevA, currA, prevB, currB) {
    // motion = min-corner displacement (register-only). For a rigid translation
    // this equals the center delta byte-for-byte; chosen so an infinite extent
    // yields (0,0) motion instead of Inf - Inf = NaN. Matches Overlap.js.
    const mAx = currA[0] - prevA[0];
    const mAy = currA[1] - prevA[1];
    const mBx = currB[0] - prevB[0];
    const mBy = currB[1] - prevB[1];
    // AND of per-axis overlaps: overlap iff EVERY axis overlaps (fail-closed).
    return axisOverlap(1, 0, prevA, currA, prevB, currB) &&
        axisOverlap(0, 1, prevA, currA, prevB, currB) &&
        axisOverlap(-mAy, mAx, prevA, currA, prevB, currB) &&
        axisOverlap(-mBy, mBx, prevA, currA, prevB, currB);
}

/* Signed NORMALIZED separation margin (positive = separated, <=0 = overlap):
 * the largest gap over the 4 axes, each axis normalized to unit length so the
 * gap is a world-space distance. Off the timed loop; used only to define G2's
 * grazing band so float-boundary near-misses are not counted as bugs. */
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

function axisGap(nx, ny, pA, cA, pB, cB) {
    const len = Math.sqrt(nx * nx + ny * ny);
    if (len < 1e-9) return -Infinity;              // zero motion contributes no axis
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
    return Math.max(aMin - bMax, bMin - aMax) / len;   // > 0 => separated on this axis
}

/* ======================================================================== *
 *  3. ribbonOracleClip -- INDEPENDENT oracle (may allocate; off timed loop).*
 *     Convex hull (monotone chain) of the 8 corners of each swept box, then *
 *     Sutherland-Hodgman clip of one hull by the other; overlap iff the     *
 *     clipped polygon has area (>= 3 vertices).                             *
 * ======================================================================== */
function hullOf(prev, curr) {
    // 8 corners: 4 of prev, 4 of curr. Duplicates/collinear are fine -- the
    // monotone chain collapses the axis-aligned case to a 4-point rectangle.
    const pts = [
        [prev[0], prev[1]], [prev[2], prev[1]], [prev[2], prev[3]], [prev[0], prev[3]],
        [curr[0], curr[1]], [curr[2], curr[1]], [curr[2], curr[3]], [curr[0], curr[3]],
    ];
    return convexHull(pts);
}

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
    return lower.concat(upper);   // CCW
}

function ribbonOracleClip(prevA, currA, prevB, currB) {
    const hullA = hullOf(prevA, currA);
    const hullB = hullOf(prevB, currB);
    const clipped = suthHodgman(hullA, hullB);
    return clipped.length >= 3;
}

/* Clip subject polygon by the convex CCW clip polygon. */
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

/* ---- box helpers -------------------------------------------------------- */
function mkBox(x, y) { const b = new Float32Array(4); b[0] = x; b[1] = y; b[2] = x + SIZE; b[3] = y + SIZE; return b; }
function moveBox(b, dx, dy) { const c = new Float32Array(4); c[0] = b[0] + dx; c[1] = b[1] + dy; c[2] = b[2] + dx; c[3] = b[3] + dy; return c; }

/* ======================================================================== *
 *  CORRECTNESS GATES (printed BEFORE any timing; a FAIL aborts).           *
 * ======================================================================== */
function gateG0() {
    // The bench must measure the REAL shipped behavior: prove the inline
    // unionOverlap is bit-identical to Overlap.js sweptOverlap.
    const ov = createOverlap({ maxPairs: 64 });
    const rng = xorshift32((SEED ^ 0xA0A0) >>> 0);
    let checked = 0, mism = 0;
    for (let i = 0; i < 20000; i++) {
        const pa = mkBox(rng() * 60, rng() * 60);
        const ca = moveBox(pa, (rng() - 0.5) * 80, (rng() - 0.5) * 80);
        const pb = mkBox(rng() * 60, rng() * 60);
        const cb = moveBox(pb, (rng() - 0.5) * 80, (rng() - 0.5) * 80);
        const mine = unionOverlap(pa, ca, pb, cb);
        const ship = ov.sweptOverlap(pa, ca, pb, cb);
        checked++;
        if (mine !== ship) mism++;
    }
    return { pass: mism === 0, checked, mism };
}

function gateG1() {
    // Axis-aligned identity: at angle 0 and 90, the hull IS the union rectangle,
    // so sweptExactSAT === unionOverlap for every pair and the positive counts
    // are equal (over-report fraction exactly 0).
    const rng = xorshift32((SEED ^ 0x1111) >>> 0);
    const N = 800, field = 200;
    let mism = 0, uPos = 0, ePos = 0;
    for (const ang of [0, 90]) {
        const c = Math.cos(ang * DEG), s = Math.sin(ang * DEG);
        const speed = 3.0 * SIZE;
        const dx = c * speed, dy = s * speed;
        const prev = [], curr = [];
        for (let i = 0; i < N; i++) {
            const b = mkBox(rng() * field, rng() * field);
            prev.push(b); curr.push(moveBox(b, dx, dy));
        }
        for (let i = 0; i < N; i++) {
            for (let j = i + 1; j < N; j++) {
                const u = unionOverlap(prev[i], curr[i], prev[j], curr[j]);
                const e = sweptExactSAT(prev[i], curr[i], prev[j], curr[j]);
                if (u !== e) mism++;
                if (u) uPos++;
                if (e) ePos++;
            }
        }
    }
    const frac = uPos === 0 ? 0 : (uPos - ePos) / uPos;
    return { pass: mism === 0 && uPos === ePos && frac === 0, mism, uPos, ePos, frac };
}

function gateG2() {
    // SAT vs the clip oracle over DIFF_PAIRS random pairs spanning all regimes.
    // Grazing pairs (|normalized margin| < BAND_EPS) are excluded to avoid
    // float-boundary false mismatches; the exclusion count is reported.
    const rng = xorshift32((SEED ^ 0x2222) >>> 0);
    const field = 3 * SIZE;
    let compared = 0, excluded = 0, disagree = 0, g3viol = 0;
    const fails = [];
    for (let n = 0; n < DIFF_PAIRS; n++) {
        const pa = mkBox(rng() * field, rng() * field);
        const angA = rng() * Math.PI * 2, spA = rng() * 5 * SIZE;
        const ca = moveBox(pa, Math.cos(angA) * spA, Math.sin(angA) * spA);
        const pb = mkBox(rng() * field, rng() * field);
        const angB = rng() * Math.PI * 2, spB = rng() * 5 * SIZE;
        const cb = moveBox(pb, Math.cos(angB) * spB, Math.sin(angB) * spB);

        const sat = sweptExactSAT(pa, ca, pb, cb);
        const uni = unionOverlap(pa, ca, pb, cb);
        if (sat && !uni) g3viol++;                       // G3 superset check

        const margin = satMargin(pa, ca, pb, cb);
        if (Math.abs(margin) < BAND_EPS) { excluded++; continue; }

        const orc = ribbonOracleClip(pa, ca, pb, cb);
        compared++;
        if (sat !== orc) {
            disagree++;
            if (fails.length < 4) fails.push({ pa, ca, pb, cb, sat, orc, margin });
        }
    }
    return { pass: disagree === 0 && g3viol === 0, compared, excluded, disagree, g3viol, fails };
}

/* ======================================================================== *
 *  OVER-REPORT: angle x speed x density -> unionPos, exactPos, frac.        *
 *  Uniform motion per cell (all boxes share the cell's angle+speed) is the  *
 *  documented WORST CASE: parallel diagonal ribbons maximize the gap between *
 *  the union rectangle and the true hull. It is an UPPER BOUND, not a       *
 *  real-scene rate.                                                         *
 * ======================================================================== */
function overReportCell(angDeg, speedBw, density, g3ref) {
    const field = Math.round(Math.sqrt(OVER_N / density));
    const rng = xorshift32((SEED ^ (Math.round(angDeg * 131 + speedBw * 977 + density * 1e6))) >>> 0);
    const c = Math.cos(angDeg * DEG), s = Math.sin(angDeg * DEG);
    const dx = c * speedBw * SIZE, dy = s * speedBw * SIZE;
    const prev = [], curr = [];
    for (let i = 0; i < OVER_N; i++) {
        const b = mkBox(rng() * (field - SIZE), rng() * (field - SIZE));
        prev.push(b); curr.push(moveBox(b, dx, dy));
    }
    let uPos = 0, ePos = 0;
    for (let i = 0; i < OVER_N; i++) {
        for (let j = i + 1; j < OVER_N; j++) {
            const u = unionOverlap(prev[i], curr[i], prev[j], curr[j]);
            const e = sweptExactSAT(prev[i], curr[i], prev[j], curr[j]);
            if (e && !u) g3ref.v++;              // superset violation (must stay 0)
            if (u) uPos++;
            if (e) ePos++;
        }
    }
    const frac = uPos === 0 ? 0 : (uPos - ePos) / uPos;
    return { angDeg, speedBw, density, field, uPos, ePos, frac };
}

/* ======================================================================== *
 *  COST: median-of-11 ns/pair, union vs hull, over COST_M preallocated      *
 *  cases (45deg, mixed speeds) so both paths do real work. XOR checksum     *
 *  defeats dead-code elimination.                                           *
 * ======================================================================== */
function buildCostCases() {
    const rng = xorshift32((SEED ^ 0xC057) >>> 0);
    const cpA = new Array(COST_M), ccA = new Array(COST_M);
    const cpB = new Array(COST_M), ccB = new Array(COST_M);
    const c = Math.cos(45 * DEG), s = Math.sin(45 * DEG);
    for (let i = 0; i < COST_M; i++) {
        const spA = SPEEDS[(rng() * 3) | 0] * SIZE;
        const spB = SPEEDS[(rng() * 3) | 0] * SIZE;
        const pa = mkBox(0, 0);
        const pb = mkBox((rng() - 0.5) * 4 * SIZE, (rng() - 0.5) * 4 * SIZE);
        cpA[i] = pa; ccA[i] = moveBox(pa, c * spA, s * spA);
        cpB[i] = pb; ccB[i] = moveBox(pb, c * spB, s * spB);
    }
    return { cpA, ccA, cpB, ccB };
}

let COST_CHECKSUM = 0;

function passUnion(cases) {
    const { cpA, ccA, cpB, ccB } = cases;
    let sum = 0;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < COST_M; i++) sum ^= unionOverlap(cpA[i], ccA[i], cpB[i], ccB[i]) ? 1 : 0;
    const t1 = process.hrtime.bigint();
    COST_CHECKSUM ^= sum;
    return Number(t1 - t0);
}

function passHull(cases) {
    const { cpA, ccA, cpB, ccB } = cases;
    let sum = 0;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < COST_M; i++) sum ^= sweptExactSAT(cpA[i], ccA[i], cpB[i], ccB[i]) ? 1 : 0;
    const t1 = process.hrtime.bigint();
    COST_CHECKSUM ^= sum;
    return Number(t1 - t0);
}

function medianNsPerPair(passFn, cases) {
    for (let w = 0; w < WARMUP; w++) passFn(cases);          // steady state
    const samples = new Float64Array(REPS);
    for (let r = 0; r < REPS; r++) samples[r] = passFn(cases) / COST_M;
    const sorted = Array.from(samples).sort((a, b) => a - b);
    return sorted[(REPS - 1) >> 1];
}

/* ---- render ------------------------------------------------------------- */
function main() {
    const stamp = [
        'node ' + process.version,
        os.cpus()[0].model.trim(),
        os.arch(),
        new Date().toISOString(),
        'seed=0x' + SEED.toString(16),
        'box=' + SIZE + 'x' + SIZE + ' overN=' + OVER_N + ' diffPairs=' + DIFF_PAIRS + ' costM=' + COST_M,
        'warmup=' + WARMUP + ' reps=' + REPS + ' band=' + BAND_EPS,
    ].join(' | ');

    const L = [];
    const say = (line) => { L.push(line); process.stdout.write(line + '\n'); };

    say('# lite-overlap ' + VERSION + ' -- swept union vs exact hull (S1 deferral)');
    say('');
    say('Does the shipped AABB-union swept test (`sweptOverlap`) over-report enough');
    say('vs the exact swept-ribbon hull test to justify shipping `sweptOverlapExact`,');
    say('and how much more does the exact test cost? Gated against an independent');
    say('Sutherland-Hodgman clip oracle before any timing. See');
    say('`bench/swept-union-vs-hull.mjs` for the full protocol.');
    say('');
    say('```');
    say(stamp);
    say('```');
    say('');

    // ---- gates ----
    say('## Gates (all must PASS before timing)');
    say('');
    const g0 = gateG0();
    say('- G0 shipped-mirror: unionOverlap === Overlap.js sweptOverlap over ' +
        g0.checked + ' pairs -> ' + (g0.pass ? 'PASS' : 'FAIL') + ' (mismatches=' + g0.mism + ')');
    const g1 = gateG1();
    say('- G1 axis-aligned identity (angle 0 and 90): SAT === union every pair, ' +
        'unionPos=' + g1.uPos + ' exactPos=' + g1.ePos + ' frac=' + g1.frac.toFixed(3) +
        ' -> ' + (g1.pass ? 'PASS' : 'FAIL') + ' (mismatches=' + g1.mism + ')');
    const g2 = gateG2();
    say('- G2 SAT-vs-oracle differential: compared=' + g2.compared + ' excluded(band)=' +
        g2.excluded + ' (' + (100 * g2.excluded / (g2.compared + g2.excluded)).toFixed(2) +
        '%) disagreements=' + g2.disagree + ' -> ' + (g2.pass ? 'PASS' : 'FAIL'));
    const g3ref = { v: 0 };
    // G3 across the G2 sample is already checked (g2.g3viol); accumulate it.
    g3ref.v += g2.g3viol;

    if (!g0.pass || !g1.pass || !g2.pass) {
        say('');
        say('GATE FAILED -- aborting before measurement.');
        if (g2.fails.length) {
            for (const f of g2.fails) {
                const box = (b) => '[' + b[0].toFixed(3) + ',' + b[1].toFixed(3) + ',' + b[2].toFixed(3) + ',' + b[3].toFixed(3) + ']';
                say('  disagree sat=' + f.sat + ' orc=' + f.orc + ' margin=' + f.margin.toExponential(2) +
                    ' prevA=' + box(f.pa) + ' currA=' + box(f.ca) + ' prevB=' + box(f.pb) + ' currB=' + box(f.cb));
            }
        }
        writeReport(L);
        process.exitCode = 1;
        return;
    }

    // ---- over-report table ----
    say('');
    say('## Over-report (union positives that the exact hull rejects)');
    say('');
    say('Uniform per-cell motion (all boxes share the cell angle+speed) is the');
    say('WORST CASE the planner flagged: parallel diagonal ribbons maximize the gap');
    say('between the union rectangle and the true hull. Read the 45deg rows as an');
    say('UPPER BOUND, not a real-scene over-report rate.');
    say('');
    say('| angle(deg) | speed(bw) | density | field | unionPos | exactPos | frac |');
    say('| ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    const cells = [];
    for (const ang of ANGLES) {
        for (const sp of SPEEDS) {
            for (const den of DENSITIES) {
                const cell = overReportCell(ang, sp, den, g3ref);
                cells.push(cell);
                say('| ' + ang + ' | ' + sp.toFixed(1) + ' | ' + den + ' | ' + cell.field +
                    ' | ' + cell.uPos + ' | ' + cell.ePos + ' | ' + cell.frac.toFixed(3) + ' |');
            }
        }
    }
    say('');
    say('- G3 superset (exact positive => union positive), violations across all ' +
        'gated+tabulated pairs: ' + g3ref.v + ' -> ' + (g3ref.v === 0 ? 'PASS' : 'FAIL'));

    // ---- cost ----
    const cases = buildCostCases();
    const unionNs = medianNsPerPair(passUnion, cases);
    const hullNs = medianNsPerPair(passHull, cases);
    const ratio = hullNs / unionNs;
    say('');
    say('## Cost (median-of-' + REPS + ' ns/pair over ' + COST_M + ' cases, 45deg mixed speeds)');
    say('');
    say('| test | ns/pair | ratio vs union |');
    say('| :--- | ---: | ---: |');
    say('| unionOverlap (shipped) | ' + unionNs.toFixed(3) + ' | 1.00x |');
    say('| sweptExactSAT (hull)   | ' + hullNs.toFixed(3) + ' | ' + ratio.toFixed(2) + 'x |');
    say('');
    say('(checksum=' + COST_CHECKSUM + ' -- forces both calls live)');

    // ---- pre-registered verdict ----
    let worstFrac = 0;
    for (const c of cells) if (c.angDeg === 45) worstFrac = Math.max(worstFrac, c.frac);
    let verdict;
    if (worstFrac >= 0.05 && ratio <= 3.0) verdict = 'SHIP';
    else if (worstFrac >= 0.05 && ratio <= 8.0) verdict = 'PREDICATE-ONLY';
    else verdict = 'CLOSE';
    const vline = 'VERDICT: ' + verdict + ' (worstFrac=' + worstFrac.toFixed(3) + ', ratio=' + ratio.toFixed(2) + 'x)';
    say('');
    say('## Pre-registered verdict');
    say('');
    say('Rule (fixed before the run): worstFrac = max over-report fraction across the');
    say('45deg cells. SHIP if worstFrac >= 0.05 AND ratio <= 3.0; PREDICATE-ONLY if');
    say('worstFrac >= 0.05 AND 3.0 < ratio <= 8.0; CLOSE otherwise.');
    say('');
    say('**' + vline + '**');

    writeReport(L);
}

function writeReport(L) {
    const out = join(dirname(fileURLToPath(import.meta.url)), 'RESULTS-swept.md');
    writeFileSync(out, L.join('\n') + '\n');
    process.stdout.write('\nwritten -> ' + out + '\n');
}

main();
