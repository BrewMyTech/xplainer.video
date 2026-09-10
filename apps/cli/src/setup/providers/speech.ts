/**
 * Which of the four speech routes this machine gets, and the refusal when it gets none.
 *
 * Four routes, in a fixed precedence, and each one is a different kind of thing:
 *
 * 1. **`--tts-url`** — a server somebody else runs. Nothing is downloaded and nothing is started;
 *    the URL is recorded so `status` and the narration worker agree about where speech comes from.
 * 2. **`onnx`** — the model, a voice and this platform's ONNX Runtime, each pinned by digest and
 *    each fetched from its own upstream home. No container, no Python, no server: the synthesiser
 *    runs inside the narration worker.
 * 3. **`docker`** — the pinned Kokoro-FastAPI image, pulled by digest. `setup` pulls it; the daemon
 *    never starts it.
 * 4. **`bundle`** — the manifest's own archive for this platform, verified by `sha256`.
 *
 * `--tts-url` is first because it is an instruction rather than a discovery: a user who has named a
 * server has said which one to use, and pulling half a gigabyte of container afterwards would be
 * acquiring something they have already told us they do not need.
 *
 * **`onnx` is above `docker`, and the swap is the point of the change that made it.** It sat below
 * until 2026-09-10, because `scripts/e2e/toolchain.mjs` decided its own speech plan from
 * `docker version` and then opened `marker.speech.path` *as the docker receipt* — so an
 * `onnx`-first order would have had that gate `JSON.parse` 92 MB of model graph. That ordering also
 * meant every machine with a container engine recorded `docker` and **never** took the in-process
 * route, which defeats the reason ADR 0028 exists: a user should not need Docker for a voiceover.
 * The gate now names the route it is proving (`--speech docker`) instead of inferring it from a
 * precedence it does not own, which is what lets the product put the better route first. On the
 * merits it is not close — nothing to install, nothing to start, nothing to keep running, and it
 * is the only route Windows has ever had.
 *
 * **A machine that already records a working `docker` route keeps it, and that is a deliberate
 * decision rather than a leftover.** `setup` is re-runnable by design — after an upgrade, after a
 * cleaned cache, as the thing a user does when something looks wrong — and a re-run is the worst
 * possible moment to move a machine's narration onto a different engine: the container is running,
 * it is what every previous narration was spoken by, and switching would fetch ~204 MB from three
 * hosts to replace something that works. So a recorded `docker` component whose image Docker can
 * still address takes the route again, and `setup` prints that it did and how to change it. The
 * rule is deliberately **narrow** — it is not "whatever the marker says wins", which would freeze
 * a machine on `bundle` or on a `--tts-url` receipt for ever — because `docker` is the only
 * provider this reordering can displace. `--speech onnx` is how a user asks for the switch, and it
 * is the only way it happens: nothing here changes an engine on a machine that did not ask.
 *
 * **`--speech <route>` pins a route and does not walk the precedence at all.** A route somebody
 * named is an instruction like `--tts-url` is, so a pinned route that is unavailable is a
 * **refusal** naming why — never a fall-through to the next one, which would acquire something
 * other than what was asked for and record it as though it had been chosen.
 *
 * **When none is possible the refusal names all four**, with the reason each one is unavailable on
 * this machine. A message that named only the route that was tried would send a user to install
 * Docker for an image their host cannot run, and a Linux user with no network to a bundle that is
 * not published: the reasons together are what let a reader pick the one they can act on. Exit code
 * `3` — a precondition unmet, with nothing written.
 *
 * **Every route not taken is printed, not only the ones in a refusal.** The reasons were collected
 * for the refusal message and thrown away on success, which left the one line a successful `setup`
 * printed — "recorded the onnx route" — unable to answer the question a user actually has, which is
 * why *that* one. They are logged as the precedence is walked and returned in
 * {@link AcquiredSpeech.skipped}.
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
  DOCKER_PROVIDER,
  DockerUnavailable,
  KOKORO_IMAGE,
  speechContainerCommand,
} from "./speech-docker.js";
import { acquireSpeechOnnx, ONNX_PROVIDER, type OnnxPins, OnnxUnavailable } from "./speech-onnx.js";

/** The `provider` token the marker records for a speech server this machine does not own. */
export const URL_PROVIDER = "url";

