/**
 * Tier T1 -- degenerate table states, answers PINNED.
 *
 * The lifecycle's edges, each asserted against a hand-derived expected value:
 *   - the empty table: begin/end with no adds emits nothing, stays empty.
 *   - a single pair: enter once, persist, exit once, table empties.
 *   - the full table: the (maxPairs+1)-th distinct pair throws atomically
 *     (decision D4) and the table stays byte-usable.
 *   - the self-pair guard: add(a, a) is rejected at the door (decision D1).
 *   - order invariance + within-frame idempotence at the boundary.
 *   - clear() empties silently with no exit and no realloc (decision C2).
 */

import { createOverlap } from '../../Overlap.js';

const TIER = 'T1';

export function run(h) {
    // --- empty table ---------------------------------------------------------
    {
        const ov = createOverlap({ maxPairs: 8 });
        const eA = new Int32Array(8), eB = new Int32Array(8);
        const xA = new Int32Array(8), xB = new Int32Array(8);
        ov.begin();
        ov.end();
        h.assertEq(TIER, ov.pairCount(), 0, 'empty table pairCount');
        h.assertEq(TIER, ov.stayCount(), 0, 'empty table stayCount');
        h.assertEq(TIER, ov.drainEnter(eA, eB), 0, 'empty table enters');
        h.assertEq(TIER, ov.drainExit(xA, xB), 0, 'empty table exits');
    }

    // --- single pair, full lifecycle -----------------------------------------
    {
        const ov = createOverlap({ maxPairs: 8 });
        const eA = new Int32Array(8), eB = new Int32Array(8);
        const xA = new Int32Array(8), xB = new Int32Array(8);

        ov.begin(); ov.add(4, 9); ov.end();
        h.assertEq(TIER, ov.pairCount(), 1, 'single enter pairCount');
        h.assertEq(TIER, ov.drainEnter(eA, eB), 1, 'single enter count');
        h.assertOk(TIER, eA[0] === 4 && eB[0] === 9, 'single enter ids canonical');

        ov.begin(); ov.add(9, 4); ov.end(); // reversed -> same pair, a stay
        h.assertEq(TIER, ov.drainEnter(eA, eB), 0, 'no enter on persist');
        h.assertEq(TIER, ov.drainExit(xA, xB), 0, 'no exit on persist');
        h.assertEq(TIER, ov.stayCount(), 1, 'persisted pair is a stay');

        ov.begin(); ov.end(); // vanish
        h.assertEq(TIER, ov.drainExit(xA, xB), 1, 'single exit count');
        h.assertOk(TIER, xA[0] === 4 && xB[0] === 9, 'single exit ids canonical');
        h.assertEq(TIER, ov.pairCount(), 0, 'table empty after exit');
    }

    // --- self-pair guard (D1) ------------------------------------------------
    {
        const ov = createOverlap({ maxPairs: 8 });
        const eA = new Int32Array(8), eB = new Int32Array(8);
        ov.begin();
        ov.add(7, 7);
        ov.add(0, 0);
        ov.end();
        h.assertEq(TIER, ov.pairCount(), 0, 'self-pairs rejected');
        h.assertEq(TIER, ov.drainEnter(eA, eB), 0, 'self-pair stages no enter');
    }

    // --- within-frame idempotence + order invariance -------------------------
    {
        const ov = createOverlap({ maxPairs: 8 });
        const eA = new Int32Array(8), eB = new Int32Array(8);
        ov.begin();
        ov.add(2, 5);
        ov.add(5, 2); // reversed
        ov.add(2, 5); // duplicate
        ov.add(5, 2); // duplicate reversed
        ov.end();
        h.assertEq(TIER, ov.pairCount(), 1, 'one pair from four adds');
        h.assertEq(TIER, ov.drainEnter(eA, eB), 1, 'one enter from four adds');
    }

    // --- full table: atomic throw at the boundary (D4) -----------------------
    {
        const maxPairs = 8;
        const ov = createOverlap({ maxPairs });
        ov.begin();
        for (let i = 0; i < maxPairs; i++) ov.add(2 * i, 2 * i + 1);
        h.assertEq(TIER, ov.pairCount(), maxPairs, 'table filled to cap');

        let threw = false;
        try {
            ov.add(1000, 1001); // the (maxPairs+1)-th distinct pair
        } catch (e) {
            threw = true;
            h.assertOk(TIER,
                typeof e.message === 'string' && e.message.indexOf('pair table full (8)') >= 0,
                'full-table message names the cap and remedy');
        }
        h.assertOk(TIER, threw, 'full table throws at the boundary');
        h.assertEq(TIER, ov.pairCount(), maxPairs, 'pairCount unchanged after throw (atomic)');

        // Table still usable: an existing pair still resolves as a hit.
        ov.add(0, 1);
        h.assertEq(TIER, ov.pairCount(), maxPairs, 'existing pair re-adds without growth');

        // Remove-then-add: drop one pair via an empty-ish frame, then the new
        // pair fits without throwing.
        ov.begin();
        for (let i = 1; i < maxPairs; i++) ov.add(2 * i, 2 * i + 1); // (0,1) exits
        ov.end();
        h.assertEq(TIER, ov.pairCount(), maxPairs - 1, 'one pair exited, room freed');

        ov.begin();
        for (let i = 1; i < maxPairs; i++) ov.add(2 * i, 2 * i + 1);
        ov.add(1000, 1001); // previously rejected -> now succeeds
        ov.end();
        h.assertEq(TIER, ov.pairCount(), maxPairs, 'remove-then-add succeeds');
    }

    // --- clear() is silent and reallocation-free (C2) ------------------------
    {
        const ov = createOverlap({ maxPairs: 8 });
        const xA = new Int32Array(8), xB = new Int32Array(8);
        ov.begin(); ov.add(1, 2); ov.add(3, 4); ov.end();
        const capBefore = ov.stats().capacity;
        ov.clear();
        h.assertEq(TIER, ov.pairCount(), 0, 'clear empties the table');
        h.assertEq(TIER, ov.stats().capacity, capBefore, 'clear does not realloc');
        h.assertEq(TIER, ov.drainExit(xA, xB), 0, 'clear stages no exits');
    }
}
