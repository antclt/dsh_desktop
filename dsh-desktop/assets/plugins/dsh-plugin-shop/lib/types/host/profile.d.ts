/** Profile directory discovery and user-layer writes (§8: hot enable/disable). */
/** One id-targeted user-layer row (§8: the CLI hot-reloads this file). */
export interface UserLayerRow {
    id: string;
    disabled: boolean;
    /** The module the entry mounts, when the caller knows it. A user-layer row
     * that names a DIFFERENT module is one the harness skips
     * (applyEntryPatches), so only this name lets a named row be written. */
    name?: string;
}
/**
 * Find the profile directory that owns `startPath`.
 *
 * `baseDir` is the boot-provided profile directory (the Loader root's own
 * directory, `ctx.baseUrl`) and is authoritative when it is a profile. The
 * walk-up from `startPath` covers the case where the package is materialized
 * inside the profile's node_modules — but a `link:` install keeps the package
 * at its source location, so no ancestor of the module path is a profile at
 * all. In that case only `baseDir` can answer.
 */
export declare function discoverProfile(startPath: string, baseDir?: string): {
    name: string;
    dir: string;
};
/**
 * Set one entry's `disabled` key in the profile's user layer
 * (`cordis.patch.yml`) — {@link setUserLayerRows} for a single row, with the
 * same rules: one key changes and nothing else does (§8: the CLI's
 * watchUserPatches applies the change hot through HMR).
 */
export declare function setUserLayerRow(options: {
    profileDir: string;
    row: UserLayerRow;
}): void;
/**
 * Write every user-layer row of one package in a single pass.
 *
 * A package owns as many loader entries as its bundle patch inserts (see
 * {@link ownedEntryIds}), and they toggle together: writing them one at a
 * time would read-modify-write the file once per entry, so a crash between
 * two writes would leave the package half disabled.
 *
 * The edit changes one key and nothing else (design
 * 2026-09-26-market-borrowings §2). The layer is validated by the harness's
 * own parser first, so one it cannot load still throws and is never
 * rewritten; it is then edited as a YAML document, which keeps every comment,
 * every other row, every other key and every `!!js` scalar as the user wrote
 * them. The whole-file rewrite this replaced dropped each toggled id's row —
 * and with it a `config:` override the user had put there — and dumped the
 * list back through a library that models no comments, so the first toggle
 * erased the header dsh writes into every new profile.
 *
 * For each entry the row written is the LAST one carrying its id, when the
 * harness is sure to apply it: applyEntryPatches applies rows in order and
 * each key replaces the entry's value, so the last row that sets `disabled`
 * decides it. A row with `insert` is an insertion into a group, never an
 * override; a row naming another module is skipped by the harness; a named
 * row whose module the caller did not say cannot be judged. In each of those
 * cases a row is appended instead, which the harness applies last whatever
 * came before it — so appending is never wrong, only less tidy.
 *
 * An enable writes `disabled: false` rather than deleting the row, which is
 * what lost a user's row or the comment above it; it is also the harness's
 * own convention for this file from 0.1.7. The file keeps its permission bits
 * across the rename (a new one is created owner-only, as the harness's writer
 * does), because a config override can hold a credential.
 */
export declare function setUserLayerRows(options: {
    profileDir: string;
    rows: UserLayerRow[];
}): void;
/**
 * The loader entry ids one installed package contributes to the tree.
 *
 * This — not the entry's module name — is what identifies a package's rows.
 * A package declares a bundle patch whose `insert` list may add zero, one, or
 * many entries, and an inserted entry's `name` is the MODULE it mounts, which
 * need not be the package at all: `@tt-a1i/archify-dsh` inserts a configured
 * instance of `@deepseek-ai/dsh-skill-filesystem` and registers no module of
 * its own. Matching a package to its rows by module name therefore finds
 * nothing for such a package, which is why the toggle reported it as not
 * installed. The ids the package's own patch inserts are the only honest
 * answer, and the inventory's `entryId` is exactly that id verbatim.
 *
 * Ids the patch merely TARGETS (a bare id-keyed row overriding config) are
 * not owned: those rows belong to whoever inserted them, and claiming them
 * would let one package disable another's entries.
 *
 * A package with no bundle patch, or one absent from the profile, owns
 * nothing and yields `[]` — a distinct fact from "the entry is not live",
 * which only the inventory can answer.
 */
