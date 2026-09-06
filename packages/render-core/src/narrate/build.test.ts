import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Captions, Narration, Timings } from "@xplainer/protocol";
import {
  CAPTIONED_SPEECH_PATH,
  type FetchLike,
  type HttpRequestInit,
  KokoroClient,
  type WordTimestamp,
} from "@xplainer/tts-client";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { narrate } from "./build.js";
import { GAP_MS, LEAD_IN_MS, TAIL_MS } from "./pacing.js";
import { decodeWav, pcmDurationMs } from "./wav.js";

/**
 * The whole run, end to end, with no server anywhere: the real
 * `@xplainer/tts-client` client is driven over a stub transport, so the request
 * this port sends is the request that package builds — flags included — and the
 * response it parses is the envelope Kokoro really returns.
 *
 * The two documents are then validated against `packages/protocol`'s schemas
 * directly, because those schemas are the contract every other surface reads
 * `timings.json` and `captions.json` through.
 */

const require = createRequire(import.meta.url);
const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "fixtures",
  "narrate",
);

const ajv = new Ajv2020({ allErrors: true });
const validateTimings = ajv.compile(
  JSON.parse(readFileSync(require.resolve("@xplainer/protocol/schemas/timings.json"), "utf8")),
);
const validateCaptions = ajv.compile(
  JSON.parse(readFileSync(require.resolve("@xplainer/protocol/schemas/captions.json"), "utf8")),
);

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
}

function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`no item at index ${index}`);
  }
  return value;
}

const narration = readJson<Narration>("narration.json");
const hookWords = readJson<WordTimestamp[]>("hook-words.json");
const causeWords = readJson<WordTimestamp[]>("cause-words.json");

/** One recorded call to the stub transport. */
type Call = { readonly url: string; readonly init: HttpRequestInit };

/**
 * A `fetch` that answers `/dev/captioned_speech` with the fixture WAVs and word
 * timestamps, in the order the two speaking segments are synthesised.
 */
function stubKokoro(calls: Call[]): FetchLike {
  const responses = [
    { wav: "hook.wav", words: hookWords },
    { wav: "cause.wav", words: causeWords },
  ];
  return (url, init) => {
    calls.push({ url, init });
    const next = responses[calls.length - 1];
    if (next === undefined) {
      throw new Error(`the stub server was called ${calls.length} times; it has 2 answers`);
    }
    const body = {
      audio: readFileSync(join(FIXTURES, next.wav)).toString("base64"),
      timestamps: next.words,
    };
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  };
}

const temporaryDirectories: string[] = [];

