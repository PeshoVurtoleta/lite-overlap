/**
 * @zakkster/lite-overlap -- O1 traversal boundary matrix (final QA, node:test).
 *
 * Pins the four O1 decisions (decisions/0002-traversal.md) with a dedicated
 * boundary matrix over `collectPairs(tree)` and `narrow(boxA, boxB)`, the two
 * entry points O1 adds. Does NOT duplicate `test/torture/t8-cross.mjs` (the
 * coder's fat differential + committed tight fixture at N=2000/seed
 * 0x1543beef/1565) -- it pins its OWN independent committed fixture (section 2)
 * and adds the boundary-matrix cases the torture tier does not cover: 0/1/N-1/
 * N/N+1 corpora, null/undefined/NaN/-0 tree/root inputs, duplicate collectPairs
 * within one frame, mutate-tree-between-calls, multi-source composition
 * (re-entrant use of the new entry point), corrupt-tree fail-closed throws at
 * three distinct traversal depths, and the narrow() unit matrix.
 *
 *   E1 -- stack no-grow, high-water bound, smallest-cap no-overflow.
 *   E2 -- fat-bound pairs, narrow() tight recheck, fat >= tight always.
 *   E3 -- collectPairs feeds add() only; composition inside one frame.
 *   E4 -- self-pair rule (degenerate trees), fail-closed corrupt-tree throws.
 *
 * `@zakkster/lite-bvh` is imported as a devDependency, test-only, to build real
 * trees for the differential -- exactly as `Overlap.js` itself never does
 * (decision C1: format agreement only, no runtime import).
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

/** Drain enters into a Set<string> of canonical pair keys. */
function drainSet(ov, eA, eB) {
    const n = ov.drainEnter(eA, eB);
    const s = new Set();
    for (let i = 0; i < n; i++) s.add(key(eA[i], eB[i]));
    return s;
}

/** Fat-box overlap of two nodes by their STORED (fat) boxes -- the fat oracle predicate. */
function fatOverlap(bboxes, na, nb) {
    const a = na * 4, b = nb * 4;
    return bboxes[a] <= bboxes[b + 2] && bboxes[b] <= bboxes[a + 2] &&
        bboxes[a + 1] <= bboxes[b + 3] && bboxes[b + 1] <= bboxes[a + 3];
}

/**
 * Build a tree of N leaves. A fraction of the leaves are forced onto ONE shared
 * point (a fully-overlapping stack -- the E4 self-pair clique hazard), and a
 * fraction of both the stacked and scattered leaves are zero-area (the E2/E4
 * degenerate-box hazard). Deterministic per (seed, N).
 */
function buildCorpusTree(seed, N) {
    const rng = xorshift32(seed);
    const maxNodes = Math.max(4, 4 * N);
    const tree = new DynamicBVH2D(maxNodes);
    const nodeOf = new Int32Array(N);
    const box = new Float32Array(4);
    const stackCount = N >= 5 ? Math.floor(N / 5) : 0;
    const stackX = unit(rng()) * 50;
    const stackY = unit(rng()) * 50;
    for (let i = 0; i < N; i++) {
        let x, y, w, h;
        if (i < stackCount) {
            x = stackX; y = stackY;
            w = (rng() & 3) === 0 ? 0 : unit(rng()) * 5;
            h = (rng() & 7) === 0 ? 0 : unit(rng()) * 5;
        } else {
            x = unit(rng()) * 100;
            y = unit(rng()) * 100;
            w = (rng() & 3) === 0 ? 0 : unit(rng()) * 12;
            h = (rng() & 7) === 0 ? 0 : unit(rng()) * 12;
        }
        box[0] = x; box[1] = y; box[2] = x + w; box[3] = y + h;
        nodeOf[i] = tree.insertLeaf(box, i);
    }
    return { tree, nodeOf, maxNodes, stackCount };
}

/** O(N^2) fat-box brute force over the SAME stored (fattened) boxes. */
function bruteForceFat(tree, nodeOf, N) {
    const set = new Set();
    for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
            if (fatOverlap(tree.bboxes, nodeOf[i], nodeOf[j])) set.add(key(i, j));
        }
    }
    return set;
}

