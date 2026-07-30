/**
 * Tier T6 -- the zero-alloc gate.
 *
 * A steady-state overlap instance is allocated ONCE, then a sliding-window churn
 * of ~10k+ frames is measured with lite-gc-profiler and gated at
 * maxMajor:0 / maxPauseMs:4 / maxArrayBuffersGrowth:0. The last rule is the one
 * that matters here: the pair table is Int32Array backing stores, which live
 * OUTSIDE the V8 heap and are invisible to a heapUsed gate (the lite-bvh B-08
 * lesson). It requires `stabilize:'deep'`, which harness.runOpsGate supplies.
 *
 * Each measured op is one full frame: begin -> add a churning window of pairs
 * (some persist as stays, some are new enters, some vanish as exits, exercising
 * add's probe/insert/tag path and end's backward-shift delete) -> end -> drain.
 *
 * CONTROL: with TORTURE_CONTROL=alloc the hot loop swaps the table for the naive
 * Set<string> pair store the package exists to replace -- a fresh Set and N
 * key strings per frame. That forces real major collections, the gate goes red,
 * and this tier throws: the executable proof the gate can fail.
 */

import { createOverlap } from '../../Overlap.js';

const TIER = 'T6';
const OPS = 12000;      // > 10k churn frames
const WARMUP = 2000;
const POOL = 512;       // distinct candidate pairs
const WINDOW = 200;     // pairs live per frame (window slides -> churn)
// Between begin() and end(), last frame's pairs still occupy the table while
// this frame's are added; if a measurement batch restarts the index the two
// windows can be disjoint, so the peak occupancy is 2*WINDOW. Size for it.
const MAX_PAIRS = 2 * WINDOW + 16;

export function run(h) {
    const alloc = h.CONTROL === 'alloc';

    // Pre-built candidate id pairs. POOL is a power of two so `& (POOL-1)` wraps.
    const idA = new Int32Array(POOL);
    const idB = new Int32Array(POOL);
    const rng = h.xorshift32(h.SEED ^ 0x6a6a6a6a);
    for (let i = 0; i < POOL; i++) {
        // Distinct pairs by construction: (2i, 2i+1) plus a scatter so hashing
        // and probing are exercised rather than a perfectly regular sequence.
        const base = (h.unit(rng()) * 1_000_000) | 0;
        idA[i] = base;
        idB[i] = base + 1 + (i & 7);
    }

    // Everything the real hot body touches is pre-allocated here, once.
    const ov = createOverlap({ maxPairs: MAX_PAIRS });
    const eA = new Int32Array(MAX_PAIRS), eB = new Int32Array(MAX_PAIRS);
    const xA = new Int32Array(MAX_PAIRS), xB = new Int32Array(MAX_PAIRS);

    const hot = (i) => {
        const base = i & (POOL - 1);
        ov.begin();
        for (let k = 0; k < WINDOW; k++) {
            const idx = (base + k) & (POOL - 1);
            ov.add(idA[idx], idB[idx]);
        }
        ov.end();
        ov.drainEnter(eA, eB);
        ov.drainExit(xA, xB);
    };

    // Control: the naive Set<string> pair store the package exists to replace --
    // a fresh Set + WINDOW key strings per frame, diffed against the previous set.
    //
    // A subtlety proven the hard way: TRANSIENT churn is NOT gate-detectable. A
    // per-frame Set that replaces its predecessor nets to zero retained bytes and
    // dies in a scavenge -- it trips no MAJOR GC (so checkNoGc is blind) and, in
    // this Node build, surfaces no minor-GC signal either. So the control does
    // what aabb's T6 control does: it ALLOCATES AND RETAINS (`sink.push(cur)`),
    // turning the churn into real heap growth that forces major collections the
    // maxMajor:0 gate catches. Retention is the mechanism that makes allocation
    // VISIBLE; the transient-garbage story is the demo's job (Scene 01's heap
    // sparkline), not a thing a steady-state GC gate can see.
    let controlPrev = new Set();
    const sink = alloc ? [] : null;
    const controlHot = (i) => {
        const base = i & (POOL - 1);
        const cur = new Set();
        for (let k = 0; k < WINDOW; k++) {
            const idx = (base + k) & (POOL - 1);
            const a = idA[idx], b = idB[idx];
            cur.add(a < b ? a + ',' + b : b + ',' + a);
        }
        // diff (enter/exit), same work the table does branchlessly.
        for (const kk of cur) if (!controlPrev.has(kk)) { /* enter */ }
        for (const kk of controlPrev) if (!cur.has(kk)) { /* exit */ }
        controlPrev = cur;
        sink.push(cur); // RETAIN -> real heap growth -> forced major GC.
    };

    const fn = alloc ? controlHot : hot;

    // Two complementary gates, because they catch different failures:
    //   * runOpsGate -> checkNoGc(RULES): maxMajor:0 / maxPauseMs:4 /
    //     maxArrayBuffersGrowth:0. Catches promoted heap growth and OFF-heap
    //     ArrayBuffer growth -- a growing pair table (the lite-bvh B-08 lesson),
    //     which measureAllocs' JS-heap estimator cannot see.
    //   * bytesPerOp -> measureAllocs net-retained estimator. Catches JS-heap
    //     bytes the op keeps alive per call: 0 for the genuine hot path, ~5 KB
    //     for the retaining Set<string> control. This is the gate that the
    //     control trips -- a store that retains its per-frame set is a leak by
    //     construction, and this is the estimator built to detect exactly that.
    const { report, summary } = h.runOpsGate(fn, { ops: OPS, warmup: WARMUP });
    const bpo = h.bytesPerOp(fn, OPS);
    const gateRed = !report.ok || bpo > 0;

    // Publish metrics for the GATE line (real path only).
    if (!alloc) {
        h.METRICS.gcMajor = summary.gc.major;
        h.METRICS.gcMinor = summary.gc.minor;
        h.METRICS.gcMaxMs = summary.gc.maxMs;
        h.METRICS.allocBytesPerOp = bpo;
    }

    const detail = 'verdict=' + report.verdict + ' source=' + summary.source +
        ' major=' + summary.gc.major + ' minor=' + summary.gc.minor +
        ' maxMs=' + summary.gc.maxMs.toFixed(3) + ' bytes/op=' + bpo.toFixed(1);

    if (!alloc) {
        // The genuine hot path must be green on BOTH gates.
        if (gateRed) h.fail(TIER, 'hot loop allocated: ' + detail, {});
        return;
    }

    // Control mode: the retaining Set<string> store MUST turn the gate red. If it
    // did, the proof stands and this tier throws BY DESIGN (the run exits 1). If
    // it did NOT, the gate cannot catch a store that leaks per frame -- a strictly
    // worse, must-not-ship failure.
    if (!gateRed) {
        h.fail(TIER, 'PROOF BROKEN: retaining Set<string> control did NOT trip ' +
            'the alloc gate (' + detail + ') -- gate is not falsifiable', {});
    }
    h.fail(TIER, 'Set<string> alloc control tripped the gate as expected -- ' +
        'gate is falsifiable (' + detail + ', retained ' + sink.length + ' sets)', {});
}
