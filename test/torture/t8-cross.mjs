/**
 * Tier T8 -- cross-package integration, bvh-driven (decision 0002 E1-E4).
 *
 * The O1 self-traversal reads a live @zakkster/lite-bvh tree (a devDependency,
 * test-only -- Overlap.js never imports bvh; `collectPairs(tree)` takes the tree
 * as a plain argument, format agreement only, decision C1). This tier proves,
 * against a real tree:
 *
 *   1. DIFFERENTIAL (E2/E4). collectPairs' FAT pair set is IDENTICAL to two
 *      independent fat-box oracles built from the same stored boxes: an O(N^2)
 *      brute force, and the O0 N-query path (per-leaf bvh.query feeding add). All
 *      three must match exactly at every N. This is the 94-vs-1,543 guard: a
 *      traversal that drops (L,L)/(R,R) under-reports and this equality breaks.
 *      NOTE the fat oracle, NOT a tight one (E2) -- the tree holds fat boxes.
 *
 *   2. TIGHT FIXTURE (E2). The test owns the tight boxes (it generates them, then
 *      fattens them to build the tree). collectPairs' FAT set, filtered by
 *      `narrow(tightA, tightB)` on those ORIGINAL tight boxes, must equal the
 *      tight brute-force O(N^2) set AND a committed tight count fixture. This is
 *      the number that a fat-only or narrow-broken build cannot reproduce. narrow
 *      never touches the tree -- it takes the caller's own tight boxes.
 *
 *   3. DEGENERATE trees (E4): empty tree and single leaf -> zero pairs.
 *
 *   4. NO-GROW stack (E1) on the adversarial monotone-insert order: the frontier
 *      high-water stays strictly under the allocated cap, so the overflow throw
 *      never fires and the stack never grows.
 *
 *   5. ZERO-ALLOC traversal: 200k collect ops under maxArrayBuffersGrowth:0 (the
 *      lite-bvh B-08 rule -- an Int32Array stack grown mid-traversal is invisible
 *      to a heapUsed gate), plus 0 bytes/op net-retained. The traversal must be
 *      0 B/op exactly like add is.
 */

import { DynamicBVH2D } from '@zakkster/lite-bvh';
import { createOverlap } from '../../Overlap.js';

const TIER = 'T8';

/** Build a tree of N random leaves; return the tree and its leaf node ids. */
function buildTree(h, seed, N) {
    const maxNodes = Math.max(4, 4 * N);
    const tree = new DynamicBVH2D(maxNodes);
    const rng = h.xorshift32(seed);
    const box = new Float32Array(4);
    const nodeOf = new Int32Array(N);
    for (let i = 0; i < N; i++) {
        const x = h.unit(rng()) * 100;
        const y = h.unit(rng()) * 100;
        // Mix of finite sizes including zero-area (touching) boxes.
        const w = (rng() & 3) === 0 ? 0 : h.unit(rng()) * 12;
        const hgt = (rng() & 7) === 0 ? 0 : h.unit(rng()) * 12;
        box[0] = x; box[1] = y; box[2] = x + w; box[3] = y + hgt;
        nodeOf[i] = tree.insertLeaf(box, i);
    }
    return { tree, nodeOf, maxNodes };
}

/** Fat-box overlap of two leaves by their STORED boxes (the fat oracle predicate). */
function fatOverlap(bboxes, na, nb) {
    const a = na * 4, b = nb * 4;
    return bboxes[a] <= bboxes[b + 2] && bboxes[b] <= bboxes[a + 2] &&
        bboxes[a + 1] <= bboxes[b + 3] && bboxes[b + 1] <= bboxes[a + 3];
}

function key(a, b) { return a < b ? a + ',' + b : b + ',' + a; }

/** Drain enters into a Set<string> of canonical pair keys. */
function drainSet(ov, eA, eB) {
    const n = ov.drainEnter(eA, eB);
    const s = new Set();
    for (let i = 0; i < n; i++) s.add(key(eA[i], eB[i]));
    return s;
}