function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xplainer-narrate-"));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("narrate — through the real tts-client over a stub transport", () => {
  it("posts what @xplainer/tts-client builds, flags and all", async () => {
    const calls: Call[] = [];
    const client = new KokoroClient({ baseUrl: "http://kokoro.test", fetch: stubKokoro(calls) });

    await narrate({ narration, outDir: temporaryDir(), client });

    // Two calls, not three: the silent middle segment contacts no server.
    expect(calls).toHaveLength(2);
    expect(at(calls, 0).url).toBe(`http://kokoro.test${CAPTIONED_SPEECH_PATH}`);
    const payload = JSON.parse(at(calls, 0).init.body ?? "{}") as Record<string, unknown>;
    expect(payload).toMatchObject({
      model: "kokoro",
      input: "What if your build was already broken?",
      voice: "af_heart",
      response_format: "wav",
      speed: 1,
      stream: false,
      return_timestamps: true,
    });
  });

  it("writes the three files and reports where they went", async () => {
    const outDir = temporaryDir();
    const client = new KokoroClient({ baseUrl: "http://kokoro.test", fetch: stubKokoro([]) });

    const result = await narrate({ narration, outDir, client });

    expect(result.mode).toBe("kokoro");
    expect(result.audioPath).toBe(join(outDir, "narration.wav"));
    expect(result.timingsPath).toBe(join(outDir, "timings.json"));
    expect(result.captionsPath).toBe(join(outDir, "captions.json"));
    expect(result.timings.audio).toBe("narration.wav");
  });

  it("writes a timings.json that validates against packages/protocol's schema", async () => {
    const outDir = temporaryDir();
    const client = new KokoroClient({ baseUrl: "http://kokoro.test", fetch: stubKokoro([]) });

    await narrate({ narration, outDir, client });
    const written = JSON.parse(readFileSync(join(outDir, "timings.json"), "utf8")) as Timings;

    expect(validateTimings(written), JSON.stringify(validateTimings.errors)).toBe(true);
    expect(written.segments.map((segment) => segment.id)).toEqual(["hook", "beat", "cause"]);
  });

  it("writes a captions.json that validates against packages/protocol's schema", async () => {
    const outDir = temporaryDir();
    const client = new KokoroClient({ baseUrl: "http://kokoro.test", fetch: stubKokoro([]) });

    await narrate({ narration, outDir, client });
    const written = JSON.parse(readFileSync(join(outDir, "captions.json"), "utf8")) as Captions;

    expect(validateCaptions(written), JSON.stringify(validateCaptions.errors)).toBe(true);
    expect(at(written, 0).text).toBe("What");
    expect(at(written, 0).confidence).toBeNull();
  });

  it("writes a track whose real length is timings.json's totalMs, within 1 ms", async () => {
    const outDir = temporaryDir();
    const client = new KokoroClient({ baseUrl: "http://kokoro.test", fetch: stubKokoro([]) });

    const result = await narrate({ narration, outDir, client });
    const track = decodeWav(readFileSync(join(outDir, "narration.wav")));
    const measured = pcmDurationMs(track.format, track.data.length);

    expect(track.format.sampleRate).toBe(24000);
    expect(Math.abs(measured - result.timings.totalMs)).toBeLessThan(1);
    // 400 ms lead-in + 2 350 ms + 620 + 2 000 + 620 + 3 000 + 620 + 800 tail.
    expect(result.timings.totalMs).toBe(
      LEAD_IN_MS + 2350 + GAP_MS + 2000 + GAP_MS + 3000 + GAP_MS + TAIL_MS,
    );
  });

  it("concatenates the segments' own frames, not a re-synthesis of them", async () => {
    const outDir = temporaryDir();
    const client = new KokoroClient({ baseUrl: "http://kokoro.test", fetch: stubKokoro([]) });

    await narrate({ narration, outDir, client });
    const track = decodeWav(readFileSync(join(outDir, "narration.wav")));
    const hook = decodeWav(readFileSync(join(FIXTURES, "hook.wav")));
    const leadInBytes = ((24000 * LEAD_IN_MS) / 1000) * 2;

    expect(
      Buffer.compare(track.data.subarray(leadInBytes, leadInBytes + hook.data.length), hook.data),
    ).toBe(0);
  });

  it("refuses a response whose audio is not a WAV, rather than writing a broken track", async () => {
    const client = new KokoroClient({
      baseUrl: "http://kokoro.test",
      fetch: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              audio: Buffer.from("<html>gateway error</html>").toString("base64"),
              timestamps: [],
            }),
          text: () => Promise.resolve(""),
        }),
    });

    await expect(narrate({ narration, outDir: temporaryDir(), client })).rejects.toThrow(
      /RIFF\/WAVE header/,
    );
  });
});

describe("narrate — dry run", () => {
  it("labels its output dry_run and contacts no server", async () => {
    const calls: Call[] = [];
    const client = new KokoroClient({ baseUrl: "http://kokoro.test", fetch: stubKokoro(calls) });

    const result = await narrate({ narration, outDir: temporaryDir(), dryRun: true, client });

    expect(result.mode).toBe("dry_run");
    expect(calls).toHaveLength(0);
  });

  it("needs no client at all", async () => {
    const result = await narrate({ narration, outDir: temporaryDir(), dryRun: true });

    expect(result.mode).toBe("dry_run");
  });

  it("produces the same shape of documents, valid against the same schemas", async () => {
    const outDir = temporaryDir();

    const result = await narrate({ narration, outDir, dryRun: true });
    const timings = JSON.parse(readFileSync(join(outDir, "timings.json"), "utf8")) as Timings;
    const captions = JSON.parse(readFileSync(join(outDir, "captions.json"), "utf8")) as Captions;

    expect(validateTimings(timings), JSON.stringify(validateTimings.errors)).toBe(true);
    expect(validateCaptions(captions), JSON.stringify(validateCaptions.errors)).toBe(true);
    expect(timings.segments).toHaveLength(3);
    expect(result.captions.length).toBeGreaterThan(0);
  });

  it("estimates from the text and still writes a track of exactly that length", async () => {
    const outDir = temporaryDir();

    const result = await narrate({ narration, outDir, dryRun: true });
    const track = decodeWav(readFileSync(join(outDir, "narration.wav")));
    const measured = pcmDurationMs(track.format, track.data.length);

    // Seven words at 2.9 words/second, then two words: both estimated, never measured.
    expect(Math.abs(measured - result.timings.totalMs)).toBeLessThan(1);
    expect(result.timings.totalMs).toBeGreaterThan(LEAD_IN_MS + TAIL_MS);
  });
});