/** O0 caller-fed N-query path (decision E3's oracle): per-leaf fat query feeding add. */
function nQueryOracle(tree, nodeOf, N, cap) {
    const ov = createOverlap({ maxPairs: cap });
    const qbox = new Float32Array(4);
    const qout = new Int32Array(N + 1);
    ov.begin();
    for (let i = 0; i < N; i++) {
        const nb = nodeOf[i] * 4;
        qbox[0] = tree.bboxes[nb]; qbox[1] = tree.bboxes[nb + 1];
        qbox[2] = tree.bboxes[nb + 2]; qbox[3] = tree.bboxes[nb + 3];
        const hits = tree.query(qbox, qout);
        for (let k = 0; k < hits; k++) if (qout[k] !== i) ov.add(i, qout[k]);
    }
    ov.end();
    const cA = new Int32Array(cap), cB = new Int32Array(cap);
    return drainSet(ov, cA, cB);
}

// =============================================================================
// ASSERTION 1 -- differential vs O0 caller-fed path AND brute-force, FAT oracle
// (E2, no conflation). N in {1, 2, 10, 200, 1000}. Includes zero-area boxes and
// fully-overlapping stacks in the corpus (buildCorpusTree, above).
// =============================================================================

const CORPUS_N = [1, 2, 10, 200, 1000];

for (const N of CORPUS_N) {
    test('differential vs brute-force AND N-query fat oracle, N=' + N, () => {
        const seed = (0x51ee0000 ^ N) >>> 0;
        const { tree, nodeOf, maxNodes, stackCount } = buildCorpusTree(seed, N);
        const cap = (N * (N - 1)) / 2 + 8;

        const ovT = createOverlap({ maxPairs: cap });
        const eA = new Int32Array(cap), eB = new Int32Array(cap);
        ovT.begin();
        ovT.collectPairs(tree);
        ovT.end();
        const setT = drainSet(ovT, eA, eB);

        const setB = bruteForceFat(tree, nodeOf, N);
        const setQ = nQueryOracle(tree, nodeOf, N, cap);

        assert.ok(
            sameSet(setT, setB),
            'traversal != brute-force fat set at N=' + N + ' seed=0x' + seed.toString(16) +
            ' (traversal ' + setT.size + ' vs brute ' + setB.size + ')',
        );
        assert.ok(
            sameSet(setT, setQ),
            'traversal != N-query fat set at N=' + N + ' seed=0x' + seed.toString(16) +
            ' (traversal ' + setT.size + ' vs query ' + setQ.size + ')',
        );
        assert.equal(ovT.pairCount(), setB.size, 'pairCount matches the oracle at N=' + N);

        // The stacked clique (if any) must be fully present: every pair among the
        // first `stackCount` ids is in the set (the 94-vs-1,543 guard, spot-checked
        // directly against a hand-verifiable clique rather than only cardinality).
        if (stackCount > 1) {
            for (let i = 0; i < stackCount; i++) {
                for (let j = i + 1; j < stackCount; j++) {
                    assert.ok(setT.has(key(i, j)), 'stack clique missing (' + i + ',' + j + ') at N=' + N);
                }
            }
        }

        // E1: high-water strictly under the allocated cap (2*maxNodes pending pairs).
        const hw = ovT.stats().stackHighWater;
        assert.ok(hw < 2 * maxNodes, 'stack high-water ' + hw + ' reached cap at N=' + N);
    });
}

// =============================================================================
// ASSERTION 2 -- tight fixture via narrow (E2). Own tight boxes, fatten to build
// the tree, collectPairs -> fat set, filter with narrow(tightA, tightB) on the
// ORIGINAL tight boxes, assert == tight brute-force. A committed NUMBER, and
// fat-count >= tight-count always (conservatism).
//
// Config (independently chosen from t8-cross's N=2000/1565 fixture, per the QA
// instructions): N=800 axis-aligned 10x10 boxes in a 600x600 field, margin 1.5,
// FIXED seed 0xABCD1234. Verified by an independent standalone computation:
//   fat=578, tight=347 (committed here).
// =============================================================================

