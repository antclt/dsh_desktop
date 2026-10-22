/** Self-update version check: the shop's latest published version, from the
 * npm packument. Advisory by design — like the stars sidecar, a failed
 * check degrades to `null` and never throws, never blocks a publish. The
 * catalog cannot serve here: the shop is bootstrap-installed and is not
 * harvested into its own catalog. */
/** How long one registry gets to answer. `shop/version` is warmed at every
 * web boot, so a silent socket must not hold the boot indefinitely. */
export declare const VERSION_CHECK_TIMEOUT_MS = 5000;
/**
 * Fetch the shop's `latest` dist-tag, or `null` when no registry can answer.
 * The user's own registry is tried first when known; npmjs is always the
 * fallback so a mirror that lags cannot hide a release.
 */
export declare function fetchLatestVersion(fetchFn?: typeof fetch, options?: {
    registry?: string | null;
    timeoutMs?: number;
}): Promise<string | null>;
