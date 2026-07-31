/**
 * bench/collect-vs-nquery.mjs -- the O1 crossover benchmark.
 *
 * Publishes the number O1's DONE-WHEN owes: at what N does one tree
 * self-traversal (`collectPairs`) beat N root-down `query()` calls, and by how
 * much. Both paths produce the IDENTICAL fat pair set every frame -- the bench
 * verifies that equality before timing anything, because a benchmark of two
 * functions computing different answers measures nothing.
 *
 * Honest framing, stamped in the output:
 *   - Realistic density. The field scales as sqrt(N) so the expected pairs-per-
 *     entity stays constant (~a real broadphase scene), instead of N=20000 boxes
 *     crammed into a fixed field where every box overlaps dozens and the bench
 *     just measures output volume. Density is stamped so runs are comparable.
 *   - Conservative toward N-query. The N-query path reads each entity's box
 *     straight from the tree into scratch (the cheapest possible query-box
 *     source; `query` rejects a box aliasing `bboxes`). A real caller that
 *     RECONSTRUCTS boxes from entity state each frame pays MORE -- so any
 *     crossover reported here is a lower bound on collect's advantage.
 *   - Static scene. Boxes do not move, so both paths pay only their per-frame
 *     DETECTION cost (the thing that differs). Motion adds equal `updateLeaf`
 *     cost to both paths and only adds noise to the comparison.
 *   - Median of repeated blocks, not mean -- robust to GC/OS jitter.
 *
 * Not a gate; not in `npm test`. Run: `npm run bench` (or `node
 * bench/collect-vs-nquery.mjs`). Writes a protocol-stamped table to
 * bench/RESULTS.md and prints it. @zakkster/lite-bvh is a devDependency, used
 * here exactly as a caller would -- Overlap.js never imports it.
 */

import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DynamicBVH2D } from '@zakkster/lite-bvh';
import { createOverlap, VERSION } from '../Overlap.js';

/* ---- protocol ----------------------------------------------------------- */
const NS = [100, 1000, 5000, 20000];   // the roadmap's N sweep
const SIZE = 14;                        // box edge (the roadmap's 14x14)
const MARGIN = 2;                       // fatten margin building the tree
const DENSITY = 0.002;                  // boxes per unit^2 (N=2000 -> field 1000)
const SEED = 0x1543beef;                // deterministic placement
const WARMUP = 200;                     // frames discarded before timing
const REPS = 11;                        // timed blocks per path (odd -> clean median)
const BLOCK_TARGET_NS = 40e6;           // aim each block at ~40 ms of work

/* ---- deterministic PRNG (self-contained; no test-harness dep) ----------- */
function xorshift32(s) {
    let x = s >>> 0;
    return function () {
        x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
        return x / 4294967296;
    };
}

/**
 * Build one static scene of N boxes at constant density. Returns the tree (with
 * FAT boxes), the leaf node ids, a generous maxPairs, and the field size used.
 */
function buildScene(N) {
    const field = Math.round(Math.sqrt(N / DENSITY));
    const tree = new DynamicBVH2D(4 * N);
    const nodeOf = new Int32Array(N);
    const fat = new Float32Array(4);
    const rng = xorshift32((SEED ^ (N * 2654435761)) >>> 0);
    for (let i = 0; i < N; i++) {
        const x = rng() * (field - SIZE);
        const y = rng() * (field - SIZE);
        fat[0] = x - MARGIN; fat[1] = y - MARGIN;
        fat[2] = x + SIZE + MARGIN; fat[3] = y + SIZE + MARGIN;
        nodeOf[i] = tree.insertLeaf(fat, i);
    }
    return { tree, nodeOf, field, maxPairs: Math.max(64, N * 8) };
}

/* ---- the two frame paths (both produce the same fat delta) -------------- */

/** collect: one self-traversal feeds the table. */
function collectFrame(ov, tree) {
    ov.begin();
    ov.collectPairs(tree);
    ov.end();
}

/** N-query: per entity, a fat query box (read from the tree) feeds the table. */
function nqueryFrame(ov, tree, nodeOf, N, qbox, qout) {
    const bb = tree.bboxes;
    ov.begin();
    for (let i = 0; i < N; i++) {
        const nb = nodeOf[i] * 4;
        qbox[0] = bb[nb]; qbox[1] = bb[nb + 1]; qbox[2] = bb[nb + 2]; qbox[3] = bb[nb + 3];
        const hits = tree.query(qbox, qout);
        for (let k = 0; k < hits; k++) if (qout[k] !== i) ov.add(i, qout[k]);
    }
    ov.end();
}

/* ---- correctness net: the two paths must agree before we time them ------ */
function key(a, b) { return a < b ? a + ',' + b : b + ',' + a; }

function pairSet(frameFn, ov, N, maxPairs) {
    const eA = new Int32Array(maxPairs), eB = new Int32Array(maxPairs);
    frameFn();                                  // one frame: all pairs enter
    const n = ov.drainEnter(eA, eB);
    const s = new Set();
    for (let i = 0; i < n; i++) s.add(key(eA[i], eB[i]));
    return s;
}