test('tight fixture (E2): narrow-filtered fat set == tight brute force == committed numbers', () => {
    const N = 800, FIELD = 600, SIZE = 10, MARGIN = 1.5;
    const FIX_SEED = 0xABCD1234; // deterministic; independent of any TORTURE_SEED.
    const FAT_FIXTURE = 578;
    const TIGHT_FIXTURE = 347;

    const rng = xorshift32(FIX_SEED);
    const tree = new DynamicBVH2D(4 * N);
    const tight = new Float32Array(N * 4);
    const fat = new Float32Array(4);
    for (let i = 0; i < N; i++) {
        const x = unit(rng()) * (FIELD - SIZE);
        const y = unit(rng()) * (FIELD - SIZE);
        const t = i * 4;
        tight[t] = x; tight[t + 1] = y; tight[t + 2] = x + SIZE; tight[t + 3] = y + SIZE;
        fat[0] = x - MARGIN; fat[1] = y - MARGIN;
        fat[2] = x + SIZE + MARGIN; fat[3] = y + SIZE + MARGIN;
        tree.insertLeaf(fat, i);
    }

    const cap = 1 << 12;
    const ov = createOverlap({ maxPairs: cap });
    const eA = new Int32Array(cap), eB = new Int32Array(cap);
    ov.begin(); ov.collectPairs(tree); ov.end();
    const fatN = ov.drainEnter(eA, eB);

    assert.equal(fatN, FAT_FIXTURE, 'committed FAT fixture drifted, got ' + fatN);

    const sA = new Float32Array(4), sB = new Float32Array(4);
    const tightFiltered = new Set();
    for (let k = 0; k < fatN; k++) {
        const i = eA[k], j = eB[k];
        const ti = i * 4, tj = j * 4;
        sA[0] = tight[ti]; sA[1] = tight[ti + 1]; sA[2] = tight[ti + 2]; sA[3] = tight[ti + 3];
        sB[0] = tight[tj]; sB[1] = tight[tj + 1]; sB[2] = tight[tj + 2]; sB[3] = tight[tj + 3];
        if (ov.narrow(sA, sB)) tightFiltered.add(key(i, j));
    }

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

    assert.ok(sameSet(tightFiltered, tightBrute), 'narrow-filtered fat set != tight brute force');
    assert.equal(tightBrute.size, TIGHT_FIXTURE, 'committed TIGHT fixture drifted, got ' + tightBrute.size);
    assert.ok(fatN >= tightBrute.size, 'fat count must be >= tight count (conservatism, E2)');
});

// A second, much smaller config -- proves the conservatism inequality is not an
// artefact of one particular N/margin combination.
for (const [N, FIELD, SIZE, MARGIN, seedHex] of [
    [5, 20, 4, 1, 0x1],
    [50, 200, 8, 3, 0x2],
    [100, 100, 20, 5, 0x3], // dense field: heavy overlap, margin large relative to size
]) {
    test('fat >= tight conservatism holds, N=' + N + ' margin=' + MARGIN, () => {
        const rng = xorshift32(seedHex);
        const tree = new DynamicBVH2D(4 * N);
        const tight = new Float32Array(N * 4);
        const fat = new Float32Array(4);
        for (let i = 0; i < N; i++) {
            const x = unit(rng()) * (FIELD - SIZE);
            const y = unit(rng()) * (FIELD - SIZE);
            const t = i * 4;
            tight[t] = x; tight[t + 1] = y; tight[t + 2] = x + SIZE; tight[t + 3] = y + SIZE;
            fat[0] = x - MARGIN; fat[1] = y - MARGIN;
            fat[2] = x + SIZE + MARGIN; fat[3] = y + SIZE + MARGIN;
            tree.insertLeaf(fat, i);
        }
        const cap = (N * (N - 1)) / 2 + 8;
        const ov = createOverlap({ maxPairs: cap });
        const eA = new Int32Array(cap), eB = new Int32Array(cap);
        ov.begin(); ov.collectPairs(tree); ov.end();
        const fatN = ov.drainEnter(eA, eB);

        let tightN = 0;
        for (let i = 0; i < N; i++) {
            const ti = i * 4;
            for (let j = i + 1; j < N; j++) {
                const tj = j * 4;
                if (tight[ti] <= tight[tj + 2] && tight[tj] <= tight[ti + 2] &&
                    tight[ti + 1] <= tight[tj + 3] && tight[tj + 1] <= tight[ti + 3]) tightN++;
            }
        }
        assert.ok(fatN >= tightN, 'fat=' + fatN + ' < tight=' + tightN + ' at N=' + N + ' -- missed a real overlap');
    });
}

// =============================================================================
// ASSERTION 3 -- degenerate trees, each pinned with an exact expected count (E4).
// =============================================================================

test('degenerate: empty tree -> zero pairs, no throw, no negative index', () => {
    const tree = new DynamicBVH2D(8);
    const ov = createOverlap({ maxPairs: 8 });
    assert.equal(tree.root, -1, 'sanity: empty tree has root -1');
    assert.doesNotThrow(() => { ov.begin(); ov.collectPairs(tree); ov.end(); });
    assert.equal(ov.pairCount(), 0);
});

