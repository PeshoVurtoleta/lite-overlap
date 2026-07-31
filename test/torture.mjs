/**
 * @zakkster/lite-overlap -- torture gate.
 *
 * The suite DONE-WHEN is a single command:
 *
 *     node --expose-gc test/torture.mjs        -> prints "ok", exit 0
 *
 * Tiers, sharing the lite-aabb / lite-bvh tier shape --
 *
 *     T0  metamorphic laws (O1: insert-order / id-relabel / motion invariance,
 *         dup-userData fail-closed)
 *     T1  degenerate table states (empty / single / full / self-pair guard)
 *     T3  adversarial open-addressing (mined collision chain, pinned probe bound,
 *         backward-shift healing)
 *     T4  capacity exhaustion (atomic over-cap throw) + full-load churn + the
 *         traversal-stack boundary (smallest tree, all-identical clique)
 *     T5  differential fuzz against the Set<string> oracle
 *     T6  zero-alloc GC budget (maxMajor:0 / maxPauseMs:4 / maxArrayBuffersGrowth:0)
 *     T7  soak + conservation (4096 build/teardown cycles)
 *     T8  cross-package (bvh-driven traversal vs oracle, O1)
 *     T9  controls -- every gate has a broken variant that must exit non-zero
 *
 * Registered but empty, filled by O2-O3 --
 *
 *     T2  aliasing matrix
 *
 * Tiers run STRICTLY SEQUENTIALLY: lite-gc-profiler allows one measurement at a
 * time. Never run two tiers at once.
 *
 * The gate can fail -- and is proven to. T9 self-checks the deterministic gates
 * every run; the GC gate is falsifiable on demand:
 *
 *     TORTURE_CONTROL=alloc node --expose-gc test/torture.mjs   -> exit 1
 *
 * Replay any failure with its printed seed:
 *
 *     TORTURE_SEED=<seed> node --expose-gc test/torture.mjs
 *
 * Peers (lite-gc-profiler, lite-leak) are devDependencies, never runtime deps:
 * Overlap.js has zero deps.
 *
 * @license MIT
 */

import * as h from './torture/harness.mjs';
import * as t0 from './torture/t0-laws.mjs';
import * as t1 from './torture/t1-degenerate.mjs';
import * as t2 from './torture/t2-aliasing.mjs';
import * as t3 from './torture/t3-hashing.mjs';
import * as t4 from './torture/t4-capacity.mjs';
import * as t5 from './torture/t5-fuzz.mjs';
import * as t6 from './torture/t6-alloc.mjs';
import * as t7 from './torture/t7-soak.mjs';
import * as t8 from './torture/t8-cross.mjs';
import * as t9 from './torture/t9-controls.mjs';

const TIERS = [
    ['T0-laws', t0.run],
    ['T1-degenerate', t1.run],
    ['T2-aliasing', t2.run],
    ['T3-hashing', t3.run],
    ['T4-capacity', t4.run],
    ['T5-fuzz', t5.run],
    ['T6-alloc', t6.run],
    ['T7-soak', t7.run],
    ['T8-cross', t8.run],
    ['T9-controls', t9.run],
];

async function main() {
    for (let i = 0; i < TIERS.length; i++) {
        const name = TIERS[i][0];
        const run = TIERS[i][1];
        try {
            await run(h); // throws (or rejects) on failure.
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            process.stderr.write((msg.startsWith('torture:') ? msg : 'torture: FAIL [' + name + '] ' + msg) + '\n');
            process.exit(1);
        }
    }

    const m = h.METRICS;
    // Diagnostics to STDERR; stdout stays EXACTLY "ok".
    process.stderr.write(
        'GATE leak=size ' + m.leakLive + '/' + m.leakTotal +
        ' findings=' + m.findings + ' warnings=' + m.warnings +
        ' | gc major=' + m.gcMajor + ' minor=' + m.gcMinor +
        ' maxMs=' + m.gcMaxMs.toFixed(2) +
        ' | alloc=' + m.allocBytesPerOp + ' B/op\n',
    );

    process.stdout.write('ok\n');
    process.exit(0);
}

main();
