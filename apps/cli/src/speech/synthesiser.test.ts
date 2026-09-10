import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { decodeWav, G2pError, phonemise } from "@xplainer/render-core";
import { afterEach, describe, expect, it } from "vitest";
import { createOnnxSynthesiser, type OnnxSynthesiserOptions } from "./synthesiser.js";
import { createFakeRuntime, type FakeGraph, type FakeRuntime } from "./testing/fake-runtime.js";
import { STYLE_DIMENSION } from "./voice.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A model file that exists, and a voice pack whose every row is its own row number. */
function artefacts(rows = 510): { modelPath: string; voicePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-onnx-"));
  directories.push(directory);
  const modelPath = join(directory, "model_quantized.onnx");
  writeFileSync(modelPath, "not a real model; the fake runtime never opens it");
  const voicePath = join(directory, "af_heart.bin");
  const floats = new Float32Array(rows * STYLE_DIMENSION);
  for (let row = 0; row < rows; row += 1) {
    floats.fill(row, row * STYLE_DIMENSION, (row + 1) * STYLE_DIMENSION);
  }
  writeFileSync(voicePath, Buffer.from(floats.buffer));
  return { modelPath, voicePath };
}

/** A synthesiser over a fake runtime, with the log captured. */
function overFake(graph?: FakeGraph): {
  synthesiser: ReturnType<typeof createOnnxSynthesiser>;
  fake: FakeRuntime;
  log: string[];
} {
  const fake = createFakeRuntime(graph);
  const log: string[] = [];
  const options: OnnxSynthesiserOptions = {
    ...artefacts(),
    voice: "af_heart",
    runtimeLocation: "/nowhere/the/fake/is/injected",
    runtime: fake.runtime,
    log: (line) => log.push(line),
  };
  return { synthesiser: createOnnxSynthesiser(options), fake, log };
}

