---
"@xplainer/cli": patch
---

`xplainer setup` no longer trusts a browser directory it finds already there. The headless shell
is committed under `toolchain/chrome-headless-shell-<version>-<digest>`, with a record of the
executable and the licence it was unpacked with, and a re-run re-hashes both before it records the
browser again; a tree that has changed since is refused with exit `3`, naming the directory to
remove. The executable recorded is the one the manifest row names rather than the first file a
search finds, and an archive without the licence the row names is refused. A browser acquired by an
earlier build, under `chrome-headless-shell-<version>`, is not reused, so the first `setup` after
upgrading downloads the browser once more; the old directory can be deleted.
