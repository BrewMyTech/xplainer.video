/**
 * The `docker` speech provider: pull the pinned image, and never start it.
 *
 * **The image is pinned by digest, not by tag.** `services/tts-sidecar` fixes the same reference in
 * `KOKORO_IMAGE` and in its `Dockerfile`'s `FROM`, and ADR 0006 makes the Kokoro-FastAPI HTTP
 * contract this product's TTS interface — so a tag would let the thing behind that contract change
 * under a machine that had already run `setup`. `docker pull` of a digest reference is
 * content-addressed by Docker itself: there is nothing for this module to hash, and re-hashing what
 * Docker already verified would be a second, weaker check of the same bytes.
 *
 * **The daemon never starts a container, and this is where that is decided.** `setup` pulls it, the
 * user or the supervisor runs it, and the daemon reports its absence with the command that starts
 * it — {@link speechContainerCommand}. A background service that started a container would be
 * arranging compute nobody asked it for, on a machine whose owner may be metered, and it would own
 * a lifetime it has no way to give back on uninstall.
 *
 * **What is recorded is a receipt.** `toolchain.json`'s `path` is checked for existence by the
 * install preflight, and a pulled image is not a path — it is a record in Docker's own store. So
 * the acquisition writes one small file naming the image and the digest it pulled, records that
 * file, and re-verifies against Docker on every `setup`. The receipt proves the pull happened on
 * this machine; `docker image inspect` is what proves it is still there, and that is why `setup`
 * asks it again rather than trusting the file it wrote.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolchainComponent } from "@xplainer/protocol";
import { hashFile } from "../../runtime/manifest.js";

/** The `provider` token the marker records for this route. */
export const DOCKER_PROVIDER = "docker";

/**
 * The pinned Kokoro-FastAPI image, by digest.
 *
 * The same reference `services/tts-sidecar`'s `KOKORO_IMAGE` and `Dockerfile` carry.
 * `speech-docker.test.ts` reads that `Dockerfile` and compares, so the two sides of one pin cannot
 * drift apart silently — which is the rule ADR 0006 states for the contract and this is the pin
 * half of it.
 */
export const KOKORO_IMAGE =
  "ghcr.io/remsky/kokoro-fastapi-cpu@sha256:28d6f0b6e4df369559012578299d201b855a08fac466f616653edd1f08c5370a";

/** The port the sidecar's own default `base_url` names, and the one the run command publishes. */
export const KOKORO_PORT = 8880;

/** The receipt's name under the toolchain directory's `speech/`. */
export const DOCKER_RECEIPT_FILE = "speech/docker.json";

/** How this module reaches Docker. A parameter, so every branch is testable with no Docker. */
export type DockerRunner = (argv: readonly string[]) => {
  started: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
};

/** The real `docker`, with both streams captured and a failed spawn reported rather than raised. */
export const runDocker: DockerRunner = (argv) => {
  const result = spawnSync("docker", [...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: DOCKER_TIMEOUT_MS,
  });
  return {
    started: result.error === undefined,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

/** A pull of a several-hundred-megabyte image is not a five-second query. */
export const DOCKER_TIMEOUT_MS = 900_000;

/** Why the docker route is not available on this machine. */
export type DockerUnavailableReason = "no-docker" | "no-daemon";

/** The docker route was not taken, with the sentence that says why. */
export class DockerUnavailable extends Error {
  readonly reason: DockerUnavailableReason;

  constructor(reason: DockerUnavailableReason, message: string) {
    super(message);
    this.name = "DockerUnavailable";
    this.reason = reason;
  }
}

/** The pull ran and did not produce the pinned image. */
export class DockerPullFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerPullFailed";
  }
}

/** The command a user or a supervisor runs to start the provider `setup` pulled. */
export function speechContainerCommand(image: string = KOKORO_IMAGE): string {
  return `docker run -d --name xplainer-kokoro -p ${KOKORO_PORT}:${KOKORO_PORT} ${image}`;
}

/**
 * Whether a Docker **daemon** is reachable, which is the question that matters.
 *
 * `docker` being on `PATH` is not the same fact: Docker Desktop installs the client and leaves the
 * engine stopped, so `command -v docker` reports a route that every pull would then fail on. The
 * query is `docker version --format {{.Server.Version}}`, which needs the server to answer.
 */
