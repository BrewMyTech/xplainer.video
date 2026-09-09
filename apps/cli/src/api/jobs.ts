/**
 * Reading a job, and the three calls that make one.
 *
 * `GET /jobs/:id` answers with `ExplainerJobOutput` **unchanged** — the same document
 * `explainer_job` returns to an agent, field for field. That is the point of it: ADR 0008 settled
 * that progress is polled rather than pushed and that the poll's shape is the contract's, so the
 * window and the agent watching the same render see one description of it rather than two that
 * have to be reconciled when they disagree.
 *
 * The three `POST`s are the same relay in the other direction. The route takes the slug from the
 * **path** and passes the rest of the body through untouched, exactly as `createMcpServer()` passes
 * an agent's arguments through: this phase publishes an open input schema, nothing between a caller
 * and `backend.ts` validates a field, and `backend.ts` is where every refusal is decided. A route
 * that re-validated here would be a second opinion about the contract, and the two would drift.
 *
 * They answer `202`, not `200`. The work has been accepted and has not been done; the body carries
 * the `job_id` and both routes that report on it, so a client never has to build a URL out of an
 * identifier by hand.
 */

import type { RenderBackend } from "@xplainer/mcp-server";
import type { JobState, JobType } from "@xplainer/protocol";
import type { Hono } from "hono";
import { refusal, refusalFor, sendRefusal } from "./errors.js";
import { jobEventsPath, jobPath } from "./paths.js";
import { isVideoSlug } from "./videos.js";

/**
 * The acknowledgement the three enqueueing routes answer with.
 *
 * The first four fields are the tool's own output — `explainer_narrate`, `explainer_still` and
 * `explainer_render` share it — and the last two are what an HTTP client needs and an agent does
 * not: `poll` names the *tool call* that reports progress, which is the right answer for something
 * holding an MCP session and useless to something holding a socket.
 */
export type ApiJobQueued = {
  job_id: number;
  status: JobState;
  /** One line describing the queued work. */
  what: string;
  /** The exact tool call that reports progress, for a client that also speaks MCP. */
  poll: string;
  /** `GET` this for one snapshot. */
  job: string;
  /** `GET` this for the stream of them. */
  events: string;
};

/** Which of the three long-running tools a route queues. */
type EnqueueVerb = "narrate" | "still" | "render";

/**
 * The verb in the path, and the tool it queues.
 *
 * The tool half is typed `JobType` — the protocol's own name for "a tool that makes a job" — so
 * this table cannot name `explainer_list` or drift to four rows without the contract saying so.
 */
const ENQUEUE_TOOLS: readonly (readonly [EnqueueVerb, JobType])[] = [
  ["narrate", "explainer_narrate"],
  ["still", "explainer_still"],
  ["render", "explainer_render"],
];

/** The tool behind each verb, erased to one signature — the dispatch `createMcpServer()` also does. */
type EnqueueTool = (input: Record<string, unknown>) => Promise<{
  job_id: number;
  status: JobState;
  what: string;
  poll: string;
}>;

/** A job id is a whole positive number and nothing else — not `1.5`, not `0x10`, not `+1`. */
const JOB_ID_PATTERN = /^[1-9]\d*$/;

/** The path parameter as a job id, or `null` when it is not one. */
export function parseJobId(raw: string): number | null {
  return JOB_ID_PATTERN.test(raw) ? Number.parseInt(raw, 10) : null;
}

/**
 * The request body as a plain object.
 *
 * An empty body is `{}` — `POST …/render` takes no arguments and a client should not have to send
 * `{}` to say so — and anything that is not a JSON object is refused rather than coerced, because
 * `[1,2]` spread into a tool input produces a call nobody wrote.
 */
function readBody(text: string): Record<string, unknown> | null {
  if (text.trim() === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/** What the job routes need. */
export type JobRouteDependencies = {
  backend: RenderBackend;
};

/** Mount `GET /jobs/:id` and the three `POST /videos/:slug/{narrate,still,render}` routes. */
export function registerJobRoutes(app: Hono, dependencies: JobRouteDependencies): void {
  const { backend } = dependencies;

  app.get("/jobs/:id", async (c) => {
    const jobId = parseJobId(c.req.param("id"));
    if (jobId === null) {
      return sendRefusal(
        c,
        refusal(400, "INVALID_JOB_ID", `${JSON.stringify(c.req.param("id"))} is not a job id.`),
      );
    }
    try {
      return c.json(await backend.explainer_job({ job_id: jobId }));
    } catch (error) {
      return sendRefusal(c, refusalFor(error));
    }
  });

  for (const [verb, method] of ENQUEUE_TOOLS) {
    app.post(`/videos/:slug/${verb}`, async (c) => {
      const slug = c.req.param("slug");
      if (!isVideoSlug(slug)) {
        return sendRefusal(
          c,
          refusal(400, "INVALID_SLUG", `${JSON.stringify(slug)} is not a slug.`),
        );
      }
      const body = readBody(await c.req.text());
      if (body === null) {
        return sendRefusal(
          c,
          refusal(400, "INVALID_BODY", "the body of this request is not a JSON object."),
        );
      }
      // The slug comes last on purpose: the path is what this request is about, and a body naming a
      // different video must not quietly queue a render of that one instead.
      const input = { ...body, slug };
      const tool = backend[method] as unknown as EnqueueTool;
      try {
        const queued = await tool(input);
        const answer: ApiJobQueued = {
          ...queued,
          job: jobPath(queued.job_id),
          events: jobEventsPath(queued.job_id),
        };
        return c.json(answer, 202);
      } catch (error) {
        return sendRefusal(c, refusalFor(error));
      }
    });
  }
}
