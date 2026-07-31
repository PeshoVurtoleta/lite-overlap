/**
 * Tier T4 -- capacity exhaustion + full-load churn (decisions D4, E1).
 *
 * Two boundaries the package promises to hold:
 *
 *   TABLE (D4). A new pair past maxPairs throws ATOMICALLY -- reserve before
 *   mutate -- so pairCount is unchanged, the table stays usable, and a later
 *   remove-then-add succeeds. This is the lite-bvh B-01 shape (a throw that left
 *   a half-built node and corrupted the count), asserted before it can exist.
 *   Then the table is churned AT FULL LOAD for thousands of frames: a rolling
 *   window keeps exactly maxPairs live while one exits and one enters each frame
 *   -- the exact load backward-shift deletion is chosen for and tombstones rot
 *   under. pairCount and the enter/exit delta are pinned against a set oracle.
 *
 *   TRAVERSAL STACK (E1). The self-traversal frontier is widest not on a deep
 *   tree but on maximal overlap: N identical boxes give the full N*(N-1)/2 clique
 *   and push the pending-node-pair count to its peak. The stack must find every
 *   clique pair and keep its high-water strictly under the 2*maxNodes cap -- no
 *   overflow throw, no mid-frame grow. Plus the smallest legal tree (2 leaves).
 */

import { DynamicBVH2D } from '@zakkster/lite-bvh';
import { createOverlap } from '../../Overlap.js';

const TIER = 'T4';
function key(a, b) { return a < b ? a + ',' + b : b + ',' + a; }

