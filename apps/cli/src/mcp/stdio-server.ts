/**
 * `xplainer mcp` with no daemon behind it: the whole runtime in one stdio process.
 *
 * This is the entry the **plugin bundles** point at — `npx -y xplainer mcp` in a
 * `.mcp.json` or a Codex `command`/`args` pair — and the one an agent gets on a machine where
 * nothing has been installed and no `serve` is running. It is the MCP specification's own
 * first-choice mitigation, quoted in
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §The agent path is IPC, not
 * TCP: "Use the `stdio` transport to limit access to just the MCP client". There is no port, no
 * socket, no token and no listener of any kind — the client is the parent process and nothing else
 * can reach it.
 *
 * **What it shares with the daemon, and what it does not.** It shares the *workspace*: the same
 * `XPLAINER_VIDEOS_DIR`-or-`<state dir>/workspace` root, so a video created here is a video
 * `explainer_list` reports under a daemon later, and the videos are the artefact that matters. It
 * does **not** share the daemon's **job store**. Each session gets a private directory under
 * `<state dir>/mcp/`, because a job store is a single-writer structure — `job_id`s are allocated by
 * looking at what is on disk, and two processes doing that against one directory hand out the same
 * number twice ([ADR 0024](../../../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md)
 * §Exclusive ownership is the daemon's answer to exactly this, and this process deliberately does
 * not take that lock: a `mcp` that refused to start because a daemon was running would defeat the
 * point of the bundle path).
 *
 * The consequence is worth stating rather than discovering: **a `job_id` from this process means
 * nothing to a daemon, and vice versa.** Poll the `job_id` you were given, through the connection
 * you were given it on. `xplainer mcp --attach` is the entry that shares the daemon's store, and it
 * is what `xplainer connect` writes when a daemon is installed.
 *
 * **The workspace it shares is shared with writers it cannot see, and that is what the video lock
 * is for.** Not taking `owner.lock` means a daemon and any number of these sessions can hold one
 * root at once, so `daemon/workers.ts` takes `<workspace>/locks/<slug>.lock` before it spawns
 * anything — one writer per video, across processes, released when the job ends
 * (`daemon/video-lock.ts`, ADR 0024 §Note, 2026-09-07). A session that asks for a video another
 * process is writing gets that *job* failed with a message saying to retry; it is never refused a
 * start, because being startable next to a daemon is the whole point of this entry.
 *
 * The session directory is removed when the session ends, after the runner has drained. A directory
 * per agent session that never went away would accumulate one per Claude Code window, for ever.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "@xplainer/mcp-server";
import { createLocalBackend } from "../backend.js";
import { createJobStore } from "../daemon/job-store.js";
import { createJobRunner } from "../daemon/runner.js";
import { resolveStateDir, STATE_DIR_MODE } from "../daemon/state-dir.js";
import { selfIdentity } from "../daemon/worker-identity.js";
import { createWorkerRegistry } from "../daemon/workers.js";
import { CLI_VERSION } from "../version.js";
import { resolveWorkspaceRoot } from "../workspace-root.js";

/** The directory under the state directory that holds one subdirectory per stdio session. */
export const MCP_SESSIONS_DIR = "mcp";

/** How long the session's runner is given to finish its job when the client disconnects. */
export const SESSION_DRAIN_TIMEOUT_MS = 5_000;

/** What {@link serveStdioMcp} needs. Everything has a default the shipped command uses. */
export type StdioMcpOptions = {
  /** Defaults to the resolved state directory. */
  stateDir?: string;
  /** Where the narrative goes. **Never stdout**, which is the JSON-RPC stream. */
  log?: (line: string) => void;
};

/** A session that is serving, and the way to end it. */
export type StdioMcpSession = {
  /** The private job-store directory this session allocated. */
  sessionDir: string;
  /** The workspace root the eight tools read and write. */
  workspaceRoot: string;
  /** Resolves when the client has gone away and the session has been cleaned up. */
  closed: Promise<void>;
  /** End the session now: drain the runner, close the transport, remove the session directory. */
  close(): Promise<void>;
};

/**
 * Start the stdio MCP server and return once it is serving.
 *
 * The caller keeps the process alive by awaiting {@link StdioMcpSession.closed}; the session ends
 * when stdin closes, which is what a client that has exited looks like from here.
 */
export async function serveStdioMcp(options: StdioMcpOptions = {}): Promise<StdioMcpSession> {
  const stateDir = options.stateDir ?? resolveStateDir();
  const log = options.log ?? ((): void => {});
  const workspaceRoot = resolveWorkspaceRoot(stateDir);

  mkdirSync(join(stateDir, MCP_SESSIONS_DIR), { recursive: true, mode: STATE_DIR_MODE });
  const sessionDir = mkdtempSync(join(stateDir, MCP_SESSIONS_DIR, "session-"));

  const runner = createJobRunner({
    store: createJobStore(sessionDir),
    // `run_id` distinguishes two runs of one pid in a job record's owner. There is no acquisition
    // to take a `boot_nonce` from here, so the session mints its own.
    owner: { ...selfIdentity(), run_id: `mcp-${randomBytes(8).toString("hex")}` },
    workers: createWorkerRegistry({ root: workspaceRoot, stateDir }),
  });
  const backend = createLocalBackend({ runner, root: workspaceRoot, stateDir });
  const server = createMcpServer(backend, { version: CLI_VERSION });
  const transport = new StdioServerTransport();

  let announceClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    announceClosed = resolve;
  });

  // A plain flag set *before* the first `close()` call, and not a memoised promise, because
  // `StdioServerTransport.close()` calls `onclose` **synchronously** — so an
  // `already ??= (async () => { … await server.close(); … })()` would re-enter this function
  // before the assignment it is guarding had happened, and recurse until the stack ran out.
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) {
      return closed;
    }
    closing = true;
    // Guarded for the reason `daemon/shutdown.ts` states at length: a drain writes records, a
    // record write can fail, and a rejection here would leave `closed` unresolved for ever —
    // `xplainer mcp` awaits it, so the process would hang holding the session directory open
    // instead of ending when its client did.
    try {
      await runner.drain(SESSION_DRAIN_TIMEOUT_MS);
    } catch (error) {
      log(`xplainer mcp: the session drain failed (${String(error)}); ending the session anyway.`);
    }
    await server.close();
    rmSync(sessionDir, { recursive: true, force: true });
    log(`xplainer mcp: session ended; removed ${sessionDir}.`);
    announceClosed();
  };

  // `StdioServerTransport` listens for `data` and `error` on stdin and nothing else, so a client
  // that closed the pipe rather than the process would otherwise leave this one running for ever.
  process.stdin.once("end", () => {
    void close();
  });
  transport.onclose = (): void => {
    void close();
  };

  await server.connect(transport);
  log(
    `xplainer mcp: serving the eight tools over stdio, in this process, on ${workspaceRoot}. ` +
      `Jobs are private to this session (${sessionDir}) and are not the daemon's — ` +
      "`xplainer mcp --attach` is the entry that shares a running daemon's job store.",
  );

  return { sessionDir, workspaceRoot, closed, close };
}
