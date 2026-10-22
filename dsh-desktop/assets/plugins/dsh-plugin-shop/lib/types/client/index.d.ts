/**
 * Shop surface, browser half — the shop's own page in dsh's main column
 * (`main`), which browses the catalog, installs on one click, toggles
 * enablement, lists installed plugins, and restarts dsh after installs; its
 * row in the left sidebar (`sidebar.panellist`); and the two buttons on dsh's
 * Plugins page that lead into it (`plugins.detail.actions`) (design
 * 2026-10-16-shop-sidebar-page).
 * Mounts the shop Remote itself (the assembly does not know this package)
 * and holds no privilege beyond the nine `shop/*` methods (the shop design's
 * §5.3).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { ShopLocaleKey } from './locales.ts';
import { type PluginsSubject } from './ShopDetailAction.tsx';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** The shop page's copy. */
        'settings.shop': ShopLocaleKey;
    }
    interface SlotMap {
        /** dsh's left column of global panels (`dsh-client-ui-sidebar`, on
         * 0.1.5-rc.3, 0.1.7-rc.2 and 0.2.0-rc.2): one row per entry, which owns
         * the button, its label and its selection, and renders the entry's glyph
         * at the size it asks. Declared here, in dsh's own terms, because the
         * 0.1.1-rc.2 protocol this package builds against predates it — as
         * `connection/reset` is below. */
        'sidebar.panellist': {
            kind: 'list';
            scope: 'root';
            owner: {
                size: number;
                active: boolean;
            };
        };
        /** The main column, keyed by panel id (`dsh-client-ui-layout`, the same
         * harnesses): only the selected key is mounted, and the sidebar row with
         * the same id selects it. Declared here for the same reason. */
        'main': {
            kind: 'keyed';
            scope: 'root';
        };
        /** Controls at the head of a detail page on dsh's Plugins page
         * (`dsh-client-ui-plugin-manager`, 0.1.7-rc.2 and later), rendered with
         * the page's subject; an entry renders null for a subject it has nothing
         * for. On a harness without the Plugins page nothing declares it, and a
         * registration into it waits without ever rendering. */
        'plugins.detail.actions': {
            kind: 'list';
            scope: 'root';
            owner: {
                subject: PluginsSubject;
            };
        };
    }
}
declare module '@deepseek-ai/cordis' {
    interface Events {
        /** A connection generation was established: the first connect after
         * plugin boot, and every reconnect. `@deepseek-ai/dsh-client-connection`
         * declares it, in these words, from 0.1.5-rc.3 on, and dsh-api-gateway's
         * client emits it there through 0.2.0-rc.2; the 0.1.1-rc.2 this package
         * builds against predates the declaration. A harness that never emits
         * it leaves the shop as it was before it listened. */
        'connection/reset'(): void;
    }
}
/** Dictionary namespace owned by this plugin. */
export declare const NS = "settings.shop";
/** The id the shop's sidebar row and its main-column page share (design
 * 2026-10-16-shop-sidebar-page §4.1). */
export declare const SHOP_PANEL = "shop";
/** How long a stashed catalog may satisfy a plain open. The host applies the
 * same five-minute freshness window, so the client stash must not outlive it. */
export declare const WARM_TTL_MS: number;
/** Services required by the page, row and Plugins page button registrations
 * and the Remote mount.
 *
 * `remote.shop` is deliberately ABSENT: this package both mounts its own
 * Remote (the assembly does not know it, §7.3) and consumes it, and cordis
 * will not let one package do both through the inject face. Declaring the
 * face makes the boot's activation gate wait for the `remote.shop` service —
 * which only this package's own apply can register — and the real web boot
 * deadlocked on exactly that ("waiting for service: remote.shop"). The
 * namespace is therefore read through the reflect shop instead (`ctx.get`,
 * see apply), which has no inject requirement. */
export declare const inject: string[];
/** Mount the shop Remote and contribute the shop's page, its sidebar row and
 * its buttons on dsh's Plugins page. */
export declare function apply(ctx: ClientContext): Promise<void>;
