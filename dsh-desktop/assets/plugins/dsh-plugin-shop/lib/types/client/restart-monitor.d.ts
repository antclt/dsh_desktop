/**
 * The restart handoff's browser half (design §8), held by the page rather
 * than by the tab that confirmed the restart.
 *
 * It lived in a RestartPanel effect until 2026-09-27, and a self-update
 * killed it. dsh's client HMR (`@deepseek-ai/dsh-client-hmr`, mounted by the
 * web bundle unconditionally) stat-polls every client bundle and hot-swaps
 * one whose file changed; a self-update rewrites this package's own
 * `lib/client.js`, so the swap disposes the tab's fiber and mounts a fresh
 * instance of a freshly imported module. The effect's cleanup then stopped
 * the probe, and once the restart finished nothing reloaded the page: it sat
 * on the old process's answers while dsh's socket quietly reconnected to the
 * new one. Measured on dsh 0.1.5-rc.3 updating 0.8.2 to 0.8.3; with the
 * `/plugins/events` channel blocked the same flow reloaded.
 *
 * So the state sits on `globalThis` under a registry symbol — the one thing a
 * swapped-in module instance shares with the one it replaced — and the probe
 * loop is plain timers owned by no fiber. Any tab reads the state, so the
 * replacement renders the restart under way instead of offering another.
 *
 * The REQUEST is the page's too, since later the same day. On dsh
 * 0.1.5-rc.3 and 0.1.7-rc.2 alike a unary Remote call is an HTTP POST whose
 * fetch rides the calling mount's abort signal, and an answer that arrives after the mount went inactive is
 * rewritten to "no longer mounted" (dsh-api-gateway's client). A swap landing
 * inside the restart's round trip therefore left the tab that pressed with no
 * answer, whether or not the host had committed: measured with the request
 * held, the host never restarted; with the response held, it did, and the page
 * stayed on the old process showing the old version. So every module instance
 * registers its own path to the host here (the client half's apply), a confirm
 * records the request before anything is awaited, and a request whose path is
 * withdrawn mid-call is asked again through a live one. The host answers a
 * repeat with the restart it already committed.
 *
 * The VERDICT outlives the page, since 2026-10-06. The monitor reloads on
 * any origin that keeps answering, and a process that never exited answers
 * as steadily as one that replaced it: on macOS a confirmed restart reloaded
 * into the very process it had asked to go, and the row went on showing the
 * version before the update with nothing to say why. A commit therefore
 * records, in this tab's sessionStorage, which process committed it (its
 * boot identity and pid), and every version answer the reloaded page
 * receives is judged against that record (`noteBoot`).
 */
import type { ShopRestartResult } from '../host/index.ts';
/** What this page is doing about a restart: waiting for the host to answer
 * the confirm, waiting for the new server once it committed, given up on
 * that server, or reloaded into the process that was asked to restart and
 * found it still answering — `pid` is that process. `logFile` is where the
 * host said the new process writes; a host older than that field sends
 * none, and one older than the boot identity sends no `pid` and is never
 * judged `not-restarted` at all. */
export type RestartMonitorState = {
    kind: 'requesting';
} | {
    kind: 'restarting';
    logFile?: string;
} | {
    kind: 'failed';
    logFile?: string;
} | {
    kind: 'not-restarted';
    pid?: number;
    logFile?: string;
};
/** How one press ended, for the panel that made it: the page follows the
 * restart from here, the host refused it, or it never reached a host that
 * could answer. */
export type RestartRequestOutcome = {
    kind: 'started';
} | {
    kind: 'refused';
    detail: string;
} | {
    kind: 'unreachable';
};
/**
 * Whether a shop instance on this page has registered its restart path:
 * every `apply` since 0.8.4 does so before anything can ask for a restart.
 * Read before this instance's own `apply` registers one, a store here names
 * a predecessor — a 0.8.x shop when no page store sits beside it
 * (page-store.ts `readPredecessor`; design 2026-10-16-shop-sidebar-page §6).
 * The store outlives a carrier's withdrawal: a predecessor's teardown
 * withdraws its carrier and leaves the store, and the store is what names it.
 * Only a read: unlike `monitorStore`, it never creates the store.
 */
export declare function hasRestartMonitorStore(): boolean;
/** The page's restart, or null when it has committed none. The same object
 * until the state changes, as `useSyncExternalStore` requires. */
export declare function readRestartMonitor(): RestartMonitorState | null;
/** Be told when the page's restart changes state. */
export declare function subscribeRestartMonitor(listener: () => void): () => void;
/**
 * Watch the origin for the restarted server and reload into it: probe once
 * the grace period is over (the host exits within it, so an answer is the NEW
 * server), and reload only after it has KEPT answering for the stable window.
 * A boot that is about to fail can bind the port and answer before its plugin
 * tree is audited and it exits; reloading on that one answer left the reader
 * on a blank page instead of the notice naming the log (design
 * 2026-09-26-market-borrowings §3). `restartMonitorVerdict` decides; this
 * loop only probes. Probes never overlap: each is scheduled one poll interval
 * after the previous one settled.
 *
 * A restart already being watched is left alone — every offer on the page
 * renders this state, so a second press can only come from a panel that has
 * not re-rendered yet, and a second loop would probe the same origin twice.
 */
export declare function startRestartMonitor(options: {
    reload: () => void;
    logFile?: string;
    bootId?: string;
    pid?: number;
}): void;
/**
 * Register one module instance's path to the host; the client half's apply
 * does, with the `restart` it hands the tab. The returned function withdraws
 * it, and has to run BEFORE the mount it rides is disposed: a request still in
 * flight on it is then asked again through the newest live path — at once if
 * one is registered, or as soon as one is — rather than waiting on a call the
 * dispose is about to abort.
 */
export declare function registerRestartCarrier(restart: () => Promise<ShopRestartResult>): () => void;
/**
 * Ask the host to restart, for the page (design §8). The request is the
 * page's from the confirm on, not from the answer: every offer renders it as
 * under way, and a second press joins it rather than asking twice. It rides
 * the newest path a module instance registered, or — where no client half
 * registered one — the pressing tab's own `restart`.
 *
 * Resolves, never rejects, with what the press should show. A commit starts
 * the monitor and is `started`. A refusal and an unreachable host leave
 * nothing under way. A path withdrawn mid-call decides nothing but a commit;
 * the ask on the path that replaced it decides the rest, and that ask
 * finding no host is followed as a restart, since the first ask may have
 * committed and taken its host down with it.
 */
export declare function requestRestart(options: {
    reload: () => void;
    restart: () => Promise<ShopRestartResult>;
}): Promise<RestartRequestOutcome>;
/**
 * Judge this tab's last committed restart by the process answering now. The
 * client half hands every `version()` answer here (index.ts), so the verdict
 * is made on the first answer a reloaded page receives, before any tab opens.
 *
 * The same boot as the one that committed is a restart that never happened:
 * the page says so, naming that process, for as long as it keeps answering
 * — across reloads too, since the record stays. Any other answer, an older
 * host's included, is a process that replaced it, and the record is spent.
 * Nothing is judged while this page's own restart is under way: the process
 * that committed answers until it exits, two seconds later.
 */
export declare function noteBoot(bootId: string | undefined): void;
/** Stop the probe loop and forget the page's restart, its request, every
 * registered path and the tab's record of its last commit. Nothing in the
 * page calls this — a committed restart ends in a reload or a failure — so
 * its caller is a test isolating one case from the next. */
export declare function resetRestartMonitor(): void;
