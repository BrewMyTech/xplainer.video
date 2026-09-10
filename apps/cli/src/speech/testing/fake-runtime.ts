/**
 * A stand-in for the ONNX Runtime, so the synthesiser can be driven without a 92 MB model.
 *
 * It is a stand-in for the **runtime**, not for the synthesiser: everything above it in
 * `synthesiser.ts` — the G2P call, the derived-pronunciation log, the tokenisation, the style-row
 * selection, the D6 timing derivation, the PCM conversion and the WAV envelope — is the shipping
 * code path, which is the same argument `workers/speech.ts` makes for the fixture synthesiser being
 * a stand-in for the server. What it buys over a lookalike synthesiser is the ability to answer
 * *wrongly on purpose*: a `durations` array of the wrong length or a waveform of an implausible
 * size is how the refusals in `timing.ts` are proved to fire, and no real model will produce one.
 *
 * The module is passed through `assertRuntime()` before it is handed back, so a fake that drifted
 * out of the interface fails here rather than leaving every test above it green against a shape the
 * production loader would reject.
 */

import { assertRuntime, type OnnxRuntimeModule, type OnnxTensor } from "../runtime.js";

/** Duration units the default model assigns to each token. Any constant would do. */
const UNITS_PER_TOKEN = 40;

/** Audio samples per duration unit, in the middle of the range the real model measures at. */
const SAMPLES_PER_UNIT = 592;

/** What one call to the fake graph produced. */
export type FakeOutputs = {
  readonly waveform: Float32Array;
  readonly durations: Float32Array;
};

/** The graph itself: token ids and speed in, two tensors out. */
export type FakeGraph = (ids: readonly number[], speed: number) => FakeOutputs;

/** What the fake recorded about the calls it was given, so a test can assert the inputs. */
export type FakeRuntime = {
  readonly runtime: OnnxRuntimeModule;
  /** One entry per `session.run`, in order. */
  readonly calls: {
    readonly ids: readonly number[];
    readonly style: readonly number[];
    readonly speed: number;
  }[];
  /** How many sessions were opened. One, however many segments were spoken. */
  sessions: number;
};

/**
 * A plausible graph: one duration per token, and audio as long as those durations say.
 *
 * The waveform is a quiet sine rather than zeroes so that "the audio is not silent" is a real
 * assertion against it and not one that only the real model can satisfy.
 */
export const plausibleGraph: FakeGraph = (ids, speed) => {
  const durations = Float32Array.from(ids, () => UNITS_PER_TOKEN / speed);
  let units = 0;
  for (const unit of durations) {
    units += unit;
  }
  const waveform = new Float32Array(Math.round(units * SAMPLES_PER_UNIT));
  for (let index = 0; index < waveform.length; index += 1) {
    waveform[index] = Math.sin((index / 24000) * 2 * Math.PI * 220) * 0.25;
  }
  return { waveform, durations };
};

/** Build a fake runtime over `graph`. */
export function createFakeRuntime(graph: FakeGraph = plausibleGraph): FakeRuntime {
  const record: FakeRuntime = {
    calls: [],
    sessions: 0,
    runtime: assertRuntime(
      {
        Tensor: class {
          readonly dims: readonly number[];
          readonly data: ArrayLike<number>;
          constructor(_type: string, data: ArrayLike<number>, dims: readonly number[]) {
            this.data = data;
            this.dims = dims;
          }
        },
        InferenceSession: {
          create(): Promise<{
            run(
              feeds: Readonly<Record<string, OnnxTensor>>,
            ): Promise<Readonly<Record<string, OnnxTensor>>>;
          }> {
            record.sessions += 1;
            return Promise.resolve({
              run(feeds) {
                const ids = Array.from(feeds.input_ids?.data ?? [], (id) => Number(id));
                const style = Array.from(feeds.style?.data ?? []);
                const speed = Number(feeds.speed?.data[0] ?? 1);
                record.calls.push({ ids, style, speed });
                const { waveform, durations } = graph(ids, speed);
                return Promise.resolve({
                  waveform: { dims: [1, waveform.length], data: waveform },
                  durations: { dims: [1, durations.length], data: durations },
                });
              },
            });
          },
        },
      },
      "the fake runtime",
    ),
  };
  return record;
}
