# @xplainer/tts-client

**Request and response shaping for the speech services narration talks to, and nothing else:**
[Kokoro-FastAPI][kokoro], and ElevenLabs' [with-timestamps endpoint][elevenlabs]. For each it builds
the exact JSON body, sends it through an injectable `fetch`, and types what comes back. It does not
synthesise, does not decode or wrap audio, does not retry, does not read the environment and does
not own a process.

```bash
npm i @xplainer/tts-client
```

```ts
import { KokoroClient, resolveBaseUrl } from "@xplainer/tts-client";

const client = new KokoroClient({ baseUrl: resolveBaseUrl(process.env) });
const voices = await client.listVoices();
const speech = await client.captionedSpeech({ input: "…", voice: voices[0] });
```

## Kokoro: the two endpoints

| Path | Why it is the one used |
|---|---|
| `/v1/audio/voices` | The voice list, normalised to plain strings whichever shape the server returns |
| `/dev/captioned_speech` | The only endpoint that returns **word-level timestamps** alongside the audio |

`/dev/captioned_speech` is not a convenience: word timestamps are what every scene duration is
computed from, so a narration built on `/v1/audio/speech` would have no measured timing to
derive from.

The base URL defaults to `http://localhost:8880`, and `resolveBaseUrl(env)` takes it from a
`KOKORO_URL` in the environment it is given. `fetch` is injectable, so a consumer can test against a fake without a
server. The exported surface is recorded in `api/tts-client.api.md` in the repository.

## ElevenLabs

```ts
import { alignmentToWordTimestamps, ElevenLabsClient } from "@xplainer/tts-client";

const client = new ElevenLabsClient({ apiKey });
const speech = await client.timestampedSpeech({
  text: "The build failed — start again.",
  voiceId: "JBFqnCBsd6RMkjVDRZzb",
  modelId: "eleven_multilingual_v2",
});
const words = alignmentToWordTimestamps(speech.alignment); // the same shape Kokoro returns
```

One endpoint, `POST /v1/text-to-speech/{voice_id}/with-timestamps`, because it is the one that
answers with **character timings beside the audio**; the plain speech endpoint is not modelled.

- **`alignment`, never `normalized_alignment`.** `alignment` is timed over the characters as sent;
  `normalized_alignment` over the service's rewriting of them (`—` becomes `--`). A response with no
  usable `alignment` is refused as `alignment_missing`, whatever else it carries.
- **`alignmentToWordTimestamps` is pure.** A word is a run of non-whitespace characters, with
  punctuation attached; it starts at its first character's start and ends at its last character's
  own end. Empty or unequal arrays, a non-finite or negative time, a span that ends before it
  starts, and words whose starts or ends go backwards are refused as `alignment_invalid`, never
  repaired. It knows nothing about the audio's length — bounding spans by it is the caller's job.
- **The audio is raw PCM**, base64, `pcm_24000`: 24 kHz mono signed 16-bit, no header. Wrapping it
  as a WAV is the caller's job.
- **One attempt, no retry.** `ElevenLabsError` carries `status`, `code` — the service's
  `detail.status` when that is a string, else `detail.code`, or this client's own `timeout`,
  `network`, `audio_missing`, `alignment_missing`, `alignment_invalid`, `response_invalid` — and
  `retryable`, which is `true` for `429` and `5xx` only. A timeout is not retryable, because the
  service may have finished, and billed, the request anyway.
- **The API key is sent as `xi-api-key` and appears nowhere else**; every message composed from text
  the client did not write has it replaced with `[redacted]`.

ElevenLabs bills per character. In the `xplainer` CLI the provider, model and key are chosen by the
machine's owner with `xplainer config`, never by an agent — see
[ADR 0030][adr-0030].

## Docs

- [Architecture][architecture] — the members and the dependency direction
- [Decision records][adr]
- [Roadmap][roadmap] — what is built and what is not

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`, both shipped inside this package.

[kokoro]: https://github.com/remsky/Kokoro-FastAPI
[elevenlabs]: https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps
[adr-0030]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/adr/0030-speech-providers-are-admitted-by-their-timestamps.md
[architecture]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/ARCHITECTURE.md
[adr]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/adr/README.md
[roadmap]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/ROADMAP.md
