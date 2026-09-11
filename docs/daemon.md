# The daemon: installing it, running it, updating it, exposing it

`xplainer serve` is one process per user per machine. On the three platforms that give a user their
own service manager it is *installed* — `xplainer daemon install` writes a systemd user unit, a
LaunchAgent or a Scheduled Task and never asks for an administrator
([ADR 0020](adr/0020-always-running-local-daemon.md)). This file is that path, and then the two
things that path does not cover:

- **a host with no user-scope supervisor** — a container, WSL1, an OpenRC machine, a chroot — where
  `daemon install` exits `6` and points here. §6 is the self-supervision recipes ADR 0020 promises,
  and they are recipes rather than files this repository writes;
- **a daemon reachable from another machine**, which ADR 0020 §Security R-SEC-9 makes a list of five
  requirements rather than a flag. §5.

Two facts to have before anything below. **`xplainer` on `PATH` is one of three things**: the stable
launcher an install wrote (`<state>/bin/xplainer`), a checkout you run as
`node apps/cli/dist/bin.js`, or — since `@xplainer/cli` and the unscoped `xplainer` alias reached npm
at `0.0.1` on 2026-09-11 — an `npm i -g xplainer` or an `npx -y xplainer`. Every command here is
written as `xplainer …` and the forms are interchangeable, including for installing: since
2026-09-11 `daemon install` **takes no arguments** on a machine that installed from npm. It builds
its own payload-1 directory out of that install and registers *that* rather than the `xplainer` on
your `PATH`, because a `PATH` copy lives under whichever Node installed it and the next
`nvm install` would leave a supervisor entry naming a file that is gone. `--runtime <dir>` is still
how a checkout, a CI runner or a machine with no registry access names a payload it built itself.

