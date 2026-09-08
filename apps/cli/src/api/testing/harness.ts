/**
 * A real daemon's HTTP surface, on an ephemeral port, for the `/api/*` tests.
 *
 * Everything under test here is about what a client sees on a socket — a status line, a
 * `Content-Range`, an event arriving before the next one — so every test binds the **real**
 * `startServer()` over the **real** `createLocalBackend()` and the **real** job runner, and talks
 * to it over `node:http`. No `vi.mock` anywhere, in keeping with the rest of this package: the
 * workers are `node -e` children (`daemon/testing/fake-worker.ts`), the workspace is a temporary
 * directory, and a job that says `running` is a process that is running.
 *
 * `node:http` rather than `fetch` for the same reason `server.test.ts` gives — `fetch` writes the
 * `Host` header itself and silently drops an override, so a guard test written with it would pass
 * whatever the guard did — and for two the SSE and media tests add: a response must be readable
 * **while it is still open**, and a client must be able to stop reading without closing the socket,
 * which is how "a media body is in flight" is made a fact rather than a hope.
 *
 * This directory is excluded from `tsconfig.build.json`, so nothing here reaches `dist/`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type ClientRequestArgs, type IncomingHttpHeaders, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { RenderBackend } from "@xplainer/mcp-server";
import { stillOutput, videoPaths } from "@xplainer/render-core";
import { createLocalBackend } from "../../backend.js";
import { createLoopbackGuard } from "../../daemon/guard.js";
import { createJobStore } from "../../daemon/job-store.js";
import { createJobRunner, type JobRunner, type WorkerRegistry } from "../../daemon/runner.js";
import { selfIdentity } from "../../daemon/worker-identity.js";
import type { RunningServer } from "../../server.js";
import { startServer } from "../../server.js";
import { recordTestToolchain } from "../../setup/testing/toolchain.js";
import { createWorkspaceLibrary } from "../videos.js";

/** The bearer token a guarded harness mints, known to the test that has to send it. */
export const HARNESS_TOKEN = "api-harness-token";

/** How this harness binds the server under test. */
export type ApiHarnessOptions = {
  /** Which job kinds can run. Omit for a runner that starts nothing. */
  workers?: WorkerRegistry | undefined;
  /** The SSE poll interval. Short, so a test is not a sleep. */
  pollIntervalMs?: number | undefined;
  /** How long an SSE stream may be silent before its keep-alive comment. */
  heartbeatMs?: number | undefined;
  /** Mount the loopback guard on the TCP listener, as `serve` does. */
  guard?: boolean | undefined;
  /** Bind the IPC socket as well, so a test can send a request the guard never sees. */
  ipc?: boolean | undefined;
  /** Bind without the `/api/*` surface at all, to prove it is optional. */
  withoutApi?: boolean | undefined;
};

/** What a test drives. */
export type ApiHarness = {
  server: RunningServer;
  /** The workspace root the backend and the library both read. */
  root: string;
  stateDir: string;
  backend: RenderBackend;
  runner: JobRunner;
  /** The IPC socket path, when one was asked for. */
  socketPath: string | null;
};

const scratch: string[] = [];
const bound: RunningServer[] = [];
const runners: JobRunner[] = [];

/** A temporary directory that {@link stopHarnesses} removes. */
export function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

/** Bind one server, with a real backend over a temporary workspace. */
export async function startApiHarness(options: ApiHarnessOptions = {}): Promise<ApiHarness> {
  const root = temporaryDirectory("xplainer-api-workspace-");
  const stateDir = temporaryDirectory("xplainer-api-state-");
  const store = createJobStore(stateDir);
  const runner = createJobRunner({
    store,
    owner: { ...selfIdentity(), run_id: "api-harness" },
    ...(options.workers === undefined ? {} : { workers: options.workers }),
    logFlushIntervalMs: 25,
    killGraceMs: 200,
  });
  runners.push(runner);
  const backend = createLocalBackend({ runner, root, stateDir });
  const socketPath =
    options.ipc === true ? join(temporaryDirectory("xplainer-api-ipc-"), "x.sock") : null;

  const server = await startServer({
    backend,
    port: 0,
    ...(socketPath === null ? {} : { ipc: { path: socketPath } }),
    ...(options.guard === true
      ? { guard: (port: number) => createLoopbackGuard({ token: HARNESS_TOKEN, port: () => port }) }
      : {}),
    ...(options.withoutApi === true
      ? {}
      : {
          api: {
            library: createWorkspaceLibrary({ root }),
            ...(options.pollIntervalMs === undefined
              ? {}
              : { pollIntervalMs: options.pollIntervalMs }),
            ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
          },
        }),
  });
  bound.push(server);

  return { server, root, stateDir, backend, runner, socketPath };
}