/** The receipt's name under the toolchain directory's `speech/`. */
export const URL_RECEIPT_FILE = "speech/url.json";

/** The `version` recorded for a route that acquires nothing, because nothing has a version. */
export const EXTERNAL_VERSION = "external";

/** No speech route was available, and nothing was written. */
export class SpeechRefusal extends Error {
  readonly exitCode: number = PRECONDITION_UNMET_EXIT_CODE;
  /** Why each of the four routes was unavailable, in the order they were considered. */
  readonly routes: Readonly<Record<string, string>>;

  constructor(message: string, routes: Readonly<Record<string, string>>) {
    super(message);
    this.name = "SpeechRefusal";
    this.routes = routes;
  }
}

/**
 * A route `--speech` can name: the two that *acquire* something and therefore contend.
 *
 * `url` is not here because it needs a value and has `--tts-url` for it, and `bundle` is not
 * because nothing is published for it to fetch in this phase (§2.5) — offering it would be offering
 * a route whose only possible outcome is a refusal about an empty address.
 */
export type SpeechRoute = typeof ONNX_PROVIDER | typeof DOCKER_PROVIDER;

/** The routes `--speech` accepts, in the precedence they have when nothing is pinned. */
export const PINNABLE_SPEECH_ROUTES: readonly SpeechRoute[] = [ONNX_PROVIDER, DOCKER_PROVIDER];

/**
 * Every route that *acquires* something, in the order the walk tries them.
 *
 * `--tts-url` is not in it because it is above all three and is an instruction rather than a step.
 * The list is here so a successful run can name what it never looked at — see `take` — which is a
 * different sentence from "this machine cannot do that".
 */
export const ACQUIRING_ROUTES: readonly string[] = [ONNX_PROVIDER, DOCKER_PROVIDER, "bundle"];

/** Whether `value` names a route `--speech` can pin. */
export function isSpeechRoute(value: string): value is SpeechRoute {
  return (PINNABLE_SPEECH_ROUTES as readonly string[]).includes(value);
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
  /**
   * The ONNX route's four pinned artefacts, so the precedence is testable against a loopback server.
   *
   * The counterpart of `runDocker`, and it is a *seam over the pins* rather than over the fetch:
   * this package has no `vi.mock` anywhere, so the way to exercise the route that downloads 200 MB
   * is to point it at `setup/testing/artefact-server.ts` with fixture digests, not to replace the
   * downloader with something that cannot fail the way a network does.
   */
  onnxPins?: OnnxPins | undefined;
  /**
   * `--speech <route>`: take this route or refuse, never walk the precedence.
   *
   * It is how a user asks for a switch the precedence will not make on its own — the migration case
   * in the docblock — and how `scripts/e2e/toolchain.mjs` names the route it is proving instead of
   * inferring it from an order that module does not own.
   */
  route?: SpeechRoute | undefined;
  /**
   * What the last `setup` recorded for speech, so a re-run does not move a working machine.
   *
   * The marker's own `speech` component, read by `commands/setup.ts` before anything is acquired.
   * Only one thing is done with it — see the docblock's migration rule — and it is deliberately not
   * a general "the marker decides" input.
   */
  recorded?: ToolchainComponent | undefined;
};

/** What one speech acquisition produced. */
export type AcquiredSpeech = {
  component: ToolchainComponent;
  /** Which of the four routes produced it. */
  provider: string;
  /**
   * Every route the walk passed over, and why, keyed as the refusal keys them.
   *
   * Empty for a pinned route and for `--tts-url`, because neither walked anything. This is what
   * makes a successful `setup` able to say why the route it took was the route it took.
   */
  skipped: Readonly<Record<string, string>>;
};

