/**
 * `xplainer runtime` — build and verify the two payloads this phase ships.
 *
 * Two verbs, and they are the build-time half of the packaging decision rather than anything a user
 * of the daemon runs:
 *
 * ```
 * xplainer runtime build --out <dir>              payload 1: the relocatable runtime
 * xplainer runtime build --workspace --out <dir>  payload 2: a real npm ci of the template
 * xplainer runtime verify <dir>                   re-hash payload 1 against its manifest
 * xplainer runtime verify --workspace <dir>       the same, plus the manifest against the pins
 * ```
 *
 * **`build` runs from a checkout or a runner; `build --workspace` also runs from a payload.** The
 * first assembles a payload out of the workspace's own packages, so it needs the checkout and says
 * so when there is none. The second installs `@xplainer/render-core`'s `template/package.json`,
 * which ships *inside* the CLI — `render-core`'s `files` allowlist contains `template` — so it is
 * the same command a `setup --workspace` on a machine with no Node reaches, with
 * `--from-runtime <dir>` naming the payload whose bundled npm and interpreter run the install.
 *
 * **The exit codes are the table's** (`docs/ARCHITECTURE.md` §6), and none is invented here:
 *
 * - `1` — commander's own usage errors.
 * - `3` — a precondition was not met and nothing was written: no checkout to build from, a
 *   non-empty output directory, a host that is not Node, an unbuilt `dist/`; and, for `verify`,
 *   a payload that is not what its manifest says. `verify` writes nothing in any case, so the
 *   "having written nothing" half of that row is free.
 * - `70` — the `npm ci` subprocess failed for its own reasons, which is the same shape as
 *   `connect`'s "a vendor's own `mcp add` that failed for its own reasons".
 *
 * Output goes to stdout: nothing spawns `runtime` and reads its stdout as a protocol.
 */

