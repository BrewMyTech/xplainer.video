# 0008. Async job model: poll `explainer_job` plus MCP progress, no agent webhooks

- Status: accepted
- Date: 2026-09-05
- Deciders: @rishavanand
- Settled by: interview rounds 1 and 5; assumption "agent should get a webhook" challenged
  and resolved

## Context and Problem Statement

Narration and rendering are minutes-long operations. A 60-second explainer means TTS for
every segment, a Remotion bundle, and a frame-by-frame render — comfortably past any
sensible MCP request timeout, and past the point where a caller should be holding a
connection open.

The instinct is to give the caller a callback: the agent registers a webhook, the server
posts to it on completion. That instinct is wrong here for a structural reason —
**agents cannot receive callbacks.** Claude Code and Codex are clients. They have no
inbound address, no listening port, and no stable identity a server could POST to.

## Decision Drivers

- The caller is a client-side agent with no inbound network surface. This is not a
  preference; it is what makes one of the options impossible.
- The same job model must work on the local daemon and on the hosted service, since the
  tool contract is identical (ADR 0007).
- An agent watching a long job should see *something* happening, or it will retry, cancel,
  or narrate a guess to the user.
- The scaffold must not build a queue it does not need yet (spec §Non-Goals).

## Considered Options

1. **Synchronous long-running tool calls** — the tool returns when the render finishes.
2. **`job_id` returned immediately, agent polls `explainer_job(job_id, output_lines?)`,
   server additionally emits MCP progress notifications.**
3. **Webhook callbacks to the agent.**
4. **Server-Sent Events streamed to the agent for the duration of the job.**

## Decision Outcome

Chosen: **option 2.** Long operations return a `job_id` immediately; the agent polls
`explainer_job`; servers also emit MCP progress notifications so a client that renders them
can show movement without polling faster.

Option 1 was rejected on timeouts: a multi-minute tool call fails somewhere in the
transport chain long before the render finishes, and the retry re-runs the render.

Option 3 was rejected as **not implementable against this caller**, as above. Webhooks
remain a sensible *hosted integration* feature later — for someone else's server, not for
an agent — and that is where they belong.

Option 4 was rejected for v1 because it makes every job hold a connection, which is exactly
what the polling model exists to avoid, and it does not survive an agent restart. Note that
`xplainer serve` does expose REST + SSE at `/api/*` for **GUI clients** — the desktop app
wants a live progress bar — but that is a different consumer with a different lifetime, not
the agent path.

`explainer_job` returns `{job_id, job_type, status, exit_code, error, started_at,
finished_at, output}`, with `output_lines` bounding how much log tail comes back so a
polling agent does not re-read a large log on every call. Job states are a fixed enum:
`queued | running | done | error | cancelled`.

## Consequences

- **`RenderJob` is a first-class entity** in the ontology, with the same shape on both
  tiers, and `packages/protocol/schemas/job-state.json` is its single definition.
- **Polling has a cost the skill has to manage.** `SKILL.md` tells the agent to poll with
  backoff rather than in a tight loop; an agent that polls every 200ms turns a render into
  a denial of service against its own daemon.
- **The queue implementation is deliberately not decided by this ADR.** The hosted queue is
  Cloudflare Queues (ADR 0017, superseding ADR 0012) and the local job runner is a phase-1
  deliverable; both satisfy this contract, and the contract is what the agent sees. That
  independence paid off — the switch cost this record one proper noun. Two notes it does
  change: the five states are now written by our own code into our own table rather than
  reported by the queue, since Cloudflare Queues has no per-job status to read; and honouring
  the contract's implicit promise that polling *terminates* becomes work someone has to do,
  because a message that exhausts its retries is deleted with nothing writing `error` (ADR
  0017 requires a dead-letter drain and a reaper for exactly this).
- **Nothing asynchronous is implemented in this phase.** The scaffold registers the tools
  and returns "not implemented in this phase" payloads (spec §Non-Goals); the real job
  runner lands with roadmap phase 1.
- **Cancellation is in the enum but not in the tool set.** There is no `explainer_cancel`
  in the eight tools; `cancelled` exists as a state a server can reach on its own (shutdown,
  timeout, quota). Adding a cancel tool later is a protocol change, and ADR 0007's codegen
  makes that a visible one.
