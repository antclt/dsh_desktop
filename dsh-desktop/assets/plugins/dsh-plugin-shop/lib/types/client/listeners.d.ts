/**
 * The listener plumbing the client's external stores share: the page store
 * and its owed notices (page-store.ts), the flow registries
 * (flow-registry.ts) and the restart monitor (restart-monitor.ts). Each keeps
 * its listeners in a plain `Set`. React subscribes through `listen`, as
 * `useSyncExternalStore` asks, and a change reaches every listener through
 * `notify`.
 *
 * Functions over that `Set`, never an object a store keeps in its place. The
 * restart monitor's store lives on `globalThis`, and a 0.8.x shop hands it
 * over (design 2026-10-16-shop-sidebar-page §6). Its `listeners` is a plain
 * `Set` that the predecessor's own code adds to, deletes from and iterates,
 * so the field's shape is a contract across versions, and these functions
 * take that `Set` as it is.
 */
/** Add `listener`, and hand back what removes it. A forgotten set takes
 * none: its store tells nobody anything more, so a listener subscribing in
 * a hot swap's window would only be held. */
export declare function listen(listeners: Set<() => void>, listener: () => void): () => void;
/** Call every listener as the set stands when the call begins. Over a copy,
 * so a listener that subscribes or unsubscribes one while it runs (React
 * re-subscribing in the render the change caused) changes the next notify,
 * never this one. */
export declare function notify(listeners: ReadonlySet<() => void>): void;
/** Drop every listener, and take none again: a disposed store tells nobody
 * anything more. */
export declare function forget(listeners: Set<() => void>): void;
