/** Harness compatibility: which declared peers the running installation does
 * not provide (design 2026-09-01-harness-compatibility), and — for the
 * shop's OWN declared peers — which ones it provides at a version outside
 * the declared range. */
import { type EntryIdentity } from '../shared/identity.ts';
/** Answers "can this installation provide `spec`?" — injected so fixtures
 * drive every verdict and exactly one call site touches the filesystem. */
export type PeerResolver = (spec: string) => boolean;
/**
 * The two filesystem reads the package lookup makes. Injected so fixtures can
 * drive every branch of the walk — including a permission failure, which a
 * real directory cannot stage when the suite runs as root — while
 * `NODE_LOOKUP_FS` below stays the one place this module touches the disk.
 */
export interface PackageLookupFs {
    /** `statSync`'s contract: follows symlinks, and throws an errno error
     * (`code` set) for a path it cannot stat. */
    stat(path: string): {
        isDirectory(): boolean;
        isFile(): boolean;
    };
    /** `readFileSync(path, 'utf8')`'s contract: throws for a file it cannot read. */
    readFile(path: string): string;
}
/**
 * The directory `spec` is installed at as seen from `fromDir`, or null when
 * it is not installed there: the walk's match (`findPackageDir`), and only
 * when that directory holds a `package.json` that stats as a FILE. Anything
 * else is ABSENT — a match with no manifest, a manifest that is not a file,
 * one whose stat fails — because the loader matches that directory and the
 * import fails there. The case this exists for: an uninstall that stops
 * part-way (on Windows a locked file is enough) can leave
 * `<profile>/node_modules/L/` holding nothing but a nested `node_modules/`,
 * and a plugin declaring L then fails with ERR_MODULE_NOT_FOUND; while any
 * directory counted as present, the badge naming L disappeared. The lookup
 * before that one, `require.resolve('<spec>/package.json')`, required the
 * manifest too.
 *
 * The manifest is stat-ed and never read here: presence is the file, and
 * what it says is the version resolver's question. So a manifest that exists
 * but cannot be read or parsed is a present package with no readable version.
 *
 * One edge is knowingly given up: a directory holding `index.js` and no
 * manifest DOES import — Node's legacy main resolution tries `index.js` in a
 * match without a manifest — but reads absent here. No package manager
 * installs that shape.
 *
 * Throws only for a `spec` that is not a bare package name. This one lookup
 * is behind the presence resolver, the version resolver, and the running
 * harness's own `@deepseek-ai/dsh-app-boot` (`harness.ts`).
 */
export declare function packageDirectory(fromDir: string, spec: string, fs?: PackageLookupFs): string | null;
/** `nodeResolver` over an injected filesystem, walking up from `fromDir` —
 * the seam fixtures drive the lookup through. */
export declare function packageResolver(fromDir: string, fs: PackageLookupFs): PeerResolver;
/**
 * The production resolver, anchored at the profile. A peer is present when
 * the first ancestor `node_modules/<spec>` that is a directory holds a
 * `package.json` file — the directory the ESM resolver that loads plugins'
 * host halves matches for a bare package, and a manifest in it
 * (`findPackageDir`, `packageDirectory`). From `<profile>/cordis.yml` the
 * walk reads `<profile>/node_modules`, then `$DSH_HOME/profiles/node_modules`
 * — the link farm dsh-app-boot's `healProfilesModuleFallback` keeps, pointing
 * into the global dsh install, on 0.1.5; 0.1.7 keeps none, and on a harness
 * that serves its packages another way `harnessPackageResolver` asks it in
 * front of this walk — and so on up to the root, past any candidate
 * it cannot stat, as Node's reader walks past one (measured on Node 26.6.0
 * with a looping link in front of a real copy: the import loads the copy).
 * The one shape where this and the loader knowingly disagree is a directory
 * holding `index.js` and no manifest, which imports and reads absent here;
 * no package manager installs it (`packageDirectory`).
 *
 * It used to ask `require.resolve('<spec>/package.json')`, a question that
 * answered wrongly twice:
 *
 *  - Under a packaged dsh executable (`process.pkg`) the link farm holds ESM
 *    proxy packages instead of symlinks, and a proxy's `exports` leaves
 *    `./package.json` out on purpose, so resolving it threw
 *    ERR_PACKAGE_PATH_NOT_EXPORTED for every proxied peer. Presence read that
 *    as present; the version resolver below could read nothing. Reproduced:
 *    a proxy at `0.2.0-rc.1` against a declared `^0.1.1-rc.2` gave presence
 *    true, version null, mismatches `[]` — the load-time self-check could
 *    never fire under a packaged dsh.
 *  - Node caches a SUCCESSFUL CJS resolution for the life of the process
 *    (`Module._pathCache`, keyed on request + lookup paths) and hands the
 *    cached filename back without looking at the disk; a failure is not
 *    cached. Measured on Node 26.6.0 in one process: absent → false,
 *    installed → true, uninstalled → STILL true. A peer the reader removed
 *    left every plugin declaring it unflagged until dsh restarted.
 *
 * So nothing is cached and `exports` is never consulted: every call stats
 * afresh, and a package with a manifest is present whatever its `exports`
 * says. `stat` follows symlinks, so a link to nothing reads absent — which
 * matters, because the link farm adds links and never prunes them: 29 of its
 * 511 dangled on the machine this was measured on, after upgrades.
 *
 * The global folders — `NODE_PATH`, `~/.node_modules`, `~/.node_libraries`,
 * `$PREFIX/lib/node` — are deliberately not searched: the ESM resolver that
 * loads plugin host code does not search them either. That is not academic.
 * pnpm's bin shims export `NODE_PATH` (this repo's own `node_modules/.bin/
 * vitest` points it into the virtual store), and under one the old lookup
 * found harness packages from any anchor at all, a temp directory included.
 *
 * It throws only for a `spec` that is not a bare package name, and
 * `incompatibilityMap` turns the throw into no verdict: a hostile name is not
 * a fact about this installation, and false is an accusation. Nothing on the
 * filesystem makes it throw. It used to throw on a stat failure other than
 * ENOENT or ENOTDIR as well, reasoning that such a candidate "may hold the
 * package" — but the loader never asks what a candidate it cannot stat holds;
 * it walks on (`findPackageDir`), so the throw silenced true badges and
 * established nothing.
 */