test('degenerate: one leaf -> zero pairs', () => {
    const tree = new DynamicBVH2D(8);
    tree.insertLeaf(new Float32Array([0, 0, 1, 1]), 0);
    const ov = createOverlap({ maxPairs: 8 });
    ov.begin(); ov.collectPairs(tree); ov.end();
    assert.equal(ov.pairCount(), 0);
});

test('degenerate: two leaves, overlapping -> exactly one pair', () => {
    const tree = new DynamicBVH2D(8);
    tree.insertLeaf(new Float32Array([0, 0, 10, 10]), 0);
    tree.insertLeaf(new Float32Array([5, 5, 15, 15]), 1);
    const ov = createOverlap({ maxPairs: 8 });
    const eA = new Int32Array(8), eB = new Int32Array(8);
    ov.begin(); ov.collectPairs(tree); ov.end();
    assert.equal(ov.pairCount(), 1);
    assert.equal(ov.drainEnter(eA, eB), 1);
    assert.equal(key(eA[0], eB[0]), '0,1');
});

test('degenerate: two leaves, disjoint -> zero pairs', () => {
    const tree = new DynamicBVH2D(8);
    tree.insertLeaf(new Float32Array([0, 0, 5, 5]), 0);
    tree.insertLeaf(new Float32Array([100, 100, 105, 105]), 1);
    const ov = createOverlap({ maxPairs: 8 });
    ov.begin(); ov.collectPairs(tree); ov.end();
    assert.equal(ov.pairCount(), 0);
});

test('degenerate: all leaves identical -> full N*(N-1)/2 clique (the (L,L)/(R,R) proof)', () => {
    const N = 40;
    const tree = new DynamicBVH2D(4 * N);
    for (let i = 0; i < N; i++) tree.insertLeaf(new Float32Array([0, 0, 10, 10]), i);
    const expected = (N * (N - 1)) / 2; // 780
    const ov = createOverlap({ maxPairs: expected + 8 });
    ov.begin(); ov.collectPairs(tree); ov.end();
    assert.equal(ov.pairCount(), expected, 'identical-box clique must be the full N*(N-1)/2, not a root-straddling subset');
});

test('degenerate: all leaves at one point (zero-area) -> full N*(N-1)/2 clique', () => {
    const N = 20;
    const tree = new DynamicBVH2D(4 * N);
    for (let i = 0; i < N; i++) tree.insertLeaf(new Float32Array([3, 3, 3, 3]), i);
    const expected = (N * (N - 1)) / 2; // 190
    const ov = createOverlap({ maxPairs: expected + 8 });
    ov.begin(); ov.collectPairs(tree); ov.end();
    assert.equal(ov.pairCount(), expected, 'zero-area clique must be exact');
});

test('degenerate: single row -> exactly N-1 adjacent-overlap pairs, no cross-row skip', () => {
    // box i = [3i, 0, 3i+5, 5]; neighbours (spacing 3 < width 5) overlap, and
    // i vs i+2 are disjoint by exactly 1 unit (3i+5 vs 3(i+2)=3i+6): a clean,
    // hand-verifiable exact count.
    const N = 10;
    const tree = new DynamicBVH2D(4 * N);
    for (let i = 0; i < N; i++) tree.insertLeaf(new Float32Array([3 * i, 0, 3 * i + 5, 5]), i);
    const ov = createOverlap({ maxPairs: 32 });
    const eA = new Int32Array(32), eB = new Int32Array(32);
    ov.begin(); ov.collectPairs(tree); ov.end();
    assert.equal(ov.pairCount(), N - 1, 'exactly N-1 adjacent pairs in a single row');
    const got = drainSet(ov, eA, eB);
    for (let i = 0; i < N - 1; i++) assert.ok(got.has(key(i, i + 1)), 'missing adjacent pair (' + i + ',' + (i + 1) + ')');
});

// =============================================================================
// ASSERTION 4 -- stack no-grow high-water (E1).
// =============================================================================

