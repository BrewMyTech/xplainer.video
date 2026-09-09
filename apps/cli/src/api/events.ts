/**
 * `GET /jobs/:id/events` — one job's progress, as `text/event-stream`.
 *
 * **This does not change what a job is.** ADR 0008 chose polling over webhooks and
 * [ADR 0008](../../../../docs/adr/0008-async-job-model-poll-and-progress-no-agent-webhooks.md)
 * §"polling `explainer_job` is the contract" applies to agents, not to a window with a progress
 * bar: an agent polls, and a GUI that polled four times a second would spend its life re-asking a
 * question the daemon could have answered once. So the stream carries **the poll's own document** —
 * every `job` event is an `ExplainerJobOutput`, byte for byte what `GET /jobs/:id` would answer at
 * that moment — and a client that loses the stream has lost nothing it cannot get by asking again.
 *
 * **Why it polls the runner rather than subscribing to it.** `JobRunner` publishes no events: it is
 * five operations over a durable store (`daemon/runner.ts`), and `get()` is a read of an in-memory
 * record with no filesystem work behind it. Polling it here costs a JSON stringify per interval and
 * keeps the daemon's job machinery free of a listener registry whose lifetime would have to be
 * managed across a drain. The interval is a parameter so the test suite can run at 20 ms and the
 * daemon at {@link DEFAULT_JOB_POLL_INTERVAL_MS}.
 *
 * **An event is written only when something changed**, so an idle render is silent; a comment line
 * every {@link DEFAULT_HEARTBEAT_MS} keeps the connection provably alive through that silence. It
 * is a comment rather than an event so that a client reading events sees nothing it has to filter.
 *
 * **The stream ends by itself.** A terminal job gets one last `job` event, then an `end` event, then
 * the stream closes — a client watching a render does not have to decide when to stop listening,
 * and the daemon does not accumulate streams over jobs that finished hours ago. If the client goes
 * away first, `stream.aborted` says so within one interval and the loop stops.
 *
 * A job this daemon has no record of is a `404` **before** the stream opens, rather than a stream
 * whose first event is an error: an `EventSource` would reconnect to it for ever.
 */

import type { RenderBackend } from "@xplainer/mcp-server";
import type { ExplainerJobOutput, JobState } from "@xplainer/protocol";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { refusal, refusalFor, sendRefusal } from "./errors.js";
import { parseJobId } from "./jobs.js";

/** How often an open stream re-reads its job when nothing has told it to. */
export const DEFAULT_JOB_POLL_INTERVAL_MS = 250;

/** How long a stream may say nothing before it writes a comment line to prove it is still there. */
export const DEFAULT_HEARTBEAT_MS = 15_000;

/** How long a client should wait before reconnecting, sent once as the stream's `retry` field. */
export const RECONNECT_DELAY_MS = 1_000;

/** The event name every snapshot carries. */
export const JOB_EVENT = "job";

/** The event name the last frame carries, immediately before the stream closes. */
export const END_EVENT = "end";

/** What the last frame says: which job ended, and how. */
export type JobStreamEnd = {
  job_id: number;
  status: JobState;
};

/** The three states after which nothing more will happen to a job. */
function isTerminal(status: JobState): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

/** What the event route needs. */
export type JobEventRouteDependencies = {
  backend: RenderBackend;
  /** Defaults to {@link DEFAULT_JOB_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number | undefined;
  /** Defaults to {@link DEFAULT_HEARTBEAT_MS}. */
  heartbeatMs?: number | undefined;
};

/** Mount `GET /jobs/:id/events` on a router already prefixed with `/api`. */
export function registerJobEventRoutes(app: Hono, dependencies: JobEventRouteDependencies): void {
  const { backend } = dependencies;
  const interval = dependencies.pollIntervalMs ?? DEFAULT_JOB_POLL_INTERVAL_MS;
  const heartbeat = dependencies.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  app.get("/jobs/:id/events", async (c) => {
    const jobId = parseJobId(c.req.param("id"));
    if (jobId === null) {
      return sendRefusal(
        c,
        refusal(400, "INVALID_JOB_ID", `${JSON.stringify(c.req.param("id"))} is not a job id.`),
      );
    }

    // The first read happens here, outside the stream, so "no such job" is still an HTTP status.
    let snapshot: ExplainerJobOutput;
    try {
      snapshot = await backend.explainer_job({ job_id: jobId });
    } catch (error) {
      return sendRefusal(c, refusalFor(error));
    }

    return streamSSE(c, async (stream) => {
      let sent = JSON.stringify(snapshot);
      let sequence = 0;
      await stream.writeSSE({
        event: JOB_EVENT,
        data: sent,
        id: String(sequence),
        retry: RECONNECT_DELAY_MS,
      });
      let quietSince = Date.now();
      let status = snapshot.status;

      while (!isTerminal(status) && !stream.aborted && !stream.closed) {
        await stream.sleep(interval);
        if (stream.aborted || stream.closed) {
          break;
        }
        let current: ExplainerJobOutput;
        try {
          current = await backend.explainer_job({ job_id: jobId });
        } catch {
          // The job was there a moment ago. A backend that can no longer answer for it — a store
          // that went away, a daemon mid-drain — ends the stream rather than looping on the error.
          break;
        }
        status = current.status;
        const encoded = JSON.stringify(current);
        if (encoded !== sent) {
          sent = encoded;
          sequence += 1;
          await stream.writeSSE({ event: JOB_EVENT, data: encoded, id: String(sequence) });
          quietSince = Date.now();
          continue;
        }
        if (Date.now() - quietSince >= heartbeat) {
          // An SSE comment: two colons of traffic that keep the socket demonstrably open without
          // adding an event a client has to know about.
          await stream.write(": still running\n\n");
          quietSince = Date.now();
        }
      }

      if (!stream.aborted && !stream.closed) {
        const ended: JobStreamEnd = { job_id: jobId, status };
        await stream.writeSSE({ event: END_EVENT, data: JSON.stringify(ended) });
      }
    });
  });
}
