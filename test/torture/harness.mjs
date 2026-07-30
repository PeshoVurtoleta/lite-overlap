/**
 * @zakkster/lite-overlap -- torture harness.
 *
 * Shared machinery for the tiers: a seeded PRNG, zero-allocation assertion
 * helpers, a shared METRICS sink for the GATE line, and the measured zero-GC
 * gate.
 *
 * The gate uses `measureOps(..., { stabilize: 'deep' })` so the
 * `maxArrayBuffersGrowth: 0` rule is resolvable: the pair table is Int32Array
 * backing stores, which live OUTSIDE the V8 heap and are invisible to a heapUsed
 * gate. That is the lite-bvh B-08 lesson, and this package is made entirely of
 * the arrays it warns about.
 *
 * HARNESS LAWS:
 *   - All scratch is allocated ONCE, outside every loop. Tiers reuse it.
 *   - Assertions in hot loops build a message string ONLY ON FAILURE.
 *   - Seeded xorshift32; the seed and op index print on failure so a case
 *     replays with TORTURE_SEED=... node --expose-gc test/torture.mjs.
 *   - One measurement at a time. Tiers run sequentially, never nested.
 *
 * Peers (lite-gc-profiler, lite-leak) are devDependencies, never runtime deps:
 * Overlap.js has zero deps.
 *
 * @license MIT
 */

import { measureOps, measureAllocs, checkNoGc } from '@zakkster/lite-gc-profiler';

// --- configuration -----------------------------------------------------------

export const SEED = (process.env.TORTURE_SEED
    ? (parseInt(process.env.TORTURE_SEED, 10) >>> 0)
    : 0x9e3779b9) >>> 0;

// Deliberately-broken control selector. TORTURE_CONTROL=alloc swaps the T6 hot
// loop for the naive Set<string> pair store the package exists to replace,
// which allocates a Set and N strings per frame. The gate must go red and the
// process must exit non-zero -- the proof the gate can fail.
export const CONTROL = process.env.TORTURE_CONTROL || '';

// The zero-GC rules shared by every measured tier. maxArrayBuffersGrowth:0 needs
// measureOps `stabilize:'deep'` (supplied by runOpsGate).
export const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

// Shared sink populated by the measured tiers; torture.mjs prints it as the
// GATE line (to stderr; stdout stays exactly "ok").
export const METRICS = {
    leakLive: 0,
    leakTotal: 0,
    findings: 0,
    warnings: 0,
    gcMajor: 0,
    gcMinor: 0,
    gcMaxMs: 0,
    allocBytesPerOp: 0,
};

// --- PRNG --------------------------------------------------------------------

/** xorshift32. Deterministic per seed; returns a next() yielding a uint32. */
export function xorshift32(seed) {
    let s = seed >>> 0;
    if (s === 0) s = 0x1a2b3c4d;
    return function next() {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        return s >>> 0;
    };
}

/** uint32 -> float in [0, 1). */
export function unit(u32) {
    return (u32 >>> 0) / 4294967296;
}

// --- failure -----------------------------------------------------------------

/** Throw a replayable failure. The message string is built HERE, on failure only. */
export function fail(tier, msg, ctx) {
    let out = 'torture: FAIL [' + tier + '] ' + msg + ' | seed=' + SEED;
    if (ctx && ctx.op !== undefined) out += ' | op=' + ctx.op;
    throw new Error(out);
}

/** Assert `got === exp` (strict); throws on mismatch. */
export function assertEq(tier, got, exp, what, op) {
    if (got !== exp) fail(tier, (what || 'value') + ': got ' + got + ' expected ' + exp, { op });
}

/** Assert `cond` truthy; throws on false. */
export function assertOk(tier, cond, what, op) {
    if (!cond) fail(tier, (what || 'assertion') + ' failed', { op });
}

// --- gc --------------------------------------------------------------------

/** Force a collection when --expose-gc is present; a no-op otherwise. */
export function maybeGc() {
    if (typeof globalThis.gc === 'function') globalThis.gc();
}

/**
 * Run `fn(i)` under a single measured window and gate it against RULES. Uses
 * measureOps with `stabilize:'deep'` so the arrayBuffers-growth rule resolves.
 * @param {(i:number)=>void} fn
 * @param {{ops:number, warmup?:number}} opts
 */
export function runOpsGate(fn, opts) {
    const res = measureOps(fn, {
        ops: opts.ops,
        warmup: opts.warmup === undefined ? 0 : opts.warmup,
        stabilize: 'deep',
    });
    return { report: checkNoGc(res.summary, RULES), summary: res.summary };
}

/** Measure steady-state bytes/op of `fn` (for the GATE line). */
export function bytesPerOp(fn, iterations) {
    const res = measureAllocs(fn, { iterations });
    return res.bytesPerCall;
}
