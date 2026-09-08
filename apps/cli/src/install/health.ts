/**
 * The authenticated `/healthz` poll that turns "registered" into "installed".
 *
 * ADR 0025's note of 2026-09-08 settles what a caller waits on: `Type=notify` is rejected, the unit
 * is `Type=exec`, and "the readiness wait belongs to the caller — an authenticated `GET /healthz`
 * polled with a bounded timeout and a named failure". This module is that wait, for `install`,
 * and it is the reason an install can fail *after* everything has been written and still leave the
 * machine as it found it.
 *
 * **The token is part of the measurement, not around it.** The spike says so in as many words: "a
 * `401` proves a bind and nothing about readiness". The daemon mints the token on its first start
 * — an install never writes one, because the value would then exist in a second place — so this
 * poll waits for the file to appear, reads it, and only then asks. A `401` against our own token is
 * therefore "something is on our port that is not our daemon", which is the same row ADR 0020 gives
 * code `4`, and it is reported rather than retried into a timeout.
 *
 * **The port comes from the daemon, not from the installer.** `runtime.json` is written by
 * `markReady`, after ownership, reconciliation and both binds, and it carries the port that was
 * really bound. Polling the port the artefact *asked* for would answer "yes" to a daemon that fell
 * back to a recorded value, and would answer nothing at all for a future `--port 0`. The record is
 * also required to be **newer than the moment registration began**, so a `runtime.json` an earlier
 * daemon left behind cannot pass this check for a process that never started.
 */

import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { readDaemonState, readRuntimeState } from "../daemon/daemon-state.js";
import { resolveTokenPath, type TokenEnvironment } from "../daemon/token.js";

/** How long `install` waits for the daemon it just registered to answer. */
export const HEALTH_TIMEOUT_MS = 15_000;

/** How often the poll asks again while it waits. */
export const HEALTH_POLL_INTERVAL_MS = 100;

/** One HTTP answer, reduced to what this poll decides on. */
export type HealthResponse = {
  status: number;
  body: string;
};

/** How the poll reaches the daemon. A parameter, so a test can drive it without a network. */
export type HealthTransport = (request: {
  url: string;
  token: string;
  timeoutMs: number;
}) => Promise<HealthResponse>;

/** What the daemon said when it answered. */
export type HealthAnswer = {
  /** The port `runtime.json` recorded, which is the port that was really bound. */
  port: number;
  /** The origin the poll got its `200` from. */
  url: string;
  /** The release the daemon reports. */
  version: string;
  /** The tool contract it advertises. */
  contractVersion: string;
  /** The token file it was read from — a path, never the value. */
  tokenFile: string;
  /** How long the wait took, in milliseconds. */
  elapsedMs: number;
};

/** Why the wait ended without a `200`. One value per distinguishable condition. */
export type HealthFailureReason =
  | "no-runtime-record"
  | "no-token"
  | "unauthorised"
  | "refused"
  | "bad-status";

/** The daemon did not answer, and this says which of the five ways it did not. */
export class HealthTimeout extends Error {
  readonly reason: HealthFailureReason;
  /** The last thing that was observed, so the message names something concrete. */
  readonly detail: string;

  constructor(reason: HealthFailureReason, message: string, detail: string) {
    super(message);
    this.name = "HealthTimeout";
    this.reason = reason;
    this.detail = detail;
  }
}

/** What {@link awaitHealthy} needs. */
export type AwaitHealthyRequest = {
  /** The durable state directory the daemon records into. */
  stateDir: string;
  /** Milliseconds since the epoch before which a `runtime.json` is an earlier daemon's. */
  since: number;
  /** The whole budget. */
  timeoutMs?: number | undefined;
  /** The environment `XPLAINER_TOKEN_FILE` is read from. */
  env?: TokenEnvironment | undefined;
  /** How the poll reaches the daemon. Defaults to a real loopback request. */
  transport?: HealthTransport | undefined;
  /** The clock, for a caller that wants to bound a test rather than sleep through one. */
  now?: (() => number) | undefined;
  /** How long to wait between attempts. */
  intervalMs?: number | undefined;
};

