/**
 * `xplainer mcp --attach`: the shim between an agent's stdio and the daemon's socket.
 *
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §The agent path is IPC, not
 * TCP is why this exists at all: "`xplainer connect claude|codex` therefore writes a **stdio** entry
 * by default, pointing at `xplainer mcp --attach`, which proxies stdio to that socket. No URL and
 * no token enter any agent configuration file." Everything below is that sentence, in two steps.
 *
 * **Step one, before anything is proxied: read the daemon's contract version and decide.**
 * [ADR 0025](../../../../docs/adr/0025-daemon-updates-and-readiness.md) §Part two: "the shim
 * compares the daemon's **contract** version with its own — and when it deems the pair
 * **incompatible**, exits with a new code **`8`** and a message naming both versions and a command
 * that fixes it." The number comes from `GET /healthz`'s `contract_version`, which is where spike
 * P1-S3 put it and *why* it put it there — a candidate carried on the `initialize` result "is only
 * readable after an MCP session has been opened. The shim's whole job at that point is to decide
 * whether it may open one: a check that requires the session it is gating is not a gate". The
 * predicate is `isContractCompatible` from `@xplainer/protocol`, major-compatible and symmetric,
 * and an unparseable version is incompatible rather than "probably fine".
 *
 * The release version in the same body is *not* compared — "Two releases that serve the same
 * contract must attach cleanly, or every patch release breaks every agent session that outlives
 * them" — but it is read, because it is what makes the remediation a command rather than an
 * instruction: the daemon says which release it is running, and the message names that exact
 * version to install.
 *
 * **Step two: one session, pumped.** The stdio side is the SDK's `StdioServerTransport` and the
 * daemon side is its `StreamableHTTPClientTransport` over `socket-fetch.ts`, and messages are
 * handed from one to the other untouched. Nothing here parses a tool call, keeps a tool list or
 * knows what the eight tools are: a shim that understood the contract would be a second place the
 * contract is defined, and the whole point of ADR 0020's IPC path is that there is one server and
 * one registration behind it. The `initialize` handshake the agent sends is the daemon's to answer,
 * which is what makes this a proxy rather than a second server.
 *
 * A request that cannot be delivered is answered with a JSON-RPC error carrying the same id, never
 * dropped: an agent whose `tools/call` vanished waits for ever, and "the daemon went away" is an
 * answer it can act on.
 */

import process from "node:process";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";
import { isContractCompatible, MCP_CONTRACT_VERSION } from "@xplainer/protocol";
import { CONTRACT_SKEW_EXIT_CODE, DAEMON_UNHEALTHY_EXIT_CODE } from "../daemon/exit-codes.js";
import { createSocketFetch } from "./socket-fetch.js";

/**
 * The authority the shim writes into the URLs it builds.
 *
 * A socket has none, and `socket-fetch.ts` ignores it — but it reaches the daemon as the `Host`
 * header and shows up in `@hono/node-server`'s reconstructed request URL, so it is a name that says
 * where the request came from rather than a loopback address that is not where it came from.
 */
export const IPC_AUTHORITY = "xplainer.ipc";

/** What `GET /healthz` told us. Both fields are the daemon's, and they are different numbers. */
export type DaemonHealth = {
  /** The release version of the daemon binary — what a remediation command installs. */
  version: string;
  /** The tool contract it speaks, which is the only number compatibility depends on. */
  contractVersion: string;
};

/** The daemon's socket could not be reached, or did not answer `/healthz` as a daemon would. */
export class DaemonUnreachableError extends Error {
  readonly exitCode: number = DAEMON_UNHEALTHY_EXIT_CODE;

  constructor(socketPath: string, detail: string) {
    super(
      `xplainer mcp --attach: no xplainer daemon is answering on ${socketPath} (${detail}). ` +
        "Start one with `xplainer serve`, or drop --attach to run the tools in this process " +
        "instead — `xplainer mcp` needs no daemon.",
    );
    this.name = "DaemonUnreachableError";
  }
}

/** The pair is incompatible, and this is ADR 0025's exit `8`. */
export class ContractSkewError extends Error {
  readonly exitCode: number = CONTRACT_SKEW_EXIT_CODE;
  readonly daemonContractVersion: string;
  readonly shimContractVersion: string;

  constructor(daemon: DaemonHealth, shim: string) {
    super(
      `xplainer mcp --attach: this daemon speaks tool contract ${daemon.contractVersion} and ` +
        `this shim speaks ${shim}, and the two are not compatible, so nothing was proxied ` +
        `(exit ${CONTRACT_SKEW_EXIT_CODE}). The daemon is running release ${daemon.version}; ` +
        "install the matching shim and start the session again:\n\n" +
        `  npm i -g @xplainer/cli@${daemon.version}\n`,
    );
    this.name = "ContractSkewError";
    this.daemonContractVersion = daemon.contractVersion;
    this.shimContractVersion = shim;
  }
}

