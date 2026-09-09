/**
 * The two one-click controls, and the program each of them shells out to.
 *
 * Both are the same shape and both exist for the same reason: **the app asks the CLI to do it, and
 * never does it itself.** "Add to Claude Code / Codex" runs `connect claude` or `connect codex`,
 * which is the writer that already knows a scope from a `config.toml` table and how to answer a
 * vendor CLI that refuses a name it already holds; "start xplainer at login" runs `daemon install`,
 * which is the only thing in this project allowed to write a `plist`, a systemd unit or a scheduled
 * task ([ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md)). A second
 * implementation of either in a renderer would be a second implementation that can disagree with
 * the CLI about what this machine is already configured to do.
 *
 * **Which program runs is decision D10, and it is `resolveCliProgram`'s answer — never a bare
 * `xplainer`.** Round 2 of the plan wrote `xplainer connect …` and assumed a `PATH`; rounds 3 and 4
 * routed both controls through the stable launcher, which `daemon install` *creates*. Either way
 * both controls were unreachable in exactly the situation they exist for — a machine with nothing
 * installed — and "Add to Claude Code" was unreachable *permanently* for the user ADR 0020 cares
 * most about: the one with no supported supervisor, who never installs and whose whole product is a
 * spawned daemon plus `connect --spawn`. So before an install these run
 * `<resources>/xplainer-runtime/bin/node <…>/dist/bin.js …`, and afterwards the launcher, exactly
 * as discovery does.
 *
 * **`daemon install` is given the payload it is being run from.** `--runtime` takes "a payload-1
 * directory from `xplainer runtime build --out`", and on a clean machine nothing is staged under
 * `<state>/runtime/` yet — so an install with no `--runtime` has nothing to install. The packaged
 * app is carrying one: `extraResources` put payload 1 beside `app.asar` and the command is already
 * running out of it. Once the launcher exists the argument is dropped, because by then the state
 * directory has a staged runtime of its own and `daemon update` is what changes it; re-staging this
 * build's payload over a newer one would be a downgrade nobody asked for.
 *
 * Nothing here is an Electron call, so every branch is assertable by a plain `vitest` run against a
 * recording program on a temporary path — the pattern the CLI's own `connect` tests use for vendor
 * CLIs, one level up.
 */

import type { ConnectVendor, ControlMessage } from "../shared/ipc";
import {
  type CliProgram,
  DiscoveryRefusal,
  type ProgramRequest,
  resolveCliProgram,
  runCli,
} from "./discovery";
import { packagedPayloadRoot } from "./paths";
import { currentHost } from "./spawn";

/** `connect` writes a file and answers; a vendor CLI in front of it is the slow part. */
export const CONNECT_TIMEOUT_MS = 60_000;

/**
 * How long `daemon install` is given.
 *
 * It copies payload 1 — ~147 MB measured — registers a supervisor job, starts the daemon and waits
 * for it to answer, so this is minutes rather than the twenty seconds a discovery gets.
 */
export const INSTALL_TIMEOUT_MS = 600_000;

/** The argv `connect` is run with. The vendor is a closed set, so this cannot build a third verb. */
export function connectArgv(vendor: ConnectVendor): readonly string[] {
  return ["connect", vendor];
}

/**
 * The argv `daemon install` is run with, which depends on which of D10's stages resolved.
 *
 * The payload root is derived from `resourcesPath` by the same function `resolvePayloadCommand`
 * uses, rather than taken from the resolved command, so what is staged is named here in one place.
 */
export function installArgv(
  program: CliProgram,
  resourcesPath: string,
  platform: NodeJS.Platform,
): readonly string[] {
  if (program.kind === "launcher") {
    return ["daemon", "install"];
  }
  return ["daemon", "install", "--runtime", packagedPayloadRoot(resourcesPath, platform)];
}

/** What a control needs: D10's two inputs, plus an environment a test can point somewhere else. */
export type ControlRequest = ProgramRequest & {
  /** The child's environment. Defaults to this process's, as every other spawn here does. */
  env?: NodeJS.ProcessEnv | undefined;
};

/**
 * Run one control's command and describe what happened.
 *
 * A non-zero exit is **data**: `connect` refusing because no daemon has ever bound is a sentence a
 * user has to read, not an exception a window has to catch. The only outcome that is not a run is
 * one where there was no program to run at all, and that arrives as `control_unavailable` carrying
 * the payload's own named refusal.
 */
async function runControl(
  request: ControlRequest,
  build: (program: CliProgram) => readonly string[],
  timeoutMs: number,
): Promise<ControlMessage> {
  let program: CliProgram;
  try {
    program = resolveCliProgram(request);
  } catch (error) {
    if (error instanceof DiscoveryRefusal) {
      return { event: "control_unavailable", reason: error.reason, detail: error.message };
    }
    throw error;
  }
  const argv = build(program);
  let run: { code: number | null; stdout: string; stderr: string };
  try {
    run = await runCli(program, argv, {
      timeoutMs,
      ...(request.env === undefined ? {} : { env: request.env }),
    });
  } catch (error) {
    return {
      event: "control_unavailable",
      reason: "command-failed",
      detail:
        `${program.executable} is on disk and would not start: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    event: "control_ran",
    stage: program.kind,
    executable: program.executable,
    // Everything after the executable, which at the payload stage includes the entry it runs. The
    // window shows this line verbatim, so it has to be the command that was actually spawned rather
    // than the verb that was asked for.
    argv: [...program.leadingArgs, ...argv],
    ok: run.code === 0,
    exitCode: run.code,
    detail: sentence(run),
  };
}

/** Register this daemon with one agent, by running the writer that already knows how. */
export function connectAgent(
  vendor: ConnectVendor,
  request: ControlRequest,
): Promise<ControlMessage> {
  return runControl(request, () => connectArgv(vendor), CONNECT_TIMEOUT_MS);
}

/** Install the daemon so it starts at login, by running the one command allowed to write a job. */
export function startAtLogin(request: ControlRequest): Promise<ControlMessage> {
  const { platform } = request.host ?? currentHost();
  return runControl(
    request,
    (program) => installArgv(program, request.resourcesPath, platform),
    INSTALL_TIMEOUT_MS,
  );
}

/**
 * What the window shows: the command's own words.
 *
 * `stderr` first, because every refusal in this project is written there and a refusal is the thing
 * a user most needs to read; `stdout` is what a success has to say for itself.
 */
function sentence(run: { stdout: string; stderr: string }): string {
  const failed = run.stderr.trim();
  return failed === "" ? run.stdout.trim() : failed;
}
