# 0029. The agent path may be HTTP, because a headers helper keeps the token out of the config

- Status: accepted
- Date: 2026-09-11
- Deciders: @rishavanand
- Amends, by dated note and without rewriting its body:
  **[ADR 0020](0020-always-running-local-daemon.md)** §*The agent path is IPC, not TCP*, and
  specifically the sentence *"`xplainer connect claude|codex` therefore writes a **stdio** entry by
  default, pointing at `xplainer mcp --attach`… No URL and no token enter any agent configuration
  file."* The **reason** for that sentence is upheld in full; what changed is that the agent client
  gained a way to satisfy it over HTTP, which did not exist when ADR 0020 was written.
- Builds on: **[ADR 0008](0008-async-job-model-poll-and-progress-no-agent-webhooks.md)** — the
  polling contract is untouched; **[ADR 0016](0016-cli-first-local-runtime-desktop-is-an-optional-client.md)**
  — the TCP listener this uses already exists for `/api/*`.

## Context and Problem Statement

ADR 0020 gave `serve` two listeners over one application and pointed agents at the **socket**, via a
`stdio` entry running `xplainer mcp --attach`. The argument was the MCP specification's own
preference order for locally-run servers, quoted in that record: prefer `stdio`; if using an HTTP
transport, require an authorization token **or** use a unix socket with restricted access. Choosing
the socket made the DNS-rebinding class *structurally absent* from the agent path rather than
filtered out of it, and — the operative constraint — meant no credential was written into a file
this project does not own.

**The cost of that choice was not visible until it was measured.** MCP's `stdio` transport requires
the client to spawn a child process per session and speak over its pipes. So every agent session
holds a whole Node process whose only job is to forward JSON-RPC to a socket. Measured on
darwin-arm64, Claude Code 2.1.268, `xplainer@0.0.1`:

| Process | Idle RSS | Startup to usable |
|---|---|---|
| `xplainer mcp` (tools in-process) | 97–98 MB | ~140 ms |
| `xplainer mcp --attach` (forwards to the socket) | **98.3 MB** | ~139 ms |
| `xplainer serve` (the daemon) | 98.5 MB | — |

The shim costs **the same as the full server**, because it loads the same CLI bundle to do nothing.
The daemon therefore did not centralise anything: it *added* a process. Ten agent sessions cost
~1.08 GB with a daemon and ~980 MB without one, and in neither case did the resident daemon pay for
itself in memory — only in the things it alone can do (a render that survives a disconnect, one
serial queue, the `/api/*` surface the desktop needs).

## Decision Drivers

- **The token must not enter an agent's configuration file.** ADR 0020's constraint, unchanged.
  `~/.claude.json` is Claude Code's whole per-user state: it is synced, backed up, and pasted into
  bug reports. R-SEC-6 already says the credential travels as a *path*, never as a value.
- **Per-session cost should not scale with the number of agents**, when one process can serve them.
- **The loopback guard must remain unconditional.** Whatever transport an agent uses, `Host`,
  `Origin` and the bearer token are checked, and no request may become exempt by claiming to be
  local.
- **No change to the polling contract.** ADR 0008 is settled; this is about transport, not about
  how a long job reports progress.

## Considered Options

1. **Keep the stdio shim.** Zero work, and the structural argument stays at its strongest. Costs
   ~98 MB per agent session for ever.
2. **Write an HTTP entry carrying a literal bearer token.** Removes the per-session process and
   violates the one constraint ADR 0020 would not trade.
3. **Write an HTTP entry whose token comes from a helper command at connection time.** Removes the
   per-session process *and* keeps the token in the `0600` file it already lives in.
4. **A thinner stdio shim.** Keeps the structural argument and reduces the per-session cost to a
   bare Node baseline (~40–50 MB). Cheaper than today, still linear in sessions.

## Decision Outcome

**Chosen: option 3, as an opt-in second form of `connect`, with option 1 remaining the default
until the open questions below are closed.** Option 4 stays worth doing on its own merits and is
not excluded by this record.

Claude Code supports `type: "http"` with a `headers` object and a **`headersHelper`** command that
emits JSON headers at connection time. Verified on 2026-09-11 against Claude Code **2.1.268** and a
real `xplainer serve`:

