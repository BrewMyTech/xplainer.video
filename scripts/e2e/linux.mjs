#!/usr/bin/env node
/**
 * The Linux half of roadmap **P1-1**, run on this machine: `scripts/e2e/render.mjs` inside a
 * headless Debian container, against a Kokoro container, with the network and both containers
 * created and destroyed around it.
 *
 * ```bash
 * pnpm e2e:render:linux
 * ```
 *
 * WHY A WRAPPER AND NOT A COMPOSE FILE. The proof is a sequence whose last step — copy the
 * artefacts out, then remove both the containers and the network — has to run whether or not it
 * passed, which is exactly what a Compose file cannot express. The repository's Compose files are
 * also generated and owned elsewhere; this proof stays out of them and uses plain `docker build`,
 * `docker run` and `docker network`.
 *
 * WHAT THE CONTAINER REACHES BESIDES KOKORO. Since 2026-09-09 `render.mjs` runs a real
 * `xplainer setup` inside the container — the batch-6 toolchain gate refuses `explainer_still` and
 * `explainer_render` on a machine with no `<state>/toolchain.json`, and there is no honest way past
 * it — so the run now fetches a ~100 MB headless shell and resolves the render workspace with
 * `npm ci` from the public registry. The user-defined bridge below gives it that, exactly as it
 * gives Kokoro its image; a machine that can build the image can run the proof. The image's own
 * `remotion browser ensure` layer stays where it is and is now borrowed explicitly: `render.mjs`
 * links `/repo/node_modules/.remotion` into the workspace `setup` materialised, so Remotion's own
 * copy of the same browser is not fetched a second time inside the measured still job.
 *
 * WHY ITS OWN NETWORK AND ITS OWN KOKORO. A developer machine very often already has a Kokoro
 * container answering on host port 8880, and this script must neither disturb it nor depend on it.
 * It starts its own on a user-defined bridge network, publishes no host port at all, and reaches
 * it by container name — so two Kokoros coexist and the run is reproducible on a machine that has
 * none.
 *
 * WHAT IT LEAVES BEHIND. `$COLLIE_ARTIFACTS_DIR/e2e-linux.log` (the container's full transcript,
 * including the `ffprobe` report and the `queued → running → done` sequences) and
 * `e2e-linux.mp4`, plus the three frames the caption comparison is made of. The container writes
 * them to a bind-mounted directory as it goes, so a run that dies mid-render still leaves its
 * transcript on the host.
 *
 * Environment: `COLLIE_ARTIFACTS_DIR` (default `<repo>/.session/artifacts`) and `XPLAINER_DOCKER`
 * (default `docker`). The Kokoro image and the container names are constants below — they are part
 * of the proof, not a configuration surface.
 *
 * Exit codes:
 *   0  the end-to-end run passed on Linux
 *   1  it failed — the step is named on stderr and the transcript is copied out regardless
 *   2  Docker is not usable on this machine
 * 130  interrupted; the containers and the network are removed before exiting
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** The repository root, three levels up from this file. */
const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** Where the transcript and the MP4 are left for a human to look at. */
const ARTIFACTS =
  (process.env.COLLIE_ARTIFACTS_DIR ?? "").trim() || join(REPO, ".session/artifacts");

/** The host side of the container's `/artifacts`, emptied before every run. */
const MOUNT = join(ARTIFACTS, "e2e-linux");

/** The Docker CLI. Overridable only so a machine with a differently named client can run this. */
const DOCKER = (process.env.XPLAINER_DOCKER ?? "").trim() || "docker";

/** Named for this proof so nothing here can collide with a container a developer already has. */
const NETWORK = "xplainer-e2e-linux";
const KOKORO = "xplainer-e2e-kokoro-linux";
const RUNNER = "xplainer-e2e-render-linux";
const IMAGE = "xplainer-e2e-linux:local";

/** The same pinned CPU image `infra/docker-compose.tts.yml` and P1-3 use. */
const KOKORO_IMAGE = "ghcr.io/remsky/kokoro-fastapi-cpu:latest";

/**
 * Kokoro loads its voice pack on boot; on a cold pull that is minutes, not seconds.
 *
 * Handed to `render.mjs` as `XPLAINER_TTS_WAIT_MS` rather than spent in a probe container here.
 * `render.mjs` already waits for the same endpoint before it narrates, and it waits from inside the
 * network on the address the render will actually use — so a second probe would prove nothing more
 * and would keep its evidence out of the transcript this run copies to the host.
 */
const KOKORO_READY_TIMEOUT_MS = 600_000;

/**
 * What the container produced, and what it is called on the host. The renames are the point: a
 * `.session/artifacts` directory ends up holding one macOS set and one Linux set of the same
 * proof, and P1-1 is judged on both.
 */
const ARTEFACTS = [
  ["e2e-render.log", "e2e-linux.log"],
  ["e2e-sample.mp4", "e2e-linux.mp4"],
  ["e2e-still.png", "e2e-linux-still.png"],
  ["e2e-frame-captioned.png", "e2e-linux-frame-captioned.png"],
  ["e2e-frame-nocaptions.png", "e2e-linux-frame-nocaptions.png"],
];

