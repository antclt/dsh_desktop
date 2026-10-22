/**
 * The browser half of the peer verdict (design 2026-09-01-harness-compatibility
 * §9): a declared peer is missing only if NEITHER the host NOR this page's
 * module table provides it.
 *
 * The host judges each entry's peers by node resolution from the profile
 * (`host/peers.ts`), and that answers only half of how a client plugin's
 * `require(x)` is served. The module table in `@deepseek-ai/dsh-client-modules`
 * answers in this order: a platform SEED word; an already materialized module
 * (`loadCache`); a graph row (`manifest.modules` — a `dsh.client` package in
 * this profile's boot graph); a registered factory; otherwise it throws. Seed
 * words never touch node resolution, and of the nine the 0.1.5-rc.3 web shell
 * seeds only `@deepseek-ai/cordis` exists as a package on disk — so the host
 * reports the other eight missing for every plugin that declares them, which
 * on the live catalog made most of the host's badges false — `react` among
 * them, the very module this shop's own client runs with. Design
 * 2026-09-01-harness-compatibility §9.1 owns the measurement.
 *
 * So the host's list is never rendered as it arrives: every name the live
 * table provides is removed first (`index.ts`, at the moment a result is
 * handed to the tab). A pure core, `refineIncompatible`, driven by any oracle;
 * and a thin shell, `moduleTableOracle`, over the harness's live object.
 */
/** What the module table says about one specifier: `true` provided, `false`
 * absent, `null` unknown. Injected, so fixtures drive every verdict and only
 * one oracle ever touches the harness. */
export type ModuleOracle = (spec: string) => Promise<boolean | null>;
/**
 * How long one probe may take before its answer counts as unknown.
 *
 * The work a probe can actually reach is a microtask: a seed-word lookup, or a
 * factory this page already registered. So this bounds a harness that never
 * answers, not work — and it exists because the cost of the alternative is the
 * whole shelf. `refineAgainstModuleTable` promises that a table in any state
 * cannot cost the reader the catalog, and an `import()` that never settles
 * would have made that promise false by leaving the tab with nothing to render
 * (§9's degradation rule: an unavailable fact is silence, never an accusation).
 * A probe per name, not one deadline for the whole refinement: every other
 * name is still judged, and the tab waits at most this long however many names
 * there are.
 */
export declare const MODULE_PROBE_TIMEOUT_MS = 2000;
/**
 * The host's verdict less every name the oracle provides.
 *
 * An entry whose list empties is dropped, and an entry ANY of whose names
 * comes back unknown gets no verdict at all — the rule `incompatibilityMap`
 * follows on the host, for the host's reason: an unavailable fact must never
 * read as an accusation, and keeping the rest of a list whose one unknown name
 * was dropped would publish a partial answer as the whole one. Each distinct
 * name is asked once, however many entries declare it. Never rejects: any
 * failure of the oracle is an unknown.
 */
export declare function refineIncompatible(incompatible: Readonly<Record<string, readonly string[]>>, provides: ModuleOracle, timeoutMs?: number): Promise<Record<string, string[]>>;
/**
 * An oracle over the live `modules` service, or null when the page offers no
 * usable table.
 *
 * The service is the harness's `ClientModuleLoader`, published to client
 * plugins as `ctx.reflect.provide('modules', …)`. It arrives as unknown-typed
 * foreign state, so only its PUBLIC contract is read, and only after
 * narrowing: `manifest.modules` must be an array, `loadCache` a Map and
 * `import` a function. `seed`, `factories` and `graphRows` exist on the
 * instance too, but they are TypeScript-`private` in the harness's own
 * declarations, and nothing here names them.
 *
 * Per spec, in the table's own order but with every side effect kept out:
 * 1. A graph row provides it, and `import` is NOT called — for a row it
 *    fetches the bundle and runs the module body, and a probe must never be
 *    what loads a plugin. `manifest.modules` is the row index, but it is not
 *    fixed for the page's whole life on every harness build. On 0.1.5-rc.3
 *    `this.manifest = options.manifest` is the constructor's only write, so a
 *    row placed at boot stands unchanged for as long as the page lives. On
 *    0.1.7-rc.2 (`next`) `updateManifest` REPLACES `this.manifest` outright
 *    with a new manifest that no longer lists an uninstalled package, and
 *    `reconcile` removes the plugin from the loader — so UNTIL this page's own
 *    uninstall reconciles, the OLD row still stands in `manifest.modules` and
 *    this step clears the entry falsely; AFTER it reconciles, this step can no
 *    longer be the false clear, because `manifest.modules` has already dropped
 *    the package. The false clear then comes from `prune`, which keeps the
 *    removed id only in the PRIVATE `graphRows` and in `loadCache`, and only
 *    while some retained module still references it — that is step 2 below,
 *    or the side effect of `import` in step 3 (a private graph row this
 *    function cannot see).
 * 2. A `loadCache` record provides it, again without `import`.
 * 3. Otherwise `import(spec, '', {})`, with the spec as written — the seed
 *    holds `react-dom/client` itself, not its stripped form. Resolving means a
 *    seed word, whose lookup has no side effect; rejecting with the
 *    "cannot resolve" message means absent; any other rejection is unknown.
 *
 * A kept-but-unmaterialized row is this function's own remaining blind spot:
 * asked about here, it still reaches step 3's `import` probe, which fetches
 * and runs it — the one side effect this module promises never to cause on
 * its own account. `refineAgainstModuleTable`'s page-removed set is the fix
 * for the one case a page can know about on its own — a name uninstalled
 * through THIS shop, on THIS page, since it loaded — by bypassing this oracle
 * for that name entirely rather than trusting a row that may only be kept. An
 * uninstall made from another tab, another window, or the CLI is not in that
 * set and stays unknown to this page until it reloads.
 *
 * One side-effect path remains: a registered page-local factory that is
 * neither a graph row nor yet materialized, which `import` materializes. That
 * is reachable only for a name the host could not resolve AND the page
 * registered without a row — the shell's own page-local modules are
 * node-resolvable, so the host never lists them. And what it does is what the
 * first real `require` of that name does anyway: run a factory this page
 * registered precisely so it would be materialized, once, memoized in
 * `loadCache`, fetching nothing. It moves that moment earlier; it runs nothing
 * the page did not already hold.
 */
export declare function moduleTableOracle(service: unknown): ModuleOracle | null;
/**
 * The host's verdict as this page can stand behind it: refined against the
 * live table, or `{}` — no verdicts at all — when there is no usable table.
 *
 * Never the host's list unrefined. Measured, that list is majority-false on
 * this harness line (see the header), so showing it whenever the table cannot
 * be read would hand the reader a verdict already known to be unreliable;
 * silence is this project's documented degradation — an unavailable fact must
 * never read as an accusation. Never rejects, so a table in any state cannot
 * cost the reader the catalog.
 *
 * `removed` is the page-removed set (design 2026-09-01-harness-compatibility
 * section 9.1): package names this page has uninstalled since it loaded.
 * Every name in it is reported missing exactly
 * as the host said, WITHOUT ever reaching the table — not the rows check, not
 * `loadCache`, not `import` — because a row or a cache record can outlive a
 * restart-free uninstall (`moduleTableOracle`'s header), and the table's own
 * "provided" would be precisely the false clear this set exists to prevent.
 */
export declare function refineAgainstModuleTable(incompatible: Readonly<Record<string, readonly string[]>>, service: unknown, removed?: ReadonlySet<string>, timeoutMs?: number): Promise<Record<string, string[]>>;
