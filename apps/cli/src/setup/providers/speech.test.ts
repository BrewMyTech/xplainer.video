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
import type { ToolchainComponent } from "@xplainer/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { parseToolchainManifest, type ToolchainManifest } from "../manifest.js";
import { committedManifestPath } from "../source.js";
import { ARTEFACT_ROUTES, type ArtefactServer } from "../testing/artefact-server.js";
import { startOnnxArtefacts } from "../testing/onnx-artefacts.js";
import {
  acquireSpeech,
  EXTERNAL_VERSION,
  isSpeechRoute,
  PINNABLE_SPEECH_ROUTES,
  recordExternal,
  SpeechRefusal,
  URL_PROVIDER,
} from "./speech.js";
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
      // darwin-x64 has no ONNX binding, which is how the walk reaches docker with no pins to
      // point at loopback — see the reordering test below. A host that *does* have one would take
      // the onnx route here and fetch 204 MB from HuggingFace inside a unit test.
      probe: { platform: "darwin", arch: "x64", osRelease: null, glibc: null },
    });

    expect(pulled.provider).toBe(DOCKER_PROVIDER);
  });

  it("falls to docker when there is no URL and no ONNX binding for this host", async () => {
    const acquired = await acquireSpeech({
      manifest: async () => manifest(),
      toolchainDir: temporaryDirectory("xplainer-toolchain-"),
      runDocker: dockerWith(true),
      // darwin-x64 is the one host `onnxruntime-node` publishes no binding for, so it is the only
      // way to reach the docker route without a `--speech` flag — which is the whole content of the
      // reordering below.
      probe: { platform: "darwin", arch: "x64", osRelease: null, glibc: null },
    });

    expect(acquired.provider).toBe(DOCKER_PROVIDER);
    expect(acquired.skipped.onnx).toContain("no darwin/x64");
  });

  /**
   * The reordering, and the reason for it: a machine with a container engine used to record
   * `docker` and never take the in-process route, which defeats what ADR 0028 exists for — a user
   * should not need Docker for a voiceover. Asserted with pins pointed at loopback rather than at
   * HuggingFace and the npm registry, because the decision under test is the *precedence* and not
   * the two hundred megabytes.
   */
  it("takes onnx above docker, so a machine with an engine still gets the better route", async () => {
    const artefacts = await startOnnxArtefacts();
    servers.push(...artefacts.servers);

    const acquired = await acquireSpeech({
      manifest: () => {
        throw new Error("the manifest must not be fetched for the onnx route");
      },
      toolchainDir: temporaryDirectory("xplainer-toolchain-"),
      runDocker: dockerWith(true),
      onnxPins: artefacts.pins,
    });

    expect(acquired.provider).toBe(ONNX_PROVIDER);
    expect(acquired.component.files?.length).toBeGreaterThan(3);
    // Nothing was pulled: the docker route is below this one now, so it is never even probed.
    expect(acquired.skipped.docker).toBeUndefined();
  });

  it("takes onnx on a machine with no Docker at all, which is the host it was written for", async () => {
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
  });

  /**
   * Every route not taken is reported on a *successful* run too, which is the half that was
   * missing: the reasons were collected for the refusal and thrown away when a route worked, so the
   * one line `setup` printed could not answer "why this one?".
   */
  it("says why each route it walked past was not taken", async () => {
    const acquired = await acquireSpeech({
      manifest: async () => manifest(),
      toolchainDir: temporaryDirectory("xplainer-toolchain-"),
      runDocker: noDocker,
      probe: { platform: "darwin", arch: "x64", osRelease: null, glibc: null },
    }).catch((error: unknown) => error);

    // darwin-x64 has none of the four, so the walk is visible end to end in one value.
    expect(acquired).toBeInstanceOf(SpeechRefusal);
    expect(Object.keys((acquired as SpeechRefusal).routes)).toEqual([
      "--tts-url <url>",
      ONNX_PROVIDER,
      DOCKER_PROVIDER,
      "bundle",
    ]);
  });
});