test('E1: monotone-insert adversarial order -- high-water > 0, strictly < cap, stable across collects', () => {
    const N = 500;
    const maxNodes = 4 * N;
    const tree = new DynamicBVH2D(maxNodes);
    const box = new Float32Array(4);
    for (let i = 0; i < N; i++) {
        box[0] = i; box[1] = i; box[2] = i + 2; box[3] = i + 2;
        tree.insertLeaf(box, i);
    }
    const ov = createOverlap({ maxPairs: N * 8 });
    ov.begin(); ov.collectPairs(tree); ov.end();
    const hwBefore = ov.stats().stackHighWater;
    assert.ok(hwBefore > 0, 'high-water must be nonzero after a real collect');
    assert.ok(hwBefore < 2 * maxNodes, 'high-water ' + hwBefore + ' reached the cap ' + (2 * maxNodes));

    ov.begin(); ov.collectPairs(tree); ov.end();
    const hwAfter = ov.stats().stackHighWater;
    assert.equal(hwAfter, hwBefore, 'high-water must be stable across repeated collects on the same tree');
});

test('E1: all-identical corpus drives the widest self-pair frontier -- still strictly under cap', () => {
    const N = 300;
    const maxNodes = 4 * N;
    const tree = new DynamicBVH2D(maxNodes);
    for (let i = 0; i < N; i++) tree.insertLeaf(new Float32Array([0, 0, 10, 10]), i);
    const cap = (N * (N - 1)) / 2 + 8;
    const ov = createOverlap({ maxPairs: cap });
    ov.begin(); ov.collectPairs(tree); ov.end();
    const hw = ov.stats().stackHighWater;
    assert.ok(hw > 0, 'high-water must be nonzero');
    assert.ok(hw < 2 * maxNodes, 'high-water ' + hw + ' reached the cap ' + (2 * maxNodes) + ' on all-identical corpus');
});

test('E1: smallest possible cap (maxNodes=3, a single internal + two leaves) -- no overflow throw', () => {
    const tree = new DynamicBVH2D(3); // hard floor: 2 leaves + 1 internal node
    tree.insertLeaf(new Float32Array([0, 0, 5, 5]), 0);
    tree.insertLeaf(new Float32Array([1, 1, 6, 6]), 1);
    const ov = createOverlap({ maxPairs: 8 });
    assert.doesNotThrow(() => { ov.begin(); ov.collectPairs(tree); ov.end(); });
    assert.equal(ov.pairCount(), 1);
    const hw = ov.stats().stackHighWater;
    assert.ok(hw > 0 && hw < 2 * 3, 'high-water bounded even at the smallest legal maxNodes');
});

test('E1: repeated collects on a stable tree allocate/grow nothing (maxArrayBuffersGrowth:0, no realloc)', () => {
    const N = 24;
    const { tree } = buildCorpusTree(0x7a11c0de, N);
    const cap = (N * (N - 1)) / 2 + 8;
    const ov = createOverlap({ maxPairs: cap });
    const eA = new Int32Array(cap), eB = new Int32Array(cap);
    const xA = new Int32Array(cap), xB = new Int32Array(cap);

    const hot = () => {
        ov.begin();
        ov.collectPairs(tree);
        ov.end();
        ov.drainEnter(eA, eB);
        ov.drainExit(xA, xB);
    };

    // Pre-warm: the FIRST collect lazily sizes the traversal stack (a one-time
    // cold event). If the traversal ever reallocated a bigger stack mid-loop
    // (the E1 violation this whole decision exists to prevent), it would show
    // here as ArrayBuffer growth -- invisible to a heapUsed-only gate (the
    // lite-bvh B-08 shape).
    hot();

    const res = measureOps(hot, { ops: 5000, warmup: 500, stabilize: 'deep' });
    const report = checkNoGc(res.summary, { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 });
    assert.ok(
        report.ok,
        'collectPairs grew a buffer across repeated collects: verdict=' + report.verdict +
        ' violations=' + JSON.stringify(report.violations),
    );
});

// =============================================================================
// ASSERTION 5 -- corrupt-tree fail-closed (E4). Hand collectPairs a tree whose
// SoA disagrees on leaf signals; assert THROW, not a silent drop, at three
// distinct depths of the traversal (root, self-pair child, deeper cross-pair
// descent), plus the NaN-root case from the boundary matrix.
// =============================================================================