/**
 * Take the first speech route this machine has, or refuse naming why none of the four worked.
 *
 * A route that is *unavailable* (no Docker, no binding for this platform, no published bundle)
 * moves on to the next one; a route that is available and *fails* (a pull that errored, an artefact
 * whose digest did not match) is raised, because falling through from a real failure would replace
 * a message about a broken pull with a message about a missing bundle and lose the only evidence
 * the user had. For the ONNX route that line is drawn at the **platform table**: a host
 * `onnxruntime-node` publishes no binding for is an absence — there is nothing here to fix — and
 * everything after that first byte is a failure.
 */
export async function acquireSpeech(options: AcquireSpeechOptions): Promise<AcquiredSpeech> {
  const log = options.log ?? ((): void => {});
  const probe = options.probe ?? probeHost();
  const routes: Record<string, string> = {};

  /** Record a route the walk passed over, and say so at the moment it is passed over. */
  const skip = (route: string, reason: string): void => {
    routes[route] = reason;
    log(`speech: not the ${route} route — ${reason}`);
  };

  /**
   * Return a route the walk took, having said what it took and what it never looked at.
   *
   * The two halves are different facts and a reader needs both. A route **above** the winner was
   * probed and reported itself unavailable, and `skip` has already said why. A route **below** it
   * was never asked: nothing pulls an image or fetches a manifest once something has already
   * answered, so "docker was not taken" here means "docker was not needed", and a message that did
   * not distinguish the two would read as a claim that this machine has no Docker.
   */
  const take = (taken: TakenRoute): AcquiredSpeech => {
    log(`speech: took the ${taken.provider} route`);
    const below = ACQUIRING_ROUTES.slice(ACQUIRING_ROUTES.indexOf(taken.provider) + 1);
    if (below.length > 0) {
      log(
        `speech: ${below.join(" and ")} sit below it in the precedence and were not probed at all. ` +
          `\`xplainer setup --speech <${PINNABLE_SPEECH_ROUTES.join("|")}>\` takes a named route ` +
          "instead of the first available one",
      );
    }
    return { ...taken, skipped: { ...routes } };
  };

  if (options.ttsUrl !== undefined && options.ttsUrl !== "") {
    if (options.route !== undefined) {
      log(
        `speech: --tts-url names a server outright, so --speech ${options.route} is not used: a ` +
          "URL is a server to talk to and a route is something to acquire",
      );
    }
    log(`speech: using the server at ${options.ttsUrl}; nothing is downloaded and nothing is run`);
    return {
      component: recordExternal(options.toolchainDir, options.ttsUrl),
      provider: URL_PROVIDER,
      skipped: {},
    };
  }

  if (options.route !== undefined) {
    return await pinnedSpeechRoute(options.route, options, probe, log);
  }
  routes["--tts-url <url>"] =
    "not given. Pass it when a Kokoro-FastAPI server is already running somewhere you can reach.";

  // The migration rule, and the one thing `recorded` is used for. A machine whose last `setup`
  // recorded `docker` is asked *of Docker* whether that is still true — `acquireSpeechImage` re-asks
  // `docker image inspect` on every run rather than trusting its own receipt — so a machine that
  // has since lost its engine falls through to `onnx` and gets the better route, while a machine
  // whose container is still there keeps the engine every previous narration was spoken by.
  if (options.recorded?.provider === DOCKER_PROVIDER) {
    try {
      const kept = dockerSpeechRoute(options, log);
      log(
        "speech: kept the docker route this machine already records, so a re-run does not move " +
          `narration onto a different engine. \`xplainer setup --speech ${ONNX_PROVIDER}\` is how ` +
          "to switch to the in-process synthesiser, which needs no container at all",
      );
      skip(
        ONNX_PROVIDER,
        "not tried: this machine already records the docker route and its image is still here, so " +
          "a re-run does not change which engine narration uses.",
      );
      return take(kept);
    } catch (error) {
      if (!(error instanceof DockerUnavailable)) {
        throw error;
      }
      skip(
        "recorded docker",
        `${error.message} The route this machine recorded is no longer usable here, so the ` +
          "precedence is walked as it would be on a machine that had never run setup.",
      );
    }
  }

  try {
    return take(await onnxSpeechRoute(options, probe, log));
  } catch (error) {
    if (!(error instanceof OnnxUnavailable)) {
      throw error;
    }
    skip(ONNX_PROVIDER, error.message);
  }

  try {
    return take(dockerSpeechRoute(options, log));
  } catch (error) {
    if (!(error instanceof DockerUnavailable)) {
      throw error;
    }
    skip(DOCKER_PROVIDER, error.message);
  }

  try {
    const bundle = await acquireSpeechBundle({
      manifest: await options.manifest(),
      toolchainDir: options.toolchainDir,
      probe,
      log,
    });
    return take({ component: bundle.component, provider: bundle.component.provider });
  } catch (error) {
    if (!(error instanceof ToolchainSelectionRefusal)) {
      throw error;
    }
    skip("bundle", error.message);
  }

  throw new SpeechRefusal(
    `no speech provider could be acquired for ${speechPlatformKey(probe)}. All four routes:\n\n` +
      Object.entries(routes)
        .map(([route, reason]) => `  ${route}\n      ${reason}`)
        .join("\n\n") +
      "\n\nNothing was written. The docker route pulls " +
      `${KOKORO_IMAGE}; setup pulls it and the daemon never starts a container.`,
    routes,
  );
}

