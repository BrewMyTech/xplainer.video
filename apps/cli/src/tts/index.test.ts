/**
 * ElevenLabs end to end, in this process: render-core's own `narrate()` over the adapter, wrapped
 * the way `resolveSpeech()` wraps it, writing the three files a render is measured against.
 *
 * Everything below the port is the shipping code — `decodeWav`, `planSegments`, `buildTrack`,
 * `buildCaptions`, `buildTimings` and the writers — and nothing in it was changed for this
 * provider (spec §1: `packages/render-core` is not edited). That is the claim this file checks: a
 * WAV wrapped from `pcm_24000` and spans converted from a character alignment are indistinguishable,
 * to everything downstream, from what a Kokoro route returns. The only substitution is the service,
 * answering with the recorded bodies at their full recorded length.
 *
 * **What the captions are asserted against (spec §11 C11a).** Strict token equality is the
 * adapter's check and is asserted in `elevenlabs.test.ts`. Here the captions are what
 * `buildCaptions` makes of the spans, and it folds a free-standing mark into the caption before
 * it — `"failed" "—"` becomes one caption `"failed—"`, exactly as it does for Kokoro's punctuation
 * tokens. So the assertion is that every *lexical* token of the script — one with a letter or a
 * digit in it — has its own caption, in order, carrying nothing but folded punctuation after it.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Captions, Narration, Timings } from "@xplainer/protocol";
import { decodeWav, narrate, pcmDurationMs } from "@xplainer/render-core";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createElevenLabsSynthesiser,
  ELEVENLABS_DEFAULT_MODEL,
  ELEVENLABS_DEFAULT_VOICE,
  requireWordSpans,
  TTS_PROVIDERS,
} from "./index.js";
import { recordedSpeech, scriptedClient, scriptedService } from "./testing/elevenlabs-fixture.js";

const require = createRequire(import.meta.url);
const ajv = new Ajv2020({ allErrors: true });
const validateTimings = ajv.compile(
  JSON.parse(readFileSync(require.resolve("@xplainer/protocol/schemas/timings.json"), "utf8")),
);
const validateCaptions = ajv.compile(
  JSON.parse(readFileSync(require.resolve("@xplainer/protocol/schemas/captions.json"), "utf8")),
);

const SENTENCE = recordedSpeech("with-timestamps");
const OVERRUN = recordedSpeech("with-timestamps-v4-overrun");

/** A token a voice speaks: it has a letter or a digit in it. */
const LEXICAL = /[\p{L}\p{N}]/u;

/** A caption's tail that `buildCaptions` folded in: punctuation only, as render-core defines it. */
const FOLDED = /^[^\p{L}\p{N}_]*$/u;

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("narrate() over ElevenLabs", () => {
  it("writes a track, timings.json and captions.json that the protocol schemas accept", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "xplainer-tts-e2e-"));
    scratch.push(outDir);
    const service = scriptedService([SENTENCE, OVERRUN]);
    // The two recordings were spoken by different models; one adapter speaks both here because the
    // service is scripted by text, and the model is not what this file is about.
    const synthesiser = requireWordSpans(
      createElevenLabsSynthesiser({
        client: scriptedClient(service),
        voice: ELEVENLABS_DEFAULT_VOICE,
        model: ELEVENLABS_DEFAULT_MODEL,
        log: () => {},
      }),
      "elevenlabs",
    );
    const narration: Narration = {
      voice: "af_heart",
      speed: 1,
      fps: 30,
      segments: [
        { id: "cause", text: SENTENCE.text },
        { id: "beat", text: "", holdSeconds: 1 },
        { id: "retry", text: `  ${OVERRUN.text.replace(" ", "\n  ")}  ` },
      ],
    };

    const result = await narrate({ narration, outDir, client: synthesiser });

    expect(TTS_PROVIDERS.elevenlabs.remote).toBe(true);
    // render-core's literal means "measured" (spec §11 C9); the worker prints the provider.
    expect(result.mode).toBe("kokoro");
    // One request per spoken segment, each with the text after render-core collapsed it.
    expect(service.requests.map((request) => request.body.text)).toEqual([
      SENTENCE.text,
      OVERRUN.text,
    ]);
    expect(service.requests.map((request) => request.voiceId)).toEqual([
      ELEVENLABS_DEFAULT_VOICE,
      ELEVENLABS_DEFAULT_VOICE,
    ]);

    const timings = JSON.parse(readFileSync(result.timingsPath, "utf8")) as Timings;
    const captions = JSON.parse(readFileSync(result.captionsPath, "utf8")) as Captions;
    expect(validateTimings(timings), JSON.stringify(validateTimings.errors)).toBe(true);
    expect(validateCaptions(captions), JSON.stringify(validateCaptions.errors)).toBe(true);

    expect(timings.segments.map((segment) => segment.id)).toEqual(["cause", "beat", "retry"]);
    const track = decodeWav(readFileSync(result.audioPath));
    expect(track.format).toEqual({ channels: 1, sampleWidth: 2, sampleRate: 24_000 });
    expect(pcmDurationMs(track.format, track.data.length)).toBeCloseTo(timings.totalMs, 0);
    // Both recorded clips are in the track at their full length, not their 100 ms prefix.
    expect(track.data.length).toBeGreaterThan(SENTENCE.audioBytes + OVERRUN.audioBytes);

    const script = `${SENTENCE.text} ${OVERRUN.text}`
      .split(/\s+/u)
      .filter((token) => LEXICAL.test(token));
    const shown = captions.map((caption) => caption.text.trim());
    expect(shown).toHaveLength(script.length);
    for (const [index, token] of script.entries()) {
      const caption = shown[index] ?? "";
      expect(caption.startsWith(token), `caption ${index}: ${caption} vs ${token}`).toBe(true);
      expect(FOLDED.test(caption.slice(token.length)), `caption ${index}: ${caption}`).toBe(true);
    }
    expect(shown).toContain("failed—");
    expect(shown).toContain("retry—");

    // Every caption lies inside the audio it captions: the eleven_v4 overrun was clamped.
    const retry = timings.segments[2];
    const lastCaption = captions.at(-1);
    expect(retry).toBeDefined();
    expect(lastCaption?.text.trim()).toBe("fast.");
    expect(lastCaption?.endMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      (retry?.startMs ?? 0) + 4_800 + 1,
    );
  });
});
