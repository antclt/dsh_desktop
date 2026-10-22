/** The user's configured npm registry, if they have one (design §3).
 *
 * Pure: the caller injects the read. This is a deliberately partial reading
 * of npm's config resolution — only the user-level `registry=` line — and
 * that is safe precisely because the origin list is raced: a registry we
 * guess wrong about loses a 400-byte request and nothing else.
 *
 * That property only holds for a value that is actually a URL, which is why
 * the value is VALIDATED here rather than left to the caller. `npmOrigin`
 * addresses its probe with `new URL(<pkg>/latest, registryUrl)`, which
 * throws a raw `TypeError` — not a `TransportError` — for anything that is
 * not an absolute URL, and `catalog.ts`'s race loop rethrows everything that
 * is not a `TransportError`. An unvalidated `registry=` line would therefore
 * fail the WHOLE load with npmmirror, npmjs and Pages all healthy and no
 * cache fallback: the opposite of the stated property. Not a hypothetical
 * shape either — `registry=${NPM_REGISTRY}/` is npm's own documented config
 * expansion, it works perfectly for npm, and a reader that does not expand
 * it captures the literal. */
/**
 * @param readFile - returns the file's text, or null when it does not exist.
 * @param home - the user's home directory.
 */
export declare function npmrcRegistry(readFile: (path: string) => string | null, home: string): string | null;
