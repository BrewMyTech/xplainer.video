---
"@xplainer/cli": patch
---

**A payload's symlinks stay relative, so the payload can still be moved.**

`runtime/assemble.ts` copies with `cpSync`, and Node **resolves** a symlink's target against the
source location unless `verbatimSymlinks` is set. Neither of the two copies set it, so a relative
link inside a copied package tree — `../dist/bin.js` — arrived in the payload as an absolute path
back into the tree it was built from. Measured on Node 24:

```
source link target : ../lib/node_modules/real/cli.js
copied link target : /private/tmp/.../sym-src/lib/node_modules/real/cli.js
```

**Relocatability is the one thing payload 1 exists for**, so this defeated the whole artefact where
it applied. It is the same failure as the one the argument-free install exists to avoid, arriving by
a different route: a `PATH` copy dies on the next `nvm install`, and so does an absolute link into
the directory that `nvm install` replaces.

**It was silent in both directions, which is why it survived.** `scanTree` records whatever the copy
produced, so `runtime verify` compared each link against the rewritten target and answered
`ok: true` — a payload that could not move, verifying clean. And `bin/npm` is correct however the
option is set, because the assembler creates that one with `symlinkSync` rather than by copying, so
the one link a reader would spot-check by hand was the one that could not be wrong.

**Nothing was broken yet, and the trigger would not have been a code change.** A real payload
assembled from this checkout carries one link and no absolute targets: the dependency closure's
1805 relative symlinks all sit at the `node_modules/<name>` boundary, which the external copy's
filter excludes at any depth and which the checkout route resolves through `realpathSync` before
copying. It would have started the day some package in the closure shipped a symlink inside its own
`files` allowlist — a lockfile change rather than a diff anybody would review for this.

The `npm` copy has always had it; the external-install copy inherited it. Both now pass
`verbatimSymlinks: true`, and `install/materialise.test.ts` asserts a package's relative link is
recorded relative **and** resolves to a file inside the payload from where the payload now is.