export function dockerAvailable(run: DockerRunner = runDocker): DockerUnavailable | null {
  const probe = run(["version", "--format", "{{.Server.Version}}"]);
  if (!probe.started) {
    return new DockerUnavailable(
      "no-docker",
      "docker is not on this machine's PATH, so the pinned speech image cannot be pulled.",
    );
  }
  if (probe.status !== 0) {
    return new DockerUnavailable(
      "no-daemon",
      "docker is installed and its engine is not answering (`docker version` exited " +
        `${String(probe.status)}: ${(probe.stderr || probe.stdout).trim()}). Start Docker and ` +
        "run setup again.",
    );
  }
  return null;
}

/** What {@link acquireSpeechImage} was asked to do. */
export type AcquireImageOptions = {
  /** Where acquisitions live on this machine — `<state>/toolchain`, as `setup` resolves it. */
  toolchainDir: string;
  /** The image reference, by digest. Defaults to {@link KOKORO_IMAGE}. */
  image?: string | undefined;
  run?: DockerRunner | undefined;
  log?: (line: string) => void;
};

/** What one pull produced, in the shape `toolchain.json` records. */
export type AcquiredSpeechImage = {
  component: ToolchainComponent;
  /** Whether this call pulled anything, or found the image already in Docker's store. */
  pulled: boolean;
};

/**
 * Pull the pinned image if it is not already here, confirm it, and write the receipt.
 *
 * The confirmation is a separate `docker image inspect` **after** the pull rather than a reading of
 * the pull's own output: a pull that reported success and left nothing addressable is the failure
 * this check exists for, and the pull's stdout is a progress log rather than an assertion.
 */
export function acquireSpeechImage(options: AcquireImageOptions): AcquiredSpeechImage {
  const log = options.log ?? ((): void => {});
  const run = options.run ?? runDocker;
  const image = options.image ?? KOKORO_IMAGE;

  const unavailable = dockerAvailable(run);
  if (unavailable !== null) {
    throw unavailable;
  }

  let pulled = false;
  if (!imagePresent(run, image)) {
    log(`speech: docker pull ${image}`);
    const pull = run(["pull", image]);
    if (!pull.started || pull.status !== 0) {
      throw new DockerPullFailed(
        `\`docker pull ${image}\` exited ${String(pull.status)}: ` +
          `${(pull.stderr || pull.stdout).trim()}`,
      );
    }
    pulled = true;
  } else {
    log(`speech: ${image} is already in this machine's Docker store`);
  }

  if (!imagePresent(run, image)) {
    throw new DockerPullFailed(
      `${image} is still not in this machine's Docker store after a pull that reported success. ` +
        "Nothing was recorded.",
    );
  }

  const receipt = writeReceipt(options.toolchainDir, image);
  return {
    component: {
      version: image,
      path: receipt,
      sha256: hashFile(receipt),
      provider: DOCKER_PROVIDER,
    },
    pulled,
  };
}

/** Whether Docker can address the pinned reference right now. */
function imagePresent(run: DockerRunner, image: string): boolean {
  const probe = run(["image", "inspect", image, "--format", "{{.Id}}"]);
  return probe.started && probe.status === 0 && probe.stdout.trim() !== "";
}

/** The one file this route leaves on disk: what was pulled, and what starts it. */
function writeReceipt(toolchainDir: string, image: string): string {
  const path = join(toolchainDir, ...DOCKER_RECEIPT_FILE.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        provider: DOCKER_PROVIDER,
        image,
        port: KOKORO_PORT,
        start: speechContainerCommand(image),
        note: "setup pulls this image; the daemon never starts a container (T19).",
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

/** Whether a receipt this module wrote is still on disk, which is what the marker's path names. */
export function receiptPath(toolchainDir: string): string {
  return join(toolchainDir, ...DOCKER_RECEIPT_FILE.split("/"));
}

/** Whether the receipt exists — used by `setup` to report a re-run without re-querying Docker. */
export function receiptPresent(toolchainDir: string): boolean {
  return existsSync(receiptPath(toolchainDir));
}