/** Close every server and runner this file started, and remove every directory it made. */
export async function stopHarnesses(): Promise<void> {
  for (const server of bound.splice(0)) {
    await server.close();
  }
  // Drain before the directories go: a runner with a job still queued would otherwise start it
  // after the test ended and write a record into a directory that no longer exists.
  for (const runner of runners.splice(0)) {
    await runner.drain(0);
  }
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Where a request is sent: a port, or the socket the IPC listener bound. */
export type Endpoint = { port: number } | { socketPath: string };

/** One buffered answer. */
export type HttpAnswer = {
  status: number;
  headers: IncomingHttpHeaders;
  /** The body decoded as UTF-8, for the JSON routes. */
  body: string;
  /** The body as it arrived, for the routes that serve bytes. */
  bytes: Buffer;
};

/** How one request is made. */
export type RequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

function target(endpoint: Endpoint, path: string, options: RequestOptions): ClientRequestArgs {
  const headers = options.headers ?? {};
  const method = options.method ?? "GET";
  return "port" in endpoint
    ? { host: "127.0.0.1", port: endpoint.port, path, method, headers }
    : {
        socketPath: endpoint.socketPath,
        path,
        method,
        headers: { host: "xplainer.ipc", ...headers },
      };
}

/** Send one request and read the whole answer. */
export function send(
  endpoint: Endpoint,
  path: string,
  options: RequestOptions = {},
): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const call = request(target(endpoint, path, options), (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: bytes.toString("utf8"),
          bytes,
        });
      });
    });
    call.on("error", reject);
    call.end(options.body);
  });
}

/** The token every guarded request carries. */
export function authorized(): Record<string, string> {
  return { Authorization: `Bearer ${HARNESS_TOKEN}` };
}

/** One `text/event-stream` frame, as a client reassembles it. */
export type SseFrame = {
  event: string;
  data: string;
  id: string | null;
};

/** A stream a test reads while it is still open. */
export type SseClient = {
  status: number;
  headers: IncomingHttpHeaders;
  /** Every frame seen so far, in order. */
  frames: SseFrame[];
  /** Comment lines, which carry no event and are what a heartbeat is. */
  comments: string[];
  /** Resolve once a frame with this name has arrived (or immediately, if one already has). */
  waitFor(event: string): Promise<SseFrame>;
  /** Resolves when the server closes the stream. */
  ended: Promise<void>;
  /** Whether the server has closed it. */
  isEnded(): boolean;
  /** Hang up from this end. */
  close(): void;
};

/** Open an SSE stream and parse it as the frames arrive. */
export function openSse(
  endpoint: Endpoint,
  path: string,
  options: RequestOptions = {},
): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const call = request(
      target(endpoint, path, {
        ...options,
        headers: { accept: "text/event-stream", ...options.headers },
      }),
      (response) => {
        const frames: SseFrame[] = [];
        const comments: string[] = [];
        const waiters: { event: string; resolve: (frame: SseFrame) => void }[] = [];
        let buffer = "";
        let done = false;
        let finish: () => void = () => {};
        const ended = new Promise<void>((resolveEnded) => {
          finish = resolveEnded;
        });

        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          buffer += chunk;
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const frame = parseFrame(block);
            if (frame === null) {
              comments.push(block);
            } else {
              frames.push(frame);
              for (let index = waiters.length - 1; index >= 0; index -= 1) {
                const waiter = waiters[index];
                if (waiter !== undefined && waiter.event === frame.event) {
                  waiters.splice(index, 1);
                  waiter.resolve(frame);
                }
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
        });
        response.on("end", () => {
          done = true;
          finish();
        });
        response.on("close", () => {
          done = true;
          finish();
        });

        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          frames,
          comments,
          waitFor: (event: string) =>
            new Promise<SseFrame>((resolveFrame) => {
              const seen = frames.find((frame) => frame.event === event);
              if (seen !== undefined) {
                resolveFrame(seen);
                return;
              }
              waiters.push({ event, resolve: resolveFrame });
            }),
          ended,
          isEnded: () => done,
          close: () => {
            call.destroy();
          },
        });
      },
    );
    call.on("error", reject);
    call.end(options.body);
  });
}

/** `event:`/`data:`/`id:` out of one block, or `null` when the block is a comment. */
function parseFrame(block: string): SseFrame | null {
  const data: string[] = [];
  let event = "message";
  let id: string | null = null;
  let sawField = false;
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) {
      continue;
    }
    sawField = true;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    } else if (field === "id") {
      id = value;
    }
  }
  return sawField ? { event, data: data.join("\n"), id } : null;
}

/** A response whose body is read only far enough to prove it started, and then left in flight. */
export type HeldBody = {
  status: number;
  headers: IncomingHttpHeaders;
  /** Bytes the client has actually taken off the socket. */
  received(): number;
  /** Whether the server sent the whole body and ended it cleanly. */
  isComplete(): boolean;
  /** Resolves once at least `bytes` have arrived — proof the transfer is under way. */
  waitForBytes(bytes: number): Promise<void>;
  /**
   * Start reading again and resolve when the response ends, one way or the other.
   *
   * A paused socket is not polled for readability, so a client that has stopped reading does not
   * *learn* that the far end went away until it reads again — which is why this is a method and not
   * a promise that resolves on its own. It is also what a player does: it comes back for more of
   * the file and finds the connection gone.
   */
  finish(): Promise<void>;
  close(): void;
};