/**
 * The migration case: a machine that already records a working `docker` route keeps it.
 *
 * This is the one thing `recorded` is used for and it is deliberately narrow. `setup` is
 * re-runnable by design, and a re-run is the worst moment to move a machine's narration onto a
 * different engine — the container is running, it is what every previous narration was spoken by,
 * and the switch would fetch ~204 MB to replace something that works. `--speech onnx` is how a user
 * asks for it, and the only way it happens.
 */
describe("acquireSpeech and a machine that has already run setup", () => {
  /** The `speech` component a previous `setup` recorded for the docker route. */
  function recordedDocker(toolchainDir: string): ToolchainComponent {
    return acquireSpeechImage({ toolchainDir, run: dockerWith(true) }).component;
  }

  it("keeps a recorded docker route rather than switching the engine under it", async () => {
    const toolchainDir = temporaryDirectory("xplainer-toolchain-");
    const artefacts = await startOnnxArtefacts();
    servers.push(...artefacts.servers);

    const acquired = await acquireSpeech({
      manifest: () => {
        throw new Error("the manifest must not be fetched for the docker route");
      },
      toolchainDir,
      runDocker: dockerWith(true),
      onnxPins: artefacts.pins,
      recorded: recordedDocker(toolchainDir),
    });

    expect(acquired.provider).toBe(DOCKER_PROVIDER);
    // And not a byte of the 204 MB was fetched to sit unused beside the container.
    expect(artefacts.model.requests).toHaveLength(0);
    expect(artefacts.runtime.requests).toHaveLength(0);
  });

  it("says it kept it, and names the command that switches", async () => {
    const toolchainDir = temporaryDirectory("xplainer-toolchain-");
    const lines: string[] = [];

    await acquireSpeech({
      manifest: async () => manifest(),
      toolchainDir,
      runDocker: dockerWith(true),
      recorded: recordedDocker(toolchainDir),
      log: (line) => lines.push(line),
    });

    const said = lines.join("\n");
    expect(said).toContain("kept the docker route this machine already records");
    expect(said).toContain(`xplainer setup --speech ${ONNX_PROVIDER}`);
    // And it says why the route it would otherwise have taken was not tried, rather than leaving
    // "recorded the docker route" to be read as "this machine has no ONNX binding".
    expect(said).toContain("not the onnx route — not tried");
  });

  /**
   * A machine that has *lost* its engine is not a machine to keep on the docker route: the recorded
   * route is asked of Docker rather than believed, so this falls through and the host gets the
   * in-process engine — which is the migration the reordering is for, arriving when the container
   * has stopped being the answer.
   */
  it("falls through to onnx when the recorded route no longer works here", async () => {
    const toolchainDir = temporaryDirectory("xplainer-toolchain-");
    const recorded = recordedDocker(toolchainDir);
    const artefacts = await startOnnxArtefacts();
    servers.push(...artefacts.servers);

    const acquired = await acquireSpeech({
      manifest: () => {
        throw new Error("the manifest must not be fetched for the onnx route");
      },
      toolchainDir,
      runDocker: noDocker,
      onnxPins: artefacts.pins,
      recorded,
    });

    expect(acquired.provider).toBe(ONNX_PROVIDER);
    expect(acquired.skipped["recorded docker"]).toContain("no longer usable here");
  });

  /** A recorded `url` or `onnx` component is not part of the rule, and does not freeze the walk. */
  it("keeps nothing but docker, because docker is the only route the reordering displaces", async () => {
    const artefacts = await startOnnxArtefacts();
    servers.push(...artefacts.servers);
    const toolchainDir = temporaryDirectory("xplainer-toolchain-");

    const acquired = await acquireSpeech({
      manifest: () => {
        throw new Error("the manifest must not be fetched for the onnx route");
      },
      toolchainDir,
      runDocker: dockerWith(true),
      onnxPins: artefacts.pins,
      recorded: recordExternal(toolchainDir, "http://127.0.0.1:8880"),
    });

    expect(acquired.provider).toBe(ONNX_PROVIDER);
  });
});

describe("acquireSpeech and --speech <route>", () => {
  it("takes the route it names and walks no precedence at all", async () => {
    const artefacts = await startOnnxArtefacts();
    servers.push(...artefacts.servers);

    const pinned = await acquireSpeech({
      manifest: () => {
        throw new Error("a pinned route needs no manifest");
      },
      toolchainDir: temporaryDirectory("xplainer-toolchain-"),
      // Docker answers and a docker route is recorded, and neither wins: the flag did.
      runDocker: dockerWith(true),
      recorded: acquireSpeechImage({
        toolchainDir: temporaryDirectory("xplainer-toolchain-"),
        run: dockerWith(true),
      }).component,
      onnxPins: artefacts.pins,
      route: ONNX_PROVIDER,
    });

    expect(pinned.provider).toBe(ONNX_PROVIDER);
    expect(pinned.skipped).toEqual({});
  });

  /**
   * `--speech docker` is what `scripts/e2e/toolchain.mjs` passes, so that the gate names the route
   * it is proving instead of inferring it from a precedence it does not own — which is what let the
   * product put `onnx` first at all.
   */
  it("pins docker on a host where onnx would otherwise win", async () => {
    const artefacts = await startOnnxArtefacts();
    servers.push(...artefacts.servers);

    const pinned = await acquireSpeech({
      manifest: async () => manifest(),
      toolchainDir: temporaryDirectory("xplainer-toolchain-"),
      runDocker: dockerWith(true),
      onnxPins: artefacts.pins,
      route: DOCKER_PROVIDER,
    });

    expect(pinned.provider).toBe(DOCKER_PROVIDER);
    expect(artefacts.model.requests).toHaveLength(0);
  });

  /** A route somebody named is an instruction, so an unavailable one refuses rather than falls. */
  it("refuses a named route this machine does not have, naming that route and nothing else", async () => {
    const failure = await acquireSpeech({
      manifest: async () => manifest(),
      toolchainDir: temporaryDirectory("xplainer-toolchain-"),
      runDocker: noDocker,
      route: DOCKER_PROVIDER,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SpeechRefusal);
    const refusal = failure as SpeechRefusal;
    expect(refusal.exitCode).toBe(3);
    expect(Object.keys(refusal.routes)).toEqual([DOCKER_PROVIDER]);
    expect(refusal.message).toContain("`--speech docker` names a route this machine does not have");
    expect(refusal.message).toContain("Nothing was written");
    expect(refusal.message).toContain(ONNX_PROVIDER);
  });

  /** `--tts-url` wins outright: a URL is a server to talk to, a route is something to acquire. */
  it("loses to --tts-url, and says so rather than quietly ignoring one of them", async () => {
    const lines: string[] = [];

    const acquired = await acquireSpeech({
      manifest: () => {
        throw new Error("the manifest must not be fetched for the --tts-url route");
      },
      toolchainDir: temporaryDirectory("xplainer-toolchain-"),
      ttsUrl: "http://127.0.0.1:8880",
      runDocker: noDocker,
      route: DOCKER_PROVIDER,
      log: (line) => lines.push(line),
    });

    expect(acquired.provider).toBe(URL_PROVIDER);
    expect(lines.join("\n")).toContain("--tts-url names a server outright");
  });
});

describe("isSpeechRoute", () => {
  it("admits the two routes that acquire something and nothing else", () => {
    expect(PINNABLE_SPEECH_ROUTES).toEqual([ONNX_PROVIDER, DOCKER_PROVIDER]);
    expect(isSpeechRoute(ONNX_PROVIDER)).toBe(true);
    expect(isSpeechRoute(DOCKER_PROVIDER)).toBe(true);
    // `url` needs a value and has `--tts-url`; `bundle` reads an address nothing is published to.
    expect(isSpeechRoute(URL_PROVIDER)).toBe(false);
    expect(isSpeechRoute("bundle")).toBe(false);
    expect(isSpeechRoute("")).toBe(false);
  });
});

/**
 * Plan D5's rule at the acquisition end: an *absent* route falls through, a route that **failed** is
 * raised, and nothing is ever silently substituted for what was asked for.
 */
describe("acquireSpeech refusals", () => {
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
        // The claim is about the *walk*, so the docker route has to be reached by falling through
        // rather than by `--speech docker`: darwin-x64 is the host with no ONNX binding, so `onnx`
        // reports itself absent, docker is tried, and its failure must not become a message about
        // the bundle below it.
        probe: { platform: "darwin", arch: "x64", osRelease: null, glibc: null },
      }),
    ).rejects.toThrow(/no space left on device/);
  });
});
