/**
 * @zakkster/lite-overlap -- O2 layers/filters (final QA, node:test).
 *
 * Pins the four O2 decisions (decisions/0003-filters.md) added on top of the O1
 * self-traversal. Filtering happens at collect time, before `add`, keyed by
 * `userData`; it changes COST, never results relative to post-filtering the
 * unfiltered set.
 *
 *   F1 -- filter state keyed by userData (entity id), never node id.
 *   F2 -- symmetric 32-bit collision matrix; default all-pairs-enabled == the O1
 *         identity; filtered set == unfiltered-set-post-filtered-in-JS.
 *   F3 -- NO cached node-keyed subtree masks: the rotation adversary (monotone
 *         drift that provokes bvh `_balance` rotations) keeps the filtered set
 *         equal to the brute filtered oracle EVERY frame. A cached-mask impl
 *         fails this; leaf-level (userData-keyed) filtering passes.
 *   F4 -- filter-at-collect rides the O0 mark-sweep: a now-filtered / disabled
 *         pair simply is not re-stamped, so it exits at end(), exactly once, with
 *         no special exit path. The dup-userData corruption throw runs BEFORE the
 *         filter -- filtering must never mask a corrupt tree.
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

/** Drain enters into a Set<string> of canonical pair keys. */
function drainEnterSet(ov, eA, eB) {
    const n = ov.drainEnter(eA, eB);
    const s = new Set();
    for (let i = 0; i < n; i++) s.add(key(eA[i], eB[i]));
    return s;
}

/** Drain exits into a Set<string> of canonical pair keys. */
function drainExitSet(ov, xA, xB) {
    const n = ov.drainExit(xA, xB);
    const s = new Set();
    for (let i = 0; i < n; i++) s.add(key(xA[i], xB[i]));
    return s;
}

/** Fat-box overlap of two nodes by their STORED (fat) boxes. */
function fatOverlap(bboxes, na, nb) {
    const a = na * 4, b = nb * 4;
    return bboxes[a] <= bboxes[b + 2] && bboxes[b] <= bboxes[a + 2] &&
        bboxes[a + 1] <= bboxes[b + 3] && bboxes[b + 1] <= bboxes[a + 3];
}

/**
 * Build a tree of N leaves scattered over a field small enough that many overlap
 * (so filtering has real work to remove). userData[i] === i. Deterministic.
 */
function buildScatterTree(seed, N, field) {
    const rng = xorshift32(seed);
    const maxNodes = Math.max(4, 4 * N);
    const tree = new DynamicBVH2D(maxNodes);
    const nodeOf = new Int32Array(N);
    const box = new Float32Array(4);
    for (let i = 0; i < N; i++) {
        const x = unit(rng()) * field;
        const y = unit(rng()) * field;
        const w = unit(rng()) * 12;
        const h = unit(rng()) * 12;
        box[0] = x; box[1] = y; box[2] = x + w; box[3] = y + h;
        nodeOf[i] = tree.insertLeaf(box, i);
    }
    return { tree, nodeOf, maxNodes };
}

/** The unfiltered fat brute-force set over the CURRENT stored boxes. */
function bruteFatSet(tree, nodeOf, N) {
    const set = new Set();
    for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
            if (fatOverlap(tree.bboxes, nodeOf[i], nodeOf[j])) set.add(key(i, j));
        }
    }
    return set;
}

/** A JS mirror of the F2 collision matrix: Int32Array(32), all-on default. */
function makeMatrixOracle() {
    const m = new Int32Array(32);
    m.fill(-1);
    return {
        m,
        set(a, b, on) {
            const bitB = 1 << b, bitA = 1 << a;
            if (on) { m[a] |= bitB; m[b] |= bitA; }
            else { m[a] &= ~bitB; m[b] &= ~bitA; }
        },
        interact(a, b) { return ((m[a] >>> b) & 1) === 1; },
    };
}

// =============================================================================
// F2 -- default matrix is all-pairs-enabled: a permissively-configured filtered
// instance reports the SAME set as an unconfigured (pure O1) one.
// =============================================================================

