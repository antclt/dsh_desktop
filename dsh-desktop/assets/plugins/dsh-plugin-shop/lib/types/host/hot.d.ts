/**
 * Restart-free installs: mount a freshly installed plugin into the running
 * composition through a shop-owned Include subtree (design 2026-08-31
 * market-borrowings §4, mechanism ported from dsh-market's hot.ts).
 *
 * Durable state stays with the profile's `dsh.profile.bundles`, so the next
 * boot loads the plugin through the normal bundle layer. The subtree exists
 * only for this process: its input files live under `<profile>/.dsh-shop/`
 * and are wiped on every boot, so a crash can never leave a file that
 * collides with the bundle layer (inserting an id the bundle layer also
 * inserts is a hard boot failure). Rows are prefixed `mkt-` for the same
 * reason: within this session the hot entry must never share an id with a
 * boot-layer entry, including a disabled one left behind by an update swap.
 *
 * The Include subclass suppresses `write()` — the loader otherwise persists
 * tree changes back to the file it read (dsh-market hot.ts; the in-tree
 * precedent is dsh's agent-presets PresetTree).
 *
 * Reasons are CODES, never copy: the host has no idea which language the
 * person reading it set in dsh, so it names what happened and the client
 * renders it through dsh's own locale service.
 *
 * Deliberate non-port: dsh-market's client-only shim (`mountClientOnlyDeps`
 * and `shimNames`, which hot-mounted a package with no server-side entry by
 * inserting a shim loader entry) is omitted. Our catalog never lists a
 * package without `dsh.bundle`, so the shim branch is unreachable here
 * (YAGNI). `hotMount` still distinguishes "no patch file / not
 * hot-mountable" from "restart will fix it" through the `reason` code.
 */
/** One hot-mountable insert row: a plain `- id:` / `name:` pair. */
export interface HotRow {
    id: string;
    name: string;
}
/** The loader-side surface hot mounts consume: a cordis plugin registration
 * and (optionally) a logger. The real ctx satisfies this structurally. */
export interface HotContext {
    plugin(plugin: unknown, config: unknown): PluginHandle;
    logger?: {
        info(message: string): void;
        warn(message: string): void;
    };
}
/** A cordis Fiber handle: `await()` settles when activation finishes (or
 * fails); `dispose()` tears the fiber down. */
export interface PluginHandle {
    await(): Promise<unknown>;
    dispose(): Promise<unknown> | void;
}
/**
 * Why a restart is needed after the hot path ran — a stable code the client
 * turns into copy in the reader's own dsh language.
 *
 * Five of the six say the MOUNT could not activate, and distinguish
 * "restart will fix it" (`timeout`, `mount-failed`) from "this package can
 * never hot-mount" (`no-patch`, `not-simple`) and "this harness cannot"
 * (`host-unsupported`).
 *
 * `already-loaded` is the one that does not: no mount was attempted, because
 * this process may already hold the package's module, and Node caches a
 * module by its URL — the new files sit at the old URL, so a mount would re-run
 * the old code under the new version's name (design
 * 2026-09-26-market-borrowings §1). The gateway decides it before calling
 * `hotMount`, which never returns it.
 */
export type HotRestartReason = 'no-patch' | 'not-simple' | 'host-unsupported' | 'timeout' | 'mount-failed' | 'already-loaded';
export interface HotMountResult {
    ok: boolean;
    /** null exactly when ok. */
    reason: HotRestartReason | null;
}
/** Test injection for the host shell (filesystem + ctx + clock). Production
 * defaults: the real include import, node:fs, `join(profileDir, '.dsh-shop')`
 * and `DSH_SHOP_HOT_MOUNT_TIMEOUT_MS || 10000`. */
export interface HotDeps {
    /** The tree class to mount; production loads the Include class via the
     * optional peer. An explicit null means "the include is unavailable" and
     * short-circuits the load (the old-harness fallback). */
    hotTreeClass?: unknown;
    fs?: HotFs;
    dir?: string;
    timeoutMs?: number;
    now?: () => number;
}
/** The node:fs surface hot.ts uses; injectable so tests never touch disk. */
export interface HotFs {
    read: (path: string) => string;
    write: (path: string, data: string) => void;
    list: (path: string) => string[];
}
export declare const nodeHotFs: HotFs;
/**
 * Parse a bundle patch into the plain insert rows a hot tree can replicate.
 *
 * Only an `insert` list of plain `id`/`name` entries parses. A bare id-keyed
 * row is a TARGETING patch — the loader looks the id up in the already
 * composed tree and skips it when absent (applyEntryPatches), so it creates
 * nothing and there is nothing to replicate. A row carrying config, a group,
 * or an `!!js` expression name returns null too, and every null sends the
 * caller to restart activation. Parsed as YAML in the loader's own dialect,
 * so line endings and comments are the parser's problem, not ours, and
 * nothing in the patch is evaluated. Pure: string in, rows out.
 */
export declare function parseSimplePatch(patchText: string): HotRow[] | null;
/** Render the accepted rows with prefixed ids — the exact input file the
 * Include tree mounts. Only values the line scan accepted are emitted, and
 * the output is itself a simple patch (round-trips through
 * parseSimplePatch). */
export declare function renderRows(rows: HotRow[], prefix: string): string;
/**
 * Mount one installed package into the running composition through an
 * Include subtree: read its bundle patch, replicate the simple rows under
 * `mkt-` ids into `<profile>/.dsh-shop/hot-<n>.yml`, register the tree, and
 * race its activation against `timeoutMs`. Success returns `ok: true` with
 * no reason; any fallback returns `ok: false` with a reason code
 * distinguishing "restart will fix it" (timeout, activation failure,
 * unavailable include) from "this package can never hot-mount" (no patch
 * file, or rows the hot tree cannot replicate). The plugin is installed in
 * the bundle layer either way, so a restart always activates it.
 */
export declare function hotMount(ctx: HotContext, profileDir: string, packageName: string, deps?: HotDeps): Promise<HotMountResult>;
/**
 * Dispose a package's hot mount. Returns false (without touching anything)
 * when the name is not mounted; the handle leaves the map before the
 * dispose so a mount can never be disposed twice, and a throwing dispose
 * propagates — the plugin may still be live in this session.
 */
export declare function hotUnmount(packageName: string): Promise<boolean>;
/** The package names hot-mounted this session, in mount order. */
export declare function listHotMounts(): string[];
/** Wipe the session's mount inputs at host start: `hot-<n>.yml` files under
 * `<profile>/.dsh-shop/` only — anything else in the namespace directory is
 * left alone, and a missing directory is a no-op. */
export declare function cleanHotDir(profileDir: string): void;
