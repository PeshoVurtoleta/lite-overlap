/**
 * bench/subtree-prune-vs-leaf.mjs -- the O2.1 subtree-prune deferral decision
 * (decisions/0003-filters.md F3, "What is deferred to the build session").
 *
 * F3 settled the CORRECTNESS story of subtree masking: an incrementally-cached
 * node-keyed union mask goes stale silently under bvh rotations (a relink with no
 * external hook) and is REJECTED. The only admissible form is a per-frame REBUILD:
 * at the start of every collect, one bottom-up O(nodeCount) pass computing
 * `subtreeLayers[node] = subtreeLayers[left] | subtreeLayers[right]` (leaves seed
 * from `layerOf[userData[node]]`), into a pre-owned `Int32Array(maxNodes)`. Because
 * it is recomputed from the authoritative current topology every frame there is
 * nothing to invalidate -- a rotation between frames cannot make it stale.
 *
 * What F3 DEFERRED to this bench: whether that per-frame rebuild is worth shipping
 * at all, or whether leaf-level filtering (F1+F2, already shipped) recovers most of
 * the win on realistic layer counts and the rebuild is dead weight. The rebuild is
 * O(nodes) of UNCONDITIONAL work added to every collect; it pays only when it prunes
 * more descent work than it costs. This bench measures that with a number.
 *
 * TWO measured paths, both sharing ONE descent implementation so the delta isolates
 * the rebuild+prune, never a rewrite:
 *
 *   LEAF-ONLY (baseline = shipped) -- the leaf-level layer filter alone, applied at
 *     the leaf-leaf candidate exactly as Overlap.js `collectPairs` ships it. A
 *     faithful MIRROR of the shipped `traverse` (Overlap.js cannot be instrumented
 *     for an exact cross-pair-visit count without touching a shipped file), proven
 *     to emit the BYTE-IDENTICAL pair set as the real library on every grid cell
 *     before its counts are trusted (a differential self-check, like the swept
 *     bench's clip oracle). Cross-pair node visits counted exactly, timing-free.
 *
 *   PROTOTYPE (rebuild + prune) -- the SAME descent PLUS, at the start of each
 *     collect, one bottom-up O(nodeCount) pass building `subtreeLayers` and
 *     `subtreeInteract` (= interactMaskOf(subtreeLayers), the union of the matrix
 *     rows of the layers present) into buffers allocated ONCE per cell OUTSIDE the
 *     timed loop. During descent a cross-pair (a,b) is pruned early when
 *     `(subtreeLayers[a] & subtreeInteract[b]) === 0` -- no layer in a's subtree
 *     interacts with any layer in b's, so no leaf pair across them can survive the
 *     leaf filter. The rebuild's fixed node-visit cost is counted too.
 *
 * SAFETY INVARIANT (asserted, hard FAIL on any mismatch): the prototype's final
 * filtered pair set is BYTE-IDENTICAL to leaf-only's on every cell. The prune may
 * only skip pairs that provably cannot interact by layer -- it must never drop a
 * real pair. This is the strict-subset-safety proof at bench scale.
 *
 * Matrix model: DIAGONAL -- each layer interacts only with itself ("L independent
 * collision groups", the canonical Unity/Box2D layer split). It is the FAVORABLE
 * matrix for pruning (interactMaskOf(layer) = {layer}); combined with clustered
 * (best-case) and interleaved (worst-case) spatial layouts, the grid honestly
 * brackets the outcome. Layers=1 collapses to all-interacting -- the prune can
 * NEVER fire, so it bounds the pure rebuild downside (planner self-check cell).
 *
 * Not shipped: bench/ is not in package.json files[], so importing ../Overlap.js
 * and @zakkster/lite-bvh (a devDependency, used exactly as a caller would --
 * Overlap.js never imports it) is free. Run: `npm run bench:subtree` (or
 * `node bench/subtree-prune-vs-leaf.mjs`). Writes bench/RESULTS-subtree.md.
 */

