---
"@xplainer/cli": patch
---

`connect` is re-runnable on both agents, `connect codex` delegates to `codex mcp add`, and the IPC
directory is narrowed to `0700` on every start.

**`xplainer connect claude` run a second time used to exit `70`.** `claude mcp add` answers a name
its scope already holds with `MCP server xplainer already exists in <scope> config` and exit `1`,
and that came out of `connect` as a hard failure over a perfectly ordinary state — running the
command again after an upgrade, or after the binary moved off `npx`. `claude mcp` has no update
verb (none of the verbs 2.1.263 offers replaces an existing entry; `add-json` refuses the same way), so that one refusal is now
answered with `claude mcp remove <name> --scope <scope>` and a second add, leaving exactly one entry
saying what this version writes. Nothing is removed on any other failure; and because the pair is
not atomic, a re-add that fails says the entry that was there is gone rather than claiming nothing
was written.

**`xplainer connect codex` now prefers Codex CLI's own writer.** `codex mcp add <NAME> --
<COMMAND>…` does exist (codex-cli 0.153.4) — an earlier note in this repository said it did not —
and it writes the same `[mcp_servers.xplainer]` table and updates it in place when run twice. It is
delegated to whenever `codex` is on `PATH`, for the same reason the Claude path prefers
`claude mcp add`: a command that reimplements another program's file layout is a command that is one
release behind for ever. One thing that CLI does differently is worth knowing before you run it: it
rewrites the `mcp_servers` subtree, so a comment attached to or inside an `[mcp_servers.*]` table
does not survive, while comments elsewhere in `config.toml` do. The direct TOML writer — which moves
nothing it did not write — is unchanged and is still what runs for `--config <path>`, a file that
CLI has no flag to be aimed at, and on any machine where `codex` is not installed.

**The socket's `0700` directory is now `chmod`ed, not just `mkdir`ed.** A mode passed to `mkdir`
applies to a directory it creates and is ignored for one that already exists, so an `ipc/` left at
`0755` by an older release or a stray `umask` kept those bits for ever — and filesystem permissions
are the whole authentication of that transport. The state directory above it is left exactly as
found: `ipc/` is the last directory on the path to the socket, so narrowing it is sufficient.
