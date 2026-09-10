/**
 * The mapping from a rejection to a status line, and the three names it depends on.
 *
 * `errors.ts` matches `JobNotFoundError`, `NotAcceptingJobsError` and `LocalBackendError` by their
 * `name`, because a value import of the first two would drag `src/daemon/` into the application
 * the hosted media service (relocated to a private repository, ADR 0023) binds. That is a
 * deliberate coupling to a string, and this file is where
 * it is checked: the **real** classes are constructed here — a test file may import anything — and
 * asserted to still carry the names the router branches on. Rename one and this fails, rather than
 * the desktop quietly receiving a `500` where it expected a `404`.
 */

import { describe, expect, it } from "vitest";
import { type LocalBackendCode, LocalBackendError } from "../backend.js";
import { JobNotFoundError, NotAcceptingJobsError } from "../daemon/runner.js";
import {
  JOB_NOT_FOUND_ERROR_NAME,
  LOCAL_BACKEND_ERROR_NAME,
  NOT_ACCEPTING_JOBS_ERROR_NAME,
  refusalFor,
} from "./errors.js";

/**
 * Every refusal `backend.ts` can raise, and the status this surface answers with.
 *
 * Written out rather than derived from the mapping under test: a table that reads itself proves
 * nothing. `LocalBackendCode` is exhaustive at compile time — a `Record` over it — so a refusal
 * added to `backend.ts` fails to compile here as well as in `errors.ts`.
 */
const EXPECTED: Record<LocalBackendCode, number> = {
  INVALID_SLUG: 400,
  INVALID_SOURCE_PATH: 400,
  INVALID_MEDIA_NAME: 400,
  INVALID_MEDIA_PAYLOAD: 400,
  INVALID_STILL_ARGUMENT: 400,
  NO_SEGMENTS: 400,
  ENGINE_OWNED_PATH: 403,
  NO_SUCH_VIDEO: 404,
  NARRATION_MISSING: 409,
  WORKSPACE_NOT_INSTALLED: 503,
};

describe("the error names the router branches on", () => {
  it("are the names the real classes carry", () => {
    expect(new JobNotFoundError(7).name).toBe(JOB_NOT_FOUND_ERROR_NAME);
    expect(new NotAcceptingJobsError().name).toBe(NOT_ACCEPTING_JOBS_ERROR_NAME);
    expect(new LocalBackendError("NO_SUCH_VIDEO", "no such video").name).toBe(
      LOCAL_BACKEND_ERROR_NAME,
    );
  });
});

describe("refusalFor", () => {
  it("answers 404 NO_SUCH_JOB for a job this daemon has no record of", () => {
    const refused = refusalFor(new JobNotFoundError(7));

    expect(refused.status).toBe(404);
    expect(refused.body.error.code).toBe("NO_SUCH_JOB");
    expect(refused.body.error.message).toContain("7");
  });

  it("answers 503 SHUTTING_DOWN while the daemon is draining", () => {
    const refused = refusalFor(new NotAcceptingJobsError());

    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe("SHUTTING_DOWN");
  });

  it("gives every backend refusal the status this surface promised it", () => {
    for (const [code, status] of Object.entries(EXPECTED)) {
      const refused = refusalFor(
        new LocalBackendError(code as LocalBackendCode, `${code} refused`),
      );

      expect([code, refused.status]).toEqual([code, status]);
      expect(refused.body.error.code).toBe(code);
      expect(refused.body.error.message).toBe(`${code} refused`);
    }
  });

  it("answers 500 BACKEND_FAILED for anything it does not recognise, keeping the message", () => {
    const refused = refusalFor(new Error("the renderer fell over"));

    expect(refused.status).toBe(500);
    expect(refused.body.error.code).toBe("BACKEND_FAILED");
    expect(refused.body.error.message).toBe("the renderer fell over");
  });

  it("does not trust a code it was never told about", () => {
    const impostor = new LocalBackendError("NO_SUCH_VIDEO", "spoofed");
    (impostor as unknown as { code: string }).code = "TEAPOT";

    expect(refusalFor(impostor).status).toBe(500);
  });
});