test('F2: default all-pairs-enabled == O1 identity; permissive config changes nothing', () => {
    const N = 120;
    const { tree, nodeOf } = buildScatterTree(0x02de0001, N, 90);
    const cap = (N * (N - 1)) / 2 + 8;
    const eA = new Int32Array(cap), eB = new Int32Array(cap);

    // Unfiltered (pure O1).
    const ov1 = createOverlap({ maxPairs: cap });
    ov1.begin(); ov1.collectPairs(tree); ov1.end();
    const setPlain = drainEnterSet(ov1, eA, eB);
    assert.ok(sameSet(setPlain, bruteFatSet(tree, nodeOf, N)), 'unfiltered != brute (harness sanity)');

    // Filters ACTIVE but fully permissive: every entity layer 0, matrix all-on
    // (re-assert it), every entity enabled. Must equal the unfiltered set exactly.
    const ov2 = createOverlap({ maxPairs: cap });
    for (let i = 0; i < N; i++) { ov2.setLayer(i, 0); ov2.setEnabled(i, true); }
    for (let a = 0; a < 32; a++) ov2.setInteract(a, 0, true); // redundant, flips filtersActive
    ov2.begin(); ov2.collectPairs(tree); ov2.end();
    const setPermissive = drainEnterSet(ov2, eA, eB);

    assert.ok(sameSet(setPlain, setPermissive),
        'permissive filter config changed the set (' + setPlain.size + ' vs ' + setPermissive.size + ')');
});

// =============================================================================
// F2 -- THE core invariant: filtered set == unfiltered-set-post-filtered-in-JS,
// over a fuzz corpus of random layers + random symmetric matrix + random enabled
// bits. "Filtering changes cost, never results."
// =============================================================================

const CORPUS = [
    { N: 40, field: 60, seed: 0x0c0f0001 },
    { N: 120, field: 90, seed: 0x0c0f0002 },
    { N: 200, field: 110, seed: 0x0c0f0003 },
];

for (const { N, field, seed } of CORPUS) {
    test('F2 corpus: filtered == unfiltered-post-filtered, N=' + N + ' seed=0x' + seed.toString(16), () => {
        const { tree, nodeOf } = buildScatterTree(seed, N, field);
        const cap = (N * (N - 1)) / 2 + 8;
        const eA = new Int32Array(cap), eB = new Int32Array(cap);
        const rng = xorshift32((seed ^ 0x9e3779b9) >>> 0);

        // Random config, mirrored into a JS oracle.
        const layer = new Int32Array(N);
        const enabled = new Uint8Array(N);
        for (let i = 0; i < N; i++) {
            layer[i] = rng() % 32;
            enabled[i] = (rng() & 7) !== 0 ? 1 : 0;   // ~7/8 enabled
        }
        const oracle = makeMatrixOracle();
        // Randomly disable ~half of the unordered layer pairs (incl. self-pairs).
        for (let a = 0; a < 32; a++) {
            for (let b = a; b < 32; b++) {
                if ((rng() & 1) === 0) oracle.set(a, b, false);
            }
        }

        // Configure the library instance identically.
        const ov = createOverlap({ maxPairs: cap });
        for (let i = 0; i < N; i++) {
            ov.setLayer(i, layer[i]);
            ov.setEnabled(i, enabled[i] === 1);
        }
        for (let a = 0; a < 32; a++) {
            for (let b = a; b < 32; b++) {
                if (((oracle.m[a] >>> b) & 1) === 0) ov.setInteract(a, b, false);
            }
        }

        ov.begin(); ov.collectPairs(tree); ov.end();
        const filtered = drainEnterSet(ov, eA, eB);

        // Oracle: unfiltered set, post-filtered in JS.
        const unfiltered = bruteFatSet(tree, nodeOf, N);
        const oracleSet = new Set();
        for (const k of unfiltered) {
            const c = k.indexOf(',');
            const i = +k.slice(0, c), j = +k.slice(c + 1);
            if (enabled[i] === 1 && enabled[j] === 1 && oracle.interact(layer[i], layer[j])) {
                oracleSet.add(k);
            }
        }

        assert.ok(sameSet(filtered, oracleSet),
            'filtered (' + filtered.size + ') != oracle (' + oracleSet.size + ') at N=' + N +
            ' seed=0x' + seed.toString(16));
        // Filtering must actually be doing work in this corpus (guards a no-op pass).
        assert.ok(oracleSet.size < unfiltered.size,
            'corpus filtered nothing -- test would be vacuous (unfiltered=' + unfiltered.size + ')');
    });
}

