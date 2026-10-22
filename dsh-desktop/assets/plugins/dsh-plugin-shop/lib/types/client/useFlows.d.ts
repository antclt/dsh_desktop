/**
 * React's view of a keyed registry of install-shaped flows (flow-registry.ts):
 * start, poll to terminal, reset.
 *
 * Install and uninstall are the same machine. Both fold a
 * `ShopInstallStatusResult` through `reduceInstall` into an `InstallView`,
 * both poll every running identity from one interval, and both must keep a
 * settled outcome after the installed projection that follows it drops the
 * row the panel was mounted on (I-1, §7.2) — which is why the state is keyed
 * by identity here rather than held by the card.
 *
 * They differ in exactly one place: what the STARTING RPC's answer means. An
 * install refusal is a `rejected` view carrying the gate's code; an uninstall
 * refusal is a `failed` view carrying the host's published detail, because
 * `ShopUninstallResult`'s failure variant has no code to populate and those
 * codes belong to the install gate. That difference is the registry's
 * `begin`, and it is the whole of it.
 *
 * The two used to be hand-synced copies — 71 of 84 lines identical. The cost
 * was not theoretical: a single review round had to make the same edit twice
 * (the settle signature, and its call), and the `pending` set below was added
 * to one of them and not the other before this module existed.
 *
 * Since 2026-10-16 the registry is its own module, framework-free, and the
 * polling belongs to it: a component's effect stopped the moment the shop left
 * the screen (design 2026-10-16-shop-sidebar-page §5). This module only
 * renders one, through `useRegistryFlows`.
 */
import type { InstallArgs } from '../host/index.ts';
import { type FlowRegistry } from './flow-registry.ts';
import type { InstallView } from './present.ts';
/** One identity's flow, as the tab hands it to a panel. */
export interface KeyedFlow<TArgs> {
    view: InstallView;
    /** A start for THIS key is in flight and unanswered. The button that
     * offered it renders disabled with a wait cursor while this holds, and a
     * second `start` for the same key is ignored rather than sent. */
    starting: boolean;
    start: (args: TArgs) => Promise<void>;
    reset: () => void;
}
export interface UseKeyedFlows<TArgs> {
    /** Two panels asking for the same identity receive one flow — the SAME
     * object, for as long as that identity's view is unchanged, so a
     * memoized consumer handed the result re-renders only when its own flow
     * moves. The accessor's identity still tracks `views`; the result's does
     * not, and the result is what a card should be given. */
    flowFor: (key: string) => KeyedFlow<TArgs>;
    /** Return every identity whose view `predicate` selects to `idle`, and
     * nothing else. Stable across renders, unlike `flowFor`; a call selecting
     * nothing leaves the registry — and so every flow and `pending` — exactly
     * as it was. The receipts dsh restarting under the page settled are
     * cleared the same way at the store, through each registry's own
     * `resetWhere` (page-store.ts `noteRestarted`; design §8, 2026-10-06
     * amendment). */
    resetWhere: (predicate: (view: InstallView) => boolean) => void;
    /**
     * The identities whose flow is not `idle` — asked by the shelf, which has
     * to keep a settled uninstall's row in the Installed view after the
     * installed projection drops it.
     *
     * A membership test rather than a flow, and its IDENTITY changes only when
     * that membership does. Both matter to the same caller: `flowFor` builds a
     * fresh object and two closures per call, so asking it inside a filter
     * allocated three objects for every entry on the shelf; and it tracks
     * `views`, which changes on every poll RESPONSE, because `reduceInstall`
     * returns a new `running` view for each status. A filter depending on that
     * re-ran over the whole catalog once a second for a log line nobody read.
     */
    pending: ReadonlySet<string>;
}
/** One entry's install flow, as the tab hands it to a panel: the page
 * store's install registry (page-store.ts), begun through flow-registry.ts's
 * `beginInstall`. */
export type InstallFlow = KeyedFlow<InstallArgs>;
/** One entry's uninstall flow, as the tab hands it to a panel: the page
 * store's uninstall registry, begun through `beginUninstall`. */
export type UninstallFlow = KeyedFlow<{
    name: string;
}>;
/** The uninstall flows as the tab hands them to the shadowed rows. */
export type UseUninstallFlows = UseKeyedFlows<{
    name: string;
}>;
/** The keyed-flow face over any registry: one of the page store's, which
 * outlives the component, or one of the store a tab builds for itself when
 * none is handed over (ShopTab). */
export declare function useRegistryFlows<TArgs>(registry: FlowRegistry<TArgs>): UseKeyedFlows<TArgs>;
