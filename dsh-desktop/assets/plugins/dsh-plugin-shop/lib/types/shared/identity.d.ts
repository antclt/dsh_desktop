/**
 * One entry's install identity, defined once for both halves of the package.
 *
 * `name` is not an identity. The registry's uniqueness rule is `npm:<name>`
 * for an npm entry and `github:<repo>#<subdir>` for a repository entry, so
 * two repositories publishing the same package name remain distinct.
 */
/** The fields that decide which catalog row a request is about. */
export interface EntryIdentity {
    source: 'npm' | 'github';
    name: string;
    repo?: string;
    subdir?: string;
}
/** The registry's uniqueness rule, shared with the presentation layer. */
export declare function identityKey(identity: EntryIdentity): string;
/** A GitHub commit pin. */
export declare const COMMIT_SHA: RegExp;
/** A GitHub release tag accepted as the version/pin of a rescued entry. */
export declare const RELEASE_TAG: RegExp;
/** Where a profile dependency spec says its package came from. */
export type SpecOrigin = {
    kind: 'npm';
}
/** `owner/slug` spelled as the spec spells it — GitHub does not preserve
 * case for comparison, but a reader sent to look at `clapeill/x` when the
 * repository is `CLAPEILL/x` has to guess at it. */
 | {
    kind: 'github';
    repo: string;
};
/**
 * Attribute a profile dependency spec to where its package came from.
 *
 * The single parse: every other function here reads its answer rather than
 * re-applying the regexes, so the grammar cannot be widened in one place and
 * not the other.
 *
 * `null` means this spec is a form the grammar does not cover — `git+ssh://`,
 * `git@github.com:`, a `file:`/`link:` checkout, `workspace:*`, an `npm:`
 * alias to a different package, a non-GitHub URL. Attribution is POSITIVE on
 * both arms and null is never guessed away: reading an unattributable spec as
 * npm is what let an npm entry silently replace a git install, and what
 * printed "already installed from the npm package X" about a local checkout.
 */
export declare function parseSpec(spec: string): SpecOrigin | null;
/** `owner/slug`, lowercased, or null when this spec is not a GitHub
 * reference. Lowercased because it exists to COMPARE. */
export declare function parseRepoSpec(spec: string): string | null;
/**
 * Whether two identities of the SAME bundle name are the same install.
 *
 * Deliberately coarser than `identityKey`: a profile records a dependency
 * spec, which carries the repository but not the subdirectory, so this is the
 * finest distinction the installed state can actually support. It ignores
 * `name` — every caller has already matched on it — and answers only "is the
 * thing under that name this one, or a different one?".
 */
export declare function sameInstall(a: EntryIdentity, b: EntryIdentity): boolean;
/**
 * What the profile's dependency spec for a name says about this entry.
 *
 * Three-valued on purpose. `unknown` is a spec `parseSpec` cannot attribute,
 * and the two callers need opposite defaults for it while sharing one rule:
 * `installed()` shows the row (it is the only row that can represent that
 * dependency, and dropping it would take the uninstall control with it),
 * while the install gate refuses (overwriting a checkout it cannot identify
 * is exactly the silent replacement it exists to prevent). Collapsing the two
 * into a boolean is what forced one of them to be wrong.
 */
export type SpecVerdict = 'same' | 'different' | 'unknown';
export declare function specVerdict(entry: EntryIdentity, spec: string): SpecVerdict;
/**
 * Whether an installed dependency spec may be shown as this catalog entry's
 * row — the DISPLAY default of {@link specVerdict}.
 *
 * An unattributable spec still needs exactly one row to represent it, or the
 * same dependency shows twice under two same-named entries and the uninstall
 * control appears on both. The npm entry claims it: it is the shape with
 * nothing else to distinguish it, and this is the tie-break the installed
 * list has always used.
 */
export declare function installedSpecMatches(entry: EntryIdentity, spec: string): boolean;
/**
 * The token naming whatever holds a bundle name, for someone deciding what to
 * do about it.
 *
 * One function for both halves. The host's refusal and the card's badge wrap
 * it in their own sentence — the host in English prose, the card in the
 * reader's language — but the token itself is identical, so the two surfaces
 * can never name one plugin two ways. It is language-neutral for that reason:
 * a github holder is its repository (the only thing that tells it apart from
 * the entry it blocks), an npm holder is `npm:<name>`, and a spec we cannot
 * attribute is quoted verbatim, because saying which string is in the way is
 * the only honest thing left to say about it.
 */
export declare function holderLabel(spec: string, name: string): string;
