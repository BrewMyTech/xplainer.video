# 0020. The local runtime is an installed, supervised, per-user daemon

- Status: accepted
- Date: 2026-09-06
- Deciders: @rishavanand
- Settled by: an owner request after the scaffold landed — the local runtime should be
  **always running, like the Docker daemon**: installed once, started on boot or login,
  restarted on crash, and simply there when an agent calls it. Recorded as a post-scaffold
  amendment, in the same way Rounds 11 and 12 were.
- Builds on: **[ADR 0016](0016-cli-first-local-runtime-desktop-is-an-optional-client.md)**,
  which decided *which process* owns the local runtime — `xplainer serve`, not an Electron main
  process. This record decides **how that process is supervised**, which 0016 does not answer
  and does not contain. 0016 carries a dated note pointing here.
- **Amends** the ADR 0016 consequence "The daemon has no authentication and binds localhost",
  and **narrows** one row of
  [ADR 0019](0019-sequencing-local-cli-before-hosted.md)'s Dissolved table. See
  [§The amendment to ADR 0016 and ADR 0019](#the-amendment-to-adr-0016-and-adr-0019). Both
  records stay `accepted` and are not rewritten.

## Context and Problem Statement

`xplainer serve` is today a foreground command a human starts by hand. `apps/cli/src/commands/serve.ts`
binds the server, prints one line, and returns; there is no signal handler, no supervisor, no
state on disk, and nothing that survives a terminal closing.

That is the wrong shape for what the product actually is. The pitch — and the vision video
ADR 0016 quotes — is a `brew install`-style daemon: something an agent calls without anybody
having thought about it that morning. An agent that has to ask the user to open a terminal
and run a server first is not "installed once, and simply there". The Docker daemon is the
comparison the owner drew, and it is the right one: nobody starts `dockerd` by hand.

Three properties of the target follow from the records already written, and they constrain
the answer before any mechanism is chosen.

**It must install without an administrator.** ADR 0016's distribution decision is
`npx xplainer` and per-OS standalone binaries — not a `.pkg`, not an MSI, not `apt`. A design
that silently needs `sudo` fails at install time, on the exact machine class ADR 0016 exists
for.

**A headless Linux VM with no desktop session is a supported target.** This is ADR 0016's
decisive driver: "the local stack has to run with no desktop environment present." Any
mechanism that only starts a process when a human logs into a graphical session fails the
one case that motivated the CLI.

**Always-on changes the threat model, and the change is not incremental.** ADR 0016 records
"The daemon has no authentication and binds localhost. Non-localhost access needs a bearer
token, deferred to roadmap phase 2." That sentence was written for a server a human starts,
uses, and Ctrl-Cs. A permanently listening loopback HTTP server is reachable by **any web
page the user visits**, through DNS rebinding — and the MCP specification names this exact
scenario as an attack on local servers: "An attacker accesses an insecure local server that's
left running on localhost via DNS rebinding"
([Security Best Practices, §Local MCP Server Compromise](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices)).
On our daemon the consequence is not information disclosure: `explainer_put_source` writes
agent-authored TSX to the user's disk and `explainer_render` executes it in Chrome under the
user's uid. "Left running" is precisely the property this record proposes to add, so the
security work is part of this decision rather than a follow-up to it.

## Decision Drivers

- **No administrator privileges at install.** The supported install path is `npx xplainer`.
  If the daemon needs a password, the product needs a package manager, and ADR 0016 already
  decided it does not have one.
- **Boot persistence on a headless Linux VM.** Reboot the VM with nobody logged in, and the
  daemon must answer. This is the criterion ADR 0016 was written to satisfy.
- **The user's own uid, never root.** ADR 0019's Dissolved table rests on one sentence: "The
  agent writing the TSX is the user's own agent, running under the user's own uid… Rendering
  their output confers no privilege they did not hold." A privileged daemon executing
  agent-authored TSX destroys that sentence.
- **One command surface across three operating systems**, because a per-OS story is a per-OS
  support burden, and ADR 0016's targets are macOS, Linux and Windows.
- **Legible failure.** ADR 0005's rule — "a download that fails behind a corporate proxy must
  say so, not produce a render that fails later with a missing-binary error" — applies with
  more force to something that starts unattended. A daemon that fails invisibly at boot is
  worse than a command that fails visibly in a terminal.
- **The security obligations above are drivers, not consequences.** A design that gets
  always-on right and authentication wrong is not a partial success.

## Considered Options

1. **Foreground `serve` only — the status quo.** The user starts it, or their shell profile
   does, or they wrap it in `tmux`/`screen`.
2. **A login item or tray application owns the daemon** — the Electron app (ADR 0004) starts
   at login, spawns `xplainer serve` as a child, and shows a menu-bar icon.
3. **A true system service** — `/etc/systemd/system/xplainer.service`, a
   `/Library/LaunchDaemons` plist, or a Windows Service via `sc.exe create`, installed once
   for the whole machine.
4. **A per-user supervisor on each OS** — `systemd --user` with lingering, a LaunchAgent in
   the user's GUI domain, a Scheduled Task registered for the current user.

## Decision Outcome

Chosen: **option 4 — one supervised process per user, per machine, started by the operating
system's own user-scope supervisor, never by root.**

| | Linux | macOS | Windows |
|---|---|---|---|
| Mechanism | `systemd --user` unit | LaunchAgent in `gui/$UID` | Scheduled Task, `S4U` principal, `RunLevel=Limited` |
| Artefact | `~/.config/systemd/user/xplainer.service` (0644) | `~/Library/LaunchAgents/video.xplainer.daemon.plist` (0600) | task `\xplainer-daemon`, definition mirrored at `%LOCALAPPDATA%\xplainer\service\xplainer-daemon.xml` |
| Starts at | **boot**, with lingering enabled | **login** | **logon** |
| Needs administrator | No — except `loginctl enable-linger` on images with no polkit | No — except `--system` | No — except `--at-boot`, or granting "Log on as a batch job" to a genuine standard user |
| Restart policy | `Restart=on-failure`, `RestartSec=2`, `StartLimitIntervalSec=300`, `StartLimitBurst=10` | `KeepAlive` with `SuccessfulExit: false`, `ThrottleInterval=30`, explicit `ExitTimeOut` | `RestartOnFailure` 3 × `PT1M`, plus an indefinite `PT5M` trigger repetition with `IgnoreNew` |
| Logs | journald (`SyslogIdentifier=xplainer`); we ship **no** rotator | our own rotating file at `~/Library/Logs/xplainer/daemon.log` | our own rotating file at `%LOCALAPPDATA%\xplainer\logs\daemon.log` |

The daemon is installed by a new command group, `xplainer daemon`, with seven verbs:
`install`, `uninstall`, `start`, `stop`, `restart`, `status`, `logs`. It is named `daemon`
and not `service` because `daemon` is already this repository's own word for the thing —
ADR 0016's "The daemon has no authentication", `apps/desktop`'s `resolveDaemonUrl()` and
`DEFAULT_DAEMON_PORT` — and because on Windows `service` would be a lie: we register a
Scheduled Task, and a user who opens `services.msc` after `xplainer service install` would
find nothing and file a bug.

### Why not the other three

**Option 1, foreground only, is the status quo and it is what the owner asked to change.**
It is kept as a first-class mode — see below — but as the only mode it makes the agent's
first call fail on every fresh boot.

**Option 2, a login item or tray app, was rejected on ADR 0016's own driver.** It reintroduces
the exact dependency 0016 removed: a desktop session. On a headless Linux VM there is nothing
to log into and no tray to draw, so the runtime would be unstartable on the machine class the
CLI exists for. It also inverts the layering ADR 0016 fixed — the GUI is "an optional client",
and making the daemon's lifetime depend on the optional client is not optional. As a
convenience it survives: at phase 2 the desktop app may still spawn a daemon when none is
installed, which is P2-1's existing "spawns a bundled daemon **and** attaches to a remote
daemon URL". It is not the supervision mechanism.

**Option 3, a true system service, was rejected on two independent grounds, either of which
is sufficient.**

*It needs an administrator at install*, on all three platforms — writing to
`/etc/systemd/system`, to `/Library/LaunchDaemons`, or calling `sc.exe create`. That is the
failure this record is required to avoid: an install path that works for the author and
prompts for a password on the user's machine.

*It voids the sentence ADR 0019's Dissolved table is built on.* A root or `LocalSystem`
daemon that renders agent-authored TSX **is** the privilege escalation that "confers no
privilege they did not hold" denies. Under option 4, an agent that can write a malicious
scene can already do everything that scene could do, because both run as the same uid; under
option 3 it cannot, and the render becomes a privilege boundary we would then have to defend
with the ephemeral-container sandbox ADR 0010 built for the *hosted* tier. That is the hosted
tier's cost structure imported into the free local tier for no gain.

`sc.exe create` is additionally non-functional as written: `dist/bin.js` never calls
`StartServiceCtrlDispatcher`, so the Service Control Manager kills it with error 1053 ("The
service did not respond to the start request in a timely fashion"). Making a Node CLI into a
real Windows Service means a service wrapper — one more binary to build, sign and support on
the one platform phase 1 does not even target.

### `serve` stays a foreground process, and that is what the supervisors run

This is not a debugging affordance. It is what all three supervisors execute.
`launchd.plist(5)` EXPECTATIONS is explicit that a job **MUST NOT** "Call daemon(3)" or "Do
the moral equivalent of daemon(3) by calling fork(2) and have the parent process exit(3) or
_exit(2)". systemd `Type=exec` and Task Scheduler expect the same. So the supervised daemon
and the hand-run debug process are the **same invocation**; only the parent and the log sink
differ.

The corollary is a rule, and it belongs in `serve.ts`'s docblock: **never add
`serve --detach`.** Detaching belongs to `xplainer daemon`. A `serve` that backgrounds itself
is a `serve` that no supervisor can supervise.

`serve` does gain four things it needs in order to be supervised, and they are prerequisites
rather than extras:

- **A SIGTERM handler and a clean shutdown.** `launchd.plist(5)` EXPECTATIONS says a job
  **SHOULD** "Handle the SIGTERM signal, preferably with a dispatch(3) source, and respond to
  this signal by unwinding any outstanding work quickly and then exiting", and the man page
  says `ExitTimeOut`'s "default value is system-defined" — so a job cannot rely on any
  particular grace period and must set one explicitly. Logout, reboot, `bootout`,
  `kickstart -k`, `systemctl --user stop` and `Stop-ScheduledTask` all go through this path.
  Without a handler, a render dies mid-frame and leaves an orphaned Chrome behind roughly
  every time the user logs out.
- **The guard middleware and the token** (see §Security below).
- **The IPC listener** (see §The agent path is IPC).
- **State on disk** — `daemon.json` and `runtime.json` (see §Port and discovery) — and a small
  table of exit codes the supervisor can act on: `0` clean shutdown or a deliberate stall,
  `10` the recorded port is taken, `11` state file unreadable, `12` token file missing (it
  cannot enforce authentication, so it must not serve), `70` internal error. The CLI's own
  codes extend the precedent in `apps/cli/src/not-implemented.ts` — "`2` distinguishes 'this
  command exists but does nothing yet' from commander's own `1`" — with `3` precondition
  unmet, `4` installed but not healthy, `5` administrator privileges required, `6` no
  supported supervisor, `7` port or label conflict. `NOT_IMPLEMENTED_EXIT_CODE = 2` keeps its
  meaning and its export site.

### The agent path is IPC, not TCP

`serve` binds **two** listeners over one Hono application: the TCP loopback listener it binds
today, and a unix domain socket (named pipe on Windows) inside a `0700` directory. The MCP
specification's own mitigation for locally-run servers, in its own order of preference:

> Use the `stdio` transport to limit access to just the MCP client
> Restrict access if using an HTTP transport, such as: Require an authorization token; Use
> unix domain sockets or other Interprocess Communication (IPC) mechanisms with restricted
> access
> — [MCP Security Best Practices, §Local MCP Server Compromise](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices)

`xplainer connect claude|codex` therefore writes a **stdio** entry by default, pointing at
`xplainer mcp --attach`, which proxies stdio to that socket. No URL and no token enter any
agent configuration file. A browser can neither open a unix socket nor spawn a process, so
the entire DNS-rebinding class is **structurally absent** from the path agents actually use,
rather than filtered out of it. Filesystem permissions are the authentication, which is
Docker-on-Linux's model, stated honestly: the socket is exactly as strong as the uid
boundary.

The TCP listener stays, because ADR 0016 promises `/api/*` REST + SSE for GUI clients and
`apps/desktop`'s `resolveDaemonUrl()` is already written against a URL. It carries every
guard in §Security. `@hono/node-server` supports both from one app: `serve()` for the port,
and `createAdaptorServer({ fetch })` — exported by the pinned `2.1.1` — returning a plain
Node server that can `listen()` on a socket path. One `createServer()`, one tool
registration, two listeners.

`createServer()` gains an optional `guard` middleware rather than a boolean "local mode": the
TCP binding passes the loopback guard, the IPC binding passes none, and at phase 3
`services/media-service` passes its OAuth guard. One place decides, and the loopback Host
allowlist does not have to be wrong for the hosted service.

### Port and discovery: decided once, at install

`DEFAULT_PORT = 8787` stays exactly as it is in `apps/cli/src/server.ts` — it is what
`xplainer serve` binds when nothing tells it otherwise, so AC-14's `xplainer serve --port 8787`
and every existing test stay true. What changes is that **the daemon's port is decided at
install time and written to a durable state file**, and `connect`, `status`, `logs` and the
desktop client read that file rather than a constant.

Neither alternative survives contact with always-on:

- *Always 8787* fails on any machine with two users — fast user switching on a Mac, two RDP
  sessions on Windows, two developers on the shared Linux VM that is ADR 0016's own driver.
  Each gets their own unit or agent or task; the second one gets `EADDRINUSE` forever, at one
  Node cold start per throttle interval, silently.
- *A fresh ephemeral port at every start* breaks `connect`, which has already written a URL
  into `~/.claude.json` or `~/.codex/config.toml`. A discovery value that changes on restart
  is not a discovery mechanism, and restart is the property this record adds.

So the recorded port is a **contract**. `install` probes 8787, then 8788–8799, records what it
took, and if that port is later unavailable `serve` exits `10` naming the pid that holds it
and `status` prints the fix. A loud one-line failure, rather than a silent daemon that moved
and left every agent config pointing at nothing.

Two state files, because they have opposite lifetimes:

- **`daemon.json` — durable, written by `install`, must survive reboot.**
  `${XDG_STATE_HOME:-~/.local/state}/xplainer/` on Linux, `~/Library/Application Support/video.xplainer/`
  on macOS, `%LOCALAPPDATA%\xplainer\state\` on Windows. It records the port, the socket path,
  the token file path, the supervisor kind and artefact path, the resolved program and
  interpreter, whether *we* enabled lingering, the log sink, and the installing version.
- **`runtime.json` — ephemeral, written by `serve` at bind, removed on clean shutdown, never
  trusted without a liveness check.** On Linux it lives in systemd's `RuntimeDirectory=xplainer`
  (`$RUNTIME_DIRECTORY`, under `$XDG_RUNTIME_DIR`), where "the innermost subdirectories are
  removed when the unit is stopped"
  ([systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html)) — so the
  descriptor cannot go stale, which is what makes it trustworthy. macOS and Windows have no
  such reaper, so `status` treats it as a hint and confirms over HTTP.

`XDG_RUNTIME_DIR` is the right home for the socket, whose mandated lifetime matches a
socket's, and the wrong home for the token, which must survive logout. Hence the split.

`resolveDaemonUrl()` in `apps/desktop/src/main/daemon.ts` gains a third branch in strict
precedence — **configured remote URL → `daemon.json`'s recorded port → `DEFAULT_DAEMON_PORT`** —
and stays a pure function; the caller reads the file and passes `{ port }`. Its comment
"Must equal `DEFAULT_PORT` in `apps/cli/src/server.ts`" becomes a statement about the
fallback, not about the daemon.

### Ordering: `setup`, then `install`, then `connect`

```
xplainer setup  →  xplainer daemon install  →  (wait for /healthz)  →  xplainer connect claude
```

**`xplainer daemon install` never downloads, and the daemon never downloads.** This is
ADR 0005's decision applied to a new caller, not a new decision: the several-hundred-megabyte
fetch is "an explicit, resumable, user-visible" step precisely because "a download that fails
behind a corporate proxy must say so". A background agent has no terminal, no progress bar and
no way to report a proxy failure — and a service that starts at boot and immediately pulls
hundreds of megabytes over someone's tethered connection is a bad neighbour twice over, at
install and on every reboot.

`install` therefore checks a marker written by `setup` (`toolchain.json`, recording the
Chrome Headless Shell and TTS versions, paths and checksums), verifies the recorded paths
still exist, and on failure **exits 3 having written nothing**, printing the one command that
fixes it. `--with-setup` runs setup in the foreground first for the impatient — still visible,
still interruptible, still not inside the service.

If the toolchain disappears *after* install, the daemon starts **degraded** rather than
crash-looping or fetching: it binds, reports `{"status":"degraded","reason":"toolchain_missing"}`
on `/healthz`, and answers `explainer_render`/`explainer_narrate` with a named MCP error
telling the agent to run `xplainer setup`. A crash loop here would be a boot-time restart
storm on a machine whose only problem is a stale cache. Upgrades follow the same rule:
`status` reports that a newer toolchain is needed; the daemon never self-applies it. **The
daemon does not become an updater.**

`connect` refuses to write an agent configuration pointing at a daemon that has never
answered (`--force` overrides). A working-looking config for a daemon that is not running is
the single most likely first-run support ticket, and it is cheap to prevent.

## Consequences

### Security is part of this decision, not a later nicety

These are acceptance obligations of the always-on change. None of them ships later. They are
listed as requirements because they will be read as requirements.

**R-SEC-1 — Loopback by default.** `DEFAULT_HOSTNAME = "127.0.0.1"` is unchanged, and the
installer writes the bind address explicitly into the unit/plist/task, so changing it is a
visible diff in a reviewed file rather than silent drift. This matches the MCP transport
spec's "When running locally, servers **SHOULD** bind only to localhost (127.0.0.1) rather
than all network interfaces (0.0.0.0)"
([Transports, §Security Warning](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)).

**R-SEC-2 — `Host` allowlist, exact match, every TCP route.** Hono middleware mounted in
`createServer()` before any route, so `/healthz`, `/mcp` and the future `/api/*` are all
covered. The allowlist is exactly `{127.0.0.1:PORT, localhost:PORT, [::1]:PORT}`, built
**after** bind because `startServer()` resolves the real port in the listen callback and
`--port 0` must keep working. Mismatch → 403. Never a parser: `http://2130706433:8787` and
`http://0x7f000001:8787` both reach loopback and would pass a "does this look like 127.0.0.1"
check. `Host` is the header that catches rebinding because script cannot set it and it is
present on every HTTP/1.1 request, including the GETs where `Origin` is absent.

This is also a defect being fixed, not only a feature: `createServer()` passes the SDK only
`{sessionIdGenerator, enableJsonResponse}`, and in the pinned `@modelcontextprotocol/sdk`
1.30.0 `validateRequestHeaders()` opens with `if (!this._enableDnsRebindingProtection) return undefined;`,
defaulting to `false` for backwards compatibility. The daemon is in violation of the spec's
transport-level MUST **today**; always-on makes that violation reachable from a web page.

**R-SEC-3 — `Origin` validation.** "Servers **MUST** validate the `Origin` header on all
incoming connections to prevent DNS rebinding attacks" (Transports, §Security Warning).
Present-and-not-allowed → 403; **absent → pass**, because `curl`, Claude Code and Codex send
none. That asymmetry is why R-SEC-2 is ranked above this one. After a rebind both headers
still read the attacker's name — the browser rewrites the address, not the name it believes
it is talking to — so either check rejects.

**R-SEC-4 — A bearer token on every TCP route, including `/healthz`.** 32 bytes from
`crypto.randomBytes`, base64url, compared with `crypto.timingSafeEqual` after a length check;
failure → 401 with `WWW-Authenticate: Bearer`. Authenticating `/healthz` is load-bearing
twice: an unauthenticated `{status, version}` tells any web page which xplainer version to
attack, and a 401 against *our* token gives `status` the precise sentence "something is on our
port that is not our daemon".

**R-SEC-5 — Token storage, and an honest gap on Windows.** File `0600` inside a `0700`
directory, created with `fs.open(path, "wx", 0o600)` under a tightened umask so it is never
briefly world-readable, minted by `xplainer setup` and never by `serve` (a daemon that mints
a token on first boot races `connect`). On Windows a mode is not protection: Node's `fs`
documentation records that only the write permission can be changed there and that the
owner/group/other distinction is not implemented
([File modes](https://nodejs.org/api/fs.html#file-modes)), so a `0600` token file is readable
by every account on the box. DPAPI needs a native addon, which is exactly what does not
survive phase 2's single-executable packaging, so the requirement is an explicit ACL applied
at creation — `icacls <path> /inheritance:r /grant:r "%USERNAME%:(R,W)"`, which needs no
administrator — and `xplainer daemon status` re-verifies it and warns if inheritance has been
restored.

**R-SEC-6 — The unit carries a token *path*, never a token value.** `/proc/<pid>/cmdline` is
world-readable and `systemctl --user show xplainer` prints `Environment=`. The
unit/plist/task sets `XPLAINER_TOKEN_FILE`; the daemon reads the file; the token never appears
in argv.

**R-SEC-7 — No CORS middleware, ever**, for any value including the wildcard. Worth stating
because the only thing blocking a plain cross-origin POST today is an accident: the SDK
requires a parsed `application/json` content type, which is not CORS-safelisted, so a
preflight fires and Hono 404s the OPTIONS. A *simple request* — POST with
`application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain` — is not
preflighted at all, so the moment `/api/*` accepts a form POST that accident evaporates. The
guard is the defence; media-type strictness never was.

**R-SEC-8 — Credentials in agent configuration.** The default `connect` writes a stdio entry
with no URL and no secret. `connect --http` writes the TCP entry for cases that need it, and
in both supported clients the secret stays out of the file: Claude Code at **user** scope with
a `${VAR}` header expansion — never `--scope project`, which writes a `.mcp.json` the docs
describe as shared through version control, i.e. a committed token — and Codex's
`bearer_token_env_var`, which stores the *variable name* rather than the value.
`xplainer token rotate` writes a new token with a grace window for the old one, and
`daemon uninstall` rotates automatically so a copy left in a shell history is dead.

**R-SEC-9 — Non-loopback exposure stays outside the supported configuration, and relaxing the
bind must *tighten* validation, never skip it.** This is the CVE-2026-65105 lesson stated as a
rule: NemoClaw bound Ollama to `0.0.0.0` so a sandbox container could reach it, and Ollama's
`Host` validation was conditional on the bind address being loopback — so widening the bind
silently disabled the whole defence, and one visited web page could poison a local agent's
model template persistently
([CVE record](https://www.cve.org/CVERecord?id=CVE-2026-65105)). Our guard is therefore
unconditional. A non-loopback socket requires **all** of: an explicit `--bind`; an explicit
`--i-understand-remote-exposure` (the same gesture as
`services/tts-sidecar/packaging/`'s `--i-know-this-is-a-stub`, so the repository has one idiom
for "this is deliberately hard"); a non-default token; TLS; and a Host/Origin allowlist that
still applies, now against the operator's hostnames. `0.0.0.0` and `::` are refused outright.
Until all of that exists, ROADMAP P2-5 and ADR 0016's sentence stand unchanged.

**R-SEC-10 — Logging.** `Authorization` is redacted at the logger, not at call sites. Request
bodies are **never** logged: `explainer_put_source` carries the user's source and
`explainer_put_media` carries base64 screenshots of their internal tooling — the exact
material ADR 0019 counts as never leaving the machine, and an always-on log under
`~/Library/Logs` that a backup tool syncs recreates the egress problem locally, in cleartext.
Every *rejection* is logged with its reason and the offending value, because
`403 invalid Host header: evil.com:8787` is the only way anyone ever learns a page tried this,
and rejections are low-volume by construction. The launchd job sets `Umask 0077`, because a
launchd agent's default produces world-readable logs.

**R-SEC-11 — Three negative tests ship with the middleware**, in `apps/cli/src/server.test.ts`,
beside the positive ones already there: no `Authorization` → 401; `Host: evil.com:8787` → 403;
`Origin: http://evil.com` → 403. Without them the guard regresses on the first refactor of
`createServer()` and nobody notices, because every legitimate client still works. This is the
repository's own standard, from ADR 0016: "A registered command with a defined exit code is
behaviour, and it is tested as behaviour."

**What the token is not, stated so it is not overclaimed later.** Same-uid code reads a `0600`
file trivially. The token buys exactly two boundaries, and they are the right two: **the
browser**, which can send requests to `127.0.0.1` but cannot read `~/.local/state`; and
**other local users** on a shared box or VM, who can reach `127.0.0.1:8787` but cannot read a
`0600` file — and on the headless Linux VM ADR 0016 exists for, the second is not
hypothetical. Against same-uid malware it is worth nothing, and that is acceptable, because
such malware already owns `~/.claude.json` and `~/.ssh`. A token documented as a sandbox is
worse than no token.

### The amendment to ADR 0016 and ADR 0019

ADR 0016's consequence reads: "**The daemon has no authentication and binds localhost.**
Non-localhost access needs a bearer token, deferred to roadmap phase 2." This record **amends
that consequence**: always-on makes the token a **loopback** requirement, not merely a
non-loopback one, because the caller may now be a web page rather than the user's own agent.

That in turn **narrows** the ADR 0019 Dissolved-table row whose justification is "The agent
writing the TSX is the user's own agent, running under the user's own uid." That remains true
for the **IPC and stdio transports**, where the caller is provably a local process the user's
own uid can reach, and it is why `connect` defaults to IPC. It is **not** true of the **TCP
transport** once the daemon is always listening, which is why the TCP transport carries all
four guard layers.

This is recorded as a reversal rather than smoothed into a clarification on purpose. A design
review six months from now that reads only ADR 0019 would otherwise conclude the local tier
has no authentication requirement — which was true when it was written, and is no longer true.

### Restart on crash, and the circuit breaker the supervisors do not give us

None of the three supervisors has both backoff and a give-up. systemd's give-up is too
aggressive and latches permanently until `reset-failed`; launchd never gives up and will log a
crash line every few seconds forever; Task Scheduler's `RestartCount` is a burst absorber
behind an indefinite repetition trigger. So the daemon imposes its own, and the mechanism is
portable because **exit 0 means "do not restart" on all three**: systemd `Restart=on-failure`,
launchd `KeepAlive` with `SuccessfulExit: false`, and Windows `RestartOnFailure`.

`serve` appends each start to `recentStarts[]` in `runtime.json`. If the last five runs all
failed within 30 seconds of starting, it writes one legible line naming the cause, sets a
`stalled` flag with the reason, and **exits 0**. `status` reads it and says it in words;
`restart` clears it, along with `systemctl --user reset-failed` where that applies. Without
that clearing step, `restart` on a stalled daemon is a no-op and the user concludes the CLI is
broken.

`Restart=on-failure` rather than `Restart=always` is a deliberate departure from the Docker
analogy: `always` fights the breaker, and one convention across three platforms is worth more
than the marginal robustness. One asymmetry is accepted and documented rather than hidden: on
Windows the indefinite repetition trigger still restarts the process every five minutes, at
which point it re-reads the stall flag and exits 0 again. That is a cheap no-op, `status`
explains it, and it is the price of a supervisor with no "stay down" state.

Relatedly, and in scope for phase 1: a render whose process dies must land in `error` with a
bounded log tail, never stay stuck in `running`. That is the local analogue of P3-8, and it is
*not* dissolved by local-first the way ADR 0019's queue risks are.

### Degraded paths: what a user without systemd, or without admin, actually gets

The rule across all of them: **probe before writing; on refusal, write nothing, exit with the
documented code, and print the one command that fixes it.** A design that silently needs sudo
fails at install time; a design that silently installs half a daemon fails three days later,
which is worse. `install` probes the setup marker, the supervisor, the executability of the
resolved program, the port, lingering, any stale `launchctl disable` record, and the token
file — all without root — before it writes anything, and rolls back what it wrote if a later
step fails.

- **No systemd** (container, WSL1, OpenRC, chroot). Detected by `test -d /run/systemd/system`,
  which is what `sd_booted(3)` itself checks — not `command -v systemctl`, because Debian and
  Ubuntu base images ship `systemctl` without systemd as PID 1 and would fool a naive probe.
  Exit 6. **The user is not stuck**, and the message says so first: `xplainer connect claude --spawn`
  writes a stdio entry that starts `xplainer mcp` per agent session, needs no supervision at
  all, and delivers the product — what is lost is the warm process, the shared job queue and
  the desktop client, not the tools. Self-supervision recipes (Docker `--restart unless-stopped`,
  OpenRC `supervise-daemon`) are documented in `docs/daemon.md`; we do not write those files.
  Two honest notes travel with this: **Alpine is blocked on rendering, not on init** — the
  Chrome Headless Shell build Remotion downloads is glibc-linked and will not run on musl, so
  solving OpenRC there yields a daemon that starts reliably and fails every render; and
  **WSL2 stops the distribution when the last console closes**, systemd and lingering
  notwithstanding, so supervision there belongs on the Windows side.
- **systemd present, lingering denied.** `loginctl enable-linger` for yourself is normally
  unprivileged, and is verified root-free with `test -e /var/lib/systemd/linger/$USER`. It
  fails on images with no polkit daemon and under site policy. Exit 5, nothing written, with
  the fix printed as one line (`sudo loginctl enable-linger <user>`, needed once) and an
  explicit `--allow-session-only` escape. **This is the one degraded path where refusing is
  clearly right**: ADR 0016's driver is the headless Linux VM, and a session-scoped daemon
  there is strictly worse than the foreground `serve` it replaced, because it *looks*
  installed. `uninstall` never disables lingering by reflex — lingering is per-user, not
  per-service, and turning it off would kill the user's rootless Podman, `tmux` and every
  other user service; `install` records whether *it* enabled linger, and only then is removal
  offered.
- **macOS gets login, not boot — and this is a stated limitation, not a bug.** A user agent
  runs only while that user is logged in; with no login session there is no GUI domain to
  bootstrap `~/Library/LaunchAgents` into, and a user cannot conjure one from a shell.
  `install` prints this in advance and `status` repeats it. `--system` covers the headless
  case with one **announced** `sudo` and `UserName`/`GroupName` in the plist so the job still
  runs as the human rather than as root. ADR 0016's headless target is a *Linux* VM, where
  lingering covers this cleanly; on macOS the headless case is rare and opt-in, and pretending
  otherwise is how a design fails at install time.
- **macOS: the user switched it off.** macOS 13 and later list this under System Settings ›
  General › Login Items & Extensions and fire a "Background items added" notification at
  install — which is why `install` warns before it writes. A disable record persists across
  reboots and is otherwise invisible, so `status` checks for it and names it in those words.
- **Windows: a standard user without "Log on as a batch job".** S4U registers without a
  password, but Task Scheduler will tell us at registration time when it will not launch:
  `SCHED_S_BATCH_LOGON_PROBLEM` (0x0004131C) — "The task is registered, but may fail to start.
  Batch logon privilege needs to be enabled for the task principal"
  ([ITaskFolder::RegisterTaskDefinition](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/nf-taskschd-itaskfolder-registertaskdefinition)).
  `install` therefore **verifies rather than assumes**: register, start, poll `/healthz` for
  15 s, and on failure read `LastTaskResult`, name the missing right, unregister, and exit 5,
  offering `--logon interactive` with its costs stated. Granting that right needs an
  administrator; so does `--at-boot`, because "Only a member of the Administrators group can
  create a task with a boot trigger" (same page).
- **Windows: S4U has no network credentials.** "When an S4U logon is used, no password is
  stored by the system and there is no access to either the network or to encrypted files"
  ([TASK_LOGON_TYPE](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type)).
  Plain outbound HTTPS is unaffected, and ADR 0005's downloads run under `setup` interactively
  anyway — but an agent handing `explainer_put_media` a UNC path gets a permission failure it
  cannot explain, so the error message must **name S4U**.
- **macOS TCC constrains the product, not only the plist.** `launchd.plist(5)` CAVEATS:
  "Daemons and agents managed by launchd are subject to macOS user privacy protections.
  Specifying privacy sensitive files and folders in a launchd plist may not have the desired
  effect, and may prevent the job from running." A background agent has no UI to answer a
  consent prompt, so a render writing into `~/Desktop`, `~/Documents`, `~/Downloads`, iCloud
  Drive or an external volume **fails** where the same command run interactively would have
  prompted and worked. Consequently `explainer_put_source`'s `write_source_to` defaults under
  `~/Library/Application Support/video.xplainer/`, and the daemon returns a named, legible
  error rather than an `EPERM` stack trace when an agent points it somewhere protected.

`xplainer daemon status` is the command a support ticket starts with, and it is built from
HTTP plus our own state — **never** from a parsed supervisor, because `launchctl`'s own manual
says of `print`: "This output is NOT API in any sense at all." It must be able to say, in
words: "stopped after 5 failed starts; port 8787 is held by pid 9932, which is not an xplainer
daemon"; "you or a policy switched this off in Login Items & Extensions"; "running, degraded:
the render toolchain is missing"; "running, but not boot-persistent, because lingering is not
enabled". `--json` is the machine surface for `resolveDaemonUrl()`'s consumer and for
provisioning scripts.

Log handling is deliberately asymmetric, and the asymmetry is not laziness. journald already
does retention (`SystemMaxUse=`, `MaxRetentionSec=`), so on Linux we ship no rotator and
`xplainer daemon logs` execs `journalctl --user -u xplainer`. launchd has **no log-rotation
key at all**, `/etc/newsyslog.d` is root-owned, and rename-based rotation is broken against a
live launchd job because the descriptor is opened once at spawn — so on macOS and Windows the
daemon writes its own size-bounded log and the supervisor's own capture file is treated as a
bounded crash-only sink.

### Accepted costs

- **A fifth top-level command, and an amended acceptance criterion.** AC-14 asserts that
  `--help` lists exactly `serve`, `mcp`, `setup`, `connect`; `daemon` breaks that assertion by
  design. It is amended in the spec with a dated line and the test's expected value changes —
  it stays a `toEqual`, because AC-14b's value was never the number four but that the command
  surface is **fixed and asserted**, and that commander's implicit `help [command]` can never
  sneak back in. `helpCommand(false)` therefore has to be applied to the `daemon` sub-program
  too, or the group's own assertion fails for exactly the reason AC-14b would have. The group
  is registered **now**, as `createStubCommand`s that name themselves on stderr and exit 2 —
  the shape `mcp`, `setup` and `connect` already have — so the surface other things depend on
  is fixed before the installer behind it exists.
- **Three supervisors to write, test and support**, each with a distinct failure vocabulary,
  on the phase that already owns three CI runners. This is the largest cost of the decision
  and there is no version of "always running" that avoids it.
- **`npm`/`npx` is the supported install path at phase 2; the standalone binary follows
  notarisation at phase 4.** An npm-delivered CLI carries no `com.apple.quarantine`, so
  Gatekeeper never fires on the supported path. A *downloaded* single-executable binary is the
  opposite case, and since macOS 15 there is no Control-click escape — the user has to go to
  System Settings › Privacy & Security. Until phase 4 the binary is a convenience for people
  who fetch it with `curl`, not the recommended route for a product whose pitch is "installed
  once and simply there".
- **Until the SEA binaries exist, `ExecStart` points at a path that a package manager can
  delete.** `~/.nvm/versions/node/<v>/bin` disappears on `nvm uninstall`, and `~/.npm/_npx/<hash>`
  is a garbage-collectable content-addressed cache. The phase-2 installer therefore pins a copy
  of `process.execPath` and the CLI under the state directory — roughly 120 MB of duplicated
  Node that the SEA binary later removes. Recorded here so phase 2 does not discover it as a
  bug report that reads "it stopped working after I upgraded Node".
- **`xplainer daemon` is one more thing to keep out of the hosted tier.** The supervisor
  modules are local-runtime concerns and must not leak into `packages/mcp-server`, which is
  ADR 0019's kill criterion 6 restated for this work.

## What this record does not decide

- **Which roadmap phase each piece lands in is stated in `docs/ROADMAP.md`, not here.** The
  split is prerequisites in phase 1 (SIGTERM and clean shutdown, the guard and the token, the
  IPC listener and `mcp --attach`, the state files) and the installer itself in phase 2, where
  `xplainer setup` becomes real and where the standalone binaries and `apps/desktop` — the
  second consumer of `daemon.json` — already live.
- **Whether the desktop app should also be able to install the daemon** — a one-click "start
  xplainer at login" button in settings — is a phase-2 product question. This record only
  requires that if it exists, it shells out to `xplainer daemon install` rather than writing a
  plist of its own.
- **Anything about the hosted tier's process model.** `services/media-service` runs in a
  container under ADR 0010; nothing here applies to it. The only shared surface is
  `createServer()`'s new `guard` parameter, which exists so that the loopback guard and the
  hosted OAuth guard are two arguments to one function rather than two servers.
- **Whether `serve` should ever be removed as a user-facing command.** It should not be, and
  the roadmap does not propose it: it is what the supervisors execute, and it is the only way
  to see the daemon's output attached to a terminal.