function say(text) {
  process.stdout.write(`${text}\n`);
}

function section(title) {
  say("");
  say(`── ${title} ${"─".repeat(Math.max(0, 76 - title.length))}`);
}

/** Run a Docker command with its output on this process's streams, refusing a non-zero exit. */
function docker(args, label) {
  const result = spawnSync(DOCKER, args, { cwd: REPO, stdio: "inherit" });
  if (result.error !== undefined) {
    throw new Error(`${label}: ${DOCKER} could not be run (${result.error.message})`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${label}: ${DOCKER} ${args[0]} exited ${result.status ?? `on ${result.signal}`}`,
    );
  }
}

/** Best effort: used only for teardown, where a missing container is the desired end state. */
function dockerQuietly(args) {
  spawnSync(DOCKER, args, { cwd: REPO, stdio: ["ignore", "ignore", "ignore"] });
}

/**
 * Remove both containers and the network, in dependency order. Safe to call twice and safe to call
 * before anything was created, which is what lets it be the single teardown for the success path,
 * the failure path and the signal path alike.
 */
function teardown() {
  dockerQuietly(["rm", "-f", RUNNER]);
  dockerQuietly(["rm", "-f", KOKORO]);
  dockerQuietly(["network", "rm", NETWORK]);
}

/** Copy whatever the container managed to produce, and say which of it is missing. */
function collect() {
  mkdirSync(ARTIFACTS, { recursive: true });
  const copied = [];
  for (const [inside, outside] of ARTEFACTS) {
    const from = join(MOUNT, inside);
    if (!existsSync(from)) {
      continue;
    }
    copyFileSync(from, join(ARTIFACTS, outside));
    copied.push(`${outside} (${(statSync(from).size / 1024).toFixed(0)} KB)`);
  }
  for (const line of copied) {
    say(`  ${line}`);
  }
  if (copied.length === 0) {
    say("  the container produced no artefacts at all");
  }
  try {
    rmSync(MOUNT, { recursive: true, force: true });
  } catch (error) {
    say(`  could not remove ${MOUNT}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireDocker() {
  const result = spawnSync(
    DOCKER,
    ["version", "--format", "{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}"],
    {
      encoding: "utf8",
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    process.stderr.write(
      `${DOCKER} is not usable here: ${(result.stderr ?? result.error?.message ?? "").trim()}\n`,
    );
    process.exit(2);
  }
  return result.stdout.trim();
}

/** The Node the image is built on, so the container runs the version this repository pins. */
function nodeVersion() {
  return readFileSync(join(REPO, ".node-version"), "utf8").trim();
}

function main() {
  const engine = requireDocker();
  const pinned = nodeVersion();

  say(`xplainer end-to-end on Linux, in Docker — ${new Date().toISOString()}`);
  say(`  repository:  ${REPO}`);
  say(`  engine:      ${engine}`);
  say(`  node pin:    ${pinned} (from .node-version)`);
  say(`  artifacts:   ${ARTIFACTS}`);

  // A container from a previous interrupted run holds both the name and the network.
  teardown();
  rmSync(MOUNT, { recursive: true, force: true });
  mkdirSync(MOUNT, { recursive: true });

  section("build the image");
  docker(
    [
      "build",
      "--file",
      "infra/e2e/Dockerfile",
      "--build-arg",
      `NODE_VERSION=${pinned}`,
      "--tag",
      IMAGE,
      ".",
    ],
    "image build",
  );

  section("kokoro");
  docker(["network", "create", NETWORK], "network create");
  docker(
    ["run", "--detach", "--name", KOKORO, "--network", NETWORK, KOKORO_IMAGE],
    "kokoro container",
  );

  section("render");
  docker(
    [
      "run",
      "--rm",
      "--name",
      RUNNER,
      "--network",
      NETWORK,
      // Chrome's default 64 MB /dev/shm is not enough for a 1920×1080 render.
      "--shm-size=1g",
      "--env",
      `XPLAINER_TTS_URL=http://${KOKORO}:8880`,
      "--env",
      `XPLAINER_TTS_WAIT_MS=${KOKORO_READY_TIMEOUT_MS}`,
      "--env",
      "COLLIE_ARTIFACTS_DIR=/artifacts",
      "--volume",
      `${MOUNT}:/artifacts`,
      IMAGE,
    ],
    "end-to-end run",
  );
}

let exitCode = 0;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    teardown();
    process.exit(130);
  });
}

try {
  main();
  say("");
  say("END-TO-END ON LINUX PASSED");
} catch (error) {
  exitCode = 1;
  process.stderr.write(
    `\nEND-TO-END ON LINUX FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
  );
} finally {
  section("artifacts");
  collect();
  section("teardown");
  teardown();
  say(`  removed ${RUNNER}, ${KOKORO} and the network ${NETWORK}`);
}

process.exit(exitCode);