import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DynamicBVH2D } from '@zakkster/lite-bvh';
import { createOverlap, VERSION } from '../Overlap.js';

/* ---- protocol ----------------------------------------------------------- */
const NS = [500, 2000, 8000];              // entity counts
const LAYERS = [1, 4, 16];                 // layer counts
const CLUSTERS = ['clustered', 'interleaved'];
const SIZE = 14;                           // box edge (matches the sibling benches)
const MARGIN = 2;                          // fatten margin building the tree
const DENSITY = 0.002;                     // boxes per unit^2 -> field scales as sqrt(N)
const SEED = 0x1543beef;                   // deterministic base seed (no Math.random)
const WARMUP = 100;                        // frames discarded before timing
const REPS = 11;                           // timed blocks per path (odd -> clean median)
const BLOCK_TARGET_NS = 20e6;              // aim each block at ~20 ms of work

/* ---- pre-registered verdict thresholds (FIXED before the run) ----------- */
const RED_THRESHOLD = 25.0;                // cross-pair visit drop, percent
const RED_MIN_CELLS = 2;                   // >= this many qualifying cells must clear it
const OVERHEAD_LIMIT = 3.0;                // single-layer ns/frame overhead, percent

/* ---- deterministic PRNG (self-contained; no test-harness dep) ----------- */
function xorshift32(s) {
    let x = s >>> 0;
    if (x === 0) x = 0x1a2b3c4d;
    return function () {
        x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
        return x / 4294967296;
    };
}

/* ======================================================================== *
 *  Scene builder. Entity `i` carries userData `i` and a layer; the layout   *
 *  makes subtrees either layer-HOMOGENEOUS (clustered -> prune fires) or    *
 *  layer-MIXED (interleaved -> prune never fires).                          *
 * ======================================================================== */
function buildScene(N, L, cluster, seed) {
    const field = Math.round(Math.sqrt(N / DENSITY));
    const tree = new DynamicBVH2D(4 * N);
    const layerOf = new Int32Array(N);
    const rng = xorshift32(seed);
    const box = new Float32Array(4);

    if (cluster === 'interleaved') {
        // Uniform over the whole field; layer round-robins per entity, so every
        // spatial region -- and thus every subtree -- is a mix of all L layers.
        for (let i = 0; i < N; i++) {
            const x = rng() * (field - SIZE);
            const y = rng() * (field - SIZE);
            box[0] = x - MARGIN; box[1] = y - MARGIN;
            box[2] = x + SIZE + MARGIN; box[3] = y + SIZE + MARGIN;
            layerOf[i] = i % L;
            tree.insertLeaf(box, i);
        }
    } else {
        // Partition the field into L blocks; every entity of block b lives inside
        // block b's region and carries layer b, so same-layer entities cluster
        // spatially and BVH subtrees tend layer-homogeneous.
        const cols = Math.ceil(Math.sqrt(L));
        const rows = Math.ceil(L / cols);
        const bw = field / cols;
        const bh = field / rows;
        for (let i = 0; i < N; i++) {
            const b = i % L;
            const bx = b % cols;
            const by = (b / cols) | 0;
            const x = bx * bw + rng() * Math.max(1, bw - SIZE);
            const y = by * bh + rng() * Math.max(1, bh - SIZE);
            box[0] = x - MARGIN; box[1] = y - MARGIN;
            box[2] = x + SIZE + MARGIN; box[3] = y + SIZE + MARGIN;
            layerOf[i] = b;
            tree.insertLeaf(box, i);
        }
    }
    return { tree, layerOf, field, maxNodes: tree.maxNodes };
}

/* Build the DIAGONAL collision matrix (each layer interacts only with itself)
 * both as a local Int32Array (for the mirror) and onto a real overlap instance
 * (for the shipped-library differential). Default matrix is all-on, so we CLEAR
 * every off-diagonal pair among the used layers. */
