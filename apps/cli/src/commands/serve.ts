/**
 * `xplainer serve` — the local daemon.
 *
 * The command's shape is now the ordering
 * [ADR 0024](../../../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md) makes an invariant:
 * **acquire exclusive ownership of the state directory, reconcile the jobs left behind by the last
 * run, and only then bind.** `../daemon/start.ts` does the first two and hands back a job runner;
 * this file does the third, and tells the runner which port it landed on.
 *
 * A process that cannot acquire ownership exits `10` **having written nothing** — not after
 * reconciling, which would have rewritten a live daemon's records on its way out. That is the
 * failure ADR 0020's own note describes: "the argument that a second `serve` is harmless because
 * the recorded port makes it exit `10` holds only at **bind**, and reconciliation happens earlier".
 *
 * What it serves the eight tools from is still the stub backend: the job runner exists, but the
 * tools that would enqueue against it — `explainer_narrate`, `explainer_still`, `explainer_render`
 * — are wired to real work with the render backend, which is the next roadmap step. The transport,
 * the tool list, the port, the ownership and the durable job store are real now, so the work left
 * is the work below `RenderBackend`.
 *
 * **Never add `serve --detach`.** [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md)
 * rejects self-daemonisation outright: `launchd.plist(5)` EXPECTATIONS says a job **MUST NOT**
 * "call `daemon(3)`" or "do the moral equivalent … by calling `fork(2)` and have the parent process
 * `exit(3)`", and systemd `Type=exec` and Task Scheduler expect the same. The supervisor owns the
 * process lifetime, so a `serve` that backgrounds itself is a `serve` no supervisor can supervise.
 * Detaching belongs to `xplainer daemon`.
 */

import { Command, InvalidArgumentError } from "commander";
import { createStubBackend } from "../backend.js";
import { DAEMON_INTERNAL_EXIT_CODE } from "../daemon/exit-codes.js";
import { startDaemon } from "../daemon/start.js";
import type { CliIo } from "../io.js";
import { DEFAULT_PORT, startServer } from "../server.js";

/** The highest port a TCP listener can bind. */
const MAX_PORT = 65535;

/**
 * Reject a port the OS could never bind before the server is built, so the
 * failure names the argument rather than surfacing as a bind error later.
 * `0` is allowed and means "any free port".
 */
function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) {
    throw new InvalidArgumentError(`Port must be a whole number between 0 and ${MAX_PORT}.`);
  }
  return port;
}

/** The `70` refusal, in the shape `startDaemon()` returns so both paths read the same. */
function internalFailure(error: unknown): {
  started: false;
  exitCode: number;
  message: string;
} {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    started: false,
    exitCode: DAEMON_INTERNAL_EXIT_CODE,
    message: `xplainer serve: could not start: ${detail}`,
  };
}

export function createServeCommand(io: CliIo): Command {
  return new Command("serve")
    .description("Serve /healthz and the MCP endpoint over HTTP")
    .option("-p, --port <port>", "port to listen on", parsePort, DEFAULT_PORT)
    .action(async (options: { port: number }) => {
      const outcome = await startDaemon({
        log: (line) => {
          io.writeErr(`${line}\n`);
        },
      }).catch(internalFailure);

      if (!outcome.started) {
        io.writeErr(`${outcome.message}\n`);
        io.exit(outcome.exitCode);
      } else {
        const { daemon } = outcome;
        const bound = await startServer({ backend: createStubBackend(), port: options.port }).then(
          (running) => ({ ok: true as const, running }),
          (error: unknown) => ({ ok: false as const, error }),
        );

        if (!bound.ok) {
          // A daemon that cannot bind must not keep the state directory: the next attempt, or the
          // supervisor's restart, has to be able to acquire it.
          await daemon.close();
          io.writeErr(`${internalFailure(bound.error).message}\n`);
          io.exit(DAEMON_INTERNAL_EXIT_CODE);
        } else {
          daemon.markReady(bound.running.port);
          io.writeOut(
            `xplainer serve: listening on ${bound.running.url} (MCP at ${bound.running.url}/mcp)\n`,
          );
        }
      }
    });
}
