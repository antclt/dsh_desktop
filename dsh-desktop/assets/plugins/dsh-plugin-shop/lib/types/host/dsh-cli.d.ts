/**
 * How to start the dsh CLI as a child process.
 *
 * On POSIX this is `spawn('dsh', …)` and there is nothing to decide. On
 * Windows there is no form of that call which can work: npm installs a CLI as
 * `dsh`, `dsh.cmd` and `dsh.ps1` shims with no `.exe`, libuv resolves a bare
 * name against `.com` and `.exe` only, and node has refused to spawn a `.cmd`
 * without a shell since the 2024 batfile argument-injection fix. Measured on
 * Windows 11 with dsh 0.1.1-rc.2 (2026-09-02): the bare name gives ENOENT,
 * the resolved `.cmd` shim throws EINVAL *synchronously* out of `spawn()`.
 *
 * `shell: true` — what the shim exists for, and what dsh's own pnpm spawn
 * uses — is not available to us. node hands cmd.exe a joined, UNQUOTED
 * command string, and our argv carries catalog data: a `github:` entry's spec
 * is `github:owner/slug#<sha>&path:<subdir>`, `&` is a cmd command separator,
 * and `subdir` comes from npm. That is a command-injection surface on
 * untrusted input, so the shop resolves the CLI's JS entry and runs it through
 * node instead — no shell, and node escapes the argv itself.
 *
 * Pure core, impure shell: `dshCommand` decides, `resolveDshScript` takes the
 * process snapshot and a filesystem seam as parameters (the same shape as
 * `detectSupervisor(env, proc)` and `RepoPinFs`).
 */
/** The npm package the dsh CLI is published as. */
export declare const DSH_PACKAGE = "@deepseek-ai/dsh";
/**
 * Whether dsh's CLI refuses this profile outright: `desktop`, in any letter
 * case, "is managed exclusively by the Electron application" — refused for a
 * launch and for `dsh plugin` alike (`rejectElectronProfile` in the CLI's
 * `lib/bin.js`, the same in 0.1.5-rc.3 and 0.1.7-rc.2). Every command the
 * shop spawns names a profile, so none of them can run for this one.
 */
export declare function isDesktopProfile(profile: string): boolean;
/**
 * The command that starts `bin` through `execPath` when `bin` names a
 * JavaScript entry, or `null` when `bin` is a program to spawn as given.
 *
 * Extracted from {@link dshCommand} so `prefetch.ts` can reach the same
 * decision for pnpm without a second copy of {@link JS_ENTRY}: both need it
 * for the same two reasons — a packaged JS entry is what a caller pinning an
 * installation can name, and a `.mjs` test fixture is the only fake CLI that
 * can be spawned on Windows at all.
 */
export declare function jsEntryCommand(bin: string, args: readonly string[], execPath: string): DshCommand | null;
export interface DshCliFs {
    exists: (path: string) => boolean;
    read: (path: string) => string;
}
/** A spawnable command: `spawn(command, args)` with no shell. */
export interface DshCommand {
    command: string;
    args: string[];
}
/**
 * The command that starts the dsh CLI with `args`.
 *
 * For the bare name the node route replaces exactly one thing: looking `dsh`
 * up on PATH, which on Windows can never succeed. A `dshBin` naming a
 * specific file is the caller's explicit choice and is spawned as given —
 * honoring it and reporting the real failure beats silently running something
 * else — with one exception, {@link JS_ENTRY}, where "as given" is not a
 * runnable command on any platform and node is what the caller must have
 * meant.
 */
export declare function dshCommand(options: {
    dshBin: string;
    args: readonly string[];
    platform: NodeJS.Platform;
    execPath: string;
    script: string | null;
}): DshCommand;
/**
 * Locate the dsh CLI's JS entry, or null when it cannot be found.
 *
 * `argv1` first: the shop is loaded BY dsh, so the running script is dsh's own
 * entry, and reusing it guarantees the child is the same dsh that is serving
 * the shop rather than whichever one PATH happens to name. The owner check is
 * what makes this safe to try — under a test runner `argv1` belongs to the
 * runner, and accepting it would spawn the wrong program.
 *
 * Then the shims on PATH: npm installs the package into `node_modules` beside
 * them, so the manifest is one join away. This is the branch a test harness
 * takes, which is why the real-installation test exercises it.
 */
export declare function resolveDshScript(fs: DshCliFs, options: {
    argv1: string | undefined;
    path: string | undefined;
}): string | null;