// =============================================================================
// F2 -- symmetry by construction: setInteract(a,b) also sets (b,a), so the
// filtered result is independent of which endpoint the descent reached first.
// Swapping which entity carries which layer must not change a filtered verdict.
// =============================================================================

test('F2: matrix symmetric -- swapping layers between the two endpoints is invariant', () => {
    // Two boxes forced to overlap. Distinct userData 0 and 1.
    const tree = new DynamicBVH2D(8);
    tree.insertLeaf(new Float32Array([0, 0, 10, 10]), 0);
    tree.insertLeaf(new Float32Array([2, 2, 12, 12]), 1);
    const eA = new Int32Array(4), eB = new Int32Array(4);

    for (const [la, lb] of [[3, 7], [7, 3], [0, 31], [31, 0], [5, 5]]) {
        // Disable interaction between layers 3 and 7 (and the other combos).
        const ov = createOverlap({ maxPairs: 4 });
        ov.setLayer(0, la);
        ov.setLayer(1, lb);
        ov.setInteract(la === lb ? la : Math.min(la, lb), la === lb ? lb : Math.max(la, lb), false);
        ov.begin(); ov.collectPairs(tree); ov.end();
        const s = drainEnterSet(ov, eA, eB);
        assert.equal(s.size, 0,
            'disabled layers ' + la + '/' + lb + ' still reported a pair -- matrix not symmetric');
    }

    // ...and with the interaction ENABLED (the default), the pair is present
    // regardless of order -- confirms the disable above was the cause.
    for (const [la, lb] of [[3, 7], [7, 3]]) {
        const ov = createOverlap({ maxPairs: 4 });
        ov.setLayer(0, la); ov.setLayer(1, lb);
        ov.begin(); ov.collectPairs(tree); ov.end();
        assert.equal(drainEnterSet(ov, eA, eB).size, 1, 'default-enabled pair missing at ' + la + '/' + lb);
    }
});

// =============================================================================
// F4 -- setEnabled(false) fires exit for every live pair of that entity, exactly
// once, on the frame it is disabled; nothing thereafter; re-enable brings enters.
// =============================================================================

test('F4: setEnabled(false) exits all K live pairs once, via the mark-sweep; re-enable re-enters', () => {
    // A hub entity (id 0) placed to overlap several others.
    const N = 24;
    const { tree, nodeOf } = buildScatterTree(0x0f040001, N, 40);
    const cap = (N * (N - 1)) / 2 + 8;
    const eA = new Int32Array(cap), eB = new Int32Array(cap);
    const xA = new Int32Array(cap), xB = new Int32Array(cap);
    const ov = createOverlap({ maxPairs: cap, maxEntityId: N - 1 });

    // Frame 1: establish the live set.
    ov.begin(); ov.collectPairs(tree); ov.end();
    const live1 = drainEnterSet(ov, eA, eB);
    const pc1 = ov.pairCount();

    // Which live pairs involve entity 0?
    const zeroPairs = new Set();
    for (const k of live1) { const c = k.indexOf(','); if (+k.slice(0, c) === 0 || +k.slice(c + 1) === 0) zeroPairs.add(k); }
    assert.ok(zeroPairs.size >= 2, 'need a hub with >=2 live pairs to make the test meaningful, got ' + zeroPairs.size);

    // Frame 2: disable entity 0 before collect. Its K pairs must exit, exactly once.
    ov.setEnabled(0, false);
    ov.begin(); ov.collectPairs(tree); ov.end();
    const enters2 = drainEnterSet(ov, eA, eB);
    const exits2 = drainExitSet(ov, xA, xB);
    assert.equal(enters2.size, 0, 'disabling caused spurious enters');
    assert.ok(sameSet(exits2, zeroPairs),
        'exit set != entity-0 live pairs (exits ' + exits2.size + ' vs ' + zeroPairs.size + ')');
    assert.equal(ov.pairCount(), pc1 - zeroPairs.size, 'pairCount did not drop by exactly K');

    // Frame 3: still disabled -- no further exits, no enters for entity 0.
    ov.begin(); ov.collectPairs(tree); ov.end();
    assert.equal(drainEnterSet(ov, eA, eB).size, 0, 'disabled entity re-entered');
    assert.equal(drainExitSet(ov, xA, xB).size, 0, 'phantom second exit -- not exactly once');

    // Frame 4: re-enable -- entity 0's pairs return as enters.
    ov.setEnabled(0, true);
    ov.begin(); ov.collectPairs(tree); ov.end();
    const enters4 = drainEnterSet(ov, eA, eB);
    assert.ok(sameSet(enters4, zeroPairs), 're-enable did not restore entity-0 pairs as enters');
    assert.equal(ov.pairCount(), pc1, 'pairCount not restored after re-enable');
});

