/**
 * `xplainer setup` — acquire the render toolchain, visibly, and write down what arrived.
 *
 * [ADR 0005](../../../../docs/adr/0005-download-on-first-run-chrome-headless-shell-and-tts.md)
 * makes this the one command in the product that downloads: "a several-hundred-megabyte fetch is an
 * explicit, interruptible step and not something a background service does on someone's tethered
 * connection". Neither `daemon install` nor the daemon itself ever fetches anything, and the record
 * this command leaves — `<state>/toolchain.json` — is what both of them read instead.
 *
 * **Three components, and each has its own provider module.** The browser
 * (`setup/providers/chrome.ts`), FFmpeg (`setup/providers/ffmpeg.ts`, the pinned build or one named
 * with `--ffmpeg-path`) and speech (`setup/providers/speech.ts`, over four routes). The command's
 * own job is the order, the selection, the printed report and the marker; every decision about
 * *how* a component is acquired lives with that component.
 *
 * **The workspace is not one of them.** The marker is `format_version` 2 since ADR 0031's cut
 * (§Note, 2026-11-12, D1): `chrome`, `speech` and an optional `ffmpeg`, and no `workspace`, because
 * the renderer bundles every video against this package's own install and reads nothing but the
 * video's sources from the workspace. `--workspace` is gone with the payload it acquired, and is an
 * unknown option. What an older `setup --workspace` installed there is removed by this command —
 * only once it is provably that tree, and only after the refusal below has passed (D7,
 * `setup/previous-renderer.ts`) — and every removal is printed.
 *
 * **Selection trims the default.** A bare `setup` acquires all three components; each `--skip-*`
 * flag leaves one out of this run:
 *
 * ```
 * xplainer setup                        browser, ffmpeg, speech
 * xplainer setup --skip-speech          browser and ffmpeg
 * xplainer setup --tts-url http://…     browser, ffmpeg, and a recorded external server
 * xplainer setup --ffmpeg-path <file>   browser, the named ffmpeg, speech
 * ```
 *
 * **`--speech <route>` selects *which* speech route rather than whether speech is acquired**, so it
 * neither adds nor removes a component: it is `--tts-url`'s
 * counterpart for the two routes that acquire something (`onnx`, `docker`). It exists because the
 * precedence deliberately will not move a machine that already records a working `docker` route
 * onto the in-process engine — `setup/providers/speech.ts`'s migration rule — so `--speech onnx` is
 * how a user asks for that switch, and `--speech docker` is how a machine or a proof pins the
 * container route on a host where `onnx` would otherwise win.
 *
 * **`--ffmpeg-path <file>` is the same kind of flag for ffmpeg**: it names which ffmpeg is recorded
 * rather than whether one is, so it does not restrict the run. It records the binary named instead
 * of downloading the pin (ADR 0031 §Note, 2026-11-12, D6); `--skip-ffmpeg` beside it is a usage
 * error, because the two ask for opposite things.
 *
 * **And a named ffmpeg survives a plain re-run**, as a working `docker` speech route does: a run
 * without `--ffmpeg-path` keeps the one an earlier run recorded from it while that binary still
 * verifies, probes it again where it is when it has changed, and acquires the pin only once it is
 * gone (`providers/ffmpeg.ts`'s `keepNamedFfmpeg`). `xplainer update` runs a plain `setup` on every
 * upgrade, and the machines `--ffmpeg-path` exists for — musl and Alpine — are the ones the pin
 * cannot serve. `--ffmpeg-pinned` is the way back to the pin, as `--speech onnx` is speech's; it is
 * a usage error beside `--ffmpeg-path` or `--skip-ffmpeg`.
 *
 * **FFmpeg is optional in the marker, and its absence is said rather than refused.** A run that
 * skipped it, or met a manifest row recording this platform's build as unavailable, still writes a
 * complete marker of the other two and exits `0`, naming `--ffmpeg-path`: stills need no encoder,
 * and the gate (D12) is what refuses a render on a machine with none.
 *
 * **A partial run is a success that says what is still missing.** `toolchain.json` records the
 * browser and speech or it is not a valid document, so a run that acquired one of them merges into
 * whatever the last run recorded and, where the result is still incomplete, exits `0` naming the
 * components a full `setup` would still fetch. A version-1 marker the last run left is read as the
 * two components it records and rewritten as version 2 by the next run that writes at all.
 *
 * **It will not write a marker an installed daemon cannot read.** Before anything else — before the
 * toolchain directory exists — it asks the daemon `daemon.json` records which `toolchain.json`
 * format its runtime reads, and refuses with `3` when that is not this build's: a version-2 marker
 * under a daemon from before ADR 0031's cut is a toolchain that daemon reports as missing, and the
 * way across is a reinstall it prints and does not run (§Note, 2026-11-12, D2 (c)).
 *
 * **The exit codes are the table's** (`docs/ARCHITECTURE.md` §6): `1` for commander's usage errors,
 * `3` for a precondition unmet with nothing written — an installed daemon that reads another marker
 * format, no reachable manifest, no reviewed digest for this machine, no speech route at all —
 * `11` for a `daemon.json` that cannot be read, and `70` for a subprocess that failed for its own
 * reasons.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Toolchain, ToolchainComponent, ToolchainFfmpeg } from "@xplainer/protocol";
import { Command } from "commander";
import { StateFileUnreadableError } from "../daemon/daemon-state.js";
import {
  DAEMON_INTERNAL_EXIT_CODE,
  PRECONDITION_UNMET_EXIT_CODE,
  USAGE_EXIT_CODE,
} from "../daemon/exit-codes.js";
import { resolveStateDirSetting } from "../daemon/state-dir.js";
import type { CliIo } from "../io.js";
import { ArchiveRefusal } from "../setup/archive.js";
import { DownloadRefusal } from "../setup/download.js";
import {
  type ToolchainManifest,
  ToolchainManifestError,
  ToolchainSelectionRefusal,
} from "../setup/manifest.js";
import { removePreviousRendererTree } from "../setup/previous-renderer.js";
import { acquireChrome, ChromeRefusal } from "../setup/providers/chrome.js";
import {
  type AcquiredFfmpeg,
  acquireFfmpeg,
  FFMPEG_PATH_PROVIDER,
  FfmpegRefusal,
  keepNamedFfmpeg,
  recordFfmpegPath,
} from "../setup/providers/ffmpeg.js";
import {
  acquireSpeech,
  isSpeechRoute,
  PINNABLE_SPEECH_ROUTES,
  SpeechRefusal,
} from "../setup/providers/speech.js";
import { loadToolchainManifest, ManifestUnreachable } from "../setup/source.js";
import { offerStar } from "../setup/star.js";
import {
  crossingTheCutRefusal,
  hostPlatformKey,
  readToolchainMarker,
  TOOLCHAIN_FORMAT_VERSION,
  writeToolchainMarker,
} from "../setup/toolchain.js";
import { seedUserLexicon } from "../speech/user-lexicon.js";
import { resolveWorkspaceRoot } from "../workspace-root.js";

/** The three things `setup` can acquire. */
export type SetupComponent = "browser" | "ffmpeg" | "speech";

/** All three, in acquisition order: the browser and ffmpeg, the two the manifest pins, then speech. */
export const SETUP_COMPONENTS: readonly SetupComponent[] = ["browser", "ffmpeg", "speech"];

/** Where acquisitions live, under the state directory. */
export const TOOLCHAIN_DIR_NAME = "toolchain";

/** What `xplainer setup` parses. */
type SetupOptions = {
  skipSpeech?: boolean;
  skipBrowser?: boolean;
  skipFfmpeg?: boolean;
  ffmpegPath?: string;
  ffmpegPinned?: boolean;
  ttsUrl?: string;
  speech?: string;
  stateDir?: string;
  manifest?: string;
  /** Commander sets this `false` for `--no-star`, and leaves it undefined otherwise. */
  star?: boolean;
};

/** Which components this invocation acquires: all of them, less each one a `--skip-*` flag names. */
export function selectedComponents(options: SetupOptions): SetupComponent[] {
  const skipped = new Set<SetupComponent>();
  if (options.skipBrowser === true) {
    skipped.add("browser");
  }
  if (options.skipFfmpeg === true) {
    skipped.add("ffmpeg");
  }
  if (options.skipSpeech === true) {
    skipped.add("speech");
  }
  return SETUP_COMPONENTS.filter((component) => !skipped.has(component));
}

/** Build the `setup` command, wired to `io` for output and exit. */
export function createSetupCommand(io: CliIo): Command {
  return new Command("setup")
    .description("Acquire the local render and TTS toolchain, and record what arrived")
    .option("--skip-browser", "leave the browser out of this run")
    .option("--skip-ffmpeg", "leave ffmpeg out of this run")
    .option("--skip-speech", "leave speech out of this run")
    .option("--ffmpeg-path <file>", "record this ffmpeg instead of downloading the pinned build")
    .option(
      "--ffmpeg-pinned",
      "download the pinned ffmpeg, replacing one an earlier --ffmpeg-path recorded",
    )
    .option("--tts-url <url>", "record a Kokoro-FastAPI server this machine does not own")
    .option(
      "--speech <route>",
      `take this speech route and no other (${PINNABLE_SPEECH_ROUTES.join("|")})`,
    )
    .option("--state-dir <dir>", "where toolchain.json and the acquisitions go")
    .option("--no-star", "never ask about starring the repository on GitHub")
    .option("--manifest <source>", "read the toolchain manifest from this file or https URL")
    .configureOutput({
      writeOut: (text) => {
        io.writeOut(text);
      },
      writeErr: (text) => {
        io.writeErr(text);
      },
    })
    .exitOverride((error) => io.exit(error.exitCode))
    .action(async (options: SetupOptions) => {
      // Validated here rather than with a commander `choices()`, because the sentence a wrong
      // value earns has to name the two routes a value can be *and* the two ways to reach the
      // other two — a server needs `--tts-url` and its value, and nothing is published for the
      // bundle route to fetch this phase. `1` is the table's usage code, which is also commander's
      // own for a rejected argument, so the two halves of the parser cannot disagree.
      const route = options.speech;
      if (route !== undefined && !isSpeechRoute(route)) {
        io.writeErr(
          `xplainer setup: --speech ${route} is not a route. It takes ` +
            `${PINNABLE_SPEECH_ROUTES.join(" or ")} — the two routes that acquire something. For a ` +
            "server you already run pass `--tts-url <url>` instead; the bundle route reads the " +
            "published manifest, which carries no bundle for any platform yet.\n",
        );
        io.exit(USAGE_EXIT_CODE);
      }
      if (options.ffmpegPath !== undefined && options.skipFfmpeg === true) {
        io.writeErr(
          "xplainer setup: --ffmpeg-path names the ffmpeg to record and --skip-ffmpeg leaves " +
            "ffmpeg out of this run; give one or the other.\n",
        );
        io.exit(USAGE_EXIT_CODE);
      }
      if (
        options.ffmpegPinned === true &&
        (options.ffmpegPath !== undefined || options.skipFfmpeg === true)
      ) {
        io.writeErr(
          `xplainer setup: --ffmpeg-pinned downloads the pinned ffmpeg and ${
            options.ffmpegPath === undefined
              ? "--skip-ffmpeg leaves ffmpeg out of this run"
              : "--ffmpeg-path records one you name instead"
          }; give one or the other.\n`,
        );
        io.exit(USAGE_EXIT_CODE);
      }
      const stateDir = resolveStateDirSetting({ flag: options.stateDir }).path;
      let crossing: string | null;
      try {
        crossing = crossingTheCutRefusal(stateDir, "xplainer setup");
      } catch (error) {
        // `daemon.json` exists and cannot be read: its own sentence and its own code, `11`.
        io.writeErr(`${describe(error)}\n`);
        io.exit(error instanceof StateFileUnreadableError ? error.exitCode : exitCodeFor(error));
      }
      if (crossing !== null) {
        io.writeErr(crossing);
        io.exit(PRECONDITION_UNMET_EXIT_CODE);
      }
      const toolchainDir = join(stateDir, TOOLCHAIN_DIR_NAME);
      const workspaceRoot = resolveWorkspaceRoot(stateDir);
      const components = selectedComponents(options);
      const log = (line: string): void => {
        io.writeOut(`xplainer setup: ${line}\n`);
      };

      mkdirSync(toolchainDir, { recursive: true });
      log(`state directory ${stateDir}`);
      log(`acquiring: ${components.length === 0 ? "nothing" : components.join(", ")}`);
      reportPreviousRendererTree(workspaceRoot, log);

      const previous = readToolchainMarker(stateDir);
      let chrome: ToolchainComponent | null = previous?.chrome ?? null;
      let speech: ToolchainComponent | null = previous?.speech ?? null;
      // What the last run recorded stands until this run records something in its place: a run
      // that leaves ffmpeg out, or meets an unavailable row, must not turn a complete toolchain
      // into an incomplete one behind its owner's back.
      let ffmpeg: ToolchainFfmpeg | null = previous?.ffmpeg ?? null;

      // Loaded once, by the first component that needs it and by none that does not: a run that
      // keeps a named ffmpeg and records a `--tts-url` reads no manifest at all, so it works on a
      // machine that cannot reach the published address.
      let loading: Promise<ToolchainManifest> | null = null;
      const manifest = (): Promise<ToolchainManifest> => {
        loading ??= loadToolchainManifest({
          ...(options.manifest === undefined ? {} : { override: options.manifest }),
          log,
        }).then((loaded) => loaded.manifest);
        return loading;
      };

      try {
        if (components.includes("browser")) {
          const acquired = await acquireChrome({
            manifest: await manifest(),
            toolchainDir,
            log,
          });
          chrome = acquired.component;
          log(
            `browser: ${acquired.fetched ? "acquired" : "already present"} at ${acquired.component.path}`,
          );
        }

        if (components.includes("ffmpeg")) {
          // The binary a user named stands until they name another or ask for the pin: what the
          // last run recorded from `--ffmpeg-path`, kept, probed again, or — gone — given up.
          const named =
            options.ffmpegPath === undefined &&
            options.ffmpegPinned !== true &&
            previous?.ffmpeg?.provider === FFMPEG_PATH_PROVIDER
              ? keepNamedFfmpeg(previous.ffmpeg, log)
              : null;
          if (options.ffmpegPath !== undefined) {
            ffmpeg = recordFfmpegPath({ path: options.ffmpegPath, log });
            log(`ffmpeg: recorded the path route at ${ffmpeg.path}`);
          } else if (named !== null) {
            ffmpeg = named;
            log(`ffmpeg: recorded the path route at ${ffmpeg.path}`);
          } else {
            const acquired = await acquireFfmpegOrSkip(await manifest(), toolchainDir, log);
            if (acquired !== null) {
              ffmpeg = acquired.component;
              log(
                `ffmpeg: ${acquired.fetched ? "acquired" : "already present"} — FFmpeg ` +
                  `${ffmpeg.version}, ${ffmpeg.licence}, at ${ffmpeg.path}`,
              );
            }
          }
        }

        if (components.includes("speech")) {
          const acquired = await acquireSpeech({
            // A thunk: the `--tts-url`, `onnx` and `docker` routes need no manifest, so loading one
            // for speech alone would refuse a run that had no use for it.
            manifest,
            toolchainDir,
            ...(options.ttsUrl === undefined ? {} : { ttsUrl: options.ttsUrl }),
            ...(route === undefined ? {} : { route }),
            // What the last run recorded, so the reordering that put `onnx` above `docker` cannot
            // move a working machine onto a different engine behind its owner's back. The narrow
            // rule is `providers/speech.ts`'s; this is only where the record comes from.
            ...(previous?.speech === undefined ? {} : { recorded: previous.speech }),
            log,
          });
          speech = acquired.component;
          log(`speech: recorded the ${acquired.provider} route at ${acquired.component.path}`);
          // The routes not taken, once more and together. They were printed as the precedence was
          // walked, interleaved with the download lines of the route that won; a reader asking
          // "why this one?" after a 200 MB acquisition should not have to scroll back through it.
          for (const [skipped, reason] of Object.entries(acquired.skipped)) {
            log(`speech: ${acquired.provider} was chosen over ${skipped} — ${reason}`);
          }
        }
      } catch (error) {
        io.writeErr(`xplainer setup: ${describe(error)}\n`);
        io.exit(exitCodeFor(error));
      }

      // **Seeded before the completeness check, not after it.** Placing this after the marker was
      // written meant a partial run — any run whose browser or speech acquisition is still
      // outstanding — returned below without ever creating the file, so the
      // machines most likely to be mid-setup were the ones that never got it. Nothing about a
      // pronunciation list depends on the toolchain being complete.
      //
      // Seeded once and never overwritten, so what a person writes here survives every upgrade:
      // `xplainer update` runs this command again on each one. The seed is entirely commented out,
      // so a fresh file changes no pronunciation until somebody deliberately edits it.
      const lexicon = seedUserLexicon(stateDir);
      if (lexicon.written) {
        log(`pronunciations you can edit: ${lexicon.path}`);
      }

      if (chrome === null || speech === null) {
        const missing = [
          chrome === null ? "browser" : null,
          speech === null ? "speech" : null,
        ].filter((name): name is string => name !== null);
        log(
          `nothing was recorded in toolchain.json yet: ${missing.join(", ")} ` +
            `${missing.length === 1 ? "is" : "are"} still to acquire. Run \`xplainer setup\`.`,
        );
        return;
      }

      const marker: Toolchain = {
        format_version: TOOLCHAIN_FORMAT_VERSION,
        created_at: new Date().toISOString(),
        chrome,
        speech,
        ...(ffmpeg === null ? {} : { ffmpeg }),
      };
      log(`recorded ${writeToolchainMarker(stateDir, marker)}`);
      if (ffmpeg === null) {
        log(
          "ffmpeg is not recorded: stills will work, and every render is refused until it is. " +
            "Run `xplainer setup` again, or name one with `xplainer setup --ffmpeg-path <file>`.",
        );
      }
      log(`platform ${hostPlatformKey()}`);

      // Last, and never able to fail the command: everything a user came for is already recorded
      // above, so a GitHub outage or a missing browser costs a line of output and nothing else.
      // `offerStar` answers null on a machine with no terminal and on one that has already been
      // asked, which is what keeps `xplainer update` and every e2e proof from ever seeing a prompt.
      if (options.star !== false) {
        try {
          await offerStar({ stateDir, log });
        } catch (error) {
          log(`could not ask about starring: ${describe(error)}`);
        }
      }
    });
}

/**
 * The pinned ffmpeg, or `null` with a printed skip where this platform's row says it is unavailable.
 *
 * The skip is the one refusal that is not an error, because a manifest that records a platform's
 * build as unavailable has said so deliberately and given its reason: the run goes on, the marker is
 * written without ffmpeg, and the line names the route that needs no row. Every other refusal — no
 * row at all, a C library this machine lacks, a digest or a licence that does not match — is one.
 */
async function acquireFfmpegOrSkip(
  manifest: ToolchainManifest,
  toolchainDir: string,
  log: (line: string) => void,
): Promise<AcquiredFfmpeg | null> {
  try {
    return await acquireFfmpeg({ manifest, toolchainDir, log });
  } catch (error) {
    if (error instanceof ToolchainSelectionRefusal && error.reason === "artefact-unavailable") {
      log(
        `ffmpeg: skipped — ${error.message} Name an ffmpeg with ` +
          "`xplainer setup --ffmpeg-path <file>` to render on this machine.",
      );
      return null;
    }
    throw error;
  }
}

/**
 * Remove what an older `setup --workspace` installed in the workspace, and say what happened.
 *
 * Silent when there is nothing of it there, which is every machine set up since the cut and every
 * user's own project. Never fatal: a tree that could not be removed costs disk, not a render, and
 * the run that met it still has the toolchain to acquire — so a failure is a printed line, and the
 * next run, which recognises the tree by the two documents removed last, tries again.
 */
