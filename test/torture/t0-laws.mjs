/**
 * Tier T0 -- metamorphic laws for the O1 self-traversal.
 *
 * A fixed corpus proves a traversal right on the cases you thought of. A
 * metamorphic law proves it right on the cases you did NOT: it asserts that a
 * transformation which must not change the answer does not change it. These
 * catch whole CLASSES of traversal bug -- exactly the family the 94-vs-1,543
 * sketch lived in, where the pair set silently depended on tree shape.
 *
 * Four laws (all against a live @zakkster/lite-bvh tree; bvh is a devDependency,
 * Overlap.js never imports it -- collectPairs takes the tree as an argument):
 *
 *   L1 INSERT-ORDER INVARIANCE. The same boxes inserted in a different order
 *      build a differently-shaped tree (different internal nodes, different
 *      rotations) but the SAME leaf overlaps. collectPairs' pair set must be
 *      identical across forward / reverse / shuffled / monotone-diagonal orders.
 *      A traversal that drops (L,L)/(R,R) finds a DIFFERENT subset per shape --
 *      this law is what makes that non-silent.
 *
 *   L2 ID-RELABEL INVARIANCE. Relabel every userData id through a bijection; the
 *      pair set, mapped back through the inverse, is unchanged. Identity is the
 *      two ids, never the node index -- this pins that.
 *
 *   L3 MOTION / REFIT INVARIANCE (soak). Move every box each frame (updateLeaf,
 *      which drives bvh rotations), for thousands of frames. The delta
 *      reconstructed from enter/exit must equal a brute-force fat oracle EVERY
 *      frame. This is the traversal-under-rotation soak with an oracle.
 *
 *   L4 DUP-USERDATA FAIL-CLOSED. Two DISTINCT leaves that share a userData id and
 *      overlap must make collectPairs THROW (decision E4, the qa-found case), not
 *      silently drop the collision. Asserted over random dup configs -- the
 *      failure must be deterministic, never a silent miss.
 */

import { DynamicBVH2D } from '@zakkster/lite-bvh';
import { createOverlap } from '../../Overlap.js';

const TIER = 'T0';

function key(a, b) { return a < b ? a + ',' + b : b + ',' + a; }

function sameSet(x, y, tier, what, op, h) {
    if (x.size !== y.size) h.fail(tier, what + ': size ' + x.size + ' vs ' + y.size, { op });
    for (const k of x) if (!y.has(k)) h.fail(tier, what + ': missing ' + k, { op });
}

/** Overlap of two axis-aligned boxes held in a flat [minX,minY,maxX,maxY] array. */
function boxOverlap(box, i, j) {
    const a = i * 4, b = j * 4;
    return box[a] <= box[b + 2] && box[b] <= box[a + 2] &&
        box[a + 1] <= box[b + 3] && box[b + 1] <= box[a + 3];
}

/** Brute-force fat pair set (ids space) over the stored boxes. */
function bruteSet(box, ids, N) {
    const s = new Set();
    for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
            if (boxOverlap(box, i, j)) s.add(key(ids[i], ids[j]));
        }
    }
    return s;
}

/** Build a tree of N leaves from `box`, inserting in `order`, id = ids[entity]. */
function buildTree(box, ids, order, N) {
    const tree = new DynamicBVH2D(4 * N);
    const scratch = new Float32Array(4);
    for (let k = 0; k < N; k++) {
        const i = order[k];
        const b = i * 4;
        scratch[0] = box[b]; scratch[1] = box[b + 1]; scratch[2] = box[b + 2]; scratch[3] = box[b + 3];
        tree.insertLeaf(scratch, ids[i]);
    }
    return tree;
}

/** collectPairs' full pair set (ids space) -- fresh instance so all pairs enter. */
function collectSet(tree, cap, eA, eB) {
    const ov = createOverlap({ maxPairs: cap });
    ov.begin(); ov.collectPairs(tree); ov.end();
    const n = ov.drainEnter(eA, eB);
    const s = new Set();
    for (let i = 0; i < n; i++) s.add(key(eA[i], eB[i]));
    return s;
}

