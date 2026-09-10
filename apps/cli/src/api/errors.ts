/**
 * One refusal shape for the whole `/api` surface, and the mapping that produces it.
 *
 * The desktop is the only client of these routes and it has to branch on failures without reading
 * prose, so every refusal is `{ error: { code, message } }` — `code` for the branch, `message` for
 * what the window shows. It is the same division `@xplainer/protocol`'s job records already make
 * between `error_code` and `error`, kept deliberately identical so a client does not learn two
 * conventions.
 *
 * **Why the three error classes are matched by `name` and not by `instanceof`.** `server.ts` is the
 * application the hosted media service (relocated to a private repository, ADR 0023) binds in its
 * container, and `apps/cli/AGENTS.md` §Public
 * surface states the boundary that makes that safe: "`services/media-service` imports
 * `createServer()` and nothing below it", `src/daemon/` being the local runtime's own machinery. A
 * value import of `JobNotFoundError` or `NotAcceptingJobsError` here would put `daemon/runner.ts` —
 * and the job store, the process-group keeper and the identity probe under it — into the module
 * graph of every process that binds the app, including one that has no daemon at all. `name` is not
 * a guess about those classes either: each constructor assigns it explicitly, and
 * `api/errors.test.ts` constructs the real errors and asserts these constants still match them, so
 * a rename fails a test here rather than silently turning a `404` into a `500` in the desktop.
 *
 * `LocalBackendCode` is imported as a **type**, which `verbatimModuleSyntax` erases: the mapping
 * below is exhaustive by construction — add a refusal to `backend.ts` and this file stops compiling
 * until it has an HTTP answer — without `backend.ts` itself being loaded by the hosted image.
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { LocalBackendCode } from "../backend.js";

/** `LocalBackendError.name`, as its constructor sets it. Pinned by `api/errors.test.ts`. */
export const LOCAL_BACKEND_ERROR_NAME = "LocalBackendError";

/** `JobNotFoundError.name`, as `daemon/runner.ts` sets it. Pinned by `api/errors.test.ts`. */
export const JOB_NOT_FOUND_ERROR_NAME = "JobNotFoundError";

/** `NotAcceptingJobsError.name`, as `daemon/runner.ts` sets it. Pinned by `api/errors.test.ts`. */
export const NOT_ACCEPTING_JOBS_ERROR_NAME = "NotAcceptingJobsError";

/**
 * Which class of failure a client is looking at.
 *
 * The backend's own refusal codes pass through unchanged — a client that already understands
 * `NO_SUCH_VIDEO` from a tool error reads the same word here — and the **seven** below them are the
 * ones only an HTTP route can produce. `BACKEND_FAILED` is the last of the seven and the only one
 * that is not a statement about the request: it is what a backend rejection that named no code of
 * its own becomes, so that every refusal on this surface still carries one.
 */
export type ApiErrorCode =
  | LocalBackendCode
  /** The `:id` in the path is not a job number. */
  | "INVALID_JOB_ID"
  /** No job with that id: this daemon has no record of it. */
  | "NO_SUCH_JOB"
  /** No such artefact for that video, or the file has since been removed. */
  | "NO_SUCH_ARTEFACT"
  /** The request body is not the JSON object the route takes. */
  | "INVALID_BODY"
  /** The daemon is draining and takes no more work (ADR 0024 §Drain on planned restart, step 1). */
  | "SHUTTING_DOWN"
  /** The `Range` asked for bytes this artefact does not have. */
  | "RANGE_NOT_SATISFIABLE"
  /** The backend failed for a reason it did not name. */
  | "BACKEND_FAILED";

/** What every refused request on this surface answers with. */
export type ApiErrorBody = {
  error: {
    /** Branch on this. */
    code: ApiErrorCode;
    /** Show this. */
    message: string;
  };
};

/** A refusal, ready to be written: the status line and the body that explains it. */
export type ApiRefusal = {
  status: ContentfulStatusCode;
  body: ApiErrorBody;
};

/**
 * The HTTP answer for each refusal `backend.ts` can raise.
 *
 * Written as a total record over `LocalBackendCode` rather than a `switch` with a default, because
 * the default is what would let a new refusal ship as an unconsidered `500`.
 */
const STATUS_BY_BACKEND_CODE: Record<LocalBackendCode, ContentfulStatusCode> = {
  // The caller sent something the contract does not allow.
  INVALID_SLUG: 400,
  INVALID_SOURCE_PATH: 400,
  INVALID_MEDIA_NAME: 400,
  INVALID_MEDIA_PAYLOAD: 400,
  INVALID_STILL_ARGUMENT: 400,
  NO_SEGMENTS: 400,
  // The caller may not do this at all (ADR 0018: the engine owns those five files).
  ENGINE_OWNED_PATH: 403,
  // There is no such thing here.
  NO_SUCH_VIDEO: 404,
  // There is, but it is not in a state where this call makes sense yet.
  NARRATION_MISSING: 409,
  // This machine cannot do the work until `xplainer setup` has run.
  WORKSPACE_NOT_INSTALLED: 503,
};

/** Build the body a refused route answers with. */
export function apiError(code: ApiErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } };
}

/** The refusal for a named API-level condition, with the status this file decides. */
export function refusal(
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  message: string,
): ApiRefusal {
  return { status, body: apiError(code, message) };
}

/**
 * Turn whatever a backend rejected with into the answer this surface gives.
 *
 * An unrecognised rejection is a `500` carrying its message rather than a swallowed one: these
 * routes are reachable only from this machine, behind the bearer token, and a desktop showing "the
 * daemon failed" with nothing else is a support request nobody can answer. What must not leak — a
 * host path, the render topology — is already the backend's own concern, and the same message
 * reaches an agent through the MCP tool error today.
 */
export function refusalFor(error: unknown): ApiRefusal {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";

  if (name === JOB_NOT_FOUND_ERROR_NAME) {
    return refusal(404, "NO_SUCH_JOB", message);
  }
  if (name === NOT_ACCEPTING_JOBS_ERROR_NAME) {
    return refusal(503, "SHUTTING_DOWN", message);
  }
  if (name === LOCAL_BACKEND_ERROR_NAME) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code in STATUS_BY_BACKEND_CODE) {
      const backendCode = code as LocalBackendCode;
      return refusal(STATUS_BY_BACKEND_CODE[backendCode], backendCode, message);
    }
  }
  return refusal(500, "BACKEND_FAILED", message);
}

/**
 * Write one refusal, so a route reads as "refuse with this" in one line.
 *
 * Hono's `c.json()` is what serialises it, which is what puts `content-type: application/json` on
 * a refusal as well as on an answer — a client that parses one path and not the other is a bug this
 * removes the opportunity for.
 */
export function sendRefusal(c: Context, refused: ApiRefusal): Response {
  return c.json(refused.body, refused.status);
}
