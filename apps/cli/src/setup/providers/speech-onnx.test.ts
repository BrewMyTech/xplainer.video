/**
 * The ONNX speech acquisition, against four real loopback servers.
 *
 * The route fetches ~200 MB in production, so every case here points its pins at
 * `setup/testing/artefact-server.ts` instead — a real `node:http` server with one route per way a
 * download goes wrong. That is the same rule the rest of this package follows and it is not a
 * convenience: there is no `vi.mock` anywhere in `@xplainer/cli`, and a digest mismatch, a resume a
 * server did not honour and a partial that is deleted rather than resumed onto are all *server*
 * behaviours, which a double in front of `fetch` would assert nothing about.
 *
 * The runtime tarball is `fixtures/npm-package-fixture.tgz` — `npm pack`'s own output, carrying
 * three `bin/napi-v6` platform subtrees — so "one platform out of the five the real package ships"
 * is proved on a machine that is only ever one of them, through the `platform` pin.
 *
 * Two of the four artefacts are **plain files** and go through `acquireFile`, which has no
 * extension rule at all, so they are served from the `.zip`-spelled routes without ceremony: the
 * route names describe behaviours and the extension in them exists only for the callers that refuse
 * on it.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACQUIRED_FILE, readAcquired } from "../acquired.js";
import { sha256Of } from "../archive.js";
import { DownloadRefusal } from "../download.js";
import type { HostProbe } from "../manifest.js";
import { ARTEFACT_ROUTES, type ArtefactServer } from "../testing/artefact-server.js";
import {
  MODEL_FIXTURE,
  type OnnxArtefacts,
  type OnnxRouteChoice,
  startOnnxArtefacts,
} from "../testing/onnx-artefacts.js";
import {
  acquireSpeechOnnx,
  ONNX_DIR_NAME,
  ONNX_PINS,
  ONNX_PROVIDER,
  ONNX_RUNTIME_PLATFORMS,
  ONNX_SPEECH_VERSION,
  OnnxSpeechRefusal,
  OnnxUnavailable,
  runtimePlatformKey,
} from "./speech-onnx.js";

const scratch: string[] = [];
const servers: ArtefactServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratchDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-onnx-"));
  scratch.push(directory);
  return directory;
}

async function fixtures(routes: OnnxRouteChoice = {}): Promise<OnnxArtefacts> {
  const artefacts = await startOnnxArtefacts(routes);
  servers.push(...artefacts.servers);
  return artefacts;
}

function component(toolchainDir: string): string {
  return join(toolchainDir, `${ONNX_DIR_NAME}-${ONNX_SPEECH_VERSION}`);
}

function probe(platform: string, arch: string): HostProbe {
  return { platform, arch, osRelease: null, glibc: null };
}

describe("acquireSpeechOnnx", () => {
  it("fetches all four artefacts and records every one of them in the component", async () => {
    const toolchainDir = scratchDir();
    const { pins } = await fixtures();

    const acquired = await acquireSpeechOnnx({ toolchainDir, pins });

    expect(acquired.fetched).toBe(true);
    expect(acquired.component.provider).toBe(ONNX_PROVIDER);
    expect(acquired.component.version).toBe(ONNX_SPEECH_VERSION);
    // `path` is the model graph, which is what every existing reader of the marker looks at.
    expect(acquired.component.path).toBe(join(acquired.destination, "model_quantized.onnx"));
    expect(acquired.component.sha256).toBe(sha256Of(MODEL_FIXTURE));

    const recorded = (acquired.component.files ?? []).map((file) => file.path);
    expect(recorded).toContain(join(acquired.destination, "model_quantized.onnx"));
    expect(recorded).toContain(join(acquired.destination, "voices", "af_heart.bin"));
    expect(recorded).toContain(
      join(acquired.destination, "runtime", "onnxruntime-node", "dist", "index.js"),
    );
    expect(recorded).toContain(
      join(
        acquired.destination,
        "runtime",
        "onnxruntime-node",
        "bin",
        "napi-v6",
        "linux",
        "x64",
        "native.node",
      ),
    );
    expect(recorded).toContain(
      join(
        acquired.destination,
        "runtime",
        "node_modules",
        "onnxruntime-common",
        "dist",
        "cjs",
        "index.js",
      ),
    );
    // Every recorded path exists, which is the property the install preflight then checks.
    for (const file of acquired.component.files ?? []) {
      expect(existsSync(file.path)).toBe(true);
    }
  });

  it("keeps this platform's native subtree and no other, and never the postinstall script", async () => {
    const toolchainDir = scratchDir();
    const { pins } = await fixtures();

    const acquired = await acquireSpeechOnnx({ toolchainDir, pins });
    const napi = join(acquired.destination, "runtime", "onnxruntime-node", "bin", "napi-v6");

    expect(existsSync(join(napi, "linux", "x64", "native.node"))).toBe(true);
    expect(existsSync(join(napi, "darwin"))).toBe(false);
    expect(existsSync(join(napi, "win32"))).toBe(false);
    expect(existsSync(join(acquired.destination, "runtime", "onnxruntime-node", "script"))).toBe(
      false,
    );
    // The loader's own glue, taken verbatim, is what makes the native half loadable. A regex
    // rather than a string for the same reason `manifest.test.ts` uses one: the thing being pinned
    // is a `${…}` interpolation in somebody else's source, which is also JavaScript's own, and a
    // plain string carrying it is what `noTemplateCurlyInString` flags.
    expect(
      readFileSync(
        join(acquired.destination, "runtime", "onnxruntime-node", "dist", "binding.js"),
        "utf8",
      ),
    ).toMatch(/bin\/napi-v6\/\$\{process\.platform}\/\$\{process\.arch}/);
    // `onnxruntime-common` lands where Node's own resolution looks from that glue.
    expect(
      existsSync(
        join(
          acquired.destination,
          "runtime",
          "node_modules",
          "onnxruntime-common",
          "dist",
          "cjs",
          "index.js",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(acquired.destination, "runtime", "node_modules", "onnxruntime-common", "lib"),
      ),
    ).toBe(false);
  });

  it("refuses a model whose digest does not match, and deletes the partial", async () => {
    const toolchainDir = scratchDir();
    const { pins } = await fixtures({ model: ARTEFACT_ROUTES.corrupt });

    await expect(acquireSpeechOnnx({ toolchainDir, pins })).rejects.toThrow(DownloadRefusal);
    expect(existsSync(join(component(toolchainDir), "model_quantized.onnx"))).toBe(false);
    // The partial is deleted rather than kept, which is what stops the next run resuming onto
    // bytes that are already wrong and re-downloading the same mismatch for ever. The work
    // directory itself stays: it is where a *resumable* failure leaves its resume point.
    expect(existsSync(join(component(toolchainDir), ".setup", "model_quantized.onnx.part"))).toBe(
      false,
    );
  });

  it("resumes a truncated runtime tarball on the next run rather than starting again", async () => {
    const toolchainDir = scratchDir();
    const { pins, runtime } = await fixtures({ runtime: ARTEFACT_ROUTES.flaky });

    await expect(acquireSpeechOnnx({ toolchainDir, pins })).rejects.toThrow(/delivered|stopped/);
    const acquired = await acquireSpeechOnnx({ toolchainDir, pins });

    expect(acquired.fetched).toBe(true);
    expect(runtime.requests.some((entry) => entry.range !== null)).toBe(true);
    expect(
      existsSync(join(acquired.destination, "runtime", "onnxruntime-node", "dist", "index.js")),
    ).toBe(true);
  });

  it("re-verifies everything on a second run and fetches nothing", async () => {
    const toolchainDir = scratchDir();
    const { pins, model, runtime } = await fixtures();
    const first = await acquireSpeechOnnx({ toolchainDir, pins });
    const beforeModel = model.requests.length;
    const beforeRuntime = runtime.requests.length;

    const second = await acquireSpeechOnnx({ toolchainDir, pins });

    expect(second.fetched).toBe(false);
    expect(second.destination).toBe(first.destination);
    expect(second.component.files).toEqual(first.component.files);
    expect(model.requests.length).toBe(beforeModel);
    expect(runtime.requests.length).toBe(beforeRuntime);
  });

  it("refuses a committed model that has been changed since it was acquired", async () => {
    const toolchainDir = scratchDir();
    const { pins } = await fixtures();
    const acquired = await acquireSpeechOnnx({ toolchainDir, pins });
    writeFileSync(join(acquired.destination, "model_quantized.onnx"), "not the reviewed graph\n");

    const refusal = acquireSpeechOnnx({ toolchainDir, pins });
    await expect(refusal).rejects.toThrow(OnnxSpeechRefusal);
    await expect(refusal).rejects.toThrow(/changed since setup acquired it/);
  });

  it("refuses a runtime tree whose own record has been removed", async () => {
    const toolchainDir = scratchDir();
    const { pins } = await fixtures();
    const acquired = await acquireSpeechOnnx({ toolchainDir, pins });
    rmSync(join(acquired.destination, "runtime", "onnxruntime-node", ACQUIRED_FILE));

    const refusal = acquireSpeechOnnx({ toolchainDir, pins });
    await expect(refusal).rejects.toThrow(OnnxSpeechRefusal);
    await expect(refusal).rejects.toThrow(/does not exist/);
  });

  it("refuses a runtime tree whose record names a different artefact", async () => {
    const toolchainDir = scratchDir();
    const { pins } = await fixtures();
    const acquired = await acquireSpeechOnnx({ toolchainDir, pins });
    const record = join(acquired.destination, "runtime", "onnxruntime-node", ACQUIRED_FILE);
    const before = readAcquired(join(acquired.destination, "runtime", "onnxruntime-node"));
    writeFileSync(record, JSON.stringify({ ...before, sha256: "0".repeat(64) }));

    await expect(acquireSpeechOnnx({ toolchainDir, pins })).rejects.toThrow(
      /Same name, different artefact/,
    );
  });

  it("refuses a witnessed file inside a committed tree that has since changed", async () => {
    const toolchainDir = scratchDir();
    const { pins } = await fixtures();
    const acquired = await acquireSpeechOnnx({ toolchainDir, pins });
    writeFileSync(
      join(acquired.destination, "runtime", "onnxruntime-node", "dist", "index.js"),
      "require('something else')\n",
    );

    await expect(acquireSpeechOnnx({ toolchainDir, pins })).rejects.toThrow(
      /changed since it was acquired/,
    );
  });

  it("finishes a run that was interrupted between two artefacts", async () => {
    const toolchainDir = scratchDir();
    const { pins, model } = await fixtures();
    // What an interruption after the model leaves behind: the model committed, nothing else.
    const destination = component(toolchainDir);
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "model_quantized.onnx"), MODEL_FIXTURE);
    const beforeModel = model.requests.length;

    const acquired = await acquireSpeechOnnx({ toolchainDir, pins });

    expect(acquired.fetched).toBe(true);
    expect(model.requests.length).toBe(beforeModel);
    expect(existsSync(join(destination, "voices", "af_heart.bin"))).toBe(true);
  });
});

describe("runtimePlatformKey", () => {
  it("answers Node's own spelling, which is what the loader composes its require path from", () => {
    expect(runtimePlatformKey(probe("linux", "x64"))).toBe("linux/x64");
    expect(runtimePlatformKey(probe("win32", "arm64"))).toBe("win32/arm64");
  });

  it("reports darwin-x64 as unavailable rather than fetching a binding that is not there", () => {
    expect(ONNX_RUNTIME_PLATFORMS).not.toContain("darwin/x64");
    let caught: unknown;
    try {
      runtimePlatformKey(probe("darwin", "x64"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OnnxUnavailable);
    expect((caught as OnnxUnavailable).reason).toBe("unsupported-platform");
    expect((caught as Error).message).toContain("no darwin/x64");
    expect((caught as Error).message).toContain("Nothing was downloaded");
  });

  it("is what an unsupported platform reaches before a byte is fetched", async () => {
    const toolchainDir = scratchDir();
    const { pins } = await fixtures();
    const { platform: _ignored, ...withoutPlatform } = pins;

    await expect(
      acquireSpeechOnnx({
        toolchainDir,
        pins: withoutPlatform,
        probe: probe("darwin", "x64"),
      }),
    ).rejects.toThrow(OnnxUnavailable);
  });
});

describe("the pins this build ships", () => {
  it("names the reviewed revision and fetches every byte from its own upstream home", () => {
    expect(ONNX_PINS.model.url).toContain(
      "huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/resolve/",
    );
    expect(ONNX_PINS.model.size).toBe(92_361_055);
    expect(Object.keys(ONNX_PINS.voices)).toEqual(["af_heart.bin"]);
    expect(ONNX_PINS.runtime.url).toBe(
      "https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.29.0.tgz",
    );
    expect(ONNX_PINS.common.url).toBe(
      "https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.29.0.tgz",
    );
    for (const artefact of [
      ONNX_PINS.model,
      ONNX_PINS.runtime,
      ONNX_PINS.common,
      ...Object.values(ONNX_PINS.voices),
    ]) {
      expect(new URL(artefact.url).protocol).toBe("https:");
      expect(artefact.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artefact.size).toBeGreaterThan(0);
    }
  });

  it("names the model revision and the runtime release in the one version string", () => {
    expect(ONNX_SPEECH_VERSION).toContain("dd4401a9");
    expect(ONNX_SPEECH_VERSION).toContain("1.29.0");
  });
});
