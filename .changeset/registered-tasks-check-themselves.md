---
"@xplainer/cli": patch
---

**On Windows, a daemon `xplainer daemon install` started and that then died stayed dead until the
next interactive logon — which on a machine already logged in is the next reboot.**

ADR 0020 gives the Windows daemon an "indefinite `PT5M` trigger repetition" as its restart policy,
and the registered task carried one. It was never running. A `<Repetition>` belongs to a **trigger**,
and the only trigger in the document was a `<LogonTrigger>`: `install` starts the task with
`Start-ScheduledTask`, which is an *on-demand* run and starts no trigger, and a logon trigger does
not fire in a session the user logged into before opening the terminal `install` runs in. So between
an install and the next logon nothing re-checked that the daemon was alive.

The document now carries a **`<RegistrationTrigger>`** with the same indefinite `PT5M`
`<Repetition>` beside the `<LogonTrigger>`, because registering the task is itself the trigger event:
the run that registration produces is a triggered run, and its repetition then runs the task every
five minutes for ever. Registration covers this boot and the logon trigger covers the next one.
`install`'s explicit `Start-ScheduledTask` is unchanged and cannot now produce a second concurrent
daemon — `MultipleInstancesPolicy: IgnoreNew` was measured doing exactly that job.

Measured on `windows-latest`, 2026-09-09 (run `34317779107`, job `102357526877`): three throwaway
tasks side by side, one action exiting `10`, `Get-ScheduledTaskInfo` polled every twenty seconds for
eleven minutes.

| document | started by | runs in 11 minutes |
|---|---|---|
| `<LogonTrigger>` alone, `PT5M` repetition — what shipped | `Start-ScheduledTask` | **1** |
| the same plus a `<RegistrationTrigger>` with that repetition | nothing; registering it | **3**, five minutes apart |
| `<RegistrationTrigger>`, four-minute action, `Start-ScheduledTask` immediately after | both | **1** concurrent start |

The same run settled a second claim, against itself: **`<RestartOnFailure>` (3 × `PT1M`) does not
restart an action that exits non-zero.** The task above carried `<Count>3</Count>` and
`<Interval>PT1M</Interval>`, registered and read back out of `Export-ScheduledTask`, and was started
by a trigger; its runs are five minutes apart. An exit code of `10` is a *completed* run recorded as
`LastTaskResult 10`, and what `<RestartOnFailure>` restarts is a task that failed to **launch**. The
element stays — that is a real, different failure — but the Windows retry cadence is the `PT5M`
repetition alone, and T14's circuit breaker now waits about twenty minutes for its five failed starts
rather than the quarter of an hour the old reading of the schema predicted.

`supervisors/schtasks.test.ts` pins the second trigger and the two `PT5M` intervals;
`install/testing/breaker-proof.ts` and `.github/workflows/daemon-breaker.yml` carry the new budget
with the measurement written at the site; and ADR 0020, `docs/daemon.md` and `docs/ROADMAP.md` carry
dated notes recording what was measured and which of their sentences it corrects.