function diagonalMatrix(L) {
    const m = new Int32Array(32);
    m.fill(-1);                                  // all-on default (F2)
    for (let a = 0; a < L; a++) {
        for (let b = 0; b < 32; b++) {
            if (b !== a) { m[a] &= ~(1 << b); m[b] &= ~(1 << a); }
        }
    }
    return m;
}

function configureReal(ov, layerOf, L, N) {
    for (let i = 0; i < N; i++) ov.setLayer(i, layerOf[i]);
    for (let a = 0; a < L; a++) {
        for (let b = a + 1; b < L; b++) ov.setInteract(a, b, false);   // diagonal
    }
}

/* ======================================================================== *
 *  Rebuild -- ONE bottom-up O(nodeCount) pass (F3 admissible form).         *
 *  subtreeLayers[n] = union of layers in n's subtree; subtreeInteract[n] =  *
 *  interactMaskOf(subtreeLayers[n]) = union of the matrix rows of those     *
 *  layers, so the descent prune is a single AND. Buffers are pre-owned      *
 *  (SL, SI, order, dstk) -- zero allocation here. Returns the node count    *
 *  (the rebuild's fixed node-visit cost).                                   *
 * ======================================================================== */
function rebuild(tree, SL, SI, matrix, layerOf, order, dstk) {
    const children = tree.children;
    const userData = tree.userData;
    const root = tree.root;
    if (root < 0) return 0;
    // Preorder collect into `order`: a parent is recorded before its children, so
    // processing `order` in REVERSE guarantees children are folded before parents.
    let top = 0, cnt = 0;
    dstk[top++] = root;
    while (top > 0) {
        const n = dstk[--top];
        order[cnt++] = n;
        const c = n * 2;
        const Lc = children[c];
        if (Lc !== -1) { dstk[top++] = Lc; dstk[top++] = children[c + 1]; }
    }
    // Reverse fold: leaves seed from layerOf[userData]; internals union children.
    for (let k = cnt - 1; k >= 0; k--) {
        const n = order[k];
        const c = n * 2;
        const Lc = children[c];
        if (Lc === -1) {
            const layer = layerOf[userData[n]];
            SL[n] = 1 << layer;
            SI[n] = matrix[layer];
        } else {
            const Rc = children[c + 1];
            SL[n] = SL[Lc] | SL[Rc];
            SI[n] = SI[Lc] | SI[Rc];
        }
    }
    return cnt;
}

/* ======================================================================== *
 *  Descend -- the faithful MIRROR of Overlap.js `traverse(tree, false)`,    *
 *  parameterized by `prune`. Feeds candidate pairs to `ov.add` after the    *
 *  identical leaf-level layer filter. When `prune` is true, a cross-pair is *
 *  pruned early on the subtree masks (SL/SI) before its fat-box test, so    *
 *  its children are never enqueued -- that is the descent work the rebuild  *
 *  buys. Records the exact CROSS-PAIR node-visit count into LAST_CROSS      *
 *  (every cross-pair pop is one visit, pruned or not; the reduction shows   *
 *  as fewer total pops). Zero allocation.                                   *
 * ======================================================================== */
let LAST_CROSS = 0;

