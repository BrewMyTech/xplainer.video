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
 * (`setup/providers/chrome.ts`), speech (`setup/providers/speech.ts`, over four routes) and the
 * render workspace (`setup/providers/workspace.ts`, over two). The command's own job is the order,
 * the selection, the printed report and the marker; every decision about *how* a component is
 * acquired lives with that component.
 *
 * **Selection is a union, and that is what makes both spellings mean what they say.** Positive
 * flags name components to acquire; `--skip-*` flags name components to leave out of the default
 * run; giving both asks for the union of the two:
 *
 * ```
 * xplainer setup                        browser, speech, workspace
 * xplainer setup --workspace            the workspace only
 * xplainer setup --skip-speech          browser and workspace
 * xplainer setup --skip-speech --workspace   browser and workspace
 * xplainer setup --tts-url http://…     browser, workspace, and a recorded external server
 * ```
 *
 * `--workspace` on its own is the form the D8 proof runs under a scrubbed `PATH`, and it must not
 * drag a browser download or a Docker pull in behind it — which is why a positive flag *restricts*
 * rather than adds when it is the only thing given.
 *
 * **`--speech <route>` selects *which* speech route rather than whether speech is acquired**, so it
 * is not part of the union rule above and does not select the speech component: it is `--tts-url`'s
 * counterpart for the two routes that acquire something (`onnx`, `docker`). It exists because the
 * precedence deliberately will not move a machine that already records a working `docker` route
 * onto the in-process engine — `setup/providers/speech.ts`'s migration rule — so `--speech onnx` is
 * how a user asks for that switch, and `--speech docker` is how a machine or a proof pins the
 * container route on a host where `onnx` would otherwise win.
 *
 * **A partial run is a success that says what is still missing.** `toolchain.json` records all
 * three components or it is not a valid document, so a run that acquired one of them merges into
 * whatever the last run recorded and, where the result is still incomplete, exits `0` naming the
 * components a full `setup` would still fetch. Refusing a partial run would make `--workspace`
 * unusable on exactly the machine it exists for.
 *
 * **The exit codes are the table's** (`docs/ARCHITECTURE.md` §6): `1` for commander's usage errors,
 * `3` for a precondition unmet with nothing written — no reachable manifest, no reviewed digest for
 * this machine, no speech route at all, a staged payload for another platform — and `70` for a
 * subprocess that failed for its own reasons.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Toolchain, ToolchainComponent } from "@xplainer/protocol";
import { Command } from "commander";
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
import { acquireChrome, ChromeRefusal } from "../setup/providers/chrome.js";
import {
  acquireSpeech,
  isSpeechRoute,
  PINNABLE_SPEECH_ROUTES,
  SpeechRefusal,
} from "../setup/providers/speech.js";
import {
  materialiseRenderWorkspace,
  templateVersion,
  WorkspaceRefusal,
} from "../setup/providers/workspace.js";
import { loadToolchainManifest, ManifestUnreachable } from "../setup/source.js";
import {
  hostPlatformKey,
  readToolchainMarker,
  TOOLCHAIN_FORMAT_VERSION,
  writeToolchainMarker,
} from "../setup/toolchain.js";
import { resolveWorkspaceRoot } from "../workspace-root.js";

/** The three things `setup` can acquire. */
export type SetupComponent = "browser" | "speech" | "workspace";

/** All three, in acquisition order: the two downloads first, the install last. */
export const SETUP_COMPONENTS: readonly SetupComponent[] = ["browser", "speech", "workspace"];

/** Where acquisitions live, under the state directory. */
export const TOOLCHAIN_DIR_NAME = "toolchain";

/** What `xplainer setup` parses. */
type SetupOptions = {
  workspace?: boolean;
  skipSpeech?: boolean;
  skipBrowser?: boolean;
  ttsUrl?: string;
  speech?: string;
  stateDir?: string;
  manifest?: string;
};

/**
 * Which components this invocation acquires.
 *
 * The union rule, written once: positives on their own restrict the run to themselves; negatives on
 * their own trim the default; both together give the union of "what you named" and "everything but
 * what you excluded".
 */
export function selectedComponents(options: SetupOptions): SetupComponent[] {
  const positives = new Set<SetupComponent>();
  if (options.workspace === true) {
    positives.add("workspace");
  }
  const negatives = new Set<SetupComponent>();
  if (options.skipSpeech === true) {
    negatives.add("speech");
  }
  if (options.skipBrowser === true) {
    negatives.add("browser");
  }

  if (positives.size === 0 && negatives.size === 0) {
    return [...SETUP_COMPONENTS];
  }
  const selected = new Set<SetupComponent>(positives);
  if (negatives.size > 0) {
    for (const component of SETUP_COMPONENTS) {
      if (!negatives.has(component)) {
        selected.add(component);
      }
    }
  }
  return SETUP_COMPONENTS.filter((component) => selected.has(component));
}

/** Build the `setup` command, wired to `io` for output and exit. */
export function createSetupCommand(io: CliIo): Command {
  return new Command("setup")
    .description("Acquire the local render and TTS toolchain, and record what arrived")
    .option("--workspace", "acquire the render workspace only")
    .option("--skip-browser", "leave the browser out of this run")
    .option("--skip-speech", "leave speech out of this run")
    .option("--tts-url <url>", "record a Kokoro-FastAPI server this machine does not own")
    .option(
      "--speech <route>",
      `take this speech route and no other (${PINNABLE_SPEECH_ROUTES.join("|")})`,
    )
    .option("--state-dir <dir>", "where toolchain.json and the acquisitions go")
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
            "published manifest and nothing is published to it in this phase.\n",
        );
        io.exit(USAGE_EXIT_CODE);
      }
      const stateDir = resolveStateDirSetting({ flag: options.stateDir }).path;
      const toolchainDir = join(stateDir, TOOLCHAIN_DIR_NAME);
      const workspaceRoot = resolveWorkspaceRoot(stateDir);
      const components = selectedComponents(options);
      const log = (line: string): void => {
        io.writeOut(`xplainer setup: ${line}\n`);
      };

      mkdirSync(toolchainDir, { recursive: true });
      log(`state directory ${stateDir}`);
      log(`acquiring: ${components.join(", ")}`);

      const previous = readToolchainMarker(stateDir);
      let chrome: ToolchainComponent | null = previous?.chrome ?? null;
      let speech: ToolchainComponent | null = previous?.speech ?? null;
      let workspace: Toolchain["workspace"] | null = previous?.workspace ?? null;

      try {
        const needsManifest =
          components.includes("browser") ||
          (components.includes("speech") && options.ttsUrl === undefined);
        const loaded = needsManifest
          ? await loadToolchainManifest({
              ...(options.manifest === undefined ? {} : { override: options.manifest }),
              log,
            })
          : null;

        if (loaded !== null && components.includes("browser")) {
          const acquired = await acquireChrome({
            manifest: loaded.manifest,
            toolchainDir,
            log,
          });
          chrome = acquired.component;
          log(
            `browser: ${acquired.fetched ? "acquired" : "already present"} at ${acquired.component.path}`,
          );
        }

        if (components.includes("speech")) {
          const acquired = await acquireSpeech({
            // A thunk: the `--tts-url`, `onnx` and `docker` routes need no manifest, and this
            // phase's published address answers nothing, so loading one eagerly would refuse a run
            // that had no use for it.
            manifest: async () => loaded?.manifest ?? (await requireManifest(options, log)),
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

        if (components.includes("workspace")) {
          const materialised = materialiseRenderWorkspace({ workspaceRoot, log });
          workspace = { platform: materialised.resolution.platform, version: templateVersion() };
          log(`workspace: ${materialised.remotionShim}`);
        }
      } catch (error) {
        io.writeErr(`xplainer setup: ${describe(error)}\n`);
        io.exit(exitCodeFor(error));
      }

      if (chrome === null || speech === null || workspace === null) {
        const missing = [
          chrome === null ? "browser" : null,
          speech === null ? "speech" : null,
          workspace === null ? "workspace" : null,
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
        workspace,
      };
      log(`recorded ${writeToolchainMarker(stateDir, marker)}`);
      log(`platform ${hostPlatformKey()}`);
    });
}

/**
 * Load the manifest for a speech run that had no other reason to.
 *
 * Reached only when the `bundle` route is actually tried — every earlier route needs no manifest,
 * and this is what lets `setup --tts-url … --skip-browser` work on a machine that cannot reach the
 * published address at all.
 */
async function requireManifest(
  options: SetupOptions,
  log: (line: string) => void,
): Promise<ToolchainManifest> {
  const loaded = await loadToolchainManifest({
    ...(options.manifest === undefined ? {} : { override: options.manifest }),
    log,
  });
  return loaded.manifest;
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
    error instanceof SpeechRefusal
  ) {
    return PRECONDITION_UNMET_EXIT_CODE;
  }
  if (error instanceof WorkspaceRefusal) {
    return error.exitCode;
  }
  return DAEMON_INTERNAL_EXIT_CODE;
}
