/**
 * A recorded-speech directory, built on the spot, for tests that must narrate without a server.
 *
 * `XPLAINER_TTS_FIXTURE` stands in for Kokoro, not for `@xplainer/tts-client` and not for the
 * narration port: what this writes is a real 16-bit PCM WAV per spoken segment plus the word spans
 * a server would have reported, and everything downstream of that — decoding, measuring the frames,
 * planning the offsets, concatenating the track, writing the three documents — is the shipping code
 * path. That is the point. A test that stubbed `narrate()` would prove the daemon can call a
 * function; this proves the daemon produces a `timings.json` that a render can be measured against.
 *
 * The clips are sine tones rather than silence, and each segment gets its own frequency, so a
 * decoder that returned zeroes, or a track builder that concatenated the wrong clip, fails instead
 * of passing quietly.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Narration, NarrationSegment } from "@xplainer/protocol";
import { DEFAULT_SAMPLE_RATE, encodeWav } from "@xplainer/render-core";
import type { WordTimestamp } from "@xplainer/tts-client";

/** A segment with recorded speech behind it. */
export type SpokenFixture = {
  /** The narration segment id, which is also the fixture's filename stem. */
  id: string;
  /** What the voice says. Matched verbatim against the request the narration port makes. */
  text: string;
  /** Minimum on-screen duration, when the segment should outlast its speech. */
  holdSeconds?: number;
  /** Length of the recorded clip, in seconds. */
  seconds: number;
  /** Sine frequency of the clip, in hertz, so two clips differ in the bytes as well. */
  frequency: number;
  /** Word spans in seconds from the start of the clip, as a server would report them. */
  words: readonly WordTimestamp[];
};

/** A segment with no speech at all: silence for exactly its hold. */
export type SilentFixture = {
  id: string;
  holdSeconds: number;
};

/** One narration segment, recorded or deliberately silent. */
export type NarrationFixture = SpokenFixture | SilentFixture;

function isSpoken(fixture: NarrationFixture): fixture is SpokenFixture {
  return "text" in fixture;
}

/** One clip: `seconds` of a sine at `frequency`, mono 16-bit at Kokoro's own rate. */
function sineWav(seconds: number, frequency: number): Buffer {
  const frames = Math.round(DEFAULT_SAMPLE_RATE * seconds);
  const data = Buffer.alloc(frames * 2);
  for (let n = 0; n < frames; n += 1) {
    data.writeInt16LE(
      Math.round(8000 * Math.sin((2 * Math.PI * frequency * n) / DEFAULT_SAMPLE_RATE)),
      n * 2,
    );
  }
  return encodeWav({
    format: { channels: 1, sampleWidth: 2, sampleRate: DEFAULT_SAMPLE_RATE },
    data,
  });
}

/**
 * Write a fixture directory and return the narration spec that goes with it.
 *
 * @param dir the directory to fill; created if it does not exist
 * @param fixtures the segments, in narration order
 * @returns the `Narration` to pass to `explainer_narrate`
 */
export function writeNarrationFixture(
  dir: string,
  fixtures: readonly NarrationFixture[],
): Narration {
  mkdirSync(dir, { recursive: true });

  const manifest: { text: string; audio: string; words: string }[] = [];
  const segments: NarrationSegment[] = [];

  for (const fixture of fixtures) {
    if (!isSpoken(fixture)) {
      segments.push({ id: fixture.id, text: "", holdSeconds: fixture.holdSeconds });
      continue;
    }
    const audio = `${fixture.id}.wav`;
    const words = `${fixture.id}-words.json`;
    writeFileSync(join(dir, audio), sineWav(fixture.seconds, fixture.frequency));
    writeFileSync(join(dir, words), `${JSON.stringify(fixture.words, null, 2)}\n`);
    manifest.push({ text: fixture.text, audio, words });
    segments.push({
      id: fixture.id,
      text: fixture.text,
      ...(fixture.holdSeconds === undefined ? {} : { holdSeconds: fixture.holdSeconds }),
    });
  }

  writeFileSync(join(dir, "fixtures.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // `Narration.segments` is a non-empty tuple, because the schema says `minItems: 1`. Destructuring
  // is how that is proved rather than asserted, and an empty fixture list is a mistake in the test
  // that wrote it rather than something to paper over with a cast.
  const [first, ...rest] = segments;
  if (first === undefined) {
    throw new Error("a narration fixture needs at least one segment.");
  }
  return { voice: "af_heart", speed: 1, fps: 30, segments: [first, ...rest] };
}
