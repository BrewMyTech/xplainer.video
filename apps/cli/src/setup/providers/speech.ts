/**
 * Which of the three speech routes this machine gets, and the refusal when it gets none.
 *
 * Three routes, in a fixed precedence, and each one is a different kind of thing:
 *
 * 1. **`--tts-url`** — a server somebody else runs. Nothing is downloaded and nothing is started;
 *    the URL is recorded so `status` and the narration worker agree about where speech comes from.
 * 2. **`docker`** — the pinned Kokoro-FastAPI image, pulled by digest. `setup` pulls it; the daemon
 *    never starts it.
 * 3. **`bundle`** — the manifest's own archive for this platform, verified by `sha256`.
 *
 * `--tts-url` is first because it is an instruction rather than a discovery: a user who has named a
 * server has said which one to use, and pulling half a gigabyte of container afterwards would be
 * acquiring something they have already told us they do not need. `docker` is above `bundle`
 * because in this phase it is the route that works — §2.5 records that nothing is published to R2,
 * so every `bundle` acquisition fails at the manifest.
 *
 * **When none is possible the refusal names all three**, with the reason each one is unavailable on
 * this machine. A message that named only the route that was tried would send a Windows user to
 * install Docker for an image Docker there cannot run, and a Linux user with no network to a bundle
 * that is not published: the three reasons together are what let a reader pick the one they can act
 * on. Exit code `3` — a precondition unmet, with nothing written.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolchainComponent } from "@xplainer/protocol";
import { PRECONDITION_UNMET_EXIT_CODE } from "../../daemon/exit-codes.js";
import { hashFile } from "../../runtime/manifest.js";
import {
  type HostProbe,
  probeHost,
  speechPlatformKey,
  type ToolchainManifest,
  ToolchainSelectionRefusal,
} from "../manifest.js";
import { acquireSpeechBundle } from "./speech-bundle.js";
import {
  acquireSpeechImage,
  DockerPullFailed,
  DockerUnavailable,
  KOKORO_IMAGE,
  speechContainerCommand,
} from "./speech-docker.js";

/** The `provider` token the marker records for a speech server this machine does not own. */
export const URL_PROVIDER = "url";

/** The receipt's name under the toolchain directory's `speech/`. */
export const URL_RECEIPT_FILE = "speech/url.json";

/** The `version` recorded for a route that acquires nothing, because nothing has a version. */
export const EXTERNAL_VERSION = "external";

/** No speech route was available, and nothing was written. */
export class SpeechRefusal extends Error {
  readonly exitCode: number = PRECONDITION_UNMET_EXIT_CODE;
  /** Why each of the three routes was unavailable, in the order they were considered. */
  readonly routes: Readonly<Record<string, string>>;

  constructor(message: string, routes: Readonly<Record<string, string>>) {
    super(message);
    this.name = "SpeechRefusal";
    this.routes = routes;
  }
}

/** What {@link acquireSpeech} was asked to do. */
export type AcquireSpeechOptions = {
  /**
   * The manifest, fetched only if the `bundle` route is reached.
   *
   * A thunk and not a value, because the first two routes need no manifest at all and fetching one
   * for them would make `setup --tts-url … --skip-browser` fail on a machine that cannot reach the
   * published address — which is every machine in this phase (§2.5), and exactly the machine
   * `--tts-url` exists for.
   */
  manifest: () => Promise<ToolchainManifest>;
  toolchainDir: string;
  /** The server a user named with `--tts-url`, which skips both acquiring routes. */
  ttsUrl?: string | undefined;
  probe?: HostProbe | undefined;
  log?: (line: string) => void;
  /** The docker seam, so every branch of the precedence is testable with no Docker installed. */
  runDocker?: Parameters<typeof acquireSpeechImage>[0]["run"];
};

/** What one speech acquisition produced. */
export type AcquiredSpeech = {
  component: ToolchainComponent;
  /** Which of the three routes produced it. */
  provider: string;
};

/**
 * Take the first speech route this machine has, or refuse naming why none of the three worked.
 *
 * A route that is *unavailable* (no Docker, no published bundle) moves on to the next one; a route
 * that is available and *fails* (a pull that errored, an archive whose digest did not match) is
 * raised, because falling through from a real failure would replace a message about a broken pull
 * with a message about a missing bundle and lose the only evidence the user had.
 */
export async function acquireSpeech(options: AcquireSpeechOptions): Promise<AcquiredSpeech> {
  const log = options.log ?? ((): void => {});
  const probe = options.probe ?? probeHost();
  const routes: Record<string, string> = {};

  if (options.ttsUrl !== undefined && options.ttsUrl !== "") {
    log(`speech: using the server at ${options.ttsUrl}; nothing is downloaded and nothing is run`);
    return {
      component: recordExternal(options.toolchainDir, options.ttsUrl),
      provider: URL_PROVIDER,
    };
  }
  routes["--tts-url <url>"] =
    "not given. Pass it when a Kokoro-FastAPI server is already running somewhere you can reach.";

  try {
    const image = acquireSpeechImage({
      toolchainDir: options.toolchainDir,
      ...(options.runDocker === undefined ? {} : { run: options.runDocker }),
      log,
    });
    log(`speech: pulled ${image.component.version}`);
    log(`speech: start it with \`${speechContainerCommand(image.component.version)}\``);
    return { component: image.component, provider: image.component.provider };
  } catch (error) {
    if (error instanceof DockerUnavailable) {
      routes.docker = error.message;
    } else if (error instanceof DockerPullFailed) {
      throw error;
    } else {
      throw error;
    }
  }

  try {
    const bundle = await acquireSpeechBundle({
      manifest: await options.manifest(),
      toolchainDir: options.toolchainDir,
      probe,
      log,
    });
    return { component: bundle.component, provider: bundle.component.provider };
  } catch (error) {
    if (!(error instanceof ToolchainSelectionRefusal)) {
      throw error;
    }
    routes.bundle = error.message;
  }

  throw new SpeechRefusal(
    `no speech provider could be acquired for ${speechPlatformKey(probe)}. All three routes:\n\n` +
      Object.entries(routes)
        .map(([route, reason]) => `  ${route}\n      ${reason}`)
        .join("\n\n") +
      "\n\nNothing was written. The docker route pulls " +
      `${KOKORO_IMAGE}; setup pulls it and the daemon never starts a container.`,
    routes,
  );
}

/**
 * Record a speech server this machine does not own.
 *
 * A receipt rather than nothing at all, because `toolchain.json` records an absolute path for every
 * component and the install preflight checks that it still exists. What that check means for this
 * route is honest and narrower than for the other two: it says the user's instruction is still
 * recorded here, not that the server at the far end is up — which is a liveness question, and
 * `status` is where liveness is asked.
 */
export function recordExternal(toolchainDir: string, url: string): ToolchainComponent {
  const path = join(toolchainDir, ...URL_RECEIPT_FILE.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        provider: URL_PROVIDER,
        url,
        note: "setup recorded a speech server this machine does not own; nothing was downloaded.",
      },
      null,
      2,
    )}\n`,
  );
  return {
    version: EXTERNAL_VERSION,
    path,
    sha256: hashFile(path),
    provider: URL_PROVIDER,
  };
}
