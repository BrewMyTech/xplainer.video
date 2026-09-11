---
"@xplainer/cli": patch
---

**`xplainer update` reconciles this machine after an upgrade.**

Upgrading the package is one command; making the machine match it is two more that nobody remembers
— `setup` may need to acquire something the new version wants, and `connect` has to be re-run or the
agent keeps yesterday's MCP entry and yesterday's `SKILL.md`. `xplainer update` does both, reports
each as reconciled or unchanged, and skips an agent that was never configured rather than creating
one. `--check` reports the version comparison and changes nothing.

**It does not replace the package, and that is a decision.** Spawning a package manager from here
rewrites the files the process is executing: survivable on macOS and Linux, where the running inode
outlives the unlink, and a failure on Windows, where the package is locked while it runs. The manager
is also only knowable for a global npm install — pnpm, bun and yarn globals differ, and `npx -y
xplainer` has nothing installed to update. So it reads the registry, says which version is newer, and
prints the upgrade command for the one install it can identify. Where it cannot, it says so instead
of guessing.

The reconcile steps are **spawned rather than imported**: `commands/setup.ts` and
`commands/connect.ts` are about 700 lines of orchestration between them, and calling into their
internals would mean either refactoring both or keeping a subset here that drifts the first time
either changes. A child process running this same binary cannot drift.

**The version comparison is numeric, because the first version of it was not.** It asked
`latest !== CLI_VERSION` and called any difference "newer on npm", so a build at `0.0.3` was told
`0.0.2` was available — an offer to downgrade, printed as an upgrade, found by running the command
rather than by reading it. It now answers behind, same, ahead or unknown, compares parts as numbers
so `0.0.10` beats `0.0.9`, and declines to guess at anything carrying a pre-release tag: the only
decision this command makes is whether to offer an upgrade, and offering the wrong direction is worse
than declining.
