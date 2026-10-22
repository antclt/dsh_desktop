/**
 * The fold under a card's whole red block: two lines by default, a small pill
 * that expands it when there is more, and the whole block again on a second
 * press. Three rules keep the fold honest:
 *
 * - It is measured, not declared. The toggle is offered only where the block
 *   itself shows it holds more than the clamp lets through —
 *   `scrollHeight > clientHeight`, read while the block is collapsed. A count
 *   of lines or characters would lie on exactly the narrow window the fold
 *   matters most for.
 * - It is independent of the card's own expand. The header's chevron opens
 *   the author description; the pill opens the red block.
 * - It is visual only. The label's accessible name and tooltip carry the
 *   WHOLE block, folded or open, so a screen reader meets the same facts
 *   either way.
 *
 * The measure runs wherever its answer can change: at mount, on every
 * collapse, when the block's box resizes (a ResizeObserver: the panel
 * narrowing, a font arriving), and when its text changes (a MutationObserver:
 * a verdict that lands after the first paint, or one a refresh withdraws).
 * Both observers are needed. A block already clamped at two lines keeps its
 * height when its content grows, so a ResizeObserver alone never hears the
 * line that pushes it over; and a block that first mounts with no box (a
 * hidden ancestor) changes no text when it is shown.
 *
 * While the block is open nothing is measured: an open block is as tall as
 * its content and fits by construction. Reading that as "nothing to fold" is
 * what once let the press that opened the fold unmount its own toggle.
 */
import { type MutableRefObject } from 'react';
export declare function useFoldableRedBlock(): {
    rootRef: MutableRefObject<HTMLDivElement | null>;
    expandable: boolean;
    expanded: boolean;
    toggle: () => void;
};
