---
"@xplainer/cli": patch
---

The three supervisor artefact renderers, behind one adapter.

`src/install/supervisors/` renders the systemd unit, the LaunchAgent plist and the Task Scheduler
document from a `LaunchSpec` and composes **no argument of its own**. Each renderer answers with the
file's path, its mode, the name its own supervisor addresses the daemon by, and its exact bytes;
nothing here writes, which is what makes all three platforms verifiable on one machine — the golden
tests assert each document whole rather than a key at a time.

**Every setting travels in the argv, on every platform, and that is one rule rather than two.** Task
Scheduler's `<Exec>` action has no per-action environment map, so Windows had to use the argument
vector anyway; the two POSIX platforms do the same because **there is no `XPLAINER_SOCKET`
variable** for an environment emission to use — `--socket` is a flag and `daemon/ipc.ts` reads no
variable — so an environment-only emission would leave systemd creating a `RuntimeDirectory=`
nothing writes into. `Environment=` and `EnvironmentVariables` are kept for the state directory and
the token file, so a reader of a unit or a plist still sees them where they have always been, and
every emitted value is a **path and never the token itself**. A renderer refuses a contract whose
`argv` lost a flag its `settings` still name, because that artefact would satisfy every value it
records and start a daemon that received none of them.

The values are the measured ones. `Type=exec` with **no `NotifyAccess=` line at all**, per ADR
0025's note of 2026-09-08: a unit that let the two be chosen independently is one that can render a
daemon which never starts. `KillMode=mixed` with `TimeoutStopSec=45s`, per ADR 0024's: under the
default `KillMode` the drain is not a drain, because Chrome and ffmpeg are signalled at the same
instant as the daemon, and the stop budget is escalation rather than a drain and so has to exceed
the 20 s cap. `ExitTimeOut=45` is the macOS counterpart — it is what bounds `launchctl kickstart
-k`, which was measured to send `SIGTERM`, wait for the drain and block until the process is gone.
`ProcessType=Interactive` because *unspecified* is the throttled case for a job whose work is Chrome
and ffmpeg, and `Umask` as the decimal integer `63`.

`StartLimitIntervalSec` and `StartLimitBurst` are `[Unit]` keys and are asserted in that section:
systemd 252 answers `Unknown key 'StartLimitIntervalSec' in section [Service], ignoring` to the
other placement. The Windows task is `\xplainer\<user>-daemon` with its XML mirrored at
`%LOCALAPPDATA%\xplainer\service\xplainer-daemon.xml` — per user, because two accounts on one
machine cannot both register a machine-global name — with an explicit `S4U`/`LeastPrivilege`
principal, an explicit trigger identity, and a `PT5M` repetition with no `<Duration>`, which is what
makes it indefinite.
