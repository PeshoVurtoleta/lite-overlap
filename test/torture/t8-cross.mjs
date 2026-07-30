/**
 * Tier T8 -- cross-package integration (registered placeholder).
 *
 * The real cross-package tier drives the table from a live @zakkster/lite-bvh
 * traversal; that arrives with O1. O0's peer touch-point is the FORMAT_VERSION
 * conformance assertion, which lives in test/Overlap.test.js (decision C1).
 * Registered now to fix the tier order.
 */
export function run() {
    // intentionally empty -- filled by O1 (bvh-driven).
}
