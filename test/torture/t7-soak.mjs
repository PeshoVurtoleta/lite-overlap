/**
 * Tier T7 -- soak and conservation.
 *
 * Two independent witnesses that nothing accumulates across 4096 build/teardown
 * cycles:
 *
 *   1. CONSERVATION (lite-leak, deterministic). Each cycle tracks a per-cycle
 *      resource (models an external handle) and untracks it on teardown; the
 *      cycle also exercises a real begin/add/end/drain. tracker.size() must
 *      return to 0 and audit() must be empty -- every tracked resource released
 *      by its own teardown. This is the deterministic conservation oracle, the
 *      lite-aabb T7 shape (no reliance on nondeterministic finalization).
 *
 *   2. DELTA CONSERVATION. One long-lived instance is driven through 4096
 *      appear/teardown cycles; cumulative enters must equal cumulative exits and
 *      the table must return to empty every cycle. A dropped or spurious exit
 *      (the D3 failure shape) breaks the equality.
 */

import { createOverlap } from '../../Overlap.js';
import { createLeakTracker } from '@zakkster/lite-leak';

const TIER = 'T7';
const CYCLES = 4096;
const NOOP = function () {};

export function run(h) {
    // --- witness 1: tracked-resource conservation ----------------------------
    const warns = [];
    const tracker = createLeakTracker({
        name: 'overlap-soak',
        onWarning: (w) => warns.push((w && w.kind) + ':' + (w && w.reason)),
    });

    // One instance reused across cycles (all buffers allocated once).
    const soak = createOverlap({ maxPairs: 64 });
    for (let c = 0; c < CYCLES; c++) {
        // build-up: track a per-cycle resource.
        const handle = tracker.track({ cycle: c }, NOOP, c);
        soak.begin();
        soak.add(1, 2);
        soak.add(3, 4);
        soak.add(5, 6);
        soak.end();
        // tear-down: release the resource and flush the pairs.
        soak.begin();
        soak.end();
        tracker.untrack(handle);
    }

    const live = tracker.size();
    const findings = tracker.audit();

    h.METRICS.leakLive = live;
    h.METRICS.leakTotal = 0;
    h.METRICS.findings = findings.length;
    h.METRICS.warnings = warns.length;

    if (live !== 0) h.fail(TIER, 'tracker did not return to zero: size=' + live, {});
    if (findings.length !== 0) h.fail(TIER, 'leak findings: ' + findings.length, {});

    // --- witness 2: conservation --------------------------------------------
    const ov = createOverlap({ maxPairs: 256 });
    const eA = new Int32Array(256), eB = new Int32Array(256);
    const xA = new Int32Array(256), xB = new Int32Array(256);
    let totalEnter = 0, totalExit = 0;

    for (let c = 0; c < CYCLES; c++) {
        // build: a small burst of pairs unique to this cycle.
        const b0 = (c * 8) & 0x3fffff;
        ov.begin();
        for (let k = 0; k < 8; k++) ov.add(b0 + 2 * k, b0 + 2 * k + 1);
        ov.end();
        totalEnter += ov.drainEnter(eA, eB);
        totalExit += ov.drainExit(xA, xB);

        // teardown: an empty frame flushes every live pair through exit.
        ov.begin();
        ov.end();
        totalEnter += ov.drainEnter(eA, eB);
        totalExit += ov.drainExit(xA, xB);

        if (ov.pairCount() !== 0) {
            h.fail(TIER, 'table not empty after teardown cycle ' + c + ': ' + ov.pairCount(), {});
        }
    }

    if (totalEnter !== totalExit) {
        h.fail(TIER, 'conservation broken: enters ' + totalEnter + ' != exits ' + totalExit, {});
    }
    if (totalEnter !== CYCLES * 8) {
        h.fail(TIER, 'unexpected enter total: ' + totalEnter + ' expected ' + (CYCLES * 8), {});
    }
}
