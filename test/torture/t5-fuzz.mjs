/**
 * Tier T5 -- differential fuzz against the Set<string> oracle.
 *
 * The naive string-key implementation the package exists to replace IS the
 * ground truth. Over a seeded corpus of random appear / persist / disappear
 * frames, the zero-alloc table's enter / stay / exit delta must match the
 * oracle's exactly, every frame. A mismatch prints the seed and frame so it
 * replays with TORTURE_SEED=... node --expose-gc test/torture.mjs.
 *
 * This is the differential backstop the D3 ledger names: it, not a wrap-recovery
 * test, is what proves the 1-bit tag never drops or spuriously fires an exit.
 */

import { createOverlap } from '../../Overlap.js';

const TIER = 'T5';
const N = 40;              // id pool
const MAX_PAIRS = N * N;   // above any live count
const FRAMES = 12000;

function key(a, b) {
    return a < b ? a + ',' + b : b + ',' + a;
}

export function run(h) {
    const rng = h.xorshift32(h.SEED ^ 0x5f5f5f5f);
    const ov = createOverlap({ maxPairs: MAX_PAIRS });

    const eA = new Int32Array(MAX_PAIRS), eB = new Int32Array(MAX_PAIRS);
    const xA = new Int32Array(MAX_PAIRS), xB = new Int32Array(MAX_PAIRS);

    let prev = new Set();
    const cur = new Set();

    for (let frame = 0; frame < FRAMES; frame++) {
        cur.clear();
        // Persist ~65% of last frame's pairs; the rest disappear.
        for (const k of prev) {
            if ((rng() % 100) < 65) cur.add(k);
        }
        // A handful of appears.
        const appears = rng() % 10;
        for (let i = 0; i < appears; i++) {
            const a = rng() % N;
            const b = rng() % N;
            if (a === b) continue;
            cur.add(key(a, b));
        }

        // Oracle delta.
        let oracleEnter = 0, oracleExit = 0;
        for (const k of cur) if (!prev.has(k)) oracleEnter++;
        for (const k of prev) if (!cur.has(k)) oracleExit++;
        const oracleStay = cur.size - oracleEnter;

        // Drive the table with order flips and within-frame duplicates.
        ov.begin();
        for (const k of cur) {
            const c = k.indexOf(',');
            const a = (k.charCodeAt(0) - 48) >= 0 ? parseInt(k.slice(0, c), 10) : 0;
            const b = parseInt(k.slice(c + 1), 10);
            if ((rng() & 1) === 0) ov.add(a, b); else ov.add(b, a);
            if ((rng() % 5) === 0) ov.add(b, a);
        }
        ov.end();

        const en = ov.drainEnter(eA, eB);
        const ex = ov.drainExit(xA, xB);

        if (en !== oracleEnter) h.fail(TIER, 'enter count got ' + en + ' expected ' + oracleEnter, { op: frame });
        if (ex !== oracleExit) h.fail(TIER, 'exit count got ' + ex + ' expected ' + oracleExit, { op: frame });
        if (ov.pairCount() !== cur.size) h.fail(TIER, 'pairCount got ' + ov.pairCount() + ' expected ' + cur.size, { op: frame });
        if (ov.stayCount() !== oracleStay) h.fail(TIER, 'stayCount got ' + ov.stayCount() + ' expected ' + oracleStay, { op: frame });

        // Set-identity: every reported enter/exit must be a real oracle member.
        for (let i = 0; i < en; i++) {
            const kk = key(eA[i], eB[i]);
            if (prev.has(kk) || !cur.has(kk)) h.fail(TIER, 'spurious enter ' + kk, { op: frame });
        }
        for (let i = 0; i < ex; i++) {
            const kk = key(xA[i], xB[i]);
            if (!prev.has(kk) || cur.has(kk)) h.fail(TIER, 'spurious exit ' + kk, { op: frame });
        }

        // Advance oracle. Reuse `prev` by swapping (a fresh Set is cold-path here).
        prev = new Set(cur);
    }
}
