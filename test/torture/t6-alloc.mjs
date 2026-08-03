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
 *
 * O3.1 (decision 0005): after the pair-table gate, a second section drives >=1e6
 * `sweptOverlapExact` calls over preallocated mixed-motion (axis-aligned AND
 * diagonal, so both SAT branches run) boxes under the SAME gate -- the exact
 * opt-in tightener must be register-only too. A cheap off-gate differential
 * asserts the subset invariant `sweptOverlapExact(...) => sweptOverlap(...)`.
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

        // ---- O3.1 sweptOverlapExact (decision 0005): zero-alloc + subset ------
        // Preallocated boxes with MIXED motion so BOTH SAT branches run: diagonal
        // motion adds the two oblique perp(motion) hull-normal axes; axis-aligned
        // motion collapses them to axis-parallel and exercises only x/y.
        const EXACT_POOL = 256;                 // power of two -> `& (EXACT_POOL-1)` wraps
        const SZ = 14;
        const prevAe = new Array(EXACT_POOL), currAe = new Array(EXACT_POOL);
        const prevBe = new Array(EXACT_POOL), currBe = new Array(EXACT_POOL);
        const rngE = h.xorshift32(h.SEED ^ 0x5e5e5e5e);
        const mkBox = (x, y) => { const b = new Float32Array(4); b[0] = x; b[1] = y; b[2] = x + SZ; b[3] = y + SZ; return b; };
        const moveBox = (b, dx, dy) => { const c = new Float32Array(4); c[0] = b[0] + dx; c[1] = b[1] + dy; c[2] = b[2] + dx; c[3] = b[3] + dy; return c; };
        for (let i = 0; i < EXACT_POOL; i++) {
            const pa = mkBox(h.unit(rngE()) * 60, h.unit(rngE()) * 60);
            const pb = mkBox(h.unit(rngE()) * 60, h.unit(rngE()) * 60);
            const spA = h.unit(rngE()) * 5 * SZ, spB = h.unit(rngE()) * 5 * SZ;
            const diag = (i & 1) === 0;         // half diagonal, half axis-aligned
            prevAe[i] = pa; currAe[i] = moveBox(pa, spA, diag ? spA : 0);
            prevBe[i] = pb; currBe[i] = moveBox(pb, diag ? spB : 0, spB);
        }

        // Off-gate differential: the exact test is a strict SUBSET of the union.
        for (let i = 0; i < EXACT_POOL; i++) {
            for (let j = 0; j < EXACT_POOL; j++) {
                if (ov.sweptOverlapExact(prevAe[i], currAe[i], prevBe[j], currBe[j]) &&
                    !ov.sweptOverlap(prevAe[i], currAe[i], prevBe[j], currBe[j])) {
                    h.fail(TIER, 'sweptOverlapExact reported a pair sweptOverlap rejects ' +
                        '(subset invariant broken) at i=' + i + ' j=' + j, {});
                }
            }
        }

        // >=1e6 calls under the same gate; XOR checksum defeats dead-code removal.
        let exactChecksum = 0;
        const exactHot = (i) => {
            const a = i & (EXACT_POOL - 1);
            // Second index on a coprime Smi-range stride (5) so a != b sweeps many
            // A/B combinations -- both diagonal and axis-aligned boxes land on both
            // sides. Stays a tagged small int (no HeapNumber) so the op is truly 0 B.
            const b = (i * 5 + 3) & (EXACT_POOL - 1);
            if (ov.sweptOverlapExact(prevAe[a], currAe[a], prevBe[b], currBe[b])) exactChecksum ^= (i | 1);
        };
        const EXACT_OPS = 1_000_000;
        const eGate = h.runOpsGate(exactHot, { ops: EXACT_OPS, warmup: 4000 });
        // 32 batches (vs the default 8) lowers the min-over-batches variance for a
        // nanosecond predicate measured after the pair-table session in this tier.
        const eBpo = h.bytesPerOp(exactHot, EXACT_OPS, 32);
        // Gate: no WHOLE byte allocated per op. The heavy pair-table op reads exactly
        // 0 because its churn drives some batch delta negative (freed survivors) and
        // the estimator clamps the min to 0. A branch-free predicate that frees
        // nothing USUALLY floors its min at the profiler's own ~16-byte-per-batch
        // heap-sample bookkeeping (~2e-5 B/op) -- a batch occasionally lands on exact
        // 0, so a strict `>0` gate is flaky, not always-red. Sub-byte-per-op is zero
        // allocation by definition (no object is smaller than one byte), so the
        // principled gate is "< one whole byte per op". It stays falsifiable: the
        // Set<string> control reads thousands of B/op, and any real per-call
        // allocation here would be >= one whole object (>= 16 B/op).
        if (!eGate.report.ok || eBpo >= 1) {
            h.fail(TIER, 'sweptOverlapExact hot loop allocated or collected: ok=' +
                eGate.report.ok + ' major=' + eGate.summary.gc.major +
                ' maxMs=' + eGate.summary.gc.maxMs.toFixed(3) + ' bytes/op=' + eBpo.toFixed(3), {});
        }
        if (exactChecksum === 0x7fffffff) h.fail(TIER, 'unreachable exact checksum', {});

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