function descend(ov, tree, prune, SL, SI, layerOf, matrix, stack) {
    const bboxes = tree.bboxes;
    const children = tree.children;
    const heights = tree.heights;
    const userData = tree.userData;
    const root = tree.root;
    let cross = 0;
    if (root < 0) { LAST_CROSS = 0; return; }
    if (children[root * 2] === -1) { LAST_CROSS = 0; return; }   // single leaf

    let sp = 0;
    stack[sp++] = root; stack[sp++] = root;   // self-pair (root, root)

    while (sp > 0) {
        const b = stack[--sp];
        const a = stack[--sp];

        if (a === b) {
            // SELF-PAIR (n, n): re-emit the self-pairs of internal children plus
            // the cross seed (the 94-vs-1,543 line). Self-pairs are never pruned.
            const n2 = a * 2;
            const L = children[n2];
            const R = children[n2 + 1];
            if (children[L * 2] !== -1) { stack[sp++] = L; stack[sp++] = L; }
            if (children[R * 2] !== -1) { stack[sp++] = R; stack[sp++] = R; }
            stack[sp++] = L; stack[sp++] = R;                  // cross (L, R)
        } else {
            // CROSS-PAIR (a, b): one node visit.
            cross++;
            // SUBTREE PRUNE (prototype only): no layer in a's subtree interacts
            // with any layer in b's -> no surviving leaf pair -> skip the whole
            // subtree. Its children are not enqueued: that is the saved work.
            if (prune && (SL[a] & SI[b]) === 0) continue;

            const a4 = a * 4;
            const b4 = b * 4;
            if (bboxes[a4] <= bboxes[b4 + 2] && bboxes[b4] <= bboxes[a4 + 2] &&
                bboxes[a4 + 1] <= bboxes[b4 + 3] && bboxes[b4 + 1] <= bboxes[a4 + 3]) {
                const aLeaf = children[a * 2] === -1;
                const bLeaf = children[b * 2] === -1;
                if (aLeaf && bLeaf) {
                    // Leaf-leaf candidate: apply the shipped leaf-level layer
                    // filter, then add. Same matrix test Overlap.js runs.
                    const ua = userData[a];
                    const ub = userData[b];
                    const la = layerOf[ua];
                    const lb = layerOf[ub];
                    if (((matrix[la] >>> lb) & 1) === 1) ov.add(ua, ub);
                } else {
                    // Descend the taller node (tie -> a), one side only.
                    if (heights[a] >= heights[b]) {
                        const c2 = a * 2;
                        stack[sp++] = children[c2]; stack[sp++] = b;
                        stack[sp++] = children[c2 + 1]; stack[sp++] = b;
                    } else {
                        const c2 = b * 2;
                        stack[sp++] = a; stack[sp++] = children[c2];
                        stack[sp++] = a; stack[sp++] = children[c2 + 1];
                    }
                }
            }
        }
    }
    LAST_CROSS = cross;
}

/* ---- pair-set helpers (cold; Sets allocate, off the timed loop) --------- */
function key(a, b) { return a < b ? a + ',' + b : b + ',' + a; }

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

/* ---- timing: median ns/frame over REPS blocks (robust to jitter) -------- */
function timeBlock(frameFn, frames) {
    const t0 = process.hrtime.bigint();
    for (let f = 0; f < frames; f++) frameFn();
    const t1 = process.hrtime.bigint();
    return Number(t1 - t0);
}

function calibrate(frameFn) {
    let b = 2;
    for (;;) {
        const ns = timeBlock(frameFn, b);
        if (ns >= 3e6 || b >= (1 << 22)) {
            const perFrame = ns / b;
            return Math.max(4, Math.min(1 << 22, Math.round(BLOCK_TARGET_NS / perFrame)));
        }
        b *= 4;
    }
}

function medianNsPerFrame(frameFn) {
    for (let f = 0; f < WARMUP; f++) frameFn();      // reach steady state
    const block = calibrate(frameFn);
    const samples = new Float64Array(REPS);
    for (let r = 0; r < REPS; r++) samples[r] = timeBlock(frameFn, block) / block;
    const sorted = Array.from(samples).sort((a, b) => a - b);
    return sorted[(REPS - 1) >> 1];
}

/* ======================================================================== *
 *  Run one grid cell: build, prove byte-identity, count visits, time.       *
 * ======================================================================== */
