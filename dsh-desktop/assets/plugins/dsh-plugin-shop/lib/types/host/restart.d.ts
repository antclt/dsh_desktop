/** Restart executor: hand the port to a new dsh instance, two-phase.
 *
 * The old process cannot wait for the new one: the new one must bind the
 * port the old one still holds, and two live processes cannot bind it at
 * once — the first implementation spawned the child and waited for its URL,
 * and the child crashed in boot with EADDRINUSE every time. The handoff is
 * therefore inverted: the parent commits and exits FIRST, and a detached
 * helper waits for the parent's pid to disappear before exec'ing the same
 * dsh command line. The browser monitors the origin and refreshes once the
 * new server answers; a boot that fails is diagnosed from the log file,
 * since nobody is attached to the child's pipes. */
/** `shop/restart` result: committed, or a typed refusal issued BEFORE
 * anything is torn down. Once `ok` is returned the old process WILL exit —
 * the client monitors the new server and reports a failed boot with the
 * manual command and `logFile`, the file the new process's output goes to:
 * where a boot that died explains itself, at a path that depends on DSH_HOME
 * and the shop row's `cacheDir`, which only the host knows. A host older than
 * the field answers without it, so the client reads it as optional.
 *
 * `bootId` and `pid` name the process that committed: its boot identity
 * (own-version.ts) and the pid the takeover waits on. A page reloaded into a
 * process with that same boot is a restart that never happened, and the pid
 * is what the reader has to stop by hand (design §8, 2026-10-06 amendment).
 * Optional for the same older-host reason as `logFile`. */
export type RestartOutcome = {
    ok: true;
    logFile?: string;
    bootId?: string;
    pid?: number;
} | {
    ok: false;
    detail: string;
};
/** Spawn the two-phase handoff. The helper is a POSIX shell wrapper that
 * polls the parent pid until it is gone, then replaces itself with the dsh
 * command — `exec "$@"` keeps the argv verbatim, so no argument quoting is
 * involved. The child's stdout/stderr go to `logFile`, opened here in
 * append mode; opening throws on failure, and the caller treats a throw as
 * a refusal (the restart is never committed without its log).
 *
 * The pid-poll has the usual tiny reuse race — if the parent's pid is
 * recycled within the 0.2s polling gap the helper waits for the unrelated
 * process too. Harmless: it only delays the boot.
 *
 * POSIX only: `sh`, `kill -0` and `sleep` are all Unix, and `exec "$@"` has
 * no Windows equivalent. The spawn would fail ASYNCHRONOUSLY, after this
 * function has already returned and the caller has committed — so the gateway
 * refuses on Windows before reaching here rather than exiting into nothing
 * (index.ts `restartPlatformSupported`). */
/**
 * Resolve the command line that re-runs this process.
 *
 * A bare `dsh` from PATH is not necessarily the process serving the current
 * port: a dsh launched through `node`, `npx`, or `pnpm dlx` carries its own
 * script and `execArgv`. Reconstructing that exact node invocation preserves
 * the entry point and runtime flags. An explicitly named binary remains an
 * explicit choice and is passed through unchanged.
 */
export declare function restartCommand(options: {
    dshBin: string;
    argv: readonly string[];
    execPath: string;
    execArgv: readonly string[];
    script: string | undefined;
}): {
    command: string;
    args: string[];
};
export declare function startRestart(options: {
    /** The already-resolved command — see `restartCommand`. */
    command: string;
    args: readonly string[];
    parentPid: number;
    logFile: string;
    env?: NodeJS.ProcessEnv;
}): void;
