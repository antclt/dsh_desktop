/**
 * The shop's two buttons on dsh's Plugins page (design
 * 2026-10-16-shop-sidebar-page §7), in the head of a detail page, before the
 * page's own switch and uninstall (`plugins.detail.actions`, dsh 0.1.7-rc.2
 * and later): "Open Plugin shop" on the shop's own bundle page, and "View in
 * Plugin shop" on the page of any bundle the shelf lists. Any other subject
 * renders nothing, as the slot's contract asks of an entry.
 *
 * It renders inside dsh's page, so it carries its own error boundary: a
 * throw here costs the reader a button, never dsh's page.
 */
import { type ReactNode } from 'react';
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { ShopCatalogResult } from '../host/index.ts';
import type { ShopPageStore } from './page-store.ts';
/** One bundle as a detail contribution sees it: the field this reads of the
 * Plugins page's `PluginPackageRef` (`dsh-client-ui-plugin-manager`'s slot
 * contract, identical in 0.1.7-rc.2 and 0.2.0-rc.2). */
export interface PluginPackageRef {
    readonly name: string;
}
/** What a detail page is about, as the Plugins page hands it over. */
export type PluginsSubject = {
    readonly kind: 'bundle';
    readonly pkg: PluginPackageRef;
} | {
    readonly kind: 'row';
    readonly pkg: PluginPackageRef;
} | {
    readonly kind: 'item';
    readonly id: string;
};
/** The face index.ts hands the buttons. */
export interface ShopDetailActionInjected {
    /** The catalog a listing question is asked of (index.ts `listing`). */
    listing: () => Promise<ShopCatalogResult>;
    /** Whether the page can be opened at all: false without a layout service
     * that can select a panel. */
    canOpen: () => boolean;
    openShop: () => void;
    page: ShopPageStore;
}
export type ShopDetailActionProps = {
    subject: PluginsSubject;
} & PropsLocale<'settings.shop'> & InjectFace<ShopDetailActionInjected>;
export declare function ShopDetailAction(props: ShopDetailActionProps): ReactNode;