describe("createOnnxSynthesiser", () => {
  it("refuses a missing model at construction, before a job starts", () => {
    const { voicePath } = artefacts();

    expect(() =>
      createOnnxSynthesiser({
        modelPath: join(tmpdir(), "no-such-model.onnx"),
        voicePath,
        voice: "af_heart",
        runtimeLocation: "/nowhere",
      }),
    ).toThrow(/no speech model at .*xplainer setup/s);
  });

  it("answers in the port's own envelope: base64 16-bit PCM WAV, plus word spans", async () => {
    const { synthesiser } = overFake();

    const response = await synthesiser.captionedSpeech({
      text: "The cached value was stale.",
      voice: "af_heart",
      speed: 1,
    });

    const wav = Buffer.from(response.audio, "base64");
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    const decoded = decodeWav(wav);
    expect(decoded.format).toEqual({ channels: 1, sampleWidth: 2, sampleRate: 24000 });
    expect(decoded.data.length).toBeGreaterThan(0);
    expect(response.timestamps.length).toBe(5);
    expect(response.timestamps[0]?.word).toBe("The");
  });

  it("produces audio that is not silent", async () => {
    const { synthesiser } = overFake();

    const response = await synthesiser.captionedSpeech({
      text: "The cached value was stale.",
      voice: "af_heart",
      speed: 1,
    });

    const { data } = decodeWav(Buffer.from(response.audio, "base64"));
    let peak = 0;
    for (let offset = 0; offset + 1 < data.length; offset += 2) {
      peak = Math.max(peak, Math.abs(data.readInt16LE(offset)));
    }
    expect(peak).toBeGreaterThan(1000);
  });

  it("times every word inside the audio it returned", async () => {
    const { synthesiser } = overFake();

    const response = await synthesiser.captionedSpeech({
      text: "The reader observed an old record.",
      voice: "af_heart",
      speed: 1,
    });

    const decoded = decodeWav(Buffer.from(response.audio, "base64"));
    const seconds = decoded.data.length / 2 / decoded.format.sampleRate;
    let previous = 0;
    for (const timing of response.timestamps) {
      expect(timing.start_time).toBeGreaterThanOrEqual(previous);
      expect(timing.end_time).toBeGreaterThan(timing.start_time);
      previous = timing.end_time;
    }
    expect(previous).toBeLessThanOrEqual(seconds);
  });

  it("selects the style row by the token count, not the first row of the pack", async () => {
    const { synthesiser, fake } = overFake();
    const text = "The cached value was stale.";

    await synthesiser.captionedSpeech({ text, voice: "af_heart", speed: 1 });

    const expected = [...phonemise(text).ipa].length - 1;
    expect(fake.calls[0]?.style[0]).toBe(expected);
    expect(fake.calls[0]?.style).toHaveLength(STYLE_DIMENSION);
  });

  it("pads the token sequence at both ends and passes the speed through", async () => {
    const { synthesiser, fake } = overFake();
    const text = "Stop.";

    await synthesiser.captionedSpeech({ text, voice: "af_heart", speed: 1.3 });

    const ids = fake.calls[0]?.ids ?? [];
    expect(ids[0]).toBe(0);
    expect(ids.at(-1)).toBe(0);
    expect(ids).toHaveLength([...phonemise(text).ipa].length + 2);
    expect(fake.calls[0]?.speed).toBeCloseTo(1.3, 6);
  });

  it("opens one session however many segments it speaks", async () => {
    const { synthesiser, fake } = overFake();

    await Promise.all([
      synthesiser.captionedSpeech({ text: "One.", voice: "af_heart", speed: 1 }),
      synthesiser.captionedSpeech({ text: "Two.", voice: "af_heart", speed: 1 }),
    ]);
    await synthesiser.captionedSpeech({ text: "Three.", voice: "af_heart", speed: 1 });

    expect(fake.sessions).toBe(1);
    expect(fake.calls).toHaveLength(3);
  });

  it("logs every derived pronunciation, naming the word, the reading and the layer (D5)", async () => {
    const { synthesiser, log } = overFake();
    const text = "The frobnicator was misaligned.";
    const derived = phonemise(text).derived;

    await synthesiser.captionedSpeech({ text, voice: "af_heart", speed: 1 });

    expect(derived.length).toBeGreaterThan(0);
    for (const pronunciation of derived) {
      const line = log.find((candidate) => candidate.includes(JSON.stringify(pronunciation.word)));
      expect(line, pronunciation.word).toBeDefined();
      expect(line).toContain(pronunciation.ipa);
      expect(line).toContain(pronunciation.source);
      expect(line).toContain("lexicon.txt");
    }
  });

  it("says nothing when every word was looked up", async () => {
    const { synthesiser, log } = overFake();

    await synthesiser.captionedSpeech({
      text: "The cached value was stale.",
      voice: "af_heart",
      speed: 1,
    });

    expect(log).toEqual([]);
  });

  it("fails the job with the word named when the G2P cannot pronounce one (D5)", async () => {
    const { synthesiser } = overFake();

    // A letter outside the English alphabet is the one refusal no lexicon entry can fix, so it is
    // the reliable trigger. The error is rethrown untouched, so `word` is still a field: the fix is
    // mechanical and a caller must not have to regex a message for the spelling.
    const rejection = await synthesiser
      .captionedSpeech({ text: "The Δ changed.", voice: "af_heart", speed: 1 })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(G2pError);
    expect((rejection as G2pError).word).toBe("Δ");
    expect((rejection as G2pError).message).toContain("Δ");
  });

  it("refuses a voice this pack does not speak, rather than substituting one", async () => {
    const { synthesiser } = overFake();

    await expect(
      synthesiser.captionedSpeech({ text: "Hello.", voice: "af_bella", speed: 1 }),
    ).rejects.toThrow(/asks for voice "af_bella" and the acquired voice pack is "af_heart"/);
  });

  it("refuses a server-side blend, which has no meaning on this route", async () => {
    const { synthesiser } = overFake();

    await expect(
      synthesiser.captionedSpeech({ text: "Hello.", voice: "af_bella(2)+af_sky(1)", speed: 1 }),
    ).rejects.toThrow(/blend/);
  });

  it("refuses a speaking rate this engine does not speak at", async () => {
    const { synthesiser } = overFake();

    await expect(
      synthesiser.captionedSpeech({ text: "Hello.", voice: "af_heart", speed: 0 }),
    ).rejects.toThrow(/outside the 0.25–4/);
    await expect(
      synthesiser.captionedSpeech({ text: "Hello.", voice: "af_heart", speed: 9 }),
    ).rejects.toThrow(/outside the 0.25–4/);
  });

  it("refuses a graph whose durations do not align with the tokens it was given (D6)", async () => {
    const { synthesiser } = overFake((ids) => ({
      waveform: new Float32Array(ids.length * 40 * 592).fill(0.2),
      durations: Float32Array.from({ length: ids.length - 2 }, () => 40),
    }));

    await expect(
      synthesiser.captionedSpeech({ text: "The value was stale.", voice: "af_heart", speed: 1 }),
    ).rejects.toThrow(/One duration per token/);
  });

  it("refuses a graph with no durations output at all", async () => {
    const fake = createFakeRuntime();
    const runtime = {
      Tensor: fake.runtime.Tensor,
      InferenceSession: {
        create: () =>
          Promise.resolve({
            run: () =>
              Promise.resolve({
                waveform: { dims: [1, 24000], data: new Float32Array(24000).fill(0.1) },
              }),
          }),
      },
    };
    const synthesiser = createOnnxSynthesiser({
      ...artefacts(),
      voice: "af_heart",
      runtimeLocation: "/nowhere",
      runtime,
    });

    await expect(
      synthesiser.captionedSpeech({ text: "Hello.", voice: "af_heart", speed: 1 }),
    ).rejects.toThrow(/no "durations" output/);
  });
});

/**
 * The real thing, against the real model.
 *
 * Gated because the artefacts are a 92 MB model, a 522 KB voice pack and an ONNX Runtime — none of
 * which is an npm dependency of this package (plan D7), and none of which a checkout has. Point the
 * three variables at what `xplainer setup` acquired, or at a hand-downloaded copy:
 *
 * ```
 * XPLAINER_ONNX_MODEL=…/model_quantized.onnx \
 * XPLAINER_ONNX_VOICE=…/af_heart.bin \
 * XPLAINER_ONNX_RUNTIME=…/node_modules/onnxruntime-node \
 *   pnpm --filter @xplainer/cli test
 * ```
 *
 * The gate is the model alone, and the other two are a **named failure** rather than a second skip
 * condition: all three describe one machine, so setting one of them is somebody who meant to run
 * this and mistyped, and telling them so is more use than skipping silently. (The condition is also
 * on one line because `AC-2c`'s second grep requires it there — a skip gated on a named constant
 * reads as an unconditional skip to everyone but the author of that constant.)
 */
describe.skipIf((process.env.XPLAINER_ONNX_MODEL ?? "").trim() === "")("real inference", () => {
  /** The three paths, with the two the gate does not cover checked here. */
  function realOptions(): OnnxSynthesiserOptions {
    const voicePath = (process.env.XPLAINER_ONNX_VOICE ?? "").trim();
    const runtimeLocation = (process.env.XPLAINER_ONNX_RUNTIME ?? "").trim();
    if (voicePath === "" || runtimeLocation === "") {
      throw new Error(
        "XPLAINER_ONNX_MODEL is set, so this suite runs; XPLAINER_ONNX_VOICE and " +
          "XPLAINER_ONNX_RUNTIME must name the voice pack and the runtime on the same machine.",
      );
    }
    return {
      modelPath: (process.env.XPLAINER_ONNX_MODEL ?? "").trim(),
      voicePath,
      voice: "af_heart",
      runtimeLocation,
      log: () => {},
    };
  }

  it("speaks a real sentence, and its word timings describe the audio it returned", {
    timeout: 120_000,
  }, async () => {
    const text = "The cached value was stale, so the reader observed an old record.";
    const response = await createOnnxSynthesiser(realOptions()).captionedSpeech({
      text,
      voice: "af_heart",
      speed: 1,
    });

    const decoded = decodeWav(Buffer.from(response.audio, "base64"));
    expect(decoded.format).toEqual({ channels: 1, sampleWidth: 2, sampleRate: 24000 });
    const seconds = decoded.data.length / 2 / decoded.format.sampleRate;

    // Twelve words of ordinary prose. Measured 3.8 s on this model; the bounds are wide enough
    // that only a genuinely wrong style row or speed lands outside them, and the style-row error
    // the spike shipped — row 0 for every sentence — undershoots by 30%.
    expect(seconds).toBeGreaterThan(2.5);
    expect(seconds).toBeLessThan(7);

    let peak = 0;
    let energy = 0;
    for (let offset = 0; offset + 1 < decoded.data.length; offset += 2) {
      const sample = decoded.data.readInt16LE(offset) / 32767;
      peak = Math.max(peak, Math.abs(sample));
      energy += sample * sample;
    }
    expect(peak).toBeGreaterThan(0.05);
    expect(Math.sqrt(energy / (decoded.data.length / 2))).toBeGreaterThan(0.005);

    expect(response.timestamps).toHaveLength(phonemise(text).words.length);
    let previous = 0;
    for (const timing of response.timestamps) {
      expect(timing.start_time).toBeGreaterThanOrEqual(previous);
      expect(timing.end_time).toBeGreaterThan(timing.start_time);
      previous = timing.end_time;
    }
    expect(previous).toBeLessThanOrEqual(seconds);

    // The words must fill most of the clip: a duration predictor read through the wrong
    // conversion would put every word in the first fraction of the audio and leave the rest
    // unaccounted, which is the drift D6 exists to make impossible.
    let spokenSeconds = 0;
    for (const timing of response.timestamps) {
      spokenSeconds += timing.end_time - timing.start_time;
    }
    expect(spokenSeconds).toBeGreaterThan(seconds * 0.6);
    expect(spokenSeconds).toBeLessThan(seconds);
  });

  it("speaks faster when asked to, and still times the words inside the clip", async () => {
    const text = "The reader observed an old record.";
    const synthesiser = createOnnxSynthesiser(realOptions());

    const [ordinary, quick] = await Promise.all([
      synthesiser.captionedSpeech({ text, voice: "af_heart", speed: 1 }),
      synthesiser.captionedSpeech({ text, voice: "af_heart", speed: 1.5 }),
    ]);

    const length = (audio: string): number => decodeWav(Buffer.from(audio, "base64")).data.length;
    expect(length(quick.audio)).toBeLessThan(length(ordinary.audio));
    const quickSeconds = length(quick.audio) / 2 / 24000;
    expect(quick.timestamps.at(-1)?.end_time ?? 0).toBeLessThanOrEqual(quickSeconds);
  }, 120_000);
});
