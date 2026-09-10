/**
 * The four speech routes, their precedence, and the refusal that names all four.
 *
 * Docker is reached through a `DockerRunner` parameter rather than through the real binary, which
 * is what lets every branch — no client, no engine, an image already present, a pull that failed —
 * be asserted on a machine with any Docker state at all. The runner itself is a real `spawnSync` in
 * production and there is no substitute for the *decisions*: the pinned digest, the separate
 * confirmation after the pull, and the fact that nothing here ever starts a container.
 *
 * The ONNX route gets the same treatment one level out: its **pins** are the parameter, and they
 * point at `setup/testing/onnx-artefacts.ts`'s four loopback servers rather than at HuggingFace and
 * the npm registry. The downloader, the digest checks and the tar reader are all the real ones.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseToolchainManifest, type ToolchainManifest } from "../manifest.js";
import { committedManifestPath } from "../source.js";
import { ARTEFACT_ROUTES, type ArtefactServer } from "../testing/artefact-server.js";
import { startOnnxArtefacts } from "../testing/onnx-artefacts.js";
import { acquireSpeech, EXTERNAL_VERSION, SpeechRefusal, URL_PROVIDER } from "./speech.js";
import {
  acquireSpeechImage,
  DOCKER_PROVIDER,
  DockerPullFailed,
  type DockerRunner,
  DockerUnavailable,
  dockerAvailable,
  KOKORO_IMAGE,
  KOKORO_PORT,
  speechContainerCommand,
} from "./speech-docker.js";
import { ONNX_PROVIDER } from "./speech-onnx.js";

const directories: string[] = [];
const servers: ArtefactServer[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function manifest(): ToolchainManifest {
  const path = committedManifestPath() ?? "";
  return parseToolchainManifest(readFileSync(path, "utf8"), path);
}

/** A Docker that answers, with the pinned image already in its store. */
function dockerWith(present: boolean, pulls: string[] = []): DockerRunner {
  let held = present;
  return (argv) => {
    if (argv[0] === "version") {
      return { started: true, status: 0, stdout: "27.0.0\n", stderr: "" };
    }
    if (argv[0] === "image" && argv[1] === "inspect") {
      return held
        ? { started: true, status: 0, stdout: "sha256:abc\n", stderr: "" }
        : { started: true, status: 1, stdout: "", stderr: "No such image\n" };
    }
    if (argv[0] === "pull") {
      pulls.push(argv[1] ?? "");
      held = true;
      return { started: true, status: 0, stdout: "Status: Downloaded\n", stderr: "" };
    }
    if (argv[0] === "run" || argv[0] === "start" || argv[0] === "create") {
      throw new Error("setup must never start a container");
    }
    return { started: true, status: 0, stdout: "", stderr: "" };
  };
}

/** No `docker` on this machine's PATH at all. */
const noDocker: DockerRunner = () => ({
  started: false,
  status: null,
  stdout: "",
  stderr: "",
});

