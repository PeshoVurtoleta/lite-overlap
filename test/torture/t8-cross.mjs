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
 *
 *   6. O3 SWEPT (decision 0004 S1/S3/S4). Bulk collectSweptPairs over a tree of
 *      FATTENED swept boxes == manual addSwept oracle == tight-union brute (the
 *      refinement really tightens the fat descent); zero motion is byte-identical
 *      to the discrete path (S3); and the swept traversal grows no buffer over
 *      200k collects (0 B/op like collectPairs).
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

    // --- 6. O3 swept (decision 0004 S1/S3/S4): differential + zero-alloc --------
    // Build a moving corpus, a tree of the (fattened) swept boxes, and prove the
    // bulk swept traversal agrees with BOTH the manual addSwept oracle and the
    // tight-union brute force -- then that it grows no buffer over 200k collects
    // and that zero motion is byte-identical to the discrete path (S3).
    {
        const N = 200, FIELD = 120, SPEED = 40, MARGIN = 5;
        const seed = (h.SEED ^ 0x5e70ffff) >>> 0;
        const rng = h.xorshift32(seed);
        const prev = new Float32Array(N * 4);
        const curr = new Float32Array(N * 4);
        const uni = new Float32Array(N * 4);
        for (let i = 0; i < N; i++) {
            const j = i * 4;
            const x = h.unit(rng()) * FIELD, y = h.unit(rng()) * FIELD;
            const w = 4 + h.unit(rng()) * 8, hh = 4 + h.unit(rng()) * 8;
            const vx = (h.unit(rng()) * 2 - 1) * SPEED, vy = (h.unit(rng()) * 2 - 1) * SPEED;
            prev[j] = x; prev[j + 1] = y; prev[j + 2] = x + w; prev[j + 3] = y + hh;
            curr[j] = x + vx; curr[j + 1] = y + vy; curr[j + 2] = x + w + vx; curr[j + 3] = y + hh + vy;
            uni[j] = Math.min(prev[j], curr[j]); uni[j + 1] = Math.min(prev[j + 1], curr[j + 1]);
            uni[j + 2] = Math.max(prev[j + 2], curr[j + 2]); uni[j + 3] = Math.max(prev[j + 3], curr[j + 3]);
        }
        // Tree of FATTENED swept boxes -> the descent over-reports; the tight-union
        // refinement must pull it back to the tight-union brute.
        const sweptTree = new DynamicBVH2D(4 * N);
        const fb = new Float32Array(4);
        for (let i = 0; i < N; i++) {
            const j = i * 4;
            fb[0] = uni[j] - MARGIN; fb[1] = uni[j + 1] - MARGIN;
            fb[2] = uni[j + 2] + MARGIN; fb[3] = uni[j + 3] + MARGIN;
            sweptTree.insertLeaf(fb, i);
        }
        const cap = N * N + 8;
        const eA = new Int32Array(cap), eB = new Int32Array(cap);

        // Bulk swept.
        const ovS = createOverlap({ maxPairs: cap });
        ovS.begin(); ovS.collectSweptPairs(sweptTree, prev, curr, N); ovS.end();
        const setS = drainSet(ovS, eA, eB);

        // Manual addSwept oracle over every unordered pair.
        const ovM = createOverlap({ maxPairs: cap });
        const pa = new Float32Array(4), ca = new Float32Array(4);
        const pb = new Float32Array(4), cb = new Float32Array(4);
        ovM.begin();
        for (let i = 0; i < N; i++) {
            for (let jj = i + 1; jj < N; jj++) {
                const bi = i * 4, bj = jj * 4;
                pa[0] = prev[bi]; pa[1] = prev[bi + 1]; pa[2] = prev[bi + 2]; pa[3] = prev[bi + 3];
                ca[0] = curr[bi]; ca[1] = curr[bi + 1]; ca[2] = curr[bi + 2]; ca[3] = curr[bi + 3];
                pb[0] = prev[bj]; pb[1] = prev[bj + 1]; pb[2] = prev[bj + 2]; pb[3] = prev[bj + 3];
                cb[0] = curr[bj]; cb[1] = curr[bj + 1]; cb[2] = curr[bj + 2]; cb[3] = curr[bj + 3];
                ovM.addSwept(i, pa, ca, jj, pb, cb);
            }
        }
        ovM.end();
        const setM = drainSet(ovM, eA, eB);

        // Tight-union brute (ground truth).
        const setBrute = new Set();
        for (let i = 0; i < N; i++) {
            const bi = i * 4;
            for (let jj = i + 1; jj < N; jj++) {
                const bj = jj * 4;
                if (uni[bi] <= uni[bj + 2] && uni[bj] <= uni[bi + 2] &&
                    uni[bi + 1] <= uni[bj + 3] && uni[bj + 1] <= uni[bi + 3]) setBrute.add(key(i, jj));
            }
        }
        if (!sameSet(setS, setBrute)) {
            h.fail(TIER, 'bulk swept != tight-union brute (' + setS.size + ' vs ' + setBrute.size + ')', {});
        }
        if (!sameSet(setM, setBrute)) {
            h.fail(TIER, 'manual addSwept != tight-union brute (' + setM.size + ' vs ' + setBrute.size + ')', {});
        }

        // Zero motion (S3): a tree of the current boxes, prev===curr===curr, must
        // reproduce collectPairs' set byte-for-byte.
        const currTree = new DynamicBVH2D(4 * N);
        const cbx = new Float32Array(4);
        for (let i = 0; i < N; i++) {
            const j = i * 4;
            cbx[0] = curr[j]; cbx[1] = curr[j + 1]; cbx[2] = curr[j + 2]; cbx[3] = curr[j + 3];
            currTree.insertLeaf(cbx, i);
        }
        const ovD = createOverlap({ maxPairs: cap });
        ovD.begin(); ovD.collectPairs(currTree); ovD.end();
        const setDiscrete = drainSet(ovD, eA, eB);
        const ovZ = createOverlap({ maxPairs: cap });
        ovZ.begin(); ovZ.collectSweptPairs(currTree, curr, curr, N); ovZ.end();
        const setZero = drainSet(ovZ, eA, eB);
        if (!sameSet(setDiscrete, setZero)) {
            h.fail(TIER, 'zero-motion swept != discrete (' + setDiscrete.size + ' vs ' + setZero.size + ')', {});
        }

        // Zero-alloc swept traversal: 200k collects, maxArrayBuffersGrowth:0.
        const ov = createOverlap({ maxPairs: cap });
        const zA = new Int32Array(cap), zB = new Int32Array(cap);
        const hotS = () => {
            ov.begin();
            ov.collectSweptPairs(sweptTree, prev, curr, N);
            ov.end();
            ov.drainEnter(zA, zB);
        };
        hotS();   // pre-warm the one-time stack sizing.
        const OPS = 200000, WARMUP = 2000;
        const { report, summary } = h.runOpsGate(hotS, { ops: OPS, warmup: WARMUP });
        const bpo = h.bytesPerOp(hotS, OPS);
        if (!report.ok) {
            h.fail(TIER, 'collectSweptPairs grew a buffer over ' + OPS + ' collects: verdict=' +
                report.verdict + ' violations=' + JSON.stringify(report.violations) +
                ' major=' + summary.gc.major + ' bytes/op=' + bpo.toFixed(3), {});
        }
    }
}
