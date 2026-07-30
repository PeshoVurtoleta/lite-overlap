/**
 * Tier T9 -- controls. "A pass means something only if the gate can fail."
 *
 * Two ways the gate is proven falsifiable:
 *
 *   1. Deterministic self-checks (run every time, zero GC dependence). Each
 *      assertion family is fed a genuinely wrong value and must throw; if a
 *      control does NOT fire, this tier throws and torture exits non-zero.
 *
 *   2. The GC gate (T6) is falsifiable via TORTURE_CONTROL=alloc, which swaps
 *      the pair table for the naive Set<string> store the package replaces:
 *
 *          TORTURE_CONTROL=alloc node --expose-gc test/torture.mjs   -> exit 1
 *
 *      That path is human/CI-invoked so a nondeterministic GC observation can
 *      never flake the green path.
 */

import { createOverlap } from '../../Overlap.js';
import { createLeakTracker } from '@zakkster/lite-leak';

const TIER = 'T9';

function expectThrows(h, fn, label) {
    let threw = false;
    try { fn(); } catch (_e) { threw = true; }
    if (!threw) h.fail(TIER, 'control did not fire: ' + label, {});
}

export function run(h) {
    // Control A -- assertEq must reject a genuine mismatch.
    expectThrows(h, () => {
        h.assertEq('control', 3, 4, 'bogus');
    }, 'assertEq accepts unequal values');

    // Control B -- assertOk must reject a false condition.
    expectThrows(h, () => {
        h.assertOk('control', false, 'always false');
    }, 'assertOk accepts a false condition');

    // Control C -- the D4 atomic-throw claim must be real: a full table MUST
    // throw on the (maxPairs+1)-th distinct pair. If add silently grew instead,
    // this assertion (that it threw) would itself fail.
    expectThrows(h, () => {
        const ov = createOverlap({ maxPairs: 4 });
        ov.begin();
        // 5 distinct pairs into a maxPairs=4 table -> the 5th must throw.
        ov.add(0, 1); ov.add(2, 3); ov.add(4, 5); ov.add(6, 7);
        ov.add(8, 9); // this line must throw; the try swallows it -> control fires
    }, 'full table did not throw on overflow');

    // Control D -- the lifecycle oracle must notice a WRONG delta. A broken
    // "overlap" that never reports exits leaves a pair live after it vanishes;
    // comparing to the correct pairCount must fail.
    expectThrows(h, () => {
        const ov = createOverlap({ maxPairs: 8 });
        ov.begin(); ov.add(1, 2); ov.end();
        ov.begin(); ov.end(); // (1,2) vanishes -> pairCount must be 0
        // A broken oracle that expects the pair to persist:
        h.assertEq('control', ov.pairCount(), 1, 'vanished pair still live (false)');
    }, 'pairCount blind to an exit');

    // Control E -- the self-pair guard must actually reject: if add(a,a) were
    // accepted, pairCount would be 1, so asserting it 0 would... hold. So assert
    // the WRONG thing (that a self-pair was stored) and require the guard to make
    // it false.
    expectThrows(h, () => {
        const ov = createOverlap({ maxPairs: 8 });
        ov.begin(); ov.add(5, 5); ov.end();
        h.assertEq('control', ov.pairCount(), 1, 'self-pair was stored (false)');
    }, 'self-pair guard reported as storing a pair');

    // Control F -- the T7 conservation oracle must notice a leaked resource.
    expectThrows(h, () => {
        const tracker = createLeakTracker({ name: 'control-leak' });
        tracker.track({}, function () {}, 0); // tracked, never untracked
        if (tracker.size() !== 0) throw new Error('leak detected (expected)');
    }, 'tracker.size() blind to a leak');
}