/** A valid 5-node tree: root(0) -> [1(internal),2(leaf)]; 1 -> [3(leaf),4(leaf)]. */
function makeValidDeepTree() {
    const maxNodes = 5;
    const bboxes = new Float32Array(maxNodes * 4);
    const children = new Int32Array(maxNodes * 2).fill(-1);
    const heights = new Int32Array(maxNodes);
    const userData = new Int32Array(maxNodes).fill(-1);

    children[0 * 2] = 1; children[0 * 2 + 1] = 2; heights[0] = 2; userData[0] = -1;
    bboxes.set([0, 0, 20, 20], 0 * 4);

    children[1 * 2] = 3; children[1 * 2 + 1] = 4; heights[1] = 1; userData[1] = -1;
    bboxes.set([0, 0, 10, 10], 1 * 4);

    heights[2] = 0; userData[2] = 99;
    bboxes.set([5, 5, 15, 15], 2 * 4);

    heights[3] = 0; userData[3] = 3;
    bboxes.set([0, 0, 5, 5], 3 * 4);

    heights[4] = 0; userData[4] = 4;
    bboxes.set([2, 2, 8, 8], 4 * 4);

    return { bboxes, children, heights, userData, root: 0, maxNodes };
}

test('corrupt tree: root-level mismatch (children says leaf, heights says internal) throws', () => {
    const t = makeValidDeepTree();
    t.children[0 * 2] = -1; t.children[0 * 2 + 1] = -1; // root now claims to be a leaf
    // heights[0] stays 2 (nonzero) and userData[0] stays -1 -- both disagree with "leaf".
    const ov = createOverlap({ maxPairs: 32 });
    assert.throws(
        () => { ov.begin(); ov.collectPairs(t); ov.end(); },
        /lite-overlap: corrupt tree.*disagree at node 0/,
    );
});

test('corrupt tree: self-pair child mismatch (children=leaf, heights=internal) throws, names the node', () => {
    const t = makeValidDeepTree();
    t.heights[2] = 7; // node 2 looks like a leaf via children/userData but heights says internal
    const ov = createOverlap({ maxPairs: 32 });
    assert.throws(
        () => { ov.begin(); ov.collectPairs(t); ov.end(); },
        /lite-overlap: corrupt tree.*disagree at node 2/,
    );
});

test('corrupt tree: self-pair child mismatch (children=leaf, heights=leaf, userData=-1 -- internal marker on a leaf) throws', () => {
    const t = makeValidDeepTree();
    t.userData[2] = -1; // children/heights say leaf, userData says internal
    const ov = createOverlap({ maxPairs: 32 });
    assert.throws(
        () => { ov.begin(); ov.collectPairs(t); ov.end(); },
        /lite-overlap: corrupt tree.*disagree at node 2/,
    );
});

test('corrupt tree: mismatch two levels deep, only reachable via cross-pair descent, still throws', () => {
    // Node 3 is only visited after root's self-pair descends into node 1's
    // self-pair/cross-pair expansion -- proves the fail-closed check is not
    // skippable by hiding the corruption below the immediate root children.
    const t = makeValidDeepTree();
    t.heights[3] = 5; // node 3: children=leaf, userData=leaf, heights=internal
    const ov = createOverlap({ maxPairs: 32 });
    assert.throws(
        () => { ov.begin(); ov.collectPairs(t); ov.end(); },
        /lite-overlap: corrupt tree.*disagree at node 3/,
    );
});

test('corrupt tree: NaN root fails closed with a throw, not a silent zero-pair return', () => {
    const t = makeValidDeepTree();
    t.root = NaN;
    const ov = createOverlap({ maxPairs: 32 });
    assert.throws(
        () => { ov.begin(); ov.collectPairs(t); ov.end(); },
        /lite-overlap: corrupt tree.*disagree at node NaN/,
    );
});

test('ADVERSARIAL (planner-missed case): duplicate userData across two DISTINCT overlapping leaves FAILS CLOSED (throws), never a silent drop', () => {
    // A real bvh tree never assigns duplicate userData by itself; this models a
    // caller-side contract violation (two entities sharing one id). E4's
    // three-signal cross-check does not catch it -- children/heights/userData
    // agree perfectly on each node individually; the corruption is a cross-NODE
    // identity collision, not a per-node signal disagreement. Left unguarded,
    // D1's `a === b` rejection would silently treat two distinct, genuinely-
    // overlapping leaves as one entity meeting itself and DROP the real collision
    // with no throw -- the missed-collision failure this session exists to
    // prevent. So collectPairs guards the leaf-leaf emit: distinct leaf node ids
    // (a !== b by construction) sharing a userData id is unambiguous proof of the
    // violation, and it throws a named corrupt-tree error. (The asymmetry with the
    // caller-fed add(id, id) no-op is intentional and documented in E4; add() is
    // unchanged.)
    const tree = new DynamicBVH2D(8);
    tree.insertLeaf(new Float32Array([0, 0, 10, 10]), 7);
    tree.insertLeaf(new Float32Array([5, 5, 15, 15]), 7); // SAME userData, different node, overlapping
    const ov = createOverlap({ maxPairs: 8 });
    ov.begin();
    assert.throws(
        () => ov.collectPairs(tree),
        /corrupt tree -- distinct leaves .* share userData 7\. Leaf userData must be unique\./,
        'duplicate userData across distinct overlapping leaves must throw, not drop the collision',
    );
});

