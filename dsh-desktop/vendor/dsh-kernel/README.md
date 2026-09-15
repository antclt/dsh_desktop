# Vendored dsh kernel tarballs (ACTIVE — 0.1.5-rc.1)

This directory holds the packed, npm-installable tarballs for the
`@deepseek-ai/dsh` **0.1.5-rc.1** kernel (the full `@deepseek-ai/dsh-*`
family — 259 packages). The kernel is downloaded from the **npm registry**
(`registry.npmjs.org/@deepseek-ai/dsh-*` at the exact `0.1.5-rc.1` dist-tag
version) and is **NOT** re-published here under any other version. This is the
**active** vendored set: `dsh-desktop/package.json` / `package-lock.json`
resolve every `@deepseek-ai/dsh*` package against these `file:` tarballs, so a
fresh machine / CI reproduces the exact kernel `node_modules` offline from the
pre-fetched tarballs.

The single source of truth for the pinned kernel version is
`dsh-desktop/scripts/compat/kernel-pin.json` (`kernel.tag`, `kernel.packageVersion`,
`kernel.vendorDir`). Everything here — the tarball file names, the manifests, and the
comments in the surrounding scripts — must agree with that pin.

Contents: 259 `deepseek-ai-dsh-<pkg>-0.1.5-rc.1.tgz` tarballs. The authoritative
list is whatever is present in this directory — verify with
`Get-ChildItem dsh-desktop/vendor/dsh-kernel` rather than trusting any enumerated
diff. (Relative to the previous 0.1.2-alpha.5 set of 242 tarballs, this release
adds 17 new dsh-* packages for a net 259.)

## Where they came from

- Downloaded from the public npm registry at version `0.1.5-rc.1` (the registry
  uses `-rc.1`, not `-rc1`). For each package in the dsh family, the
  `dist.tarball` URL was fetched and the payload verified: the embedded
  `package.json` must report `name` equal to the requested package and `version`
  equal to `0.1.5-rc.1` before the file is accepted into this directory.
- Tarball file naming follows the vendoring convention
  `deepseek-ai-dsh-<name>-<version>.tgz` (i.e. `@deepseek-ai/dsh-acp` →
  `deepseek-ai-dsh-acp-0.1.5-rc.1.tgz`, dropping `@`, replacing `/` with `-`).
  `scripts/generate-kernel-lock.mjs` reverses this convention to build the
  `file:vendor/dsh-kernel/*.tgz` dependency map.
- Framework packages (`@deepseek-ai/cordis*`, cosmokit, schemastery,
  node-addon-system…) and external transitive deps (ws, yaml, zod, zstddec,
  koffi, …) are **not** vendored here; they resolve from the npm registry as
  regular semver dependencies.

## How to activate (kernel bump)

Version is driven by `dsh-desktop/scripts/compat/kernel-pin.json` as the single data
source (`kernel.tag` / `kernel.packageVersion` / `kernel.vendorDir`). To bump the
kernel:

1. Update the pin (`kernel.tag`, `kernel.packageVersion`) in
   `scripts/compat/kernel-pin.json`, and place the matching same-version
   `deepseek-ai-dsh-<pkg>-<newVersion>.tgz` tarballs into this directory (remove the
   old-version ones so no mixed versions remain). Update the
   `KERNEL_VERSION` constant in `scripts/install-kernel.mjs` and
   `scripts/generate-kernel-lock.mjs` to the same version.
2. Verify pin vs directory consistency: `node scripts/compat/validate-pin.js`
   (fail-closed if any tarball version does not match `kernel.packageVersion`).
3. Regenerate `package-lock.json` (the `file:`-resolved entries) with
   `dsh-desktop/scripts/generate-kernel-lock.mjs`, so `package.json` /
   `package-lock.json` declare every `@deepseek-ai/dsh*` package at the new version.
4. Re-run `npm install` (which triggers `scripts/install-kernel.mjs`) to merge the
   new kernel into `node_modules`, then re-run the patch chain and refresh the
   `patch-surface` snapshot so the adapters' anchors match the new kernel.

`scripts/install-kernel.mjs` and `scripts/patch-deps.js` pick the version up from the
pin / manifests; after install, verify the kernel reports the pinned version.