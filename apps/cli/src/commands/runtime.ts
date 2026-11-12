/**
 * `xplainer runtime` — build and verify the relocatable runtime payload this phase ships.
 *
 * Two verbs, and they are the build-time half of the packaging decision rather than anything a user
 * of the daemon runs:
 *
 * ```
 * xplainer runtime build --out <dir>   payload 1: the relocatable runtime
 * xplainer runtime verify <dir>        re-hash it against its manifest
 * ```
 *
 * **There is one payload.** The render workspace the previous renderer needed — payload 2, a real
 * `npm ci` of a pinned template — left with ADR 0031's Phase 2 (§Note, 2026-11-12, D7), and with it
 * `build --workspace`, `--from-runtime` and `verify --workspace`, which are now commander's own
 * unknown options.
 *
 * **`build` runs from a checkout or a runner.** It assembles a payload out of the workspace's own
 * packages, so it needs the checkout and says so when there is none.
 *
 * **The exit codes are the table's** (`docs/ARCHITECTURE.md` §6), and none is invented here:
 *
 * - `1` — commander's own usage errors.
 * - `3` — a precondition was not met and nothing was written: no checkout to build from, a
 *   non-empty output directory, a host that is not Node, an unbuilt `dist/`; and, for `verify`,
 *   a payload that is not what its manifest says. `verify` writes nothing in any case, so the
 *   "having written nothing" half of that row is free. Every refusal the assembler makes is one of
 *   these: it spawns nothing whose own failure would be `70`.
 *
 * Output goes to stdout: nothing spawns `runtime` and reads its stdout as a protocol.
 */

import { Command } from "commander";
import { PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import type { CliIo } from "../io.js";
import { AssemblyRefusal, assembleRuntime, measurePayload } from "../runtime/assemble.js";
import { RUNTIME_MANIFEST_FILE } from "../runtime/manifest.js";
import { verifyRuntimePayload } from "../runtime/verify.js";

/** What `xplainer runtime build` parses. */
type BuildOptions = {
  out: string;
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
      .description("Assemble and verify the relocatable runtime payload")
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
    .action((options: BuildOptions) => {
      try {
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
          io.exit(PRECONDITION_UNMET_EXIT_CODE);
        }
        throw error;
      }
    });
}

function createVerifyCommand(io: CliIo): Command {
  return route(new Command("verify"), io)
    .description("Re-hash a payload against its manifest and report the first mismatch")
    .argument("<dir>", "the payload directory to verify")
    .action((directory: string) => {
      const report = verifyRuntimePayload(directory);
      if (report.ok) {
        io.writeOut(
          `xplainer runtime verify: ${directory} matches its manifest (${report.checked} entries).\n`,
        );
        return;
      }
      io.writeErr(
        `xplainer runtime verify: ${directory} does not match its manifest.\n` +
          `  ${report.failure.reason}: ${report.failure.name}\n` +
          `  ${report.failure.detail}\n`,
      );
      io.exit(PRECONDITION_UNMET_EXIT_CODE);
    });
}

/** Bytes as megabytes with one decimal, for the one line each verb prints. */
function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}
