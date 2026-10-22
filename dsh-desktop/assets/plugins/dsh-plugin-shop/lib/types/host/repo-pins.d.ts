/**
 * The Host's memory of which commit it installed for each github entry.
 *
 * pnpm writes the manifest dependency as `github:owner/slug` — no commit —
 * and the resolved commit lives only in the lockfile. The shop records the
 * commit it pinned at install time in its own cache so `installed()` can
 * report `outdated` honestly without parsing pnpm's lockfile. The profile
 * manifest remains the source of truth for *presence*: a pin whose bundle
 * is not a manifest dependency is a leftover from a failed install and is
 * never reported.
 */
export interface RepoPinFs {
    exists: (path: string) => boolean;
    read: (path: string) => string;
    write: (path: string, data: string) => void;
}
/** Install identity to the pinned commit or release tag. */
export type RepoPins = Record<string, string>;
/** Read the pins file; any irregularity degrades to an empty record. */
export declare function readRepoPins(fs: RepoPinFs, path: string): RepoPins;
/** Write the pins file atomically enough for its purpose (a cache). */
export declare function writeRepoPins(fs: RepoPinFs, path: string, pins: RepoPins): void;