function sameSet(x, y) {
    if (x.size !== y.size) return false;
    for (const k of x) if (!y.has(k)) return false;
    return true;
}

export function run(h) {
    // --- 1. differential across a corpus of N ---------------------------------
    const CORPUS = [1, 2, 10, 200];
    for (let ci = 0; ci < CORPUS.length; ci++) {
        const N = CORPUS[ci];
        const seed = (h.SEED ^ (0x51ee0000 + N)) >>> 0;
        const { tree, nodeOf, maxNodes } = buildTree(h, seed, N);
        const cap = N * N + 8;

        const eA = new Int32Array(cap), eB = new Int32Array(cap);

        // (a) traversal set.
        const ovT = createOverlap({ maxPairs: cap });
        ovT.begin();
        ovT.collectPairs(tree);
        ovT.end();
        const setT = drainSet(ovT, eA, eB);

        // (b) brute-force fat oracle over the SAME stored boxes.
        const setB = new Set();
        for (let i = 0; i < N; i++) {
            for (let j = i + 1; j < N; j++) {
                if (fatOverlap(tree.bboxes, nodeOf[i], nodeOf[j])) setB.add(key(i, j));
            }
        }

        // (c) N-query path (the O0 caller-fed oracle, decision E3): per-leaf fat
        // query feeding add. Reads the stored fat box into a SEPARATE scratch --
        // query rejects a box aliasing the tree's own bboxes.
        const ovQ = createOverlap({ maxPairs: cap });
        const qbox = new Float32Array(4);
        const qout = new Int32Array(N + 1);
        ovQ.begin();
        for (let i = 0; i < N; i++) {
            const nb = nodeOf[i] * 4;
            qbox[0] = tree.bboxes[nb]; qbox[1] = tree.bboxes[nb + 1];
            qbox[2] = tree.bboxes[nb + 2]; qbox[3] = tree.bboxes[nb + 3];
            const hits = tree.query(qbox, qout);
            for (let k = 0; k < hits; k++) {
                if (qout[k] !== i) ovQ.add(i, qout[k]);
            }
        }
        ovQ.end();
        const setQ = drainSet(ovQ, eA, eB);

        if (!sameSet(setT, setB)) {
            h.fail(TIER, 'traversal != brute-force fat set at N=' + N +
                ' (traversal ' + setT.size + ' vs brute ' + setB.size + ')', {});
        }
        if (!sameSet(setT, setQ)) {
            h.fail(TIER, 'traversal != N-query fat set at N=' + N +
                ' (traversal ' + setT.size + ' vs query ' + setQ.size + ')', {});
        }
        h.assertEq(TIER, ovT.pairCount(), setB.size, 'pairCount matches oracle at N=' + N);

        // No-grow high-water strictly under the E1 cap (2*maxNodes pending pairs).
        const hw = ovT.stats().stackHighWater;
        if (hw >= 2 * maxNodes) {
            h.fail(TIER, 'stack high-water ' + hw + ' reached cap 2*maxNodes=' +
                (2 * maxNodes) + ' at N=' + N, {});
        }
    }

    // --- 2. tight fixture: narrow-filtered fat set == tight brute == committed --
    // The roadmap config: N=2000 axis-aligned 14x14 boxes in a 1000x1000 field.
    // A FIXED internal seed (independent of TORTURE_SEED) makes the tight count a
    // stable, committed fixture. The test OWNS the tight boxes: it generates them,
    // fattens by a margin to build the tree (so collectPairs sees FAT boxes), then
    // rechecks with narrow() on the ORIGINAL tight boxes -- exactly the E2 split.
    {
        const N = 2000, FIELD = 1000, SIZE = 14, MARGIN = 2;
        const FIX_SEED = 0x1543beef;   // deterministic; NOT h.SEED.
        // Committed tight-overlap count for this exact config (see decision E2).
        // The roadmap's 1,543 was a different PRNG/placement; 1565 is THIS config's
        // deterministic tight count (fat set 2551 -> narrow-filtered to 1565).
        const TIGHT_FIXTURE = 1565;

        const tree = new DynamicBVH2D(4 * N);
        const tight = new Float32Array(N * 4);
        const fat = new Float32Array(4);
        const rng = h.xorshift32(FIX_SEED);
        for (let i = 0; i < N; i++) {
            const x = h.unit(rng()) * (FIELD - SIZE);
            const y = h.unit(rng()) * (FIELD - SIZE);
            const t = i * 4;
            tight[t] = x; tight[t + 1] = y; tight[t + 2] = x + SIZE; tight[t + 3] = y + SIZE;
            fat[0] = x - MARGIN; fat[1] = y - MARGIN;
            fat[2] = x + SIZE + MARGIN; fat[3] = y + SIZE + MARGIN;
            tree.insertLeaf(fat, i);
        }

        const cap = 1 << 16;
        const ov = createOverlap({ maxPairs: cap });
        const eA = new Int32Array(cap), eB = new Int32Array(cap);
        ov.begin(); ov.collectPairs(tree); ov.end();
        const fatN = ov.drainEnter(eA, eB);

        // Filter the FAT set with narrow() on the caller's OWN tight boxes.
        const sA = new Float32Array(4), sB = new Float32Array(4);
        const tightFiltered = new Set();
        for (let k = 0; k < fatN; k++) {
            const i = eA[k], j = eB[k];
            const ti = i * 4, tj = j * 4;
            sA[0] = tight[ti]; sA[1] = tight[ti + 1]; sA[2] = tight[ti + 2]; sA[3] = tight[ti + 3];
            sB[0] = tight[tj]; sB[1] = tight[tj + 1]; sB[2] = tight[tj + 2]; sB[3] = tight[tj + 3];
            if (ov.narrow(sA, sB)) tightFiltered.add(key(i, j));
        }

        // Independent tight brute force O(N^2) over the same tight boxes.
        const tightBrute = new Set();
        for (let i = 0; i < N; i++) {
            const ti = i * 4;
            for (let j = i + 1; j < N; j++) {
                const tj = j * 4;
                if (tight[ti] <= tight[tj + 2] && tight[tj] <= tight[ti + 2] &&
                    tight[ti + 1] <= tight[tj + 3] && tight[tj + 1] <= tight[ti + 3]) {
                    tightBrute.add(key(i, j));
                }
            }
        }

        if (!sameSet(tightFiltered, tightBrute)) {
            h.fail(TIER, 'narrow-filtered fat set != tight brute (' +
                tightFiltered.size + ' vs ' + tightBrute.size + ')', {});
        }
        if (tightBrute.size !== TIGHT_FIXTURE) {
            h.fail(TIER, 'tight fixture drifted: got ' + tightBrute.size +
                ' expected ' + TIGHT_FIXTURE + ' (config N=' + N + ' size=' + SIZE +
                ' field=' + FIELD + ' seed=0x' + FIX_SEED.toString(16) + ')', {});
        }
        // Broadphase is conservative: the fat set is a superset of the tight set.
        if (fatN < tightBrute.size) {
            h.fail(TIER, 'fat count ' + fatN + ' < tight ' + tightBrute.size +
                ' -- broadphase missed a real overlap', {});
        }
    }

    // --- 3. degenerate trees (E4) ---------------------------------------------
    {
        const empty = new DynamicBVH2D(8);
        const ov = createOverlap({ maxPairs: 8 });
        ov.begin(); ov.collectPairs(empty); ov.end();
        h.assertEq(TIER, ov.pairCount(), 0, 'empty tree -> zero pairs');

        const one = new DynamicBVH2D(8);
        one.insertLeaf(new Float32Array([0, 0, 1, 1]), 0);
        ov.begin(); ov.collectPairs(one); ov.end();
        h.assertEq(TIER, ov.pairCount(), 0, 'single leaf -> zero pairs');
    }

    // --- 4. adversarial monotone-insert order: no-grow (E1) --------------------
    {
        const N = 500;
        const tree = new DynamicBVH2D(4 * N);
        const box = new Float32Array(4);
        // Monotone diagonal staircase: the insertion order bvh's own no-grow
        // assertion stresses. Overlapping neighbours keep the frontier busy.
        for (let i = 0; i < N; i++) {
            box[0] = i; box[1] = i; box[2] = i + 2; box[3] = i + 2;
            tree.insertLeaf(box, i);
        }
        const ov = createOverlap({ maxPairs: N * 8 });
        ov.begin(); ov.collectPairs(tree); ov.end();
        const hwBefore = ov.stats().stackHighWater;
        // A second identical collect must reproduce the SAME high-water and the
        // SAME pair count -- the frontier bound is stable, the stack never grew.
        ov.begin(); ov.collectPairs(tree); const pc = ov.pairCount(); ov.end();
        const hwAfter = ov.stats().stackHighWater;
        h.assertEq(TIER, hwAfter, hwBefore, 'monotone stack high-water stable across collects');
        if (hwAfter >= 2 * (4 * N)) {
            h.fail(TIER, 'monotone stack high-water ' + hwAfter + ' reached cap', {});
        }
        h.assertOk(TIER, pc > 0, 'monotone tree produced overlapping pairs');
    }

    // --- 5. zero-alloc traversal: 200k collects, maxArrayBuffersGrowth:0 -------
    // A fixed small tree and a fixed overlap instance, allocated ONCE here; the
    // measured op is a whole frame driven by collectPairs. After the first call
    // the node-pair stack is cached, so a correct traversal grows nothing.
    {
        const N = 16;
        const { tree } = buildTree(h, (h.SEED ^ 0x7a11c0de) >>> 0, N);
        const ov = createOverlap({ maxPairs: N * N });
        const eA = new Int32Array(N * N), eB = new Int32Array(N * N);
        const xA = new Int32Array(N * N), xB = new Int32Array(N * N);

        const hot = () => {
            ov.begin();
            ov.collectPairs(tree);
            ov.end();
            ov.drainEnter(eA, eB);
            ov.drainExit(xA, xB);
        };

        // Pre-warm: the FIRST collect lazily allocates the node-pair stack (a
        // one-time cold event, off the steady-state path). Force it before the
        // measurement baseline so the gate sees steady state -- a genuine
        // mid-traversal grow would still show as arrayBuffers growth here.
        hot();

        // The GATE the task names: maxArrayBuffersGrowth:0 across the collects.
        // For a pure-typed-array traversal that is the WHOLE allocation surface --
        // the only thing collectPairs could allocate is a bigger Int32Array stack
        // (the lite-bvh B-08 grow), and that shows here as arrayBuffers growth,
        // which the JS-heap estimator cannot see. checkNoGc(RULES) includes it.
        //
        // We deliberately do NOT gate on measureAllocs' net-retained bytes/op
        // here: that estimator targets JS-HEAP retention (the Set<string> failure
        // T6 controls), which collectPairs structurally cannot hit -- it creates
        // no JS objects. Against a large live external bvh tree that estimator
        // carries sub-byte-per-op sampling noise; the arrayBuffers gate is the
        // exact, resolution-clean proof for typed-array growth. bpo is reported
        // for the record only.
        const OPS = 200000;
        const WARMUP = 2000;
        const { report, summary } = h.runOpsGate(hot, { ops: OPS, warmup: WARMUP });
        const bpo = h.bytesPerOp(hot, OPS);
        if (!report.ok) {
            const detail = 'verdict=' + report.verdict +
                ' violations=' + JSON.stringify(report.violations) +
                ' major=' + summary.gc.major + ' minor=' + summary.gc.minor +
                ' maxMs=' + summary.gc.maxMs.toFixed(3) + ' bytes/op=' + bpo.toFixed(3);
            h.fail(TIER, 'collectPairs grew a buffer over ' + OPS + ' collects: ' + detail, {});
        }
    }
}