/**
 * Poll until the daemon answers an authenticated `/healthz` with a `200`, or the budget runs out.
 *
 * @throws {HealthTimeout} naming which of the five conditions the budget ended in.
 */
export async function awaitHealthy(request: AwaitHealthyRequest): Promise<HealthAnswer> {
  const now = request.now ?? Date.now;
  const transport = request.transport ?? loopbackGet;
  const intervalMs = request.intervalMs ?? HEALTH_POLL_INTERVAL_MS;
  const budget = request.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const started = now();
  const deadline = started + budget;

  let reason: HealthFailureReason = "no-runtime-record";
  let detail = "no runtime.json newer than the registration has appeared yet";

  for (;;) {
    const attempt = await attemptOnce(request, transport, now() - started);
    if (attempt.ok) {
      return attempt.answer;
    }
    reason = attempt.reason;
    detail = attempt.detail;
    // `unauthorised` is not a state that improves by waiting: the token was read from the file the
    // daemon itself names, so a `401` says the process on that port is not ours (ADR 0020's `4`).
    if (attempt.reason === "unauthorised" || now() >= deadline) {
      break;
    }
    await sleep(intervalMs);
  }

  throw new HealthTimeout(
    reason,
    `the daemon did not answer an authenticated GET /healthz within ${budget} ms: ${detail}`,
    detail,
  );
}

/** One attempt: read what the daemon has recorded, then ask it. */
async function attemptOnce(
  request: AwaitHealthyRequest,
  transport: HealthTransport,
  elapsedMs: number,
): Promise<
  { ok: true; answer: HealthAnswer } | { ok: false; reason: HealthFailureReason; detail: string }