export declare function ownedEntryIds(options: {
    profileDir: string;
    packageName: string;
}): string[];
/** One loader entry a package's bundle patch inserts: its id, and the module
 * it mounts when the patch names one as a plain string. */
export interface OwnedEntry {
    id: string;
    name: string | undefined;
}
/**
 * {@link ownedEntryIds} with the module each entry mounts beside its id. The
 * name is what the harness judges a NAMED user-layer row by — a row naming a
 * different module is skipped (applyEntryPatches) — so it is what lets the
 * toggle write a user's own named row rather than append one beside it. It is
 * read through the harness's parser, so a relative name arrives anchored to a
 * file URL exactly as the composed entry carries it; an `!!js` name has no
 * plain value and reads as undefined. Throws where `ownedEntryIds` does.
 */
export declare function ownedEntries(options: {
    profileDir: string;
    packageName: string;
}): OwnedEntry[];
/**
 * An installed package's own `dsh.bundle.patch`, exactly as declared, or
 * undefined when the package, its manifest or the field is absent — or the
 * manifest cannot be read, which no post-install check can judge either.
 */
export declare function declaredBundlePatch(options: {
    profileDir: string;
    packageName: string;
}): unknown;
/**
 * Does a live loader entry id belong to the package that owns `owned`?
 *
 * `owned` holds CONFIG ids — the ids a bundle patch's `insert` declares. A
 * LIVE id is that id under the namespace of every tree composed above it,
 * colon-joined, so the last segment is the declared id and the segments
 * before it name the trees:
 *
 * - `foo` — no tree above the entry at all (a harness that composes the
 *   entry list directly).
 * - `include:foo` — what a REAL dsh boot produces: app-boot mounts the whole
 *   profile as one root Include entry (`id: include`), so EVERY entry any
 *   bundle patch inserted is namespaced by it. Matching only the bare
 *   spelling found no row for any installed package, and the toggle answered
 *   "not in the running plugin tree" for all of them.
 * - `include:<tree>:mkt-foo` — the shop's own hot subtree, which prefixes its
 *   rows `mkt-` so a plugin installed this session cannot collide with a
 *   boot-layer id. The same plugin, one restart earlier.
 *
 * The last segment is therefore the answer, with `mkt-` stripped when a tree
 * namespace is present.
 */
export declare function ownsEntryId(owned: ReadonlySet<string>, entryId: string): boolean;
/**
 * The loader entry id `packageName` shares with another installed package, or
 * null when it collides with nothing.
 *
 * The collision a bundle-name check cannot see. A bundle name and a loader
 * entry id are independent: two DIFFERENTLY-named bundles may both declare
 * `id: plugin-manager` — measured on `2768651338/dsh-plugin-manager` and
 * `Dingpenghui-good/dsh-plugin-manager` — and dsh then refuses to load the
 * whole tree ("duplicate loader entry id"), so the profile does not boot.
 * Conversely two SAME-named plugins often declare different ids and would
 * coexist fine, which is why the name gate is about overwriting a manifest
 * key and this is about the loader.
 *
 * Best-effort per package, the same rule the installed list uses: an
 * unreadable patch in some OTHER package owns nothing here rather than
 * failing the caller. A package declaring no ids collides with nothing.
 */
export declare function collidingEntryId(options: {
    profileDir: string;
    packageName: string;
    /** Every installed package name, `packageName` included or not. */
    dependencies: readonly string[];
}): {
    id: string;
    holder: string;
} | null;