/** How much of the body is read before it is left hanging. */
export type HeldBodyOptions = RequestOptions & {
  /** Pause once this many bytes have arrived. Defaults to the first chunk. */
  pauseAfter?: number;
};

/**
 * Send a request, read the first few kilobytes of the body, and then stop reading.
 *
 * This is how "a media response in flight" is made a fact rather than a hope. A response with no
 * listener at all has merely never been consumed; one that has delivered bytes and then stopped
 * being read is a transfer the daemon has actually begun and is now blocked on — which is the state
 * a player scrubbing a large MP4 leaves a connection in, and the state the drain has to survive.
 */
export function openBody(
  endpoint: Endpoint,
  path: string,
  options: HeldBodyOptions = {},
): Promise<HeldBody> {
  const pauseAfter = options.pauseAfter ?? 1;
  return new Promise((resolve, reject) => {
    const call = request(target(endpoint, path, options), (response) => {
      let complete = false;
      let received = 0;
      let settled = false;
      // Whether the body is still being held back. `finish()` clears it, or the handler below would
      // pause the response again on the first chunk of every resume.
      let holding = true;
      let announce: () => void = () => {};
      const enough = new Promise<void>((resolveEnough) => {
        announce = resolveEnough;
      });

      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (holding && received >= pauseAfter) {
          // `pause()` in flowing mode stops the `data` events and leaves the rest of the body on
          // the socket, where the server is waiting to write more of it.
          response.pause();
          announce();
        }
      });
      response.on("end", () => {
        complete = true;
        settled = true;
        announce();
      });
      const settle = (): void => {
        settled = true;
        announce();
      };
      response.on("close", settle);
      response.on("aborted", settle);
      // Without a listener a socket error on a response is an unhandled `error` event.
      response.on("error", settle);

      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        received: () => received,
        isComplete: () => complete,
        waitForBytes: async (bytes: number) => {
          while (received < bytes && !settled) {
            await enough;
            if (received < bytes && !settled) {
              response.resume();
              await new Promise<void>((tick) => {
                setTimeout(tick, 5);
              });
            }
          }
        },
        finish: () =>
          new Promise<void>((resolveFinish) => {
            holding = false;
            if (settled) {
              resolveFinish();
              return;
            }
            response.on("end", resolveFinish);
            response.on("close", resolveFinish);
            response.on("aborted", resolveFinish);
            response.on("error", resolveFinish);
            response.resume();
          }),
        close: () => {
          call.destroy();
        },
      });
    });
    call.on("error", reject);
    call.end(options.body);
  });
}

/**
 * A machine where `xplainer setup` has run, so `explainer_still` and `explainer_render` get past
 * their toolchain gate.
 *
 * The same two halves `backend.test.ts` stands up — a Remotion shim in the workspace and the real
 * marker, written by the real writer — because the two render tools ask `checkToolchain` the same
 * question the worker factory asks a moment later.
 */
export function pretendInstalled(harness: ApiHarness): void {
  const bin = join(harness.root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, process.platform === "win32" ? "remotion.cmd" : "remotion"),
    "#!/bin/sh\n",
  );
  recordTestToolchain({ stateDir: harness.stateDir, workspaceRoot: harness.root });
}

/** A narrated video, without running a narration: `timings.json`, the captions and the audio. */
export function pretendNarrated(harness: ApiHarness, slug: string): void {
  const video = videoPaths(harness.root, slug);
  mkdirSync(video.publicDir, { recursive: true });
  writeFileSync(
    video.timings,
    `${JSON.stringify({
      fps: 30,
      durationInFrames: 60,
      totalMs: 2000,
      audio: "narration.wav",
      segments: [],
    })}\n`,
  );
  writeFileSync(video.captions, JSON.stringify([{ text: "hi", startMs: 0, endMs: 100 }]));
  writeFileSync(video.audio, Buffer.alloc(64, 7));
}

/** Put an MP4 of a known size where a render would have left one, and answer with its path. */
export function writeRenderedMp4(harness: ApiHarness, slug: string, bytes: number): string {
  const video = videoPaths(harness.root, slug);
  mkdirSync(video.out, { recursive: true });
  // A recognisable pattern with a prime period, so a `Range` test can assert it got *those* bytes
  // and not merely the right number of them: byte `i` is `i % 251` however large the file is.
  const period = Buffer.alloc(251);
  for (let index = 0; index < period.length; index += 1) {
    period[index] = index;
  }
  writeFileSync(video.mp4, Buffer.alloc(bytes, period));
  return video.mp4;
}

/** Put a still where a layout check would have left one. */
export function writeStill(harness: ApiHarness, slug: string, frame: number, bytes = 32): string {
  const video = videoPaths(harness.root, slug);
  mkdirSync(video.out, { recursive: true });
  const path = stillOutput(video, frame);
  writeFileSync(path, Buffer.alloc(bytes, frame % 251));
  return path;
}
