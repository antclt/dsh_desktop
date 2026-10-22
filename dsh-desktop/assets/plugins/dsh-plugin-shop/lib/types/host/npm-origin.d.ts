/** The npm transport (design §2, §3): the catalog as a package.
 *
 * Shell — this and `origin.ts`'s fetch half are the only places the catalog
 * loader touches the network. The payoff is measured, not assumed: the same
 * bytes reach a China-side machine at 12.53 MB/s from npmmirror against
 * 0.03 MB/s from GitHub Pages. */
import { type CatalogOrigin } from './origin.ts';
/** Maximum compressed package bytes read from a registry. */
export declare const MAX_PACKAGE_BYTES: number;
/** Maximum bytes allowed after gzip inflation. */
export declare const MAX_INFLATED_BYTES: number;
/** Normalise to a trailing slash so relative `URL` resolution against a
 * registry that carries a path — every corporate registry, e.g.
 * `https://artifactory.corp/api/npm/npm-repo` — keeps that path instead of
 * eating its last segment; a host-root registry's trailing slash is already
 * a no-op either way. Exported so `catalog.ts`'s dedupe compares against the
 * same normalised form `npmOrigin` races on. */
export declare function normalizeRegistryUrl(url: string): string;
/**
 * An origin that reads the catalog out of `<registryUrl>`'s copy of
 * `<packageName>`.
 *
 * The probe is the abbreviated `latest` manifest — 13.5 KB against the live
 * registry — so the race is decided without downloading anything large. The
 * tarball is fetched lazily on the first `pointer()` or `file()` and kept on
 * the handle, so one origin download serves the whole load.
 */
export declare function npmOrigin(rawRegistryUrl: string, packageName: string, fetchImpl: typeof fetch): CatalogOrigin;