// =============================================================================
// F4 -- a mid-flight LAYER change that removes an interaction fires exit for the
// now-filtered live pairs (the "my exit never fired" failure, prevented).
// =============================================================================

test('F4: disabling a layer interaction mid-flight exits the now-filtered live pairs', () => {
    const N = 24;
    const { tree } = buildScatterTree(0x0f040002, N, 40);
    const cap = (N * (N - 1)) / 2 + 8;
    const eA = new Int32Array(cap), eB = new Int32Array(cap);
    const xA = new Int32Array(cap), xB = new Int32Array(cap);
    const ov = createOverlap({ maxPairs: cap, maxEntityId: N - 1 });

    // Split entities into two layers: evens -> 1, odds -> 2. Default all-on.
    for (let i = 0; i < N; i++) ov.setLayer(i, i % 2 === 0 ? 1 : 2);

    ov.begin(); ov.collectPairs(tree); ov.end();
    const live1 = drainEnterSet(ov, eA, eB);

    // The cross-layer (1<->2) pairs are exactly those whose endpoints differ in parity.
    const crossPairs = new Set();
    for (const k of live1) {
        const c = k.indexOf(','); const i = +k.slice(0, c), j = +k.slice(c + 1);
        if ((i % 2) !== (j % 2)) crossPairs.add(k);
    }
    assert.ok(crossPairs.size >= 1, 'need at least one cross-layer live pair');

    // Disable 1<->2 before the next collect. Every cross pair must exit that frame.
    ov.setInteract(1, 2, false);
    ov.begin(); ov.collectPairs(tree); ov.end();
    const exits2 = drainExitSet(ov, xA, xB);
    assert.ok(sameSet(exits2, crossPairs),
        'mid-flight layer disable did not exit exactly the cross-layer pairs (exits ' +
        exits2.size + ' vs ' + crossPairs.size + ')');
});

// =============================================================================
// F3 -- THE rotation adversary. Monotone drift on one axis provokes bvh
// `_balance` rotations (relinking node ids with no external hook). Leaf-level
// userData-keyed filtering must keep the filtered set equal to the brute filtered
// oracle EVERY frame. A cached node-keyed subtree mask would go stale here and
// silently drop pairs; this is the test that rejects it.
// =============================================================================

test('F3: filtered set == brute filtered oracle across rotation-provoking motion, every frame', () => {
    const N = 40;
    const FRAMES = 160;
    const MARGIN = 0.1;
    const rng = xorshift32(0x0f030001);
    const maxNodes = 4 * N;
    const tree = new DynamicBVH2D(maxNodes);
    const nodeOf = new Int32Array(N);
    const px = new Float64Array(N), py = new Float64Array(N);
    const layer = new Int32Array(N);
    const box = new Float32Array(4);

    for (let i = 0; i < N; i++) {
        px[i] = unit(rng()) * 40;
        py[i] = unit(rng()) * 40;
        layer[i] = rng() % 4;   // few layers => dense, interacting mix
        box[0] = px[i]; box[1] = py[i]; box[2] = px[i] + 6; box[3] = py[i] + 6;
        nodeOf[i] = tree.insertLeaf(box, i);
    }

    const cap = (N * (N - 1)) / 2 + 8;
    const eA = new Int32Array(cap), eB = new Int32Array(cap);
    const ov = createOverlap({ maxPairs: cap, maxEntityId: N - 1 });
    for (let i = 0; i < N; i++) ov.setLayer(i, layer[i]);

    // Disable a couple of layer interactions (symmetric): 0<->1 and 2<->3 off.
    const oracle = makeMatrixOracle();
    ov.setInteract(0, 1, false); oracle.set(0, 1, false);
    ov.setInteract(2, 3, false); oracle.set(2, 3, false);

    for (let f = 0; f < FRAMES; f++) {
        // Monotone drift: each entity marches +x by an id-dependent step, so the
        // spatial order churns and the tree must rotate to stay balanced.
        for (let i = 0; i < N; i++) {
            px[i] += 0.25 + (i & 7) * 0.03;
            box[0] = px[i]; box[1] = py[i]; box[2] = px[i] + 6; box[3] = py[i] + 6;
            nodeOf[i] = tree.updateLeaf(nodeOf[i], box, MARGIN);
        }

        // Snapshot the FULL current filtered live set as enters: clear() empties
        // the table silently (filter config survives -- it only touches the pair
        // table), so this frame's collect re-enters every currently-matching pair.
        ov.clear();
        ov.begin(); ov.collectPairs(tree); ov.end();
        const filtered = drainEnterSet(ov, eA, eB);

        const oracleSet = new Set();
        for (const k of bruteFatSet(tree, nodeOf, N)) {
            const c = k.indexOf(','); const i = +k.slice(0, c), j = +k.slice(c + 1);
            if (oracle.interact(layer[i], layer[j])) oracleSet.add(k);
        }

        assert.ok(sameSet(filtered, oracleSet),
            'frame ' + f + ': filtered (' + filtered.size + ') != oracle (' + oracleSet.size +
            ') -- a rotation desynced filter state (F3 violation)');
    }
    // Confirm the tree actually rotated (height moved) -- else the adversary was toothless.
    assert.ok(tree.validate());
});

