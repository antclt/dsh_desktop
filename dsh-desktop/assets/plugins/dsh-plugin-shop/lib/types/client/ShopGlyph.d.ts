/**
 * The shop's glyph in dsh's sidebar (design 2026-10-16-shop-sidebar-page
 * §4.3): a bag with a whale tail, drawn the way dsh draws its own panel
 * glyphs — a 16×16 view box, one-pixel `currentColor` strokes, no fill — so
 * the row's colour and its selection treatment reach it unchanged. `active`
 * is ignored, as dsh's own glyphs ignore it: the row draws the selection.
 */
import type { ReactNode } from 'react';
export declare function ShopGlyph({ size }: {
    size: number;
    active: boolean;
}): ReactNode;