function assertAgree(N, scene) {
    const { tree, nodeOf, maxPairs } = scene;
    const ovC = createOverlap({ maxPairs });
    const setC = pairSet(() => collectFrame(ovC, tree), ovC, N, maxPairs);

    const ovQ = createOverlap({ maxPairs });
    const qbox = new Float32Array(4), qout = new Int32Array(N + 1);
    const setQ = pairSet(() => nqueryFrame(ovQ, tree, nodeOf, N, qbox, qout), ovQ, N, maxPairs);

    if (setC.size !== setQ.size) {
        throw new Error('bench abort: paths disagree at N=' + N + ' (collect ' +
            setC.size + ' vs n-query ' + setQ.size + '), seed=0x' + SEED.toString(16));
    }
    for (const k of setC) if (!setQ.has(k)) {
        throw new Error('bench abort: pair ' + k + ' missing from n-query at N=' + N);
    }
    return setC.size;
}

/* ---- timing: median ns/frame over REPS blocks --------------------------- */
function timeBlock(frameFn, frames) {
    const t0 = process.hrtime.bigint();
    for (let f = 0; f < frames; f++) frameFn();
    const t1 = process.hrtime.bigint();
    return Number(t1 - t0);              // ns for the whole block
}

/** Grow a block until it runs >= 5ms, then extrapolate to BLOCK_TARGET_NS. */
function calibrate(frameFn) {
    let b = 4;
    for (;;) {
        const ns = timeBlock(frameFn, b);
        if (ns >= 5e6 || b >= (1 << 20)) {
            const perFrame = ns / b;
            return Math.max(8, Math.min(1 << 20, Math.round(BLOCK_TARGET_NS / perFrame)));
        }
        b *= 4;
    }
}

function medianNsPerFrame(frameFn) {
    for (let f = 0; f < WARMUP; f++) frameFn();          // reach steady state
    const block = calibrate(frameFn);
    const samples = new Float64Array(REPS);
    for (let r = 0; r < REPS; r++) samples[r] = timeBlock(frameFn, block) / block;
    const sorted = Array.from(samples).sort((a, b) => a - b);
    return { ns: sorted[(REPS - 1) >> 1], block };
}

/* ---- run ---------------------------------------------------------------- */
function fmtNs(ns) {
    if (ns >= 1e6) return (ns / 1e6).toFixed(3) + ' ms';
    if (ns >= 1e3) return (ns / 1e3).toFixed(2) + ' us';
    return ns.toFixed(0) + ' ns';
}

function main() {
    const rows = [];
    let crossover = null;         // first N where collect <= n-query
    for (const N of NS) {
        const scene = buildScene(N);
        const pairs = assertAgree(N, scene);

        const ovC = createOverlap({ maxPairs: scene.maxPairs });
        const c = medianNsPerFrame(() => collectFrame(ovC, scene.tree));

        const ovQ = createOverlap({ maxPairs: scene.maxPairs });
        const qbox = new Float32Array(4), qout = new Int32Array(N + 1);
        const q = medianNsPerFrame(() => nqueryFrame(ovQ, scene.tree, scene.nodeOf, N, qbox, qout));

        const ratio = q.ns / c.ns;    // > 1 means collect is faster
        if (crossover === null && c.ns <= q.ns) crossover = N;
        rows.push({ N, field: scene.field, pairs, collect: c.ns, nquery: q.ns, ratio });
    }

    // --- render a protocol-stamped report --------------------------------
    const stamp = [
        'node ' + process.version,
        os.cpus()[0].model.trim(),
        os.arch(),
        new Date().toISOString(),
        'seed=0x' + SEED.toString(16),
        'density=' + DENSITY + ' box=' + SIZE + 'x' + SIZE + ' margin=' + MARGIN,
        'warmup=' + WARMUP + ' reps=' + REPS,
    ].join(' | ');

    let verdict;
    if (crossover === null) {
        verdict = 'N-query was faster or equal at every measured N -- collect never pulled ahead in this run. Both paths stay first-class (caller-fed `add` is the O0 contract).';
    } else if (crossover === NS[0]) {
        verdict = 'collect wins across the whole measured range (from N=' + NS[0] + ' up). No crossover -- self-traversal is the default.';
    } else {
        verdict = 'crossover at N=' + crossover + ': N-query wins below it, collect wins at and above it. Both paths kept -- pick by N.';
    }

    const L = [];
    L.push('# lite-overlap ' + VERSION + ' -- collect vs N-query');
    L.push('');
    L.push('One BVH self-traversal (`collectPairs`) vs N root-down `query()` calls,');
    L.push('both producing the identical fat pair set. Median ns/frame, static scene,');
    L.push('constant density. See `bench/collect-vs-nquery.mjs` for the full protocol.');
    L.push('');
    L.push('```');
    L.push(stamp);
    L.push('```');
    L.push('');
    L.push('| N | field | pairs | collect | N-query | speedup |');
    L.push('| ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const r of rows) {
        L.push('| ' + r.N + ' | ' + r.field + ' | ' + r.pairs + ' | ' +
            fmtNs(r.collect) + ' | ' + fmtNs(r.nquery) + ' | ' +
            r.ratio.toFixed(2) + 'x |');
    }
    L.push('');
    L.push('**Crossover:** ' + verdict);
    L.push('');
    L.push('`speedup` = N-query / collect (>1 means collect is faster). N-query reads');
    L.push('each box straight from the tree -- the cheapest possible query source, so');
    L.push('this understates collect\'s real-world edge over a caller that rebuilds boxes.');
    L.push('');
    const report = L.join('\n');

    const out = join(dirname(fileURLToPath(import.meta.url)), 'RESULTS.md');
    writeFileSync(out, report + '\n');
    process.stdout.write(report + '\n\nwritten -> ' + out + '\n');
}

main();