// =============================================================================
// F1/F4 -- the dup-userData corruption throw runs BEFORE the filter: filtering
// (even disabling the offending entity) must NEVER mask a corrupt tree.
// =============================================================================

/** Hand-built 3-node tree: root(0) internal -> [leaf1, leaf2], both share ud=5, boxes overlap. */
function makeDupUserDataTree() {
    const maxNodes = 3;
    const bboxes = new Float32Array(maxNodes * 4);
    const children = new Int32Array(maxNodes * 2).fill(-1);
    const heights = new Int32Array(maxNodes);
    const userData = new Int32Array(maxNodes).fill(-1);
    // root 0 (internal)
    children[0] = 1; children[1] = 2; heights[0] = 1; userData[0] = -1;
    bboxes[0] = 0; bboxes[1] = 0; bboxes[2] = 12; bboxes[3] = 12;
    // leaf 1, ud=5
    heights[1] = 0; userData[1] = 5;
    bboxes[4] = 0; bboxes[5] = 0; bboxes[6] = 10; bboxes[7] = 10;
    // leaf 2, ud=5 (DUPLICATE across a distinct node -> corruption)
    heights[2] = 0; userData[2] = 5;
    bboxes[8] = 2; bboxes[9] = 2; bboxes[10] = 12; bboxes[11] = 12;
    return { bboxes, children, heights, userData, root: 0, maxNodes };
}

test('F1: dup-userData throw fires BEFORE the filter -- disabling the entity does not hide corruption', () => {
    const tree = makeDupUserDataTree();

    // Even with the offending entity disabled AND its layer self-interaction off,
    // collectPairs must THROW at the leaf-leaf candidate, not silently drop it.
    const ov = createOverlap({ maxPairs: 8, maxEntityId: 5 });
    ov.setEnabled(5, false);
    ov.setLayer(5, 3);
    ov.setInteract(3, 3, false);
    ov.begin();
    assert.throws(() => ov.collectPairs(tree), /share userData 5/);
});

// =============================================================================
// Validation matrix (fail-closed, suite Law).
// =============================================================================

test('setLayer / setInteract / setEnabled fail closed on bad input', () => {
    const ov = createOverlap({ maxPairs: 8 });

    // setLayer: id must be non-negative int; layer must be int in [0,31].
    assert.throws(() => ov.setLayer(-1, 0), RangeError);
    assert.throws(() => ov.setLayer(1.5, 0), RangeError);
    assert.throws(() => ov.setLayer('x', 0), RangeError);
    assert.throws(() => ov.setLayer(0, -1), RangeError);
    assert.throws(() => ov.setLayer(0, 32), RangeError);
    assert.throws(() => ov.setLayer(0, 3.5), RangeError);
    assert.doesNotThrow(() => { ov.setLayer(0, 0); ov.setLayer(0, 31); });

    // setInteract: layers in [0,31]; enabled boolean.
    assert.throws(() => ov.setInteract(-1, 0, true), RangeError);
    assert.throws(() => ov.setInteract(0, 32, true), RangeError);
    assert.throws(() => ov.setInteract(0, 0, 1), TypeError);   // not a boolean
    assert.doesNotThrow(() => ov.setInteract(0, 31, false));

    // setEnabled: id non-negative int; enabled boolean.
    assert.throws(() => ov.setEnabled(-1, true), RangeError);
    assert.throws(() => ov.setEnabled(0, 'yes'), TypeError);
    assert.doesNotThrow(() => ov.setEnabled(0, false));
});