> {
  const runtime = readRuntimeState(request.stateDir);
  const port = typeof runtime?.port === "number" ? runtime.port : null;
  const startedAt = typeof runtime?.started_at === "string" ? Date.parse(runtime.started_at) : NaN;
  if (runtime === null || port === null || !Number.isFinite(startedAt)) {
    return {
      ok: false,
      reason: "no-runtime-record",
      detail: `${request.stateDir}/runtime.json does not yet record a bound port`,
    };
  }
  if (startedAt < request.since) {
    return {
      ok: false,
      reason: "no-runtime-record",
      detail:
        `${request.stateDir}/runtime.json records a daemon that started at ` +
        `${String(runtime.started_at)}, before this registration did — so it is an earlier run's ` +
        "record and not evidence about this one",
    };
  }

  const tokenFile =
    readDaemonState(request.stateDir).token_file ??
    resolveTokenPath(request.stateDir, request.env ?? {});
  const token = readToken(tokenFile);
  if (token === null) {
    return { ok: false, reason: "no-token", detail: `no readable bearer token at ${tokenFile}` };
  }

  const url = `http://127.0.0.1:${String(port)}/healthz`;
  let response: HealthResponse;
  try {
    response = await transport({ url, token, timeoutMs: 2_000 });
  } catch (error) {
    return {
      ok: false,
      reason: "refused",
      detail: `${url} did not answer (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason: "unauthorised",
      detail:
        `${url} answered ${String(response.status)} to the token in ${tokenFile}, so what is ` +
        "listening on that port is not this daemon",
    };
  }
  if (response.status !== 200) {
    return {
      ok: false,
      reason: "bad-status",
      detail: `${url} answered ${String(response.status)}: ${response.body.slice(0, 200)}`,
    };
  }

  const health = parseHealth(response.body);
  if (health === null) {
    return {
      ok: false,
      reason: "bad-status",
      detail: `${url} answered 200 with a body this build cannot read: ${response.body.slice(0, 200)}`,
    };
  }
  return {
    ok: true,
    answer: { port, url, tokenFile, elapsedMs, ...health },
  };
}

/**
 * The statuses a `/healthz` body may carry that mean **this daemon is up and answering**.
 *
 * `degraded` is one of them, and that is a decision rather than a leniency. T19 made `/healthz`
 * report `{"status":"degraded","reason":"toolchain_missing"}` for a machine whose render toolchain
 * is absent — ADR 0020 §Degraded paths requires that condition to be *reported* — and the daemon in
 * that state has taken ownership, reconciled its jobs, bound both listeners and is serving every
 * tool that does not render. Treating it as "nothing answered" would make `daemon start` and
 * `daemon restart` fail on exactly the machine ADR 0005 expects: one where `xplainer setup` has not
 * run yet, and where the next step is to run it rather than to reinstall a daemon that is working.
 * `daemon status --json` is where the condition is surfaced, as its own `degraded` code.
 */
const ANSWERING_STATUSES: readonly string[] = ["ok", "degraded"];

/** The two identity fields `/healthz` carries, or `null` when the body is not one of ours. */
function parseHealth(body: string): { version: string; contractVersion: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.status !== "string" || !ANSWERING_STATUSES.includes(record.status)) {
    return null;
  }
  if (typeof record.version !== "string") {
    return null;
  }
  const contract = record.contract_version;
  return { version: record.version, contractVersion: typeof contract === "string" ? contract : "" };
}

/**
 * The token's value, or `null` for every reason the file is not usable yet.
 *
 * Read here rather than through `daemon/token.ts`, whose `loadOrMintToken` **mints** on absence: an
 * installer that minted the token would put the value on disk in a place the daemon did not choose,
 * and the whole arrangement (R-SEC-5) is that the daemon owns it and the artefact carries only its
 * path. An absent file is the ordinary state of a machine whose daemon has not started yet, so it
 * is a "not ready" answer and never an error.
 */
function readToken(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/**
 * One loopback `GET`, over `node:http`, with no connection pool behind it.
 *
 * Exported because every poll of a local daemon in this package goes through it, and the two
 * reasons are the same reasons: a pooled socket outlives the answer and holds a finished command's
 * process open, and — measured on 2026-09-08 — the platform's own `fetch` **throws where no caller
 * can catch it** when it resumes a pooled socket the daemon has already torn down. Node's bundled
 * undici calls `socket.setTypeOfService()` on every request it writes, `node:net` reports a failed
 * `setsockopt` by throwing synchronously, and undici writes from inside the socket's own event
 * handler — so `EINVAL` there is an *uncaught exception*, not a rejected promise, and a
 * `try`/`catch` around `await fetch(...)` never sees it. That is what ended a whole Vitest worker
 * with "1 error" while every test in it passed, in three runs out of five, moving between whichever
 * file happened to be polling a daemon at the time. `node:http` sets no such option.
 *
 * The token is optional because one caller — `daemon status` — deliberately asks without one, to
 * tell "nothing is listening" apart from "something is listening and it is not ours".
 */
export async function loopbackGet(request: {
  url: string;
  token: string | null;
  timeoutMs: number;
}): Promise<HealthResponse> {
  return await new Promise<HealthResponse>((resolve, reject) => {
    const call = httpRequest(
      request.url,
      {
        method: "GET",
        headers: request.token === null ? {} : { Authorization: `Bearer ${request.token}` },
        // A pooled socket outlives the answer and holds the process open after `install` is done,
        // and it is the socket the platform `fetch` throws on when it resumes one (see above).
        agent: false,
        timeout: request.timeoutMs,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    call.on("timeout", () => {
      call.destroy(new Error(`no answer within ${String(request.timeoutMs)} ms`));
    });
    call.on("error", reject);
    call.end();
  });
}

/** Wait, without holding the event loop open any longer than the wait itself. */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((done) => {
    setTimeout(done, ms);
  });
}