function runCell(N, L, cluster) {
    const seed = (SEED ^ Math.imul(N, 2654435761) ^ Math.imul(L, 40503) ^
        (cluster === 'clustered' ? 0x5a5a : 0xa5a5)) >>> 0;
    const { tree, layerOf, field, maxNodes } = buildScene(N, L, cluster, seed);
    const matrix = diagonalMatrix(L);

    // Pre-owned buffers, allocated ONCE per cell OUTSIDE the timed loop.
    const SL = new Int32Array(maxNodes);
    const SI = new Int32Array(maxNodes);
    const order = new Int32Array(maxNodes);
    const dstk = new Int32Array(maxNodes);        // rebuild DFS frontier
    const stack = new Int32Array(maxNodes * 4);   // descent node-pair stack (as shipped)

    // ---- cold: prove BYTE-IDENTICAL pair sets, then trust the counts. ----
    // A generously-sized scratch instance for the cold set collection only.
    const bigPairs = Math.max(256, N * 64);
    const eA = new Int32Array(bigPairs), eB = new Int32Array(bigPairs);

    // leaf-only mirror -> set + cross count.
    const ovL = createOverlap({ maxPairs: bigPairs });
    ovL.begin(); descend(ovL, tree, false, SL, SI, layerOf, matrix, stack); ovL.end();
    const leafSet = drainSet(ovL, eA, eB);
    const leafCross = LAST_CROSS;

    // prototype mirror (rebuild + prune) -> set + cross count + rebuild count.
    const ovP = createOverlap({ maxPairs: bigPairs });
    const rebuildVisits = rebuild(tree, SL, SI, matrix, layerOf, order, dstk);
    ovP.begin(); descend(ovP, tree, true, SL, SI, layerOf, matrix, stack); ovP.end();
    const protoSet = drainSet(ovP, eA, eB);
    const protoCross = LAST_CROSS;

    // real shipped library -> set (the differential oracle for the mirror).
    const ovR = createOverlap({ maxPairs: bigPairs });
    configureReal(ovR, layerOf, L, N);
    ovR.begin(); ovR.collectPairs(tree); ovR.end();
    const realSet = drainSet(ovR, eA, eB);

    const mirrorOk = sameSet(leafSet, realSet);        // mirror == shipped library
    const identical = sameSet(leafSet, protoSet);      // prototype == leaf-only (SAFETY)
    const pairs = leafSet.size;

    const reduction = leafCross === 0 ? 0 : (100 * (leafCross - protoCross) / leafCross);

    // ---- timing (only meaningful once byte-identity holds) ----
    // Buffers are captured by closure here, OUTSIDE the timed loop; the rebuild
    // reuses SL/SI/order/dstk every frame with zero allocation. Instances are
    // sized to the actual pair count so end()'s scan stays proportionate to the
    // detection work (inflating capacity would understate the rebuild overhead).
    let leafNs = 0, protoNs = 0, realNs = 0;
    if (mirrorOk && identical) {
        const cap = Math.max(64, Math.ceil(pairs * 1.2) + 16);
        const ovmL = createOverlap({ maxPairs: cap });
        const ovmP = createOverlap({ maxPairs: cap });
        const ovrr = createOverlap({ maxPairs: cap });
        configureReal(ovrr, layerOf, L, N);

        const leafFrame = () => {
            ovmL.begin();
            descend(ovmL, tree, false, SL, SI, layerOf, matrix, stack);
            ovmL.end();
        };
        const protoFrame = () => {
            ovmP.begin();
            rebuild(tree, SL, SI, matrix, layerOf, order, dstk);
            descend(ovmP, tree, true, SL, SI, layerOf, matrix, stack);
            ovmP.end();
        };
        const realFrame = () => {
            ovrr.begin();
            ovrr.collectPairs(tree);
            ovrr.end();
        };
        leafNs = medianNsPerFrame(leafFrame);
        protoNs = medianNsPerFrame(protoFrame);
        realNs = medianNsPerFrame(realFrame);
    }
    const overhead = leafNs === 0 ? 0 : (100 * (protoNs - leafNs) / leafNs);

    return {
        N, L, cluster, field, pairs, nodeCount: rebuildVisits,
        leafCross, protoCross, reduction, rebuildVisits,
        leafNs, protoNs, realNs, overhead,
        mirrorOk, identical,
    };
}

/* ---- render ------------------------------------------------------------- */
function fmtNs(ns) {
    if (ns >= 1e6) return (ns / 1e6).toFixed(3) + ' ms';
    if (ns >= 1e3) return (ns / 1e3).toFixed(2) + ' us';
    return ns.toFixed(0) + ' ns';
}