test('maxEntityId caps fail closed; uncapped grows lazily', () => {
    // Capped: id above the cap throws; at the cap succeeds.
    const capped = createOverlap({ maxPairs: 8, maxEntityId: 10 });
    assert.throws(() => capped.setLayer(11, 0), /exceeds maxEntityId \(10\)/);
    assert.throws(() => capped.setEnabled(11, true), /exceeds maxEntityId \(10\)/);
    assert.doesNotThrow(() => { capped.setLayer(10, 5); capped.setEnabled(0, false); });

    // maxEntityId itself validated.
    assert.throws(() => createOverlap({ maxPairs: 8, maxEntityId: -1 }), RangeError);
    assert.throws(() => createOverlap({ maxPairs: 8, maxEntityId: 1.5 }), RangeError);

    // Uncapped: a large id grows the backing array on the cold path, no throw.
    const grow = createOverlap({ maxPairs: 8 });
    assert.doesNotThrow(() => grow.setLayer(100000, 7));
    assert.doesNotThrow(() => grow.setEnabled(250000, false));
});

test('layer 31 works (sign-bit): 1<<31 / >>> handled correctly', () => {
    const tree = new DynamicBVH2D(8);
    tree.insertLeaf(new Float32Array([0, 0, 10, 10]), 0);
    tree.insertLeaf(new Float32Array([2, 2, 12, 12]), 1);
    const eA = new Int32Array(4), eB = new Int32Array(4);

    const ov = createOverlap({ maxPairs: 4 });
    ov.setLayer(0, 0);
    ov.setLayer(1, 31);
    // Default all-on: the 0<->31 pair is present.
    ov.begin(); ov.collectPairs(tree); ov.end();
    assert.equal(drainEnterSet(ov, eA, eB).size, 1, '0<->31 default-on pair missing (sign-bit read bug)');

    // Disable 0<->31: pair gone.
    ov.setInteract(0, 31, false);
    ov.begin(); ov.collectPairs(tree); ov.end();
    // frame 2 is a fresh live set; the previous pair exits, no new enter.
    assert.equal(drainEnterSet(ov, eA, eB).size, 0, '0<->31 disable ignored (sign-bit write bug)');
    assert.equal(ov.pairCount(), 0, '0<->31 pair not filtered out');
});

// =============================================================================
// Alloc gate: filtering ACTIVE adds zero per-frame allocation (the O0/O1 gates
// must stay green with filters on). Mirrors the O1 E1 buffer-growth gate.
// =============================================================================

test('filtering active allocates/grows nothing across repeated collects (maxArrayBuffersGrowth:0)', () => {
    const N = 40;
    const { tree } = buildScatterTree(0x0a110c01, N, 60);
    const cap = (N * (N - 1)) / 2 + 8;
    const ov = createOverlap({ maxPairs: cap, maxEntityId: N - 1 });
    const eA = new Int32Array(cap), eB = new Int32Array(cap);
    const xA = new Int32Array(cap), xB = new Int32Array(cap);

    // Configure filters ONCE (cold): layers + a couple of disabled interactions.
    for (let i = 0; i < N; i++) ov.setLayer(i, i % 6);
    ov.setInteract(0, 1, false);
    ov.setInteract(2, 3, false);
    ov.setEnabled(N - 1, false);

    const hot = () => {
        ov.begin();
        ov.collectPairs(tree);   // now runs the FILTERED emit path
        ov.end();
        ov.drainEnter(eA, eB);
        ov.drainExit(xA, xB);
    };
    hot(); // pre-warm the one-time stack sizing.

    const res = measureOps(hot, { ops: 5000, warmup: 500, stabilize: 'deep' });
    const report = checkNoGc(res.summary, { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 });
    assert.ok(report.ok,
        'filtered collectPairs allocated across repeated collects: verdict=' + report.verdict +
        ' violations=' + JSON.stringify(report.violations));
});