```
xplainer: http://127.0.0.1:61573/mcp (HTTP) - ✔ Connected
```

The configuration that produced it contains **no credential**:

```json
{ "mcpServers": { "xplainer": {
  "type": "http",
  "url": "http://127.0.0.1:61573/mcp",
  "headersHelper": "<path>/auth-headers.sh"
} } }
```

…and the helper reads the same `0600` token file `serve` mints, at connection time. So ADR 0020's
constraint is **met rather than overridden**: the token still travels as a path.

Measured the same day, one daemon against five concurrent HTTP MCP clients, each completing
`initialize`, `tools/list` and a real `explainer_list` call: **102.6 MB total**, versus ~490 MB for
the same five sessions over stdio. At ten agents this is ~100 MB against ~1 GB.

**The guards were re-verified on that path rather than assumed**, with `curl`, which unlike `fetch`
can actually set `Host`:

| Request | Result |
|---|---|
| correct `Host`, valid token | `200` |
| `Host: evil.example.com`, valid token | **`403`** |
| `Origin: https://evil.example.com`, valid token | **`403`** |
| correct `Host`, no token | **`401`** |

A first attempt at this used `fetch` with a `Host` override and reported `200`, which looked like a
guard failure and was not: `Host` is a forbidden header name, so the override was silently dropped
and the request carried the real one. **Any future test of this allowlist must use a client that can
set `Host`**, or it proves nothing.

## Consequences

- **What ADR 0020 called *structurally absent* becomes *filtered*.** This is the real cost and it is
  not rhetorical. A browser can neither open a unix socket nor spawn a process, so the socket path
  excluded the DNS-rebinding class by construction; the HTTP path excludes it by the `Host`
  allowlist, the `Origin` check and the token — three mechanisms that are correct today, are tested,
  and *could* be got wrong by a future change in a way the socket could not. The MCP specification
  sanctions both ("require an authorization token; **use** unix domain sockets…"), and it lists
  `stdio` first. **So the socket entry stays the default**, and this record makes HTTP available to
  a user who asks for it rather than moving everyone onto it.
- **The port becomes part of the agent's configuration, and it can go stale.** A socket path is
  derived from the state directory and is therefore stable for ever; an HTTP entry names a port.
  `daemon.json` records the bound port, so `connect` can write the right one — but a daemon that
  later binds a different port leaves a configuration pointing at nothing, and nothing currently
  rewrites it. This is the one genuinely new failure mode and it must be answered before this form
  becomes a default. Three candidates, none chosen here: pin the port and refuse to move it, have
  `connect` rewrite on change, or use `${XPLAINER_PORT}` expansion.
- **It only removes the per-session process where the client speaks HTTP.** `headersHelper` is
  Claude Code's; Codex's own configuration is a `[mcp_servers.*]` TOML table and has not been
  checked for an equivalent. Until it has, `connect codex` keeps the stdio entry, and a claim that
  this halves memory "for agents" would be true of one client and unverified for the other.
- **A helper is a command this project asks an agent to run**, which is a small new surface: it must
  be written by `connect`, live beside the state directory, be `0700`, and emit nothing on failure
  but a non-zero exit. A helper that printed a partial document would produce a confusing
  authentication failure rather than a refusal.
- **The daemon becomes cheaper than no daemon**, which inverts the advice this repository has been
  giving. With the shim, `--spawn` was the cheaper mode at every session count; over HTTP one
  daemon serves ten agents for the cost of one. That makes the daemon's install friction — the
  manual `runtime build` step — the thing standing between users and the better mode, and it is
  why closing that is sequenced ahead of this.

## Open questions, and what closes them

1. **Port stability.** Named above. Nothing here is a default until one of the three candidates is
   chosen and proven against a daemon that has moved port.
2. **Concurrent-client semantics.** `/mcp` answered `initialize` with no `mcp-session-id` header, and
   five concurrent clients each got a correct answer. Whether that is a stateless per-request server
   or one holding sessions is **not established**, and "one instance serving all" depends on which.
3. **Codex parity.** Whether `~/.codex/config.toml` can express a headers helper at all.
4. **`${VAR}` expansion** was reported by a documentation pass as working in `headers` and `url`,
   and is **not** what the verification above used. Only `headersHelper` is proven here.