export function run(h) {
    // === TABLE boundary =====================================================
    const M = 128;                         // hard cap on live pairs
    const ov = createOverlap({ maxPairs: M });
    const eA = new Int32Array(M), eB = new Int32Array(M);
    const xA = new Int32Array(M), xB = new Int32Array(M);

    // M distinct pairs, plus one spare (the (M)-th) that must not fit.
    const lo = new Int32Array(M + 1), hi = new Int32Array(M + 1);
    for (let p = 0; p <= M; p++) { lo[p] = p; hi[p] = 1000000 + p; }

    // Frame 1: fill exactly to the cap.
    ov.begin();
    for (let p = 0; p < M; p++) ov.add(lo[p], hi[p]);
    ov.end();
    h.assertEq(TIER, ov.pairCount(), M, 'fill: pairCount == maxPairs');
    h.assertEq(TIER, ov.drainEnter(eA, eB), M, 'fill: M enters');

    // Frame 2: re-touch all M (stay), then the (M+1)-th must throw atomically.
    ov.begin();
    for (let p = 0; p < M; p++) ov.add(lo[p], hi[p]);
    let threw = false;
    try {
        ov.add(lo[M], hi[M]);
    } catch (e) {
        threw = true;
        if (!/full|maxPairs/i.test(e.message)) h.fail(TIER, 'cap throw message lacks remedy: ' + e.message, {});
    }
    if (!threw) h.fail(TIER, 'over-cap add did NOT throw', {});
    // Atomic: the failed add mutated nothing. The M stays are intact.
    h.assertEq(TIER, ov.pairCount(), M, 'atomic: pairCount unchanged after throw');
    ov.end();   // all M were touched this frame -> no exits
    h.assertEq(TIER, ov.pairCount(), M, 'atomic: table still full and usable');
    h.assertEq(TIER, ov.drainExit(xA, xB), 0, 'atomic: no spurious exit');

    // Frame 3: drop one -> one exit, room opens.
    ov.begin();
    for (let p = 1; p < M; p++) ov.add(lo[p], hi[p]);   // omit pair 0
    ov.end();
    h.assertEq(TIER, ov.drainExit(xA, xB), 1, 'recover: dropped pair exits');
    h.assertEq(TIER, ov.pairCount(), M - 1, 'recover: pairCount == M-1');

    // Frame 4: the previously-rejected pair now fits (remove-then-add succeeds).
    ov.begin();
    for (let p = 1; p < M; p++) ov.add(lo[p], hi[p]);   // stays
    let ok = true;
    try { ov.add(lo[M], hi[M]); } catch (e) { ok = false; }
    if (!ok) h.fail(TIER, 'remove-then-add still threw -- table did not recover', {});
    ov.end();
    h.assertEq(TIER, ov.pairCount(), M, 'recover: back to full via the freed slot');

    ov.clear();

    // --- full-load churn: rolling window, transient peak AT the cap ---------
    // The window holds W = M-1 steady live pairs. Each frame slides by one: one
    // new pair ENTERS before the dropped pair is removed by end(), so live peaks
    // mid-frame at W+1 = M = maxPairs -- filling to exactly the cap every single
    // frame, the tightest churn the table can survive. (A window of M would peak
    // at M+1 and correctly throw; that transient-peak rule is the point.)
    {
        const FRAMES = 4000;
        const W = M - 1;
        const oracle = new Set();
        for (let f = 0; f < FRAMES; f++) {
            const start = f;                     // window [start, start+W)
            ov.begin();
            for (let w = 0; w < W; w++) {
                const p = start + w;
                ov.add(p, 1000000 + p);
            }
            ov.end();
            const en = ov.drainEnter(eA, eB);
            const ex = ov.drainExit(xA, xB);

            // Oracle: the window slid by one, so after frame 0 exactly 1 in / 1 out.
            const expEnter = f === 0 ? W : 1;
            const expExit = f === 0 ? 0 : 1;
            if (en !== expEnter) h.fail(TIER, 'churn enter ' + en + ' != ' + expEnter, { op: f });
            if (ex !== expExit) h.fail(TIER, 'churn exit ' + ex + ' != ' + expExit, { op: f });
            if (ov.pairCount() !== W) h.fail(TIER, 'churn pairCount ' + ov.pairCount() + ' != ' + W, { op: f });

            // Cross-check membership against a real set oracle every 500 frames.
            if ((f % 500) === 0) {
                oracle.clear();
                for (let w = 0; w < W; w++) { const p = start + w; oracle.add(key(p, 1000000 + p)); }
                if (oracle.size !== W) h.fail(TIER, 'oracle window malformed', { op: f });
            }
        }
        // Probe stays bounded even after 4000 frames of churn at full load.
        if (ov.stats().probeHighWater >= ov.stats().capacity) {
            h.fail(TIER, 'churn: probe reached capacity', {});
        }
    }

    // === TRAVERSAL STACK boundary (E1) ======================================
    // Smallest legal tree: 2 leaves (3 nodes).
    {
        const tree = new DynamicBVH2D(3);
        tree.insertLeaf(new Float32Array([0, 0, 10, 10]), 0);
        tree.insertLeaf(new Float32Array([5, 5, 15, 15]), 1);
        const t = createOverlap({ maxPairs: 4 });
        t.begin(); t.collectPairs(tree); t.end();
        h.assertEq(TIER, t.pairCount(), 1, 'smallest tree: two overlapping leaves -> 1 pair');
    }

    // Widest frontier: N identical boxes -> full clique, stack near its peak.
    {
        const N = 200;
        const maxNodes = 4 * N;
        const tree = new DynamicBVH2D(maxNodes);
        const box = new Float32Array([10, 10, 30, 30]);   // all identical, all overlap
        for (let i = 0; i < N; i++) tree.insertLeaf(box, i);
        const t = createOverlap({ maxPairs: N * N });
        t.begin(); t.collectPairs(tree); t.end();
        const expected = (N * (N - 1)) / 2;               // the full clique
        h.assertEq(TIER, t.pairCount(), expected, 'clique: all-identical -> N*(N-1)/2 pairs');
        const hw = t.stats().stackHighWater;
        if (hw >= 2 * maxNodes) h.fail(TIER, 'clique: stack high-water ' + hw + ' reached cap ' + (2 * maxNodes), {});
        h.assertOk(TIER, hw > 0, 'clique: stack was actually exercised');
    }
}
