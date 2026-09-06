---
"@xplainer/cli": minor
---

`serve` binds a second listener, and `xplainer mcp` is a real command on both sides of it.

**The IPC listener.** `serve` now binds a unix socket — a named pipe on Windows — inside a `0700`
directory under the state directory, over the *same* Hono application and the same tool
registration as the TCP port: one `createServer()`, two listeners. The socket carries **no guard**,
because filesystem permissions are that transport's authentication, and the exemption is a fact
about which listener accepted the connection rather than anything a request can claim — the
socket's own adaptor records the `Request` it built, and nothing a client sends can put a TCP
request in that set. The same `GET /healthz` is answered `401` on the port and `200` on the socket,
which is the pair of tests that makes the claim mean something. The path is the ready line's
`socket` field and `runtime.json`'s, and a clean shutdown unlinks it. A socket left behind by a
`SIGKILL` is cleared at the next start — after ownership is acquired, so clearing one can never
clear a live daemon's.

**`xplainer mcp`** runs the eight tools over stdio in its own process, over the shared Remotion
workspace and a job store private to the session. That is the entry the plugin bundles'
`npx -y @xplainer/cli mcp` points at and the MCP specification's own first-choice mitigation for a
local server. It deliberately does not take the daemon's job store or its ownership lock — a job
store is single-writer — so a `job_id` from this connection means nothing on another, and the
session directory is removed when the client goes away.

**`xplainer mcp --attach`** proxies that same stdio to a running daemon's socket, so an agent's
configuration holds a command and neither a URL nor a token. Before it proxies anything it reads
`contract_version` from `GET /healthz` over the socket and applies `isContractCompatible()`: an
incompatible pair exits **`8`** naming both contract versions and the command that fixes it —
`npm i -g @xplainer/cli@<the release the daemon reported>` — while two releases that serve the same
contract attach normally. A daemon that is not answering on its socket exits `4` and names both
`xplainer serve` and the `--attach`-less command that needs no daemon.

Everything is proved against real processes: a spawned `serve`, a spawned shim, and an
`@modelcontextprotocol/sdk` client over the command line an agent would be given.