And **the exit codes are a single table** in
[`docs/ARCHITECTURE.md` §6](ARCHITECTURE.md#6-the-runtime); this file names codes and does not
restate their meanings.

---

## 1. The supported path, in order

```sh
xplainer setup                          # browser, speech route and render workspace; writes toolchain.json
xplainer setup --workspace              # the workspace alone (`npm ci` against the template's pins)
xplainer runtime build --out <dir>      # assemble payload 1 (a checkout only; it is the builder)
xplainer daemon install --runtime <dir> # register with this machine's supervisor and start it
xplainer daemon status                  # installed? running? healthy? — and which of the three
xplainer connect claude                 # write `xplainer mcp --attach` into the agent's config
```

`setup` is the only step that downloads, and `daemon install` refuses without the `toolchain.json`
it writes (exit `3`). What `install` registers, per platform:

| Platform | Supervisor | Artefact it writes | Default state directory | `daemon logs` reads |
|---|---|---|---|---|
| **Linux** | `systemd --user` | `~/.config/systemd/user/xplainer.service` (or under `$XDG_CONFIG_HOME`) | `$XDG_STATE_HOME/xplainer`, else `~/.local/state/xplainer` | `journalctl --user` |
| **macOS** | launchd user agent | `~/Library/LaunchAgents/video.xplainer.daemon.plist` | `~/Library/Application Support/video.xplainer` | the plist's `StandardOutPath` file |
| **Windows** | Task Scheduler | task `\xplainer\<user>-daemon` (one per user) | `%LOCALAPPDATA%\xplainer\state` | the task's redirected log file |

`install` also writes **`<state>/bin/xplainer`** (`xplainer.cmd` on Windows), a two-line launcher
that `exec`s the current runtime's own `bin/node` and `dist/bin.js`. That is the one name a consumer
may hold across an update: a runtime directory is named `<version>-<digest>`, and the next update
points at a directory the old name no longer describes. `connect` writes the launcher's path into
your agent's configuration for exactly that reason.

**Three settings, flags above environment above platform default**: `--state-dir` /
`XPLAINER_STATE_DIR`, `--token-file` / `XPLAINER_TOKEN_FILE`, and `--socket`. The flags exist
because Task Scheduler's `<Exec>` action has no per-action environment map, and all three are
recorded in `daemon.json` at readiness, so `xplainer status --json` reports what the running daemon
actually resolved rather than what the caller intended.

## 2. What `install` checks before it writes anything

The rule is ADR 0020's: **probe before writing; on refusal write nothing, exit with the documented
code, and print the one command that fixes it.** The read-only preflight looks at the setup marker
and whether its recorded paths still exist, the supervisor and whether *this user* has a manager,
the resolved program's executability, the port, the systemd linger marker, a stale `launchctl`
disable record, and the token file.

| Exit | When | What the message says |
|---:|---|---|
| `3` | no `toolchain.json`, its recorded paths are gone, or the resolved program cannot be executed | run `xplainer setup` |
| `5` | the supervisor is here and refuses **this user** the right the daemon needs: systemd lingering denied, or Windows `SCHED_S_BATCH_LOGON_PROBLEM` | `sudo loginctl enable-linger <user>`, or the missing batch-logon right named as a candidate |
| `6` | there is no user service manager to install into at all | `xplainer connect claude --spawn`, and this file for a machine that wants a daemon anyway |
| `7` | the port is held, or a unit, label or task of that name is somebody else's | the holding pid, from `lsof` or `ss` where one answers |

Exit `6` has a second form worth knowing: on a systemd machine where the manager is absent *because*
`/var/lib/systemd/linger/$USER` is, the message leads with `sudo loginctl enable-linger` rather than
with `--spawn`, because one command fixes that host for good.

**`connect claude --spawn` is not a lesser product.** It writes a stdio entry that starts
`xplainer mcp` inside each agent session, needs no supervisor and no daemon, and delivers all eight
tools. What it costs is the warm process, the shared job queue and the desktop client.

## 3. Lifecycle

```sh
xplainer daemon start        # start the installed daemon and wait for it to answer
xplainer daemon stop
xplainer daemon restart      # and clear a latched start failure, if there is one
xplainer daemon status       # or `--json`: one condition code from a closed set
xplainer daemon logs -n 200
xplainer daemon uninstall    # deregister, delete the token, and leave lingering exactly as it is
xplainer status              # the daemon itself, installed or not
```

**Readiness is announced, not inferred** ([ADR 0025](adr/0025-daemon-updates-and-readiness.md)).
After ownership is acquired, reconciliation has finished and both listeners are bound, the daemon
writes **one line of JSON to stdout, once**:

```json
{"event":"ready","port":8787,"socket":"/var/lib/xplainer/ipc/xplainer.sock","contract_version":"1","pid":1}
```

That line is the whole of stdout — everything else `serve` says goes to stderr — so it must never
move behind a `--quiet` flag or a log-level filter, and §6.1 is how a parent waits on it.
`socket` is `null` only for a binding that was asked for no socket at all.

**Two listeners.** The TCP one carries the guard middleware — `Host` allowlist, `Origin` check and
the bearer token on `/healthz` as well as `/mcp`. The unix socket (named pipe on Windows) sits in a
`0700` directory, which *is* its authentication, and is what `xplainer mcp --attach` dials; that is
why an agent's configuration holds no URL and no secret.

**Drain.** `SIGTERM` stops new jobs, gives in-flight ones at most **20 s** to checkpoint, hard-stops
Chrome and ffmpeg children, marks anything still `running` or `queued` as `error` with
`error_code: "daemon_shutdown"`, removes `runtime.json` and the socket, and **exits `0`** — the
portable "do not restart" signal on all three supported supervisors.

**The circuit breaker.** None of the three supervisors has both backoff and a give-up, so the daemon
imposes one: when the last **5** starts each failed before readiness and each within **30 s** of its
own start, `serve` writes one legible line, sets `stalled` in `daemon.json`, and exits `0` so the
supervisor stops. `xplainer daemon status` says it in words; `xplainer daemon restart` clears it
(and runs `systemctl --user reset-failed` where that applies). **§6's two self-supervision recipes
do not honour that exit `0`** — measured, and stated where each recipe is.

**Windows brings the daemon back every five minutes, and only that.** The registered task carries an
indefinite `PT5M` repetition on **two** triggers: a `<RegistrationTrigger>`, so the re-check exists
from the moment `install` finishes, and a `<LogonTrigger>`, so it exists again after a reboot. That
matters because a repetition belongs to a trigger that has *fired*: `Start-ScheduledTask` — what
`install` and `daemon start` call — is an on-demand run and starts no trigger, and a logon trigger
does not fire in a session the user logged into before running `install`. Its neighbour
`<RestartOnFailure>` (3 × `PT1M`) restarts a task that failed to **launch** and does **not** restart
an action that exited non-zero, so a daemon that starts and exits `10` is re-run by the repetition
and by nothing else. Both facts were measured on `windows-latest` on 2026-09-09 and the argument is
in [ADR 0020](adr/0020-always-running-local-daemon.md)'s note of that date. The practical shape: a
Windows daemon that cannot bind its port takes about twenty minutes to reach five failed starts and
latch, and a latched one goes on being asked to run every five minutes, re-reading the flag and
exiting `0`.

## 4. Updating

```sh
xplainer daemon update --from <dir>   # a payload-1 directory from `runtime build --out`
xplainer daemon update --build        # assemble one from this program's own checkout, then update
xplainer daemon recover               # finish or undo an update that was interrupted
```

The transaction is **stage → drain → switch → restart → verify → roll back**, where *switch* means
rewriting what the **supervisor** launches — the unit, the plist, the task XML and the stable
launcher — and not only the path `daemon.json` records. An update that rewrote `daemon.json` alone
would leave `ExecStart` pointing at the old copy and report success. Every write is `temp → rename`,
the journal is durable, and `daemon status` reports an interrupted transaction by naming the
transition it stopped at and the command that finishes it.

**Two refusals, both exit `3`, both before anything is staged or drained:**

- **the template pins differ.** A pin-changing upgrade is a **reinstall** this phase, not an update:
  the Remotion workspace survives updates by design, so an update that changed its pins would report
  success, keep `/healthz` green and break the next render. The message names the reinstall and
  insists it be run from the **new** runtime's own program, because `<state>/bin/xplainer` execs the
  *installed* runtime and would re-resolve the old pins:

  ```sh
  # exactly as the refusal spells it: the new payload's own interpreter and its own entry,
  # because that payload's dist/bin.js starts `#!/usr/bin/env node` and this machine may have none
  <new>/bin/node <new>/lib/node_modules/@xplainer/cli/dist/bin.js setup --workspace
  <new>/bin/node <new>/lib/node_modules/@xplainer/cli/dist/bin.js daemon install --runtime <new>
  ```

- **the installed workspace does not satisfy both runtimes.** The check runs against the runtime
  being installed *and* the one it would roll back to, in that order. A workspace that satisfies
  only the incoming runtime leaves a rollback landing on a daemon that answers `/healthz` and cannot
  render, which is the failure this check exists for.

## 5. Exposing the daemon beyond this machine

ADR 0020 §Security R-SEC-9 makes remote exposure a list, and the list is `all` rather than `any`.
A non-loopback bind requires **every one** of:

1. an explicit `--bind <address>`;
2. an explicit `--i-understand-remote-exposure`;
3. `--tls-cert` **and** `--tls-key`;
4. at least one `--allow-host <host>`, which is where the `Host` allowlist gains anything beyond
   loopback;
5. a token this daemon did not mint — `token_origin` must be `operator`, so an operator writes the
   token file rather than letting the first start create one.

`0.0.0.0`, `::`, `[::]` and `*` are refused **even with** the acknowledgement: a wildcard bind is not
a decision about which interface to expose, it is the absence of one. Every precondition argv can
decide is decided **before** the listener is bound and before the state directory is taken, so a
refusal leaves nothing behind.

```sh
xplainer serve \
  --bind 192.168.29.157 --i-understand-remote-exposure \
  --tls-cert /etc/xplainer/fullchain.pem --tls-key /etc/xplainer/privkey.pem \
  --allow-host xplainer.lan --token-file /etc/xplainer/token
```

`xplainer token rotate [--grace <seconds>]` writes a new token and keeps the old one working for a
grace window. It deliberately does **not** touch `token_origin`: rotating replaces the value, not
the answer to "who decides this daemon's credential", so an operator's daemon stays the operator's
and a self-minted one does not become non-default by minting twice.

**The gate.** `pnpm e2e:remote` (`scripts/e2e/remote.mjs`) is the proof, and it is two phases. Phase
1 runs five `serve` commands each missing exactly one requirement **while the script holds the port
they were told to bind**, so an exit `1` carrying the refusal proves the precondition was decided
before the bind rather than after it — and a sixth command with everything supplied must exit `10`
on that held port, which is what proves the trap was armed. Phase 2 binds a real TLS listener on a
real non-loopback address and asks it four questions: unauthenticated is `401`, the operator's token
is `200`, a valid token with a foreign `Host` is `403`, and the bound address itself is not in the
allowlist unless `--allow-host` put it there.

```sh
pnpm e2e:remote                                   # this machine
XPLAINER_REMOTE_BIND=192.168.29.157 pnpm e2e:remote   # a specific interface
```

The runner half is `.github/workflows/daemon-remote.yml`, `workflow_dispatch` only. `workflow_dispatch`
registers from the repository's **default branch**, so the file has to be on `main` before the API
will accept a dispatch at all; `--ref` then chooses whose code runs:

```sh
gh workflow run daemon-remote.yml --ref "$(git branch --show-current)" -f macos=true  # linux=true by default; both legs are the two-platform claim
gh run watch "$(gh run list --workflow daemon-remote.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

**Honest status: that workflow has never been dispatched.** GitHub Actions is billing-blocked for
this organisation, so no runner evidence for R-SEC-9 exists and nothing in this repository may say
otherwise. What has run is the local gate, on macOS on 2026-09-08, twice — once against the address
the gate chose for itself and once against this machine's LAN address — 42 assertions, exit `0`,
recorded in `daemon-remote.yml`'s own header beside the dispatch command above.

---

## 6. Self-supervision, where there is no user-scope supervisor

Everything below is a **recipe**. `xplainer` writes none of these files, `daemon install` does not
know about them, and `daemon status` will report `supervisor_kind: null` on a host supervised this
way — which is accurate: nothing was installed, something else is doing the supervising.

### 6.1 Wait for the ready line; never sleep

There are two forms, and which one you get is decided by who the daemon's parent is.

**A parent that spawned the daemon itself** reads the line off the pipe. That is the primary
mechanism and it costs nothing.

**A supervised daemon's stdout goes to the supervisor's log sink**, so a starter that is not the
parent — an OpenRC `start_post`, a provisioning script, `docker run` — waits on that sink instead:

```sh
wait_for_ready() {          # $1: the file stdout is redirected to, $2: seconds
    i=0
    while [ "$i" -lt "$(( $2 * 5 ))" ]; do
        grep -q '"event":"ready"' "$1" 2>/dev/null && return 0
        i=$(( i + 1 )); sleep 0.2
    done
    return 1
}
```

Polling `/healthz` is the other legitimate wait, and it must be **authenticated and bounded**: a
`401` proves the port is bound and proves nothing about readiness.

*Measured, macOS 26.5 / Node 24.20.0, 2026-09-08.* `serve --port 0` with stdout redirected to a
file: the file held exactly one line — the ready announcement above, with the resolved port — while
the startup sentences went to stderr; authenticated `/healthz` answered `200` and
unauthenticated `401`; `SIGTERM` exited `0`.

### 6.2 Docker — `--restart unless-stopped`

```sh
docker volume create xplainer-state

docker run -d --name xplainer --restart unless-stopped \
  -v xplainer-state:/var/lib/xplainer \
  -e XPLAINER_STATE_DIR=/var/lib/xplainer \
  <your image> \
  /opt/xplainer/bin/node /opt/xplainer/lib/node_modules/@xplainer/cli/dist/bin.js serve --port 8787

# the readiness wait: docker keeps the streams apart, so stdout alone is the ready line
timeout 30 docker logs --follow --since 0m xplainer 2>/dev/null \
  | grep -m1 '"event":"ready"'
```

The interpreter and the entry are named explicitly because the payload carries its own `node` and
the image need not have one on `PATH` — `bin/node` and
`lib/node_modules/@xplainer/cli/dist/bin.js` are what `runtime.manifest.json` calls the launch pair.
The image must carry that runtime: a payload built by `xplainer runtime build --out` on a machine of
the same OS **and architecture** (it copies the build host's own interpreter), or a checkout run as
`node <checkout>/apps/cli/dist/bin.js serve`, or the published package installed into the image —
which is a way to run `serve` rather than a supervised install, for the reason the two facts at the
head of this file give. Use a **glibc** base —
`node:24-bookworm-slim` is the floor this repository already uses — for the reason in §7.1.

*Measured, Docker 29.4.0 on macOS/arm64, 2026-09-08.* `node:24-bookworm-slim` with the checkout
bind-mounted and the state directory on a volume: the daemon announced ready with `pid 1`,
`docker logs 2>/dev/null` returned exactly that one line, authenticated `/healthz` answered `200`
(body `{"status":"degraded","reason":"toolchain_missing",…}`), unauthenticated `401`, and
`xplainer status` inside the container reported `condition: "ready"` with `supervisor_kind: null`.

Three things this recipe does not hide:

- **`unless-stopped` does not honour the breaker's exit `0`.** Measured on the same day: a container
  whose process exits `0` was restarted five times in twelve seconds under `--restart unless-stopped`,
  and the real daemon was restarted once (`RestartCount=1`) after a clean drain-and-exit. Under
  `--restart on-failure:5` the same exit `0` was **not** restarted (`RestartCount=0`, status
  `exited`), which is the policy that matches the daemon's own contract — at the cost of not coming
  back after a host reboot. Docker respects an operator's `docker stop` or `docker kill` under either
  policy and does not restart then. Pick the policy against that trade, not against the default.
- **Publishing the port is remote exposure.** `-p` reaches the container over its own address, so the
  daemon inside would have to bind something that is not loopback — and then §5's five requirements
  apply in full, wildcards included. A container that keeps the daemon to itself and runs
  `xplainer mcp --attach` over the socket inside needs none of that.
- **`toolchain_missing` is not an error.** A fresh container has no Chrome and no speech route:
  `/healthz` answers `200` and says `degraded` until `xplainer setup` has run against the same state
  directory.

### 6.3 OpenRC — `supervise-daemon`

`/etc/init.d/xplainer`, `chmod +x`, then `rc-update add xplainer default`:

```sh
#!/sbin/openrc-run
name="xplainer"
description="xplainer local runtime"

supervisor="supervise-daemon"
command="/opt/xplainer/bin/node"
command_args="/opt/xplainer/lib/node_modules/@xplainer/cli/dist/bin.js serve --port 8787"
command_user="xplainer:xplainer"
pidfile="/run/xplainer.pid"
output_log="/var/log/xplainer/daemon.log"
error_log="/var/log/xplainer/daemon.err"
respawn_delay=2
respawn_max=5
respawn_period=60
export XPLAINER_STATE_DIR="/var/lib/xplainer"

start_post() {
    ebegin "Waiting for the readiness line"
    i=0
    while [ "$i" -lt 150 ]; do
        grep -q '"event":"ready"' "$output_log" 2>/dev/null && { eend 0; return 0; }
        i=$(( i + 1 )); sleep 0.2
    done
    eend 1 "no readiness line in 30 s"
    return 1
}
```

`command` is the **payload's own** interpreter, for the reason §6.2 gives — with one exception that
matters here: on **Alpine** a glibc payload will not run at all, so `command` there is the
distribution's own musl `node` and the entry is a checkout or a musl-built payload. That is what the
measurement below used, and §7.1 is why such a host can serve but not render.

`supervise-daemon` redirects the child's streams to `output_log` and `error_log`, which is what makes
the ready line waitable: `start_post` reads the same file the daemon is writing, and
`rc-service xplainer start` therefore returns when the daemon is ready rather than when it was
spawned.

*Measured, Alpine Linux v3.24 (`node:24-alpine`, arm64) with OpenRC 0.63.2 and Node 24.20.0, in a
container, 2026-09-08.* The script above (with `command` pointed at the image's own musl `node` and
`command_args` at a checkout) started
green, `start_post` returned on the ready line, `rc-service xplainer status` reported `started`,
`output_log` held exactly the ready line while the startup sentences went to `error_log`, and
authenticated `/healthz` answered `200` against `401` unauthenticated.

Three measured caveats:

- **`pidfile` holds the supervisor's pid, not the daemon's.** The daemon is `supervise-daemon`'s
  child. Signalling the pidfile stops the *service*; it is not a way to bounce the process.
- **`supervise-daemon` has no "exit 0 means stay down" rule.** Sending the daemon `SIGTERM` produced
  a clean drain and an exit `0`, and it was respawned with a new pid — so the circuit breaker's
  deliberate stall is restarted here, the same way §6.2's `unless-stopped` restarts it. The only
  give-up is a count: run standalone on Alpine 3.20 / OpenRC 0.54, with
  `--respawn-max 3 --respawn-period 60`, a child that exits immediately ran four times in fourteen
  seconds and then stopped, pidfile removed. Set `respawn_max` deliberately,
  and read `xplainer daemon status` — not the supervisor — for *why* a daemon keeps dying.
- **`rc-service xplainer stop` stops both and respawns nothing**, which is the behaviour you want
  from an operator's stop.

### 6.4 What a self-supervised host still gets, and what it does not

It gets the warm process, the shared job queue, the socket `xplainer mcp --attach` dials, and
`xplainer status`. It does not get `daemon install`, `daemon update`'s transaction, `daemon logs`,
the identity comparison (`daemon.json` records no supervisor, so there is nothing to compare
against), or the breaker's stay-down, per the two measurements above. Updating is whatever your
image build or your package manager already does — build a new payload, replace the old one, restart
the service — and the daemon never self-updates in either arrangement.

---

## 7. Two caveats that are not about init at all

### 7.1 Alpine is blocked on **rendering**, not on init

The daemon runs on musl. §6.3's whole measurement was made on Alpine: `serve` started, announced
readiness, answered authenticated `/healthz`, and drained cleanly. What does not run is the browser.
Remotion's Chrome Headless Shell build for Linux is **glibc-linked**, so solving OpenRC on Alpine
yields a daemon that starts reliably and fails every render.

`setup` states this before it fetches ~100 MB rather than after. `probeHost()` reads the runtime
glibc the way Remotion does — `process.report.getReport().header.glibcVersionRuntime`, which is
present only on a glibc Linux — and `assertLibcSatisfied()` refuses an artefact the host cannot run.

*Measured 2026-09-08:* `node:24-alpine` (Alpine v3.24, arm64) reports `glibcVersionRuntime`
`undefined`, against `"2.36"` from `node:24-bookworm-slim`, and the probe on Alpine returns
`glibc: null`. The refusal is `libc-unsatisfied`:

```
chrome-headless-shell linux-arm64 is a glibc build and this machine reports no runtime glibc,
which is what a musl system (Alpine) looks like. The artefact would unpack and fail to start;
use a glibc base image, or point setup at a Chrome you supply.
```

So: a glibc base image is the answer for a rendering host, and Alpine is fine for a host that only
narrates or only proxies — or for one where you supply a Chrome that runs there yourself.

### 7.2 WSL2: the distribution's lifetime is not yours to extend from inside

A systemd user service inside a WSL2 distribution does not give that distribution a lifetime of its
own. **The Windows host decides when the distribution runs**: it is started on demand and shut down
again once nothing is using it, and neither systemd support inside the distribution nor
`loginctl enable-linger` changes that. A daemon installed inside WSL2 therefore stops when the
distribution does, however correctly it was installed.

**Supervision belongs on the Windows side.** Install the daemon on Windows —
`xplainer daemon install` registers the per-user Scheduled Task `\xplainer\<user>-daemon` — or, if
the daemon must live inside the distribution, arrange a Windows-side task whose lifetime keeps the
distribution up, and treat that task as the supervisor.

*This one is documentation, not a measurement.* This repository has no WSL2 host and has never run
the case; the statement is deliberately about lifetime rather than about any particular trigger, and
an earlier, more specific wording ("when the last console closes") is corrected here for that reason.

---

## 8. What is measured here, and what is not

| Claim | Evidence |
|---|---|
| The ready line is the whole of stdout; `/healthz` `200`/`401`; `SIGTERM` exits `0` | measured on macOS, 2026-09-08 (§6.1), and asserted by `apps/cli`'s own suites |
| The Docker recipe starts, answers and is readable through `docker logs` | measured, Docker 29.4.0, `node:24-bookworm-slim`, 2026-09-08 (§6.2) |
| `--restart unless-stopped` restarts an exit `0`; `on-failure` does not | measured, both policies, 2026-09-08 (§6.2) |
| The OpenRC recipe starts, waits on the ready line and answers | measured, Alpine v3.24 / OpenRC 0.63.2, 2026-09-08 (§6.3) |
| `supervise-daemon` respawns a clean exit `0`; `respawn_max` is the only give-up | measured, same run for the respawn; the give-up standalone on Alpine 3.20 / OpenRC 0.54 (§6.3) |
| Alpine reports no runtime glibc and `setup` refuses the browser | measured, `node:24-alpine` v3.24 arm64, 2026-09-08 (§7.1) |
| R-SEC-9's refusals and the `401`/`200`/`403` answers | `pnpm e2e:remote`, local, macOS, 2026-09-08 (§5) |
| R-SEC-9 **on a hosted runner** | **not proven.** `daemon-remote.yml` has never been dispatched; Actions is billing-blocked for this organisation |
| Task Scheduler re-runs the daemon on the `PT5M` repetition, and on nothing else | measured, `windows-latest`, 2026-09-09 (run `34317779107`): a `<RegistrationTrigger>` with that repetition ran three times five minutes apart; a `<LogonTrigger>` started on demand ran once; `<RestartOnFailure>` 3 × `PT1M` produced no retry for an action exiting `10` |
| WSL2 | **not measured.** §7.2 |

The supervisor-specific behaviour behind §1–§4 — real `systemctl --user`, real `launchctl`, real Task
Scheduler — is proved by the `daemon-*.yml` proof workflows and by `pnpm e2e:identity`,
`pnpm e2e:update` and `pnpm e2e:toolchain`; `docs/ROADMAP.md` carries which of those have reported
and which have not.