function main() {
    const stamp = [
        'node ' + process.version,
        os.cpus()[0].model.trim(),
        os.arch(),
        new Date().toISOString(),
        'seed=0x' + SEED.toString(16),
        'density=' + DENSITY + ' box=' + SIZE + 'x' + SIZE + ' margin=' + MARGIN,
        'warmup=' + WARMUP + ' reps=' + REPS + ' matrix=diagonal',
    ].join(' | ');

    const L = [];
    const say = (line) => { L.push(line); process.stdout.write(line + '\n'); };

    say('# lite-overlap ' + VERSION + ' -- subtree prune vs leaf filtering (O2.1 / F3 deferral)');
    say('');
    say('Does a PER-FRAME `subtreeLayers` rebuild + subtree prune (the only rotation-');
    say('safe form F3 admits) save more descent work than the O(nodes) rebuild costs,');
    say('versus the shipped LEAF-LEVEL layer filter alone? Both paths share one descent');
    say('mirror, proven to emit the byte-identical pair set as the real library before');
    say('any count is trusted. Matrix is DIAGONAL (each layer self-interacts only --');
    say('favorable to pruning); clustered is best-case, interleaved worst-case spatial.');
    say('See `bench/subtree-prune-vs-leaf.mjs` for the full protocol.');
    say('');
    say('```');
    say(stamp);
    say('```');
    say('');

    const cells = [];
    let mirrorFails = 0, identFails = 0;
    for (const cluster of CLUSTERS) {
        for (const N of NS) {
            for (const Lc of LAYERS) {
                const c = runCell(N, Lc, cluster);
                cells.push(c);
                if (!c.mirrorOk) mirrorFails++;
                if (!c.identical) identFails++;
            }
        }
    }

    // ---- correctness gate (must pass before any number is read) ----
    say('## Correctness gate (mirror == shipped library, prototype == leaf-only)');
    say('');
    say('| cluster | N | layers | pairs | mirror==lib | proto==leaf |');
    say('| :--- | ---: | ---: | ---: | :---: | :---: |');
    for (const c of cells) {
        say('| ' + c.cluster + ' | ' + c.N + ' | ' + c.L + ' | ' + c.pairs +
            ' | ' + (c.mirrorOk ? 'PASS' : 'FAIL') + ' | ' + (c.identical ? 'PASS' : 'FAIL') + ' |');
    }
    say('');
    say('- mirror==lib mismatches: ' + mirrorFails + ' -> ' + (mirrorFails === 0 ? 'PASS' : 'FAIL'));
    say('- proto==leaf (SAFETY: prune never drops a real pair) mismatches: ' + identFails +
        ' -> ' + (identFails === 0 ? 'PASS' : 'FAIL'));

    if (mirrorFails !== 0 || identFails !== 0) {
        say('');
        say('GATE FAILED -- the mirror or the prune is unfaithful; no measurement is valid.');
        writeReport(L);
        process.exitCode = 1;
        return;
    }

    // ---- cross-pair node-visit reduction ----
    say('');
    say('## Cross-pair node visits (exact, timing-independent) and rebuild cost');
    say('');
    say('`reduction` = (leaf-only visits - prototype visits) / leaf-only visits.');
    say('`rebuild` is the fixed O(nodeCount) node-visit cost the prototype adds per frame.');
    say('');
    say('| cluster | N | layers | leaf visits | proto visits | reduction | rebuild (nodes) |');
    say('| :--- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const c of cells) {
        say('| ' + c.cluster + ' | ' + c.N + ' | ' + c.L + ' | ' + c.leafCross +
            ' | ' + c.protoCross + ' | ' + c.reduction.toFixed(1) + '% | ' + c.rebuildVisits + ' |');
    }

    // ---- wall-clock ----
    say('');
    say('## Wall clock (median-of-' + REPS + ' ns/frame)');
    say('');
    say('`leaf` and `proto` share the descent mirror; their delta isolates the rebuild+');
    say('prune. `overhead` = (proto - leaf) / leaf. `real` is the shipped library run as');
    say('a cost-fidelity cross-check on the mirror (leaf-level filter, no prune).');
    say('');
    say('| cluster | N | layers | leaf | proto | overhead | real (lib) |');
    say('| :--- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const c of cells) {
        say('| ' + c.cluster + ' | ' + c.N + ' | ' + c.L + ' | ' + fmtNs(c.leafNs) +
            ' | ' + fmtNs(c.protoNs) + ' | ' + c.overhead.toFixed(2) + '% | ' + fmtNs(c.realNs) + ' |');
    }

    // ---- self-check cell (planner task 2): layers=1 is pure overhead ----
    say('');
    say('## Self-check: layers=1 is pure rebuild overhead (the prune can never fire)');
    say('');
    say('| cluster | N | reduction | overhead |');
    say('| :--- | ---: | ---: | ---: |');
    let singleOverhead = -Infinity, singleCell = null;
    for (const c of cells) {
        if (c.L !== 1) continue;
        say('| ' + c.cluster + ' | ' + c.N + ' | ' + c.reduction.toFixed(1) + '% | ' +
            c.overhead.toFixed(2) + '% |');
        if (c.overhead > singleOverhead) { singleOverhead = c.overhead; singleCell = c; }
    }
    say('');
    say('Worst single-layer overhead: ' + singleOverhead.toFixed(2) + '% at ' +
        singleCell.cluster + ' N=' + singleCell.N +
        ' (reduction ' + singleCell.reduction.toFixed(1) + '%, must be ~0 -- prune cannot fire).');

    // ---- pre-registered verdict (planner task 3, assertion A1) ----
    const qualifying = cells.filter((c) =>
        c.cluster === 'clustered' && c.N >= 2000 && c.L >= 4);
    const hits = qualifying.filter((c) => c.reduction >= RED_THRESHOLD);
    const ship = hits.length >= RED_MIN_CELLS && singleOverhead <= OVERHEAD_LIMIT;
    const verdict = ship ? 'SHIP' : 'CLOSE';

    say('');
    say('## Pre-registered verdict (assertion A1)');
    say('');
    say('Rule (FIXED before the run): SHIP iff cross-pair node-visits drop >= ' +
        RED_THRESHOLD.toFixed(0) + '% on >= ' + RED_MIN_CELLS + ' of the clustered cells with');
    say('N >= 2000 AND layers >= 4, AND the single-layer (layers=1) ns/frame overhead');
    say('<= ' + OVERHEAD_LIMIT.toFixed(1) + '%. Otherwise CLOSE (leaf-level filtering alone; the');
    say('rebuild is dead weight).');
    say('');
    say('Qualifying clustered cells (N>=2000, layers>=4):');
    for (const c of qualifying) {
        say('  - N=' + c.N + ' layers=' + c.L + ': reduction ' + c.reduction.toFixed(1) +
            '% ' + (c.reduction >= RED_THRESHOLD ? '(>= ' + RED_THRESHOLD.toFixed(0) + '% PASS)' : '(< ' + RED_THRESHOLD.toFixed(0) + '% MISS)'));
    }
    say('');
    say('Deciding numbers: ' + hits.length + '/' + qualifying.length +
        ' qualifying cells clear ' + RED_THRESHOLD.toFixed(0) + '% (need >= ' + RED_MIN_CELLS + '); ' +
        'single-layer overhead ' + singleOverhead.toFixed(2) + '% (limit ' + OVERHEAD_LIMIT.toFixed(1) + '%).');
    say('');
    say('**VERDICT: ' + verdict + '**');

    writeReport(L);
}

function writeReport(L) {
    const out = join(dirname(fileURLToPath(import.meta.url)), 'RESULTS-subtree.md');
    writeFileSync(out, L.join('\n') + '\n');
    process.stdout.write('\nwritten -> ' + out + '\n');
}

main();
