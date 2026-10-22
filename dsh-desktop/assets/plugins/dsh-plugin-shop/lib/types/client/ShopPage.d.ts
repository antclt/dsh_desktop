/**
 * The shop's own page in dsh's main column (design
 * 2026-10-16-shop-sidebar-page §4.2), framed as dsh frames its Plugins page:
 * the page is its own scroll container, its head carries the title and the
 * one intro line and clears the desktop title bar, and the body below is
 * `ShopTab`, unchanged.
 *
 * It keeps the reader's scroll position in the page store (design
 * 2026-10-16-shop-sidebar-page §5.7). The position is written on every
 * scroll event — a browser fires at most one a frame, and the store takes it
 * without telling anyone — with the card at the page's top edge. The page
 * goes back there once, when the shelf is on screen again and the installed
 * list has answered, unless the reader moved first: the same card at the
 * same height, held there for a moment while the cards around it render, or
 * the position when that card is no longer on the shelf or the shelf was
 * refiltered since.
 */
import { type ReactNode } from 'react';
import { type ShopTabProps } from './ShopTab.tsx';
/** How long the page holds the reader's card at its height once it is put
 * back, in ms. The cards near it render a frame or two later and take their
 * real heights, each correction brings a few more above it into range, and
 * the shelf's entry animation moves it for 220ms (ShopTab.module.css).
 * Measured on dsh 0.2.0-rc.2 with the live catalog, the card stood still
 * within 200ms of being put back. */
export declare const HOLD_MS = 500;
export declare function ShopPage(props: ShopTabProps): ReactNode;