// =============================================================================
// BOUNDARY MATRIX -- collectPairs(tree): null, undefined, NaN, -0, duplicate
// call within one frame, mutate-tree-between-calls ("dispose during iteration"
// analogue -- the reused stack must not leak stale frontier state), and
// multi-source composition within one frame ("re-entrant write" analogue, E3).
// =============================================================================

test('collectPairs(null) fails closed (throws), does not silently return zero pairs', () => {
    const ov = createOverlap({ maxPairs: 8 });
    ov.begin();
    assert.throws(() => ov.collectPairs(null));
    ov.end();
});

test('collectPairs(undefined) fails closed (throws)', () => {
    const ov = createOverlap({ maxPairs: 8 });
    ov.begin();
    assert.throws(() => ov.collectPairs(undefined));
    ov.end();
});

test('collectPairs: tree.root = -0 behaves identically to root = 0', () => {
    function mk(rootVal) {
        const maxNodes = 3;
        const bboxes = new Float32Array(maxNodes * 4);
        const children = new Int32Array(maxNodes * 2).fill(-1);
        const heights = new Int32Array(maxNodes);
        const userData = new Int32Array(maxNodes).fill(-1);
        children[0] = 1; children[1] = 2; heights[0] = 1; userData[0] = -1;
        bboxes.set([0, 0, 10, 10], 0);
        heights[1] = 0; userData[1] = 0; bboxes.set([0, 0, 5, 5], 4);
        heights[2] = 0; userData[2] = 1; bboxes.set([3, 3, 8, 8], 8);
        return { bboxes, children, heights, userData, root: rootVal, maxNodes };
    }
    const ovPlain = createOverlap({ maxPairs: 8 });
    const ovNeg0 = createOverlap({ maxPairs: 8 });
    ovPlain.begin(); ovPlain.collectPairs(mk(0)); ovPlain.end();
    ovNeg0.begin(); ovNeg0.collectPairs(mk(-0)); ovNeg0.end();
    assert.equal(ovNeg0.pairCount(), ovPlain.pairCount());
    assert.equal(ovNeg0.pairCount(), 1);
});

test('duplicate collectPairs() call on the SAME tree within one frame is idempotent (no double pair)', () => {
    const tree = new DynamicBVH2D(8);
    tree.insertLeaf(new Float32Array([0, 0, 10, 10]), 0);
    tree.insertLeaf(new Float32Array([5, 5, 15, 15]), 1);
    const ov = createOverlap({ maxPairs: 8 });
    const eA = new Int32Array(8), eB = new Int32Array(8);
    ov.begin();
    ov.collectPairs(tree);
    ov.collectPairs(tree); // duplicate call, same frame
    ov.end();
    assert.equal(ov.pairCount(), 1, 'exactly one pair, not two');
    assert.equal(ov.drainEnter(eA, eB), 1, 'exactly one enter, not a doubled enter');
});

test('mutate-tree-between-calls (dispose-during-iteration analogue): the reused stack does not leak stale frontier state', () => {
    const tree = new DynamicBVH2D(16);
    tree.insertLeaf(new Float32Array([0, 0, 10, 10]), 0);
    const ov = createOverlap({ maxPairs: 16 });

    ov.begin(); ov.collectPairs(tree); ov.end();
    assert.equal(ov.pairCount(), 0, 'single leaf, no pairs yet');

    tree.insertLeaf(new Float32Array([5, 5, 15, 15]), 1); // now overlaps leaf 0
    ov.begin(); ov.collectPairs(tree); ov.end();
    assert.equal(ov.pairCount(), 1, 'the SAME overlap instance correctly reflects the mutated tree, no stale-stack leakage');
});