export declare function nodeResolver(baseUrl: string): PeerResolver;
/**
 * The one method of dsh's `pluginPackages` service the peer check reads: the
 * harness's own answer to "which package does this import reach?".
 *
 * dsh 0.1.7 stopped mirroring its installation into
 * `$DSH_HOME/profiles/node_modules`. It serves those packages to every
 * profile through Node's module hooks instead — its runtime resolution
 * routes a plugin's bare import of any package in the installation's
 * dependency closure to the package that declares it — so the walk
 * `nodeResolver` makes, which reads the disk around the profile, finds none
 * of them. Measured on 0.1.7-rc.2 against the live catalog, the walk read
 * `@deepseek-ai/dsh-tools` as missing for 1,038 entries, and the shop badged
 * 2,214 where 0.1.5-rc.3 badges 570 (design
 * 2026-09-01-harness-compatibility §11). `packageOf` answers from that
 * resolution for the importer `parentURL` names; 0.1.5 has no such service.
 *
 * Typed loosely because the answer crosses in from the harness: only a
 * string `manifestPath` is used.
 */
export interface HarnessPackageLookup {
    packageOf(specifier: string, parentURL: string): {
        manifestPath?: unknown;
    } | undefined;
}
/**
 * Presence on a harness that serves its packages through its runtime
 * resolution (`HarnessPackageLookup`): present when the harness reaches a
 * package for `spec` from `parentURL`, the profile anchor, and otherwise
 * whatever `walk` answers — `nodeResolver` over the same anchor, in
 * production. Asking the harness first asks the loader's own question, since
 * a plugin's import goes through the same resolution. The walk stays behind
 * it because either answer can only clear a badge, never raise one, and a
 * false badge is the failure this module exists to avoid.
 *
 * Throws, which `incompatibilityMap` turns into no verdict for the entries
 * declaring `spec`, for a name that is not a bare package name and for
 * anything the service throws. A harness that cannot answer is silence:
 * falling back to the walk alone would read every package it serves as
 * missing.
 */
export declare function harnessPackageResolver(walk: PeerResolver, lookup: HarnessPackageLookup, parentURL: string, fs?: PackageLookupFs): PeerResolver;
/**
 * Package name → the peer names that did not resolve. A key is present only
 * when at least one peer is missing, so an absent key means "runs here, or we
 * could not tell" — the client renders nothing for either.
 *
 * A resolver that throws yields NO verdict at all: an unavailable fact must
 * never read as an accusation, because one false warning teaches a reader to
 * ignore every warning.
 */
export declare function incompatibilityMap(entries: readonly (EntryIdentity & {
    peers?: string[];
})[], resolve: PeerResolver): Record<string, string[]>;
/**
 * The same question one step further on: which VERSION does this
 * installation provide for `spec`? `null` is the no-verdict signal — the
 * peer is absent, or its manifest could not be read. Injected exactly like
 * `PeerResolver`, so fixtures drive every verdict and only one call site
 * touches the filesystem.
 */
