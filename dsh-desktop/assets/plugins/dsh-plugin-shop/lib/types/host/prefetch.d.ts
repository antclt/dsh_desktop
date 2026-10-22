/**
 * The download phase that runs in front of the per-profile install mutex.
 *
 * `dsh plugin add` is one opaque call: it resolves, fetches, links and writes
 * in a single pnpm invocation, so the shop cannot split it. What it can do is
 * warm pnpm's content store first, from outside the mutex, so the serialized
 * install is a store hit. Measured 2026-09-10: an npm or github spec warmed
 * this way installs with `downloaded 0`. Design doc §3.
 *
 * Best-effort by construction. Every failure here — pnpm absent, a non-zero
 * batch, a timeout, a store guessed wrong — leaves `dsh plugin add` to fetch
 * what the store lacks, exactly as it does today. Nothing about whether an
 * install SUCCEEDS may depend on this module.
 */
import { type ChildProcess, type SpawnOptions } from 'node:child_process';
import { type KillFns } from './executor.ts';
/**
 * Whether warming the store for `spec` can save the install any work.
 *
 * A raw https tarball URL cannot, measured twice on 2026-09-10: pnpm
 * re-fetches such a URL on EVERY install even when the store already holds
 * that exact tarball — it must read the `package.json` inside it and that
 * read does not go through the store — and `pnpm store add` on a URL resolves
 * no dependency closure. So a prefetch of that form is one extra full
 * download for no measured saving. The three spec forms are indistinguishable
 * at the `store add` boundary (all exit 0, all print `+ <spec>`), which is why
 * this exclusion is recorded rather than left to look like an oversight.
 * Design doc §3.
 */
export declare function isPrefetchableSpec(spec: string): boolean;
/** Why no download phase happened, when one did not. The caller writes the
 * line a user reads, so it needs the reason and not a bare `false`. */
export type PrefetchRequest = {
    started: true;
} | {
    started: false;
    reason: 'unsupported-spec' | 'no-pnpm';
};
export interface Prefetcher {
    /** Queue `spec` for this profile's next batch, starting one if none runs.
     * `log` receives the outcome of whichever batch ends up carrying this spec —
     * one batch serves several installs, so a batch's exit is reported to each
     * of them. */
    request: (args: {
        profile: string;
        spec: string;
        cwd: string;
        env?: NodeJS.ProcessEnv;
        log?: (line: string) => void;
    }) => PrefetchRequest;
    /** This spec's install has settled. Kills the batch when nothing else needs it. */
    release: (profile: string, spec: string) => void;
}
/** The one call this module makes on `spawn`: the argv form, whose child
 * carries the `error`/`exit` listeners `start` needs. `typeof nodeSpawn` is an
 * overload set that also admits two-argument forms this module never builds a
 * command line for, and a test's recording wrapper cannot satisfy those — so
 * the seam is named, and a caller still passes `spawn` itself. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export declare function createPrefetcher(options?: {
    pnpmBin?: string;
    spawn?: SpawnFn;
    platform?: NodeJS.Platform;
    execPath?: string;
    timeoutMs?: number;
    kills?: KillFns;
}): Prefetcher;