test('re-entrant write analogue (E3): collectPairs on two different trees plus a manual add() compose into one frame delta', () => {
    const treeA = new DynamicBVH2D(8);
    treeA.insertLeaf(new Float32Array([0, 0, 10, 10]), 100);
    treeA.insertLeaf(new Float32Array([5, 5, 15, 15]), 101);
    const treeB = new DynamicBVH2D(8);
    treeB.insertLeaf(new Float32Array([0, 0, 10, 10]), 200);
    treeB.insertLeaf(new Float32Array([5, 5, 15, 15]), 201);

    const ov = createOverlap({ maxPairs: 16 });
    const eA = new Int32Array(16), eB = new Int32Array(16);
    ov.begin();
    ov.collectPairs(treeA);
    ov.collectPairs(treeB);
    ov.add(999, 998);
    ov.end();

    assert.equal(ov.pairCount(), 3, 'one unified delta from two tree sources plus a manual add (E3)');
    const got = drainSet(ov, eA, eB);
    assert.ok(got.has(key(100, 101)));
    assert.ok(got.has(key(200, 201)));
    assert.ok(got.has(key(998, 999)));
});

// =============================================================================
// ASSERTION 6 -- narrow(boxA, boxB) unit matrix (E2). Reads only its two box
// args -- no tree.
// =============================================================================

test('narrow: touching (overlapping interiors) -> true', () => {
    const ov = createOverlap({ maxPairs: 4 });
    assert.equal(ov.narrow(new Float32Array([0, 0, 10, 10]), new Float32Array([5, 5, 15, 15])), true);
});

test('narrow: edge-touching (shared boundary, A.maxX === B.minX) -> true (touching counts)', () => {
    const ov = createOverlap({ maxPairs: 4 });
    assert.equal(ov.narrow(new Float32Array([0, 0, 5, 5]), new Float32Array([5, 0, 10, 5])), true);
});

test('narrow: disjoint -> false', () => {
    const ov = createOverlap({ maxPairs: 4 });
    assert.equal(ov.narrow(new Float32Array([0, 0, 5, 5]), new Float32Array([6, 0, 10, 5])), false);
});

test('narrow: one box entirely inside the other -> true', () => {
    const ov = createOverlap({ maxPairs: 4 });
    assert.equal(ov.narrow(new Float32Array([0, 0, 10, 10]), new Float32Array([2, 2, 4, 4])), true);
});

test('narrow: zero-area (point) box touching an edge -> true', () => {
    const ov = createOverlap({ maxPairs: 4 });
    assert.equal(ov.narrow(new Float32Array([0, 0, 5, 5]), new Float32Array([5, 2, 5, 2])), true);
});

test('narrow: -0 and 0 in the same box compare equal (no sign-bit hazard)', () => {
    const ov = createOverlap({ maxPairs: 4 });
    assert.equal(ov.narrow(new Float32Array([-0, -0, 5, 5]), new Float32Array([0, 0, 5, 5])), true);
});

test('narrow: NaN in a component -> false (NaN comparisons are never true, fails closed toward "no overlap")', () => {
    const ov = createOverlap({ maxPairs: 4 });
    assert.equal(ov.narrow(new Float32Array([0, 0, NaN, 5]), new Float32Array([1, 1, 2, 2])), false);
});

test('narrow: inverted box (minX > maxX) is not validated -- pinned current output, not endorsed as correct', () => {
    const ov = createOverlap({ maxPairs: 4 });
    // narrow does not call the bvh/aabb quarantine predicate (E2: zero deps, zero
    // validation, pure comparison) -- an inverted box compares as if it never
    // overlaps anything under this predicate. Pinned so a future add of input
    // validation to narrow is a deliberate diff, not a silent behaviour change.
    assert.equal(ov.narrow(new Float32Array([5, 0, 0, 5]), new Float32Array([1, 1, 2, 2])), false);
});

test('narrow(null, box) and narrow(box, undefined) fail closed with a throw, not a silent false', () => {
    const ov = createOverlap({ maxPairs: 4 });
    assert.throws(() => ov.narrow(null, new Float32Array([0, 0, 1, 1])));
    assert.throws(() => ov.narrow(new Float32Array([0, 0, 1, 1]), undefined));
});

test('narrow: a box against itself -> true (reflexive)', () => {
    const ov = createOverlap({ maxPairs: 4 });
    const box = new Float32Array([1, 1, 9, 9]);
    assert.equal(ov.narrow(box, box), true);
});