function reportPreviousRendererTree(workspaceRoot: string, log: (line: string) => void): void {
  const outcome = removePreviousRendererTree(workspaceRoot);
  const named = (entries: readonly string[]): string =>
    entries.map((entry) => (entry === "node_modules" ? "node_modules/" : entry)).join(", ");
  switch (outcome.kind) {
    case "absent":
      return;
    case "removed":
      log(
        `removed the previous renderer's install from ${workspaceRoot}: ${named(outcome.removed)}. ` +
          "Nothing renders from it any more; videos/, public/ and out/ are untouched.",
      );
      return;
    case "kept":
      log(
        `left the previous renderer's install in ${workspaceRoot} as it is: ${outcome.reason}, so ` +
          "it is not provably the tree an earlier setup wrote. Nothing renders from it; its " +
          "node_modules/ can be deleted by hand.",
      );
      return;
    case "failed":
      log(
        `could not remove ${outcome.entry} from ${workspaceRoot} (${outcome.error})` +
          `${outcome.removed.length === 0 ? "" : ` after removing ${named(outcome.removed)}`}. ` +
          "The next `xplainer setup` tries again.",
      );
      return;
  }
}

/** The message a refusal shows, which is the refusal's own sentence and never a stack. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The exit code a failure earns, from the documented table and never invented here.
 *
 * Every refusal this command can meet carries its own code, and the two that do not — an unexpected
 * throw, and a `docker pull` that failed for Docker's own reasons — are `70`, which is the same
 * shape `connect` gives a vendor CLI that failed for its own reasons.
 */
function exitCodeFor(error: unknown): number {
  if (
    error instanceof ManifestUnreachable ||
    error instanceof ToolchainManifestError ||
    error instanceof ToolchainSelectionRefusal ||
    error instanceof DownloadRefusal ||
    error instanceof ArchiveRefusal ||
    error instanceof ChromeRefusal ||
    error instanceof FfmpegRefusal ||
    error instanceof SpeechRefusal
  ) {
    return PRECONDITION_UNMET_EXIT_CODE;
  }
  return DAEMON_INTERNAL_EXIT_CODE;
}