/** Read `/healthz` over the socket. The one request the shim makes before it decides anything. */
export async function probeDaemonHealth(socketPath: string): Promise<DaemonHealth> {
  const fetchOverSocket = createSocketFetch({ socketPath, host: IPC_AUTHORITY });
  let response: Response;
  try {
    response = await fetchOverSocket(`http://${IPC_AUTHORITY}/healthz`);
  } catch (error) {
    throw new DaemonUnreachableError(
      socketPath,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!response.ok) {
    throw new DaemonUnreachableError(socketPath, `it answered ${response.status} to GET /healthz`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new DaemonUnreachableError(
      socketPath,
      `its /healthz body is not JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const record = body as Partial<{ version: unknown; contract_version: unknown }>;
  if (typeof record.contract_version !== "string" || record.contract_version === "") {
    // A daemon old enough to answer `{status, version}` and nothing else lands here, and so does
    // anything else that happens to be on the socket. Both are "this shim cannot establish that it
    // may talk to you", which is the fail-closed direction ADR 0025 §(b) asks for.
    throw new DaemonUnreachableError(
      socketPath,
      "its /healthz body carries no contract_version, so this shim cannot establish which tool " +
        "contract it speaks",
    );
  }
  return {
    version:
      typeof record.version === "string" && record.version !== "" ? record.version : "latest",
    contractVersion: record.contract_version,
  };
}

/**
 * Apply ADR 0025's predicate, and throw the exit-`8` refusal when it says no.
 *
 * `shim` is a parameter so the caller — and a test — states which version is being compared rather
 * than the predicate reaching for a constant halfway down a call stack.
 */
export function assertContractCompatible(
  health: DaemonHealth,
  shim: string = MCP_CONTRACT_VERSION,
): void {
  if (!isContractCompatible(health.contractVersion, shim)) {
    throw new ContractSkewError(health, shim);
  }
}

/** A running proxy, and the two ways it ends. */
export type AttachedSession = {
  /** Resolves when the agent's stdin closed, or the daemon connection did. */
  closed: Promise<void>;
  /** Stop proxying now and close both transports. */
  close(): Promise<void>;
};

/** What {@link proxyStdioToDaemon} needs. */
export type ProxyOptions = {
  /** The daemon's IPC endpoint. */
  socketPath: string;
  /** Where the narrative goes. **Never stdout**, which is the JSON-RPC stream. */
  log?: (line: string) => void;
};

/** The id of a JSON-RPC *request*, or `undefined` for a notification or a response. */
function requestIdOf(message: JSONRPCMessage): RequestId | undefined {
  return "method" in message && "id" in message ? message.id : undefined;
}

/**
 * Pump one MCP session between this process's stdio and the daemon's `/mcp` over the socket.
 *
 * One `StreamableHTTPClientTransport` for the life of the process, so the session the agent opened
 * is the session the daemon sees — a fresh transport per message would re-handshake on every call.
 */
export async function proxyStdioToDaemon(options: ProxyOptions): Promise<AttachedSession> {
  const log = options.log ?? ((): void => {});
  const stdio = new StdioServerTransport();
  const daemon = new StreamableHTTPClientTransport(new URL(`http://${IPC_AUTHORITY}/mcp`), {
    fetch: createSocketFetch({ socketPath: options.socketPath, host: IPC_AUTHORITY }),
  });

  let announceClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    announceClosed = resolve;
  });

  // A plain flag set *before* the first `close()` call, and not a memoised promise, because both
  // transports call `onclose` **synchronously** from inside their own `close()` — so an
  // `already ??= (async () => { await transport.close(); … })()` would re-enter this function
  // before the assignment it is guarding had happened, and recurse until the stack ran out.
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) {
      return closed;
    }
    closing = true;
    await daemon.close();
    await stdio.close();
    announceClosed();
  };

  stdio.onmessage = (message): void => {
    void daemon.send(message).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      log(`xplainer mcp --attach: the daemon did not accept a message (${detail}).`);
      const id = requestIdOf(message);
      if (id !== undefined) {
        void stdio
          .send({
            jsonrpc: "2.0",
            id,
            error: {
              // JSON-RPC reserves −32000 to −32099 for implementation-defined server errors, and
              // this one is the shim's own: the daemon never saw the call.
              code: -32001,
              message: `xplainer mcp --attach: could not reach the daemon (${detail}).`,
            },
          })
          .catch(() => {
            // The agent's stdout has gone too; there is nowhere left to report anything.
          });
      }
    });
  };
  daemon.onmessage = (message): void => {
    void stdio.send(message).catch((error: unknown) => {
      log(
        "xplainer mcp --attach: could not write the daemon's reply to stdout " +
          `(${error instanceof Error ? error.message : String(error)}).`,
      );
    });
  };
  daemon.onerror = (error): void => {
    log(`xplainer mcp --attach: ${error.message}`);
  };
  stdio.onerror = (error): void => {
    log(`xplainer mcp --attach: ${error.message}`);
  };
  daemon.onclose = (): void => {
    void close();
  };
  stdio.onclose = (): void => {
    void close();
  };
  // The SDK's stdio transport listens for `data` and `error` and nothing else, so an agent that
  // closed the pipe rather than exiting would otherwise leave this shim running for ever.
  process.stdin.once("end", () => {
    void close();
  });

  await daemon.start();
  await stdio.start();
  return { closed, close };
}
