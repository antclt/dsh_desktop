# Vendored dsh kernel tarballs (ACTIVE — 0.2.1-rc.2)

This directory holds the packed, npm-installable tarballs for the
`@deepseek-ai/dsh` **0.2.1-rc.2** kernel (the full `@deepseek-ai/dsh-*`
family — 339 packages, plus 13 framework-line tarballs whose version line is
its own: cordis / cordis-plugin-* / cosmokit / schemastery / node-addon-system
+ its four platform subpackages / libreoffice-kit). The kernel is downloaded
from the **npm registry**
(`registry.npmjs.org/@deepseek-ai/dsh-*` at the exact `0.2.1-rc.2` dist-tag
version) and is **NOT** re-published here under any other version. This is the
**active** vendored set: `dsh-desktop/package.json` / `package-lock.json`
resolve every `@deepseek-ai/dsh*` package against these `file:` tarballs, so a
fresh machine / CI reproduces the exact kernel `node_modules` offline from the
pre-fetched tarballs.

The single source of truth for the pinned kernel version is
`dsh-desktop/scripts/compat/kernel-pin.json` (`kernel.tag`, `kernel.packageVersion`,
`kernel.vendorDir`). Everything here — the tarball file names, the manifests, and the
comments in the surrounding scripts — must agree with that pin.

Contents: 339 `deepseek-ai-dsh-<pkg>-0.2.1-rc.2.tgz` tarballs + 13 framework tarballs
(352 total). The authoritative list is whatever is present in this directory — verify with
`Get-ChildItem dsh-desktop/vendor/dsh-kernel` rather than trusting any enumerated
diff. (Relative to the 0.2.1-rc.1 set of 337 tarballs, 0.2.1-rc.2 adds 2 dsh packages —
`dsh-client-ui-deepseek-model-label-1017`（V4.1-Flash-1017 模型标签）与
`dsh-web-deepseek-api`（DeepSeek Search/Fetch）— drops none, and keeps the framework line
unchanged: cordis 4.0.5 / cosmokit 1.8.6 / schemastery 3.18.5 / cordis-plugin-* 各同档.)

**框架件的平台子包只收 node-addon-system 的四件**：`@deepseek-ai/libreoffice-kit`
的平台子包（darwin-x64 / win32-arm64 / wasm 等）历史上就不进 vendor，registry 上
也没有全部发布（0.2.1-rc.1 换代实测两个 404）；它们作为传递依赖由 lock 解析。

## Where they came from

- Downloaded from the public npm registry at version `0.2.1-rc.2` (the registry
  uses `-rc.2`, not `-rc2`). For each package in the dsh family, the
  `dist.tarball` URL was fetched and the payload verified: the embedded
  `package.json` must report `name` equal to the requested package and `version`
  equal to `0.2.1-rc.2` before the file is accepted into this directory.
- Tarball file naming follows the vendoring convention
  `deepseek-ai-dsh-<name>-<version>.tgz` (i.e. `@deepseek-ai/dsh-acp` →
  `deepseek-ai-dsh-acp-0.2.1-rc.2.tgz`, dropping `@`, replacing `/` with `-`).
  `scripts/generate-kernel-lock.mjs` reverses this convention to build the
  `file:vendor/dsh-kernel/*.tgz` dependency map.
- Framework packages (`@deepseek-ai/cordis*`, cosmokit, schemastery,
  node-addon-system…) and external transitive deps (ws, yaml, zod, zstddec,
  koffi, …) are **not** vendored here besides the 13 framework tarballs listed
  above; they resolve from the npm registry as regular semver dependencies.

## How to activate (kernel bump)

Version is driven by `dsh-desktop/scripts/compat/kernel-pin.json` as the single data
source (`kernel.tag` / `kernel.packageVersion` / `kernel.vendorDir`). To bump the
kernel:

1. Update the pin (`kernel.tag`, `kernel.packageVersion`) in
   `scripts/compat/kernel-pin.json`, and place the matching same-version
   `deepseek-ai-dsh-<pkg>-<newVersion>.tgz` tarballs into this directory (remove the
   old-version ones so no mixed versions remain). The kernel version constants in
   `scripts/install-kernel.mjs` and `scripts/generate-kernel-lock.mjs` read the pin
   directly — no separate edit.
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
