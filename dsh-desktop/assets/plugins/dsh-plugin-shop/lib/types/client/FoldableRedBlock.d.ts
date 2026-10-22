/**
 * The shared fold: one surface's whole red block, clamped to two lines by
 * default, expanded on one press of the small pill under it, and back to two
 * on a second. One fold per surface, never per blocker: a card's body and an
 * Updatable row's refusal print the same verdict through two spellings, and
 * each folds on its own.
 *
 * The fold is measured, NOT declared: `useFoldableRedBlock` watches the block
 * and answers "is this too tall to leave alone?" from the block's own
 * rendered height, whenever the box or the text in it changes. Where nothing
 * can be measured — jsdom lays nothing out — no toggle is offered, and the
 * unit suite supplies a model of the engine instead
 * (`tests/fixtures/fold-geometry.ts`).
 *
 * The toggle is a BUTTON with `aria-expanded`, not a semantic fold the DOM
 * carries. A screen reader meets the whole block either way: the label
 * above it (`role="img"` + `aria-label` and `title`) is the accessible name
 * of the whole verdict, and it is NOT the thing that folds.
 */
import type { ReactNode } from 'react';
import type { ShopTabProps } from './ShopTab.tsx';
export declare function FoldableRedBlock({ children, t, attrName }: {
    children: ReactNode;
    t: ShopTabProps['t'];
    /** The data attribute the block is located by; its suffix names the toggle. */
    attrName: 'data-shop-remedy' | 'data-shop-refusal' | 'data-shop-blocker-lines';
}): ReactNode;