/** Docker Desktop installed with its engine stopped, which is not the same fact. */
const noEngine: DockerRunner = (argv) =>
  argv[0] === "version"
    ? { started: true, status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon\n" }
    : { started: true, status: 1, stdout: "", stderr: "" };

describe("the pinned image", () => {
  /**
   * ADR 0006 makes the Kokoro-FastAPI HTTP contract this product's TTS interface, and
   * `services/tts-sidecar` fixes the same reference in `KOKORO_IMAGE` and in its `Dockerfile`.
   * Two sides of one pin that could drift apart silently is exactly what this asserts against.
   */
  it("is the digest services/tts-sidecar's own Dockerfile pins", () => {
    const dockerfile = readFileSync(
      fileURLToPath(new URL("../../../../../services/tts-sidecar/Dockerfile", import.meta.url)),
      "utf8",
    );

    expect(dockerfile).toContain(`FROM ${KOKORO_IMAGE}`);
    expect(KOKORO_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("names the command a user or a supervisor runs, because setup never starts one", () => {
    expect(speechContainerCommand()).toContain("docker run");
    expect(speechContainerCommand()).toContain(`${KOKORO_PORT}:${KOKORO_PORT}`);
    expect(speechContainerCommand()).toContain(KOKORO_IMAGE);
  });
});

describe("dockerAvailable", () => {
  it("tells a missing client apart from a stopped engine, because the repairs differ", () => {
    expect(dockerAvailable(noDocker)?.reason).toBe("no-docker");
    expect(dockerAvailable(noEngine)?.reason).toBe("no-daemon");
    expect(dockerAvailable(noEngine)?.message).toContain("Start Docker");
    expect(dockerAvailable(dockerWith(true))).toBeNull();
  });
});

describe("acquireSpeechImage", () => {
  it("pulls the pinned reference once, confirms it separately, and writes a receipt", () => {
    const toolchainDir = temporaryDirectory("xplainer-toolchain-");
    const pulls: string[] = [];

    const acquired = acquireSpeechImage({ toolchainDir, run: dockerWith(false, pulls) });

    expect(pulls).toEqual([KOKORO_IMAGE]);
    expect(acquired.pulled).toBe(true);
    expect(acquired.component.provider).toBe(DOCKER_PROVIDER);
    expect(acquired.component.version).toBe(KOKORO_IMAGE);
    expect(existsSync(acquired.component.path)).toBe(true);
    const receipt = JSON.parse(readFileSync(acquired.component.path, "utf8")) as {
      image: string;
      start: string;
    };
    expect(receipt.image).toBe(KOKORO_IMAGE);
    expect(receipt.start).toBe(speechContainerCommand());
  });

  it("does not pull an image Docker can already address", () => {
    const pulls: string[] = [];

    const acquired = acquireSpeechImage({
      toolchainDir: temporaryDirectory("xplainer-toolchain-"),
      run: dockerWith(true, pulls),
    });

    expect(pulls).toEqual([]);
    expect(acquired.pulled).toBe(false);
  });

  /**
   * The confirmation is a second `docker image inspect` rather than a reading of the pull's own
   * output: a pull that reported success and left nothing addressable is the failure it exists for,
   * and the pull's stdout is a progress log rather than an assertion.
   */
  it("refuses a pull that reported success and left nothing addressable", () => {
    const lying: DockerRunner = (argv) =>
      argv[0] === "version" || argv[0] === "pull"
        ? { started: true, status: 0, stdout: "", stderr: "" }
        : { started: true, status: 1, stdout: "", stderr: "No such image\n" };

    expect(() =>
      acquireSpeechImage({ toolchainDir: temporaryDirectory("xplainer-toolchain-"), run: lying }),
    ).toThrow(DockerPullFailed);
  });

  it("reports a machine with no Docker rather than treating it as a failure", () => {
    expect(() =>
      acquireSpeechImage({
        toolchainDir: temporaryDirectory("xplainer-toolchain-"),
        run: noDocker,
      }),
    ).toThrow(DockerUnavailable);
  });
});

describe("acquireSpeech", () => {
  it("takes --tts-url first, downloading nothing and starting nothing", async () => {
    const toolchainDir = temporaryDirectory("xplainer-toolchain-");

    const acquired = await acquireSpeech({
      manifest: async () => manifest(),
      toolchainDir,
      ttsUrl: "http://127.0.0.1:8880",
      runDocker: noDocker,
    });

    expect(acquired.provider).toBe(URL_PROVIDER);
    expect(acquired.component.version).toBe(EXTERNAL_VERSION);
    const receipt = JSON.parse(readFileSync(acquired.component.path, "utf8")) as { url: string };
    expect(receipt.url).toBe("http://127.0.0.1:8880");
  });

  /**
   * Nothing is published to `cdn.xplainer.video` this phase, so a machine reaching for the manifest
   * it does not need would be refused for a document no route it takes ever reads. The thunk is
   * what makes that impossible, and a thunk that throws is how it is asserted.
   */
  it("never reaches for the manifest on a route that does not need one", async () => {
    const acquired = await acquireSpeech({
      manifest: () => {
        throw new Error("the manifest must not be fetched for the --tts-url route");
      },
      toolchainDir: temporaryDirectory("xplainer-toolchain-"),
      ttsUrl: "http://127.0.0.1:8880",
      runDocker: noDocker,
    });

    expect(acquired.provider).toBe(URL_PROVIDER);

    const pulled = await acquireSpeech({
      manifest: () => {
        throw new Error("the manifest must not be fetched for the docker route");
      },
      toolchainDir: temporaryDirectory("xplainer-toolchain-"),
      runDocker: dockerWith(true),
    });

    expect(pulled.provider).toBe(DOCKER_PROVIDER);
  });

  it("falls to docker when no URL was given", async () => {
    const acquired = await acquireSpeech({
      manifest: async () => manifest(),
      toolchainDir: temporaryDirectory("xplainer-toolchain-"),
      runDocker: dockerWith(true),
    });

    expect(acquired.provider).toBe(DOCKER_PROVIDER);
  });

  /**
   * With Docker absent, the `onnx` route is the one that runs — and it is the one that closes the
   * machines the other three never covered. Asserted with pins pointed at loopback rather than at
   * HuggingFace and the npm registry, because the decision under test is the *precedence* and not
   * the two hundred megabytes.
   */
  it("falls to the in-process ONNX route when there is no URL and no Docker", async () => {
    const artefacts = await startOnnxArtefacts();
    servers.push(...artefacts.servers);

    const acquired = await acquireSpeech({
      manifest: () => {
        throw new Error("the manifest must not be fetched for the onnx route");
      },
      toolchainDir: temporaryDirectory("xplainer-toolchain-"),
      runDocker: noDocker,
      onnxPins: artefacts.pins,
    });

    expect(acquired.provider).toBe(ONNX_PROVIDER);
    expect(acquired.component.files?.length).toBeGreaterThan(3);
  });

  /**
   * Docker keeps every machine that has an engine, and that is deliberate rather than incidental:
   * `scripts/e2e/toolchain.mjs` decides its own plan from `docker version`, runs `setup` with no
   * `--tts-url` when that answers, and then opens `marker.speech.path` **as the docker receipt** to
   * read `receipt.image`. An `onnx`-first order would have that gate `JSON.parse` a 92 MB model.
   */
  it("keeps docker above onnx, so no machine with an engine changes route", async () => {
    const artefacts = await startOnnxArtefacts();
    servers.push(...artefacts.servers);

    const acquired = await acquireSpeech({
      manifest: async () => manifest(),
      toolchainDir: temporaryDirectory("xplainer-toolchain-"),
      runDocker: dockerWith(true),
      onnxPins: artefacts.pins,
    });

    expect(acquired.provider).toBe(DOCKER_PROVIDER);
    expect(artefacts.model.requests).toHaveLength(0);
    expect(artefacts.runtime.requests).toHaveLength(0);
  });

  /**
   * A route that is available and *fails* is raised, and this is the case that proves `onnx` sits
   * **above** `bundle` in the fall-through: a 404 on the model must not be replaced by a message
   * about a bundle that was never published.
   */
  it("raises an onnx acquisition that failed rather than reporting the bundle instead", async () => {
    const artefacts = await startOnnxArtefacts({ model: ARTEFACT_ROUTES.missing });
    servers.push(...artefacts.servers);

    await expect(
      acquireSpeech({
        manifest: async () => manifest(),
        toolchainDir: temporaryDirectory("xplainer-toolchain-"),
        runDocker: noDocker,
        onnxPins: artefacts.pins,
      }),
    ).rejects.toThrow(/is not at that address/);
  });

  /**
   * Nothing is published to `cdn.xplainer.video` this phase (§2.5), so every platform's speech
   * entry records that rather than being absent — and the refusal a user meets is the manifest's
   * own recorded reason, quoted, beside the routes that do work.
   *
   * `darwin-x64` is the one host where all four are unavailable, which is what makes it the case
   * that reaches the refusal at all: `onnxruntime-node` publishes no binding for it, so the ONNX
   * route reports itself absent rather than fetching, and the manifest has no `darwin-x64` speech
   * entry either.
   */
  it("refuses naming all four routes when none of them is possible", async () => {
    const failure = await acquireSpeech({
      manifest: async () => manifest(),
      toolchainDir: temporaryDirectory("xplainer-toolchain-"),
      runDocker: noDocker,
      probe: { platform: "darwin", arch: "x64", osRelease: null, glibc: null },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SpeechRefusal);
    const refusal = failure as SpeechRefusal;
    expect(refusal.exitCode).toBe(3);
    expect(Object.keys(refusal.routes).sort()).toEqual([
      "--tts-url <url>",
      "bundle",
      "docker",
      "onnx",
    ]);
    expect(refusal.message).toContain("--tts-url");
    expect(refusal.message).toContain("docker");
    expect(refusal.message).toContain("bundle");
    expect(refusal.routes.onnx).toContain("no darwin/x64");
    expect(refusal.message).toContain("Nothing was written");
  });

  /** A route that is available and *fails* is raised, never fallen through into a worse message. */
  it("raises a pull that failed rather than reporting the bundle instead", async () => {
    const brokenPull: DockerRunner = (argv) =>
      argv[0] === "version"
        ? { started: true, status: 0, stdout: "27.0.0\n", stderr: "" }
        : argv[0] === "pull"
          ? { started: true, status: 1, stdout: "", stderr: "no space left on device\n" }
          : { started: true, status: 1, stdout: "", stderr: "" };

    await expect(
      acquireSpeech({
        manifest: async () => manifest(),
        toolchainDir: temporaryDirectory("xplainer-toolchain-"),
        runDocker: brokenPull,
      }),
    ).rejects.toThrow(/no space left on device/);
  });
});
