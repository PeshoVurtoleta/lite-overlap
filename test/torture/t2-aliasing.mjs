/**
 * Tier T2 -- aliasing / buffer-sharing matrix (registered placeholder).
 *
 * O0's drain out-buffers are caller-owned and written linearly; the aliasing
 * matrix that matters (shared traversal stacks, scratch reuse across ops) lands
 * with O1's traversal. Registered now to fix the tier order.
 */
export function run() {
    // intentionally empty -- filled by a later session.
}
