/**
 * @zakkster/lite-overlap -- boundary matrix hardening pass (final QA, O0).
 *
 * Every new entry point (`createOverlap`, `begin`, `add`, `end`, `drainEnter`,
 * `drainExit`, `clear`) walked against: 0, 1, N-1, N, N+1, empty, `null`,
 * `undefined`, `NaN`, `-0`, duplicate `clear()` ("duplicate dispose"),
 * mutate-during-scan analogues ("dispose-during-iteration"), re-entrant
 * `begin()` ("re-entrant write"), and adversarial cases the O0 planner did
 * not enumerate. This file does not replace `Overlap.test.js` / the torture
 * tiers -- it fills gaps they leave (short out-buffers, maxPairs=1, duplicate
 * clear, invalid-id inputs, out-of-protocol call order).
 *
 * Two tests below (marked FINDING) pin genuinely surprising CURRENT behaviour
 * discovered during this pass -- silent, not a crash -- and are NOT claims
 * that the behaviour is correct. They exist so a future change to that
 * behaviour is a deliberate diff, not an unnoticed regression. Overlap.js was
 * NOT modified to chase these; see the QA report.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOverlap } from '../Overlap.js';

function key(a, b) { return a < b ? a + ',' + b : b + ',' + a; }

// =============================================================================
// maxPairs = 1 (N = 1): the smallest legal table.
// =============================================================================

test('maxPairs=1: full single-pair lifecycle, then the 2nd distinct pair throws', () => {
    const ov = createOverlap({ maxPairs: 1 });
    const eA = new Int32Array(1), eB = new Int32Array(1);
    const xA = new Int32Array(1), xB = new Int32Array(1);

    ov.begin(); ov.add(10, 20); ov.end();
    assert.equal(ov.pairCount(), 1);
    assert.equal(ov.drainEnter(eA, eB), 1);
    assert.equal(key(eA[0], eB[0]), '10,20');

    // Table is full at N=1: a 2nd DISTINCT pair must throw (D4), atomically.
    ov.begin();
    ov.add(20, 10); // same pair, reversed -- a hit, not a new pair, must NOT throw
    assert.throws(() => ov.add(30, 40), /pair table full \(1\)/);
    ov.end();
    assert.equal(ov.pairCount(), 1, 'still exactly one pair after the throw');

    // Vanish, then re-fill with a different pair -- table stays usable at N=1.
    ov.begin(); ov.end();
    assert.equal(ov.drainExit(xA, xB), 1);
    assert.equal(ov.pairCount(), 0);

    ov.begin(); ov.add(30, 40); ov.end();
    assert.equal(ov.pairCount(), 1);
    assert.equal(ov.drainEnter(eA, eB), 1);
    assert.equal(key(eA[0], eB[0]), '30,40');
});

// =============================================================================
// drainEnter / drainExit: out-buffer shorter than the event count -- must cap,
// never overflow, never throw. Buffer length 0 (empty), N-1, N, N+1.
// =============================================================================

test('drainEnter/drainExit cap at a SHORTER out buffer without overflow', () => {
    const ov = createOverlap({ maxPairs: 16 });
    ov.begin();
    for (let i = 0; i < 5; i++) ov.add(2 * i, 2 * i + 1); // 5 distinct enters
    ov.end();

    // 0-length buffer (empty): must return 0, never index into an empty array.
    assert.equal(ov.drainEnter(new Int32Array(0), new Int32Array(0)), 0, 'empty out buffer -> 0');

    // N-1: shorter than the event count -- caps, does not throw, does not
    // silently drop the buffer boundary (out-of-bounds write on a typed array
    // is a silent no-op in JS, not a crash, so this specifically checks the
    // RETURN COUNT matches what was actually written, not the full event count).
    const shortA = new Int32Array(4), shortB = new Int32Array(4);
    const nShort = ov.drainEnter(shortA, shortB);
    assert.equal(nShort, 4, 'capped at the shorter (4-length) out buffer, not 5');
    const gotShort = new Set();
    for (let i = 0; i < nShort; i++) gotShort.add(key(shortA[i], shortB[i]));
    assert.equal(gotShort.size, 4, 'no duplicate / overflowed slot inside the short buffer');

    // Exactly N.
    const exactA = new Int32Array(5), exactB = new Int32Array(5);
    assert.equal(ov.drainEnter(exactA, exactB), 5, 'exact-length buffer drains everything');

    // N+1: longer than needed -- returns exactly N, tail untouched (stays 0).
    const longA = new Int32Array(6), longB = new Int32Array(6);
    assert.equal(ov.drainEnter(longA, longB), 5, 'longer buffer still returns the true count');
    assert.equal(longA[5], 0, 'tail slot beyond the event count is untouched');
    assert.equal(longB[5], 0, 'tail slot beyond the event count is untouched');

    // Asymmetric buffer lengths (outA and outB different lengths): caps at the
    // SHORTER of the two, per the documented contract.
    ov.begin(); ov.end(); // vanish all 5 -> 5 exits
    const xShortA = new Int32Array(5), xShortB = new Int32Array(2);
    const nx = ov.drainExit(xShortA, xShortB);
    assert.equal(nx, 2, 'asymmetric out buffers cap at the shorter of the two');
});

test('drainEnter/drainExit are non-destructive: repeated drains return the same data until next begin()', () => {
    const ov = createOverlap({ maxPairs: 8 });
    ov.begin(); ov.add(1, 2); ov.end();
    const a1 = new Int32Array(8), b1 = new Int32Array(8);
    const a2 = new Int32Array(8), b2 = new Int32Array(8);
    assert.equal(ov.drainEnter(a1, b1), 1);
    assert.equal(ov.drainEnter(a2, b2), 1, 'draining again before the next begin() repeats, not drains-to-empty');
    assert.equal(key(a1[0], b1[0]), key(a2[0], b2[0]));
});

// =============================================================================
// clear() -- "duplicate dispose": called twice back to back, called before any
// begin() has ever run, and clear-then-reuse.
// =============================================================================

test('duplicate clear(): back-to-back calls are idempotent, no realloc, no throw', () => {
    const ov = createOverlap({ maxPairs: 8 });
    ov.begin(); ov.add(1, 2); ov.end();
    const capBefore = ov.stats().capacity;

    ov.clear();
    ov.clear(); // duplicate dispose
    ov.clear(); // triplicate, for good measure

    assert.equal(ov.pairCount(), 0);
    assert.equal(ov.stats().capacity, capBefore, 'still no reallocation after repeated clear()');
});

test('clear() before any begin() has ever been called is a safe no-op-ish reset', () => {
    const ov = createOverlap({ maxPairs: 8 });
    assert.doesNotThrow(() => ov.clear());
    assert.equal(ov.pairCount(), 0);
    assert.equal(ov.stayCount(), 0);
    // Table remains fully usable afterward.
    ov.begin(); ov.add(5, 6); ov.end();
    assert.equal(ov.pairCount(), 1);
});

test('clear() then reuse: the table behaves identically to a fresh instance', () => {
    const ov = createOverlap({ maxPairs: 8 });
    const eA = new Int32Array(8), eB = new Int32Array(8);

    ov.begin(); ov.add(1, 2); ov.add(3, 4); ov.end();
    assert.equal(ov.pairCount(), 2);
    ov.clear();

    // Reuse: a pair that was live before clear() re-enters as a FRESH enter
    // (clear() drops all tag history -- there is nothing to "stay" against).
    ov.begin(); ov.add(1, 2); ov.end();
    assert.equal(ov.drainEnter(eA, eB), 1, 'post-clear add is a fresh enter, not a stay');
    assert.equal(ov.pairCount(), 1);
    assert.equal(ov.stayCount(), 0);
});

// =============================================================================
// "dispose-during-iteration" analogue: end()'s internal removeAt() shift runs
// WHILE end()'s own scan is in flight. There is no public iterator to mutate
// mid-loop (D2 rejected iterators outright), so the closest public analogue is
// exercised directly: a frame whose vanish set forces MULTIPLE backward-shift
// relocations in a single end() scan (chained holes, not just one).
// =============================================================================

test('end() scan survives multiple chained backward-shift relocations in one pass', () => {
    const maxPairs = 32;
    const ov = createOverlap({ maxPairs });
    const eA = new Int32Array(maxPairs), eB = new Int32Array(maxPairs);
    const xA = new Int32Array(maxPairs), xB = new Int32Array(maxPairs);

    // Fill with a dense run of ids that collide heavily under linear probing
    // (consecutive small ids), then let every OTHER one vanish in a single
    // end() -- forcing removeAt() to re-trigger repeatedly as end() re-examines
    // slot i after every shift (Overlap.js end(), "do NOT advance").
    ov.begin();
    for (let i = 0; i < 20; i++) ov.add(i, i + 100);
    ov.end();
    assert.equal(ov.pairCount(), 20);

    ov.begin();
    for (let i = 0; i < 20; i++) if ((i & 1) === 0) ov.add(i, i + 100); // odd ids vanish
    ov.end();

    const ex = ov.drainExit(xA, xB);
    assert.equal(ex, 10, 'exactly the 10 odd-indexed pairs exit');
    assert.equal(ov.pairCount(), 10);
    const survivors = new Set();
    for (let i = 0; i < 20; i += 2) survivors.add(key(i, i + 100));
    const exited = new Set();
    for (let i = 0; i < ex; i++) exited.add(key(xA[i], xB[i]));
    for (let i = 1; i < 20; i += 2) assert.ok(exited.has(key(i, i + 100)), 'odd pair ' + i + ' exited');
    for (const s of survivors) assert.ok(!exited.has(s), 'even pair ' + s + ' did NOT exit');

    // Confirm survivors still resolve correctly post-shift (steady state).
    ov.begin();
    for (let i = 0; i < 20; i += 2) ov.add(i, i + 100);
    ov.end();
    assert.equal(ov.drainEnter(eA, eB), 0, 'no spurious re-enter after the chained shift');
    assert.equal(ov.drainExit(xA, xB), 0, 'no spurious exit after the chained shift');
});

// =============================================================================
// Re-entrant write: begin() called twice with no intervening end(). FINDING --
// see the QA report. Overlap.js is unmodified; this pins current behaviour.
// =============================================================================

test('FINDING: re-entrant begin() (no intervening end()) cancels the tag flip and silently drops the pending exit', () => {
    const ov = createOverlap({ maxPairs: 8 });
    const eA = new Int32Array(8), eB = new Int32Array(8);
    const xA = new Int32Array(8), xB = new Int32Array(8);

    ov.begin(); ov.add(1, 2); ov.end();
    assert.equal(ov.pairCount(), 1);

    // Misuse: begin() called AGAIN before the matching end(). The documented
    // cycle is "begin() -> zero or more add(a,b) -> end()" (Overlap.d.ts); this
    // sequence violates the implicit 1:1 pairing. tag ^= 1 runs twice, so the
    // tag returns to its PREVIOUS value -- indistinguishable, from end()'s
    // point of view, from a frame where (1,2) WAS touched.
    ov.begin();
    ov.begin(); // re-entrant: tag flips back to where it was after frame 1
    // (1,2) is deliberately NOT re-added -- the caller's intent for "this
    // frame" is that it has vanished.
    ov.end();

    const en = ov.drainEnter(eA, eB);
    const ex = ov.drainExit(xA, xB);

    // Pinned CURRENT behaviour: the vanish is silently swallowed. No throw,
    // no exit event, pairCount does not reflect the caller's intent. This is
    // the same failure SHAPE decision D3 names for the epoch-truncation case
    // (silent, not a crash) but reached via call-order misuse rather than a
    // wraparound -- undocumented as UB, unlike the `-1` sentinel (Overlap.d.ts
    // line ~83). Not flagged as a release-blocker: it requires violating the
    // stated 1:1 begin/end pairing to trigger, and CLAUDE.md instructs the
    // coder path to fix behaviour, not this QA pass.
    assert.equal(en, 0, 'FINDING: no enter reported (pinned)');
    assert.equal(ex, 0, 'FINDING: the intended exit is silently dropped (pinned)');
    assert.equal(ov.pairCount(), 1, 'FINDING: the pair is still reported live (pinned)');
});

test('end() called twice with no intervening begin() is a harmless no-op the second time', () => {
    const ov = createOverlap({ maxPairs: 8 });
    ov.begin(); ov.add(1, 2); ov.end();
    assert.equal(ov.pairCount(), 1);
    ov.end(); // duplicate end(), no begin() between
    assert.equal(ov.pairCount(), 1, 'second end() finds nothing stale to sweep');
    const xA = new Int32Array(8), xB = new Int32Array(8);
    assert.equal(ov.drainExit(xA, xB), 0, 'no phantom exit from the duplicate end()');
});

// =============================================================================
// Invalid-id inputs: NaN, undefined, -0. `add`'s documented contract is
// "non-negative int32 ids"; these violate it. FINDING pins the coercion
// (silent, not validated) rather than asserting it is correct.
// =============================================================================

test('-0 as an id behaves as 0 (Int32Array/comparison coercion, not a distinct id)', () => {
    const ov = createOverlap({ maxPairs: 8 });
    const eA = new Int32Array(8), eB = new Int32Array(8);
    ov.begin();
    ov.add(-0, 5);
    ov.end();
    assert.equal(ov.drainEnter(eA, eB), 1);
    assert.equal(eA[0], 0, '-0 reads back as plain 0');
    assert.equal(eB[0], 5);

    // -0 and 0 must be the SAME pair (idempotent), not two distinct entries.
    ov.begin();
    ov.add(0, 5);
    ov.end();
    assert.equal(ov.pairCount(), 1, '-0 and 0 collapse to one identity');
});

test('FINDING: NaN as an id is not validated -- it coerces through Math.imul/Int32Array and can silently alias id 0', () => {
    const ov = createOverlap({ maxPairs: 8 });
    const eA = new Int32Array(8), eB = new Int32Array(8);

    ov.begin();
    ov.add(NaN, 5); // `a < b` is false for NaN, so canonicalization picks lo=5, hi=NaN;
    // Int32Array coerces NaN -> 0 on write, silently colliding with a real id 0.
    ov.end();

    assert.equal(ov.pairCount(), 1, 'FINDING: NaN did not throw, was not rejected');
    const n = ov.drainEnter(eA, eB);
    assert.equal(n, 1);
    assert.equal(key(eA[0], eB[0]), '0,5', 'FINDING: (NaN,5) silently stored as (0,5)');

    // The silent alias: a genuinely distinct pair (0,5) is now indistinguishable
    // from the corrupted (NaN,5) entry -- adding it again is treated as the
    // SAME pair (a stay), not a second distinct pair.
    ov.begin();
    ov.add(0, 5);
    ov.end();
    assert.equal(ov.pairCount(), 1, 'FINDING: (0,5) collides with the coerced (NaN,5) entry');
});

test('undefined as an id is not validated -- coerces via NaN through the same path as NaN', () => {
    const ov = createOverlap({ maxPairs: 8 });
    ov.begin();
    assert.doesNotThrow(() => ov.add(undefined, 5), 'FINDING: undefined id does not throw');
    ov.end();
    assert.equal(ov.pairCount(), 1);
});