export function run(h) {
    const N = 60;
    const FIELD = 110, SIZE = 12;
    const cap = N * N;
    const eA = new Int32Array(cap), eB = new Int32Array(cap);

    // Shared corpus of boxes + ids, seeded.
    const box = new Float32Array(N * 4);
    const ids = new Int32Array(N);
    const rng = h.xorshift32(h.SEED ^ 0x0ac10a75);
    for (let i = 0; i < N; i++) {
        const x = h.unit(rng()) * (FIELD - SIZE);
        const y = h.unit(rng()) * (FIELD - SIZE);
        box[i * 4] = x; box[i * 4 + 1] = y; box[i * 4 + 2] = x + SIZE; box[i * 4 + 3] = y + SIZE;
        ids[i] = i * 7 + 3;   // sparse, non-contiguous ids
    }
    const oracle = bruteSet(box, ids, N);

    // --- L1 insert-order invariance -----------------------------------------
    const forward = new Int32Array(N), reverse = new Int32Array(N), shuffled = new Int32Array(N);
    for (let i = 0; i < N; i++) { forward[i] = i; reverse[i] = N - 1 - i; shuffled[i] = i; }
    // Fisher-Yates on `shuffled` with the same PRNG.
    for (let i = N - 1; i > 0; i--) {
        const j = rng() % (i + 1);
        const t = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = t;
    }
    // Monotone-diagonal order: sort entity indices by x (the adversarial order).
    const diag = Array.from(forward).sort((p, q) => box[p * 4] - box[q * 4]);

    const orders = [['forward', forward], ['reverse', reverse], ['shuffled', shuffled], ['diagonal', Int32Array.from(diag)]];
    for (let o = 0; o < orders.length; o++) {
        const tree = buildTree(box, ids, orders[o][1], N);
        const set = collectSet(tree, cap, eA, eB);
        sameSet(set, oracle, TIER, 'L1 insert-order ' + orders[o][0] + ' != brute oracle', o, h);
        sameSet(oracle, set, TIER, 'L1 brute oracle != insert-order ' + orders[o][0], o, h);
    }

    // --- L2 id-relabel invariance -------------------------------------------
    // A bijection on ids: id' = id XOR mask, kept non-negative and distinct.
    const relabel = new Int32Array(N);
    const inv = new Map();
    const MASK = 0x155;
    for (let i = 0; i < N; i++) {
        relabel[i] = (ids[i] ^ MASK) & 0x7fffffff;
        inv.set(relabel[i], ids[i]);
    }
    // Distinctness guard (a collision would make the law meaningless, not wrong).
    if (inv.size !== N) h.fail(TIER, 'L2 relabel not injective (' + inv.size + '/' + N + ')', {});
    const relTree = buildTree(box, relabel, forward, N);
    const relSet = collectSet(relTree, cap, eA, eB);
    // Map the relabelled pair set back through the inverse; must equal the oracle.
    const mapped = new Set();
    for (const k of relSet) {
        const c = k.indexOf(',');
        const a = inv.get(parseInt(k.slice(0, c), 10));
        const b = inv.get(parseInt(k.slice(c + 1), 10));
        mapped.add(key(a, b));
    }
    sameSet(mapped, oracle, TIER, 'L2 id-relabel (inverse-mapped) != oracle', 0, h);

    // --- L3 motion / refit invariance (soak vs oracle) ----------------------
    {
        const FRAMES = 3000;
        const tree = new DynamicBVH2D(4 * N);
        const nodeOf = new Int32Array(N);
        const scratch = new Float32Array(4);
        const px = new Float64Array(N), py = new Float64Array(N);
        const vx = new Float64Array(N), vy = new Float64Array(N);
        for (let i = 0; i < N; i++) {
            px[i] = h.unit(rng()) * (FIELD - SIZE);
            py[i] = h.unit(rng()) * (FIELD - SIZE);
            const ang = h.unit(rng()) * 6.2832, sp = 0.5 + h.unit(rng()) * 1.5;
            vx[i] = Math.cos(ang) * sp; vy[i] = Math.sin(ang) * sp;
            scratch[0] = px[i]; scratch[1] = py[i]; scratch[2] = px[i] + SIZE; scratch[3] = py[i] + SIZE;
            nodeOf[i] = tree.insertLeaf(scratch, i);
        }
        const ov = createOverlap({ maxPairs: cap });
        const live = new Set();                 // reconstructed from the delta
        const mbox = new Float32Array(N * 4);   // current boxes for the oracle
        for (let f = 0; f < FRAMES; f++) {
            for (let i = 0; i < N; i++) {
                let x = px[i] + vx[i], y = py[i] + vy[i];
                if (x < 0 || x > FIELD - SIZE) { vx[i] = -vx[i]; x = px[i] + vx[i]; }
                if (y < 0 || y > FIELD - SIZE) { vy[i] = -vy[i]; y = py[i] + vy[i]; }
                px[i] = x; py[i] = y;
                scratch[0] = x; scratch[1] = y; scratch[2] = x + SIZE; scratch[3] = y + SIZE;
                nodeOf[i] = tree.updateLeaf(nodeOf[i], scratch, 1.0);
                mbox[i * 4] = x; mbox[i * 4 + 1] = y; mbox[i * 4 + 2] = x + SIZE; mbox[i * 4 + 3] = y + SIZE;
            }
            ov.begin(); ov.collectPairs(tree); ov.end();
            const en = ov.drainEnter(eA, eB);
            for (let k = 0; k < en; k++) live.add(key(eA[k], eB[k]));
            const ex = ov.drainExit(eA, eB);
            for (let k = 0; k < ex; k++) live.delete(key(eA[k], eB[k]));

            // Oracle: fat brute over the tree's STORED boxes (fatten adds margin,
            // so read from the tree, not mbox -- collectPairs sees the fat boxes).
            const truth = new Set();
            for (let i = 0; i < N; i++) {
                for (let j = i + 1; j < N; j++) {
                    if (boxOverlap(tree.bboxes, nodeOf[i], nodeOf[j])) truth.add(key(i, j));
                }
            }
            if (live.size !== truth.size) h.fail(TIER, 'L3 motion: reconstructed live ' + live.size + ' != oracle ' + truth.size, { op: f });
            for (const k of truth) if (!live.has(k)) h.fail(TIER, 'L3 motion: oracle pair ' + k + ' missing from live set', { op: f });
        }
    }

    // --- L4 dup-userData fail-closed ----------------------------------------
    {
        const TRIALS = 24;
        for (let t = 0; t < TRIALS; t++) {
            const n = 6 + (rng() % 10);
            const tree = new DynamicBVH2D(4 * n);
            const scratch = new Float32Array(4);
            // Two entities forced to OVERLAP and forced to SHARE an id.
            const dupId = 100 + (rng() % 50);
            const cx = h.unit(rng()) * 40, cy = h.unit(rng()) * 40;
            for (let i = 0; i < n; i++) {
                let x, y, id;
                if (i < 2) {                         // the colliding, overlapping pair
                    x = cx + i * 2; y = cy + i * 2; id = dupId;
                } else {
                    x = h.unit(rng()) * 200; y = h.unit(rng()) * 200; id = 200 + i;
                }
                scratch[0] = x; scratch[1] = y; scratch[2] = x + 20; scratch[3] = y + 20;
                tree.insertLeaf(scratch, id);
            }
            const ov = createOverlap({ maxPairs: n * n });
            let threw = false;
            try {
                ov.begin(); ov.collectPairs(tree); ov.end();
            } catch (e) {
                threw = true;
                if (!/userData/.test(e.message)) h.fail(TIER, 'L4 threw but not the dup-userData error: ' + e.message, { op: t });
            }
            if (!threw) h.fail(TIER, 'L4 dup-userData did NOT throw -- a collision was silently dropped', { op: t });
        }
    }
}