import { Command } from "commander";
import { DAEMON_INTERNAL_EXIT_CODE, PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import type { CliIo } from "../io.js";
import {
  AssemblyRefusal,
  type AssemblyRefusalReason,
  assembleRuntime,
  assembleWorkspace,
  measurePayload,
} from "../runtime/assemble.js";
import { RUNTIME_MANIFEST_FILE, WORKSPACE_MANIFEST_FILE } from "../runtime/manifest.js";
import { verifyRuntimePayload, verifyWorkspacePayload } from "../runtime/verify.js";

/** What `xplainer runtime build` parses. */
type BuildOptions = {
  out: string;
  workspace?: boolean;
  fromRuntime?: string;
};

/** What `xplainer runtime verify` parses. */
type VerifyOptions = {
  workspace?: boolean;
};

/**
 * Build the `runtime` command group.
 *
 * The group **and both verbs** carry their own output routing, which is one step further than
 * `connect` and `daemon` go. Commander's `addCommand()` copies neither `configureOutput()` nor
 * `exitOverride()` from the parent at any level, so a group that configures only itself leaves its
 * verbs writing to the process streams and calling the real `process.exit` — and both of this
 * group's verbs have usage errors a caller has to be able to observe: a missing `<dir>` and a
 * missing `--out`. Routing them through `CliIo` is what makes those two exit codes assertable
 * beside the refusals they sit next to.
 */
export function createRuntimeCommand(io: CliIo): Command {
  const runtime = route(
    new Command("runtime")
      .description("Assemble and verify the relocatable runtime and render-workspace payloads")
      .helpCommand(false),
    io,
  );

  runtime.addCommand(createBuildCommand(io));
  runtime.addCommand(createVerifyCommand(io));
  return runtime;
}

/** Send this command's output and its exits through `io` rather than through the process. */
function route(command: Command, io: CliIo): Command {
  return command
    .configureOutput({
      writeOut: (text) => {
        io.writeOut(text);
      },
      writeErr: (text) => {
        io.writeErr(text);
      },
    })
    .exitOverride((error) => io.exit(error.exitCode));
}

function createBuildCommand(io: CliIo): Command {
  return route(new Command("build"), io)
    .description("Assemble a payload into an empty directory and write its manifest")
    .requiredOption("--out <dir>", "the directory the payload is assembled into")
    .option("--workspace", "assemble the render workspace (payload 2) rather than the runtime")
    .option(
      "--from-runtime <dir>",
      "run the workspace install from this runtime payload's own node and npm",
    )
    .action((options: BuildOptions) => {
      try {
        if (options.workspace === true) {
          const built = assembleWorkspace({
            outDir: options.out,
            ...(options.fromRuntime === undefined ? {} : { runtimeDir: options.fromRuntime }),
          });
          const size = measurePayload(built.outDir);
          io.writeOut(
            `xplainer runtime build --workspace: ${built.outDir}\n` +
              `  ${size.files} files, ${megabytes(size.bytes)} MB, ` +
              `${Object.keys(built.manifest.resolved).length} packages resolved on ` +
              `${built.manifest.platform}/${built.manifest.arch}\n` +
              `  remotion entry: ${built.manifest.remotion_entry}\n` +
              `  manifest:       ${WORKSPACE_MANIFEST_FILE}\n`,
          );
          return;
        }

        const built = assembleRuntime({ outDir: options.out });
        const size = measurePayload(built.outDir);
        io.writeOut(
          `xplainer runtime build: ${built.outDir}\n` +
            `  ${size.files} files, ${megabytes(size.bytes)} MB, ` +
            `${built.manifest.packages.length} packages on ` +
            `${built.manifest.platform}/${built.manifest.arch}\n` +
            `  launch:   ${built.manifest.launch.argv.join(" ")}\n` +
            `  npm:      ${built.manifest.launch.npm_cli} (${built.manifest.npm_version})\n` +
            `  manifest: ${RUNTIME_MANIFEST_FILE}\n`,
        );
      } catch (error) {
        if (error instanceof AssemblyRefusal) {
          io.writeErr(`xplainer runtime build: ${error.message}\n`);
          io.exit(runtimeRefusalExitCode(error.reason));
        }
        throw error;
      }
    });
}

function createVerifyCommand(io: CliIo): Command {
  return route(new Command("verify"), io)
    .description("Re-hash a payload against its manifest and report the first mismatch")
    .argument("<dir>", "the payload directory to verify")
    .option("--workspace", "verify a render workspace (payload 2) against the template's pins")
    .action((directory: string, options: VerifyOptions) => {
      const workspace = options.workspace === true;
      const report = workspace
        ? verifyWorkspacePayload(directory)
        : verifyRuntimePayload(directory);
      const label = workspace ? "runtime verify --workspace" : "runtime verify";
      if (report.ok) {
        io.writeOut(
          `xplainer ${label}: ${directory} matches its manifest (${report.checked} entries).\n`,
        );
        return;
      }
      io.writeErr(
        `xplainer ${label}: ${directory} does not match its manifest.\n` +
          `  ${report.failure.reason}: ${report.failure.name}\n` +
          `  ${report.failure.detail}\n`,
      );
      io.exit(PRECONDITION_UNMET_EXIT_CODE);
    });
}

/**
 * Which row a refusal belongs to.
 *
 * An `npm ci` that exited non-zero is the one refusal that is not a precondition this command could
 * have checked first — npm ran, and failed for its own reasons — so it takes `70`, exactly as
 * `connect` does for a vendor CLI that failed for its own reasons. Everything else was knowable
 * before anything was written, which is what `3` means. The classification is read off the
 * refusal's own `reason` rather than out of its message, because a message is prose and prose is
 * edited.
 */
export function runtimeRefusalExitCode(reason: AssemblyRefusalReason): number {
  return reason === "install-failed" ? DAEMON_INTERNAL_EXIT_CODE : PRECONDITION_UNMET_EXIT_CODE;
}

/** Bytes as megabytes with one decimal, for the one line each verb prints. */
function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}