export type PeerVersionResolver = (spec: string) => string | null;
/** One declared peer whose provided version is outside its declared range. */
export interface PeerVersionMismatch {
    spec: string;
    /** The range this build declares in `peerDependencies`. */
    range: string;
    /** The version the installation actually provides. */
    found: string;
}
/** `nodeVersionResolver` over an injected filesystem, walking up from
 * `fromDir` — the seam fixtures drive the lookup through. */
export declare function packageVersionResolver(fromDir: string, fs: PackageLookupFs): PeerVersionResolver;
/**
 * The production version resolver: `nodeResolver`'s lookup, then the matched
 * directory's own `package.json`, read directly. Reading it directly is the
 * fix, not a shortcut: resolving `<spec>/package.json` is what an exports map
 * can refuse, and a packaged dsh's module proxy refuses it by construction
 * while carrying the proxied package's version in exactly that file (see
 * `nodeResolver`).
 *
 * The directory is the one the presence resolver finds present — the walk's
 * first directory match, holding a `package.json` file (`packageDirectory`;
 * `findPackageDir` cites Node's reader) — so the two never disagree about
 * which copy is installed: a candidate nobody can stat is walked past to the
 * copy further up, whose version is then the answer, exactly as the loader
 * imports that copy (measured on Node 26.6.0 with a looping link in front of
 * it); a match without a manifest is absent, and shadows every copy above
 * it. An `index.js`-only directory, which the loader would import, has no
 * manifest to read a version from either way.
 *
 * Anything that leaves no version to read answers null: a spec that is not a
 * bare package name, a peer that is absent, a manifest that is unreadable or
 * malformed, a `version` that is not a non-empty string. Absence is
 * deliberately NOT reported as a version violation: `incompatibilityMap` is
 * what covers a missing peer.
 */
export declare function nodeVersionResolver(baseUrl: string): PeerVersionResolver;
/**
 * `harnessPackageResolver`'s twin for versions: read afresh from the manifest
 * of the package the harness reaches for `spec` — the copy a plugin's import
 * loads, which the walk cannot see on dsh 0.1.7 — and `walk`'s answer only
 * when the harness reaches none. A manifest the harness names but nobody can
 * read or parse answers null, never the walk's version: the walk may match
 * another copy, and the version must describe the copy presence found (see
 * `nodeVersionResolver`).
 *
 * Null for a name that is not a bare package name and for a service that
 * throws, as null is already this resolver's no-verdict signal.
 */
export declare function harnessPackageVersionResolver(walk: PeerVersionResolver, lookup: HarnessPackageLookup, parentURL: string, fs?: PackageLookupFs): PeerVersionResolver;
/**
 * The declared peers whose provided version is outside the declared range,
 * ordered by peer name. Pure: the module graph arrives through `resolve`.
 *
 * `includePrerelease` is load-bearing, not a convenience. The harness ships
 * nothing but `-rc` versions, so under strict semver `^0.1.1-rc.2` excludes
 * every later rc on the same 0.1 line — including whichever one is installed
 * and working, named as a property because that version moves and a comment
 * naming it goes stale in place — and every future rc bump would raise a
 * false alarm. With it on, the range still excludes an older prerelease
 * (`0.1.1-rc.1`) and a minor- or major-line move
 * (`0.2.0-rc.1`, `1.0.0`), which are the moves that actually break a plugin
 * path. Discrimination on both sides is the whole point: one false warning
 * teaches a reader to ignore every warning.
 *
 * Anything unreadable yields NO verdict for that peer and never a violation:
 * a resolver that answers null or throws, a found version that is not
 * semver, a declared range semver cannot parse. The other peers are still
 * judged.
 */
export declare function peerVersionMismatches(ranges: Readonly<Record<string, string>>, resolve: PeerVersionResolver): PeerVersionMismatch[];
/**
 * The load-time message for a set of mismatches, or null when there is
 * nothing to say. Every mismatch is named with its declared range and the
 * version found, in ONE message: the reader needs the whole picture in the
 * line they will scroll past, and the message says the shop still loads
 * because refusing to load would cost them the shop over a diagnostic.
 */
export declare function peerVersionWarning(mismatches: readonly PeerVersionMismatch[]): string | null;
/** What a load-time check needs: the ranges this build declares, a way to
 * read what the installation provides, and somewhere to say it once. */
export interface PeerVersionCheckDeps {
    ranges: Readonly<Record<string, string>>;
    resolve: PeerVersionResolver;
    warn: (message: string) => void;
}
/**
 * A self-check that warns AT MOST ONCE, however many times it is called.
 * The guard is what keeps a diagnostic a diagnostic: a message repeated per
 * call is noise a reader learns to skip, and the shop's load path is not the
 * only place that could reasonably ask this question.
 *
 * It never throws. A check that could fail a load would be worse than the
 * mismatch it reports — the user would lose the whole shop over a warning.
 */
export declare function createPeerVersionCheck(deps: PeerVersionCheckDeps): () => void;
