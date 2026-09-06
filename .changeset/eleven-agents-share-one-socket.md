---
"@xplainer/cli": minor
---

`xplainer connect claude` and `xplainer connect codex` write a working stdio configuration.

`connect` stops being a stub and becomes a group of two verbs. Both write the **same** entry —
`xplainer mcp --attach` when the binary is on `PATH`, and `npx -y @xplainer/cli mcp --attach` when
it is not — into the agent's own configuration file, and there is nowhere in that entry for a URL, a
port or a token to go: the transport is the daemon's unix socket, and filesystem permissions are its
authentication.

**`connect claude`** hands the entry to Claude Code's own writer when that CLI is installed —
`claude mcp add --transport stdio --scope user xplainer -- xplainer mcp --attach`, with `--scope`
passed through — because a command that reimplements another program's file layout is a command
that is one release behind for ever. Where the CLI is absent it writes the documented user-scope
location itself, `~/.claude.json`'s `mcpServers`, merging into a file that holds Claude Code's whole
per-user state and refusing outright to rewrite one it cannot parse. `local` and `project` name
files that belong to a *directory*; without the vendor CLI those are refused rather than guessed at
(ADR 0020 §Security R-SEC-8).

**`connect codex`** writes `[mcp_servers.xplainer]` into `~/.codex/config.toml`, or the path given
by `--config`. The file is **edited, not reserialised**: the table's own lines are located and
replaced, so comments, table order and every other server survive, and running the command twice
leaves exactly one entry — updated in place, not appended beside itself. A configuration that
already declares that name another way — a dotted key, an inline parent, an array of tables — is
refused, because appending beside it would be a duplicate key and a `config.toml` with a duplicate
key does not load at all.

**Both refuse before they write.** `connect` reads `daemon.json` rather than assuming port 8787,
and a state directory where no daemon has ever bound gets exit **`3`**, nothing written, and the
one command that fixes it: run `xplainer serve`. `--force` overrides. The port is never *in* the
entry — it is the evidence that there is a daemon to attach to, and it is printed so a user with
two daemons can see which one they just connected to.

Exit code `3` — "precondition unmet, with nothing written" — moves from planned to built in the
table in `docs/ARCHITECTURE.md` §6; `1` covers a `--scope` this command cannot write, `11` a
`daemon.json` that cannot be read, and `70` a `claude mcp add` that failed for its own reasons.