/** What one route produced, before {@link acquireSpeech} says what it walked past to get there. */
type TakenRoute = Omit<AcquiredSpeech, "skipped">;

/**
 * The `docker` route: pull the pinned image, and print the command that starts it.
 *
 * A function rather than an inline block because three callers reach it — the migration rule, the
 * ordinary fall-through and `--speech docker` — and the difference between them is only what they do
 * with a {@link DockerUnavailable}, which is the distinction plan D5 draws.
 */
function dockerSpeechRoute(options: AcquireSpeechOptions, log: (line: string) => void): TakenRoute {
  const image = acquireSpeechImage({
    toolchainDir: options.toolchainDir,
    ...(options.runDocker === undefined ? {} : { run: options.runDocker }),
    log,
  });
  log(`speech: pulled ${image.component.version}`);
  log(`speech: start it with \`${speechContainerCommand(image.component.version)}\``);
  return { component: image.component, provider: image.component.provider };
}

/** The `onnx` route: the model, one voice and this platform's runtime, each pinned by digest. */
async function onnxSpeechRoute(
  options: AcquireSpeechOptions,
  probe: HostProbe,
  log: (line: string) => void,
): Promise<TakenRoute> {
  const onnx = await acquireSpeechOnnx({
    toolchainDir: options.toolchainDir,
    probe,
    log,
    ...(options.onnxPins === undefined ? {} : { pins: options.onnxPins }),
  });
  log(`speech: in-process ONNX synthesiser at ${onnx.destination}`);
  return { component: onnx.component, provider: onnx.component.provider };
}

/**
 * Take exactly the route `--speech` named, or refuse saying why that route is unavailable.
 *
 * The refusal is a {@link SpeechRefusal} like the four-route one and carries the same exit code, and
 * it names **one** route on purpose: a user who typed `--speech docker` on a machine with no engine
 * is not helped by three paragraphs about routes they did not ask for, and the sentence they need is
 * the one about the route they did.
 */
async function pinnedSpeechRoute(
  route: SpeechRoute,
  options: AcquireSpeechOptions,
  probe: HostProbe,
  log: (line: string) => void,
): Promise<AcquiredSpeech> {
  log(`speech: --speech ${route} names the route, so the precedence is not walked`);
  try {
    const taken =
      route === DOCKER_PROVIDER
        ? dockerSpeechRoute(options, log)
        : await onnxSpeechRoute(options, probe, log);
    return { ...taken, skipped: {} };
  } catch (error) {
    if (!(error instanceof DockerUnavailable) && !(error instanceof OnnxUnavailable)) {
      throw error;
    }
    throw new SpeechRefusal(
      `\`--speech ${route}\` names a route this machine does not have:\n\n  ${error.message}\n\n` +
        "Nothing was written. Drop the flag to let setup take the first route that is available " +
        `here, or name the other one — ${PINNABLE_SPEECH_ROUTES.filter(
          (candidate) => candidate !== route,
        ).join(", ")} — or pass \`--tts-url <url>\` for a server you already run.`,
      { [route]: error.message },
    );
  }
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
