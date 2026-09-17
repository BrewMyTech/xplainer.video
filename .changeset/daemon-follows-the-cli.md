---
"@xplainer/cli": patch
---

`xplainer update` now updates an installed daemon, and `xplainer status` says when it is behind.

Upgrading through a package manager replaces the global CLI and leaves the pinned runtime the
supervisor executes exactly where it was. `update` previously reconciled the toolchain and every
agent's MCP entry and skill, and deliberately skipped the daemon — so the two drifted with nothing
reporting it. Measured at four releases apart on a real machine, where a 0.0.2 daemon went on
serving renders under an 0.0.8 CLI and every command returned success, because `mcp --attach`
checks the *contract* version and the contract had not changed.

`update` now assembles a payload from the package it is itself running from and hands it to
`daemon update` as an explicit `--from`. ADR 0025's rule that an update never invents a source is
unchanged: the source is named, it simply is not typed by hand. The step is a no-op on a machine
with no daemon, and on one whose runtime already matches, so the common case costs nothing.

`status` gains one line when the running daemon's version differs from the CLI's, naming which of
the two actually does the work.
