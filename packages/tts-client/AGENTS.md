# AGENTS.md — `@xplainer/tts-client`

Workspace rules and the post-change procedure: root [`AGENTS.md`](../../AGENTS.md).

## What this package is

**Request and response shaping for the speech services narration talks to**, and nothing else:
Kokoro-FastAPI, and ElevenLabs' `POST /v1/text-to-speech/{voice_id}/with-timestamps`. For each it
builds the exact JSON body, sends it through an injected transport, and types what comes back; for
ElevenLabs it also turns the response's character alignment into the same `WordTimestamp[]` Kokoro
reports (`src/elevenlabs/alignment.ts`, a pure function). It does not synthesise, does not decode or
wrap audio, does not retry, does not read the environment and does not own a process.

The narration port lives in [`@xplainer/render-core`](../render-core/AGENTS.md), which depends on
this package: `src/narrate/build.ts` drives `KokoroClient`, and `WordTimestamp` from here is the
measured input every timing downstream is derived from. The ElevenLabs half has one caller,
`apps/cli/src/tts/`, which owns everything this package refuses to: wrapping the raw PCM as a WAV
(that needs render-core's `encodeWav`, and render-core already depends on this package), bounding
word spans by the decoded audio's duration, retries, and the choice of provider.

It declares no runtime workspace dependencies — `@xplainer/config` is a devDependency, for the
shared lint and TypeScript configuration and nothing else. It is published, emits declarations, and
carries `api/tts-client.api.md`. `test/fixtures/elevenlabs/` holds three responses recorded from the
live API; `files` in `package.json` ships `dist/` and the licences only, so they never reach the
tarball.

## Public surface

From `src/index.ts`, Kokoro: `KokoroClient` and `KokoroClientOptions`, `KokoroError`,
`buildCaptionedSpeechPayload`, `resolveBaseUrl`, `normaliseVoiceList`, the constants
`DEFAULT_BASE_URL`, `BASE_URL_ENV_VAR`, `DEFAULT_SPEED`, `VOICES_PATH`, `CAPTIONED_SPEECH_PATH`, and
the request/response types including `WordTimestamp` and the `FetchLike` seam (`HttpRequestInit`
carries an optional `signal` and `redirect`).

ElevenLabs, re-exported from `src/elevenlabs/index.ts`: `ElevenLabsClient` and
`ElevenLabsClientOptions`, `ElevenLabsError` (`status`, `code`, `retryable`),
`buildElevenLabsSpeechPayload`, `timestampedSpeechPath`, `alignmentToWordTimestamps`, the constants
`ELEVENLABS_DEFAULT_BASE_URL`, `ELEVENLABS_OUTPUT_FORMAT`, `ELEVENLABS_SAMPLE_RATE`,
`ELEVENLABS_REQUEST_TIMEOUT_MS`, and the types `ElevenLabsAlignment`, `ElevenLabsSpeechRequest`,
`ElevenLabsSpeechPayload` and `ElevenLabsSpeech`.

## Commands

```bash
pnpm --filter @xplainer/tts-client test
pnpm turbo build --filter @xplainer/tts-client   # where TS9010 appears

# The live half, against a real container (P1-3). Skipped when the variable is unset.
docker run -d --rm --name xplainer-e2e-kokoro -p 127.0.0.1:8880:8880 \
  ghcr.io/remsky/kokoro-fastapi-cpu:latest
XPLAINER_TTS_URL=http://127.0.0.1:8880 pnpm --filter @xplainer/tts-client test

# The ElevenLabs live half: one real request. Skipped when the variable is unset or blank.
ELEVENLABS_API_KEY=… pnpm --filter @xplainer/tts-client test
```

**The ElevenLabs live test bills whoever exports the key**, about 45 characters every time it runs.
It runs under `pnpm --filter @xplainer/tts-client test` (and plain `vitest run`), which hand vitest
the whole shell, so a developer with `ELEVENLABS_API_KEY` in their profile pays for it on every such
run. It does **not** run under `turbo run test`, `pnpm check` or `pnpm verify`: `turbo.json` sets no
`envMode`, so turbo 2's default **strict** mode applies, and it declares no `env`, `globalEnv`,
`passThroughEnv` or `globalPassThroughEnv`, so turbo hands the task no `ELEVENLABS_API_KEY` and the
block is skipped. Checked on 2026-11-11 with `turbo run test --dry=json` (`envMode: strict`, nothing
passed through) and by running the gated Kokoro block both ways. Declaring the variable in
`turbo.json` would make every `pnpm verify` on that machine spend money, so do not.

Then the root procedure: `pnpm verify`.

## Invariants

- **The Kokoro HTTP contract is pinned** by
  [ADR 0006](../../docs/adr/0006-kokoro-fastapi-http-contract-as-tts-interface.md). The two paths —
  `/v1/audio/voices` and `/dev/captioned_speech` — and the payload flags are the interface. Changing
  one is an ADR-level change, not an edit here.
- **`/dev/captioned_speech` is the endpoint because of word-level timestamps.** That is the whole
  reason for preferring it over the plain speech endpoint: every scene duration downstream is
  derived from those timestamps, and the captions are burned in from them. Do not "simplify" to the
  standard endpoint.
- **Take the environment as an argument; never read `process.env` at module scope.**
  `resolveBaseUrl()` is given the environment, so a test can pass one and a caller can pass another.
  A module-scope read makes the package untestable and its behaviour dependent on import order.
- **`fetch` is injected**, through the `FetchLike` seam, for the same reason.
- **The live suite is gated, never required.** `client.test.ts`'s last block talks to a real Kokoro
  server and runs only when `XPLAINER_TTS_URL` is set — the same variable the daemon's narration
  worker reads, so one export drives both it and `pnpm e2e:render`. It is what catches a server that
  renamed an endpoint or stopped returning `timestamps`, which every stubbed test above it would
  stay green through. Making it mandatory would make `pnpm verify` fail on any machine with no
  container, which is most of them, so it stays a skip.
- **`isolatedDeclarations` is on `tsconfig.build.json`**, so `TS9010` surfaces under
  `pnpm turbo build` — not under `typecheck`, and not in your editor.

ElevenLabs:

- **`alignment` is the timed text; `normalized_alignment` is never read.** `alignment` is timed over
  the characters as sent, digits and dashes included; `normalized_alignment` is timed over the
  service's reading of them (`—` comes back as `--`, with padding spaces), and captions must show the
  script. A response whose `alignment` is absent, `null` or empty is refused as
  `alignment_missing` even when `normalized_alignment` is present — never repaired from it.
- **A word ends where its last character ends**, never where the next word starts, and punctuation
  stays attached to the word it touches. `alignmentToWordTimestamps` refuses (`alignment_invalid`)
  rather than repairs: unequal or empty arrays, a non-finite or negative time, a character or an
  assembled word that ends before it starts, and a word that starts or ends before the word in front
  of it. Equal times and overlapping words are accepted.
- **`alignmentToWordTimestamps` does not know how long the audio is, and must not learn.** The
  service's alignment can run past its own audio (4.88 s over 4.80 s of `eleven_v4`, recorded in
  `test/fixtures/elevenlabs/with-timestamps-v4-overrun.json`). Bounding spans by the decoded
  duration is the CLI's job, because only the CLI decodes the audio.
- **`audio` is base64 raw PCM, `pcm_24000`, fixed.** No header, 24 kHz mono S16LE, the format the
  Kokoro routes produce, available on every tier. This package never wraps it.
- **One attempt, no retry.** `ElevenLabsError.retryable` is `true` for `429` and `5xx` only, and
  derived from the status so it cannot disagree with it. A timeout (`code: "timeout"`, after
  `ELEVENLABS_REQUEST_TIMEOUT_MS`) and a transport failure (`"network"`) are **not** retryable: the
  service may have finished and billed that request. Whether to retry belongs to the caller that
  pays for it.
- **`code` is `detail.status` when that is a string, else `detail.code`.** The recorded bodies in
  `test/fixtures/elevenlabs/errors.json` are why: a `401` arrives as `code: "unauthorized"`,
  `status: "invalid_api_key"`, and a bad model has `status` and no `code` at all.
- **The API key appears in the `xi-api-key` header and nowhere else.** Every message composed from
  text the client did not write — the service's `code` included — is redacted before it is
  truncated, so neither an echoing service nor a cut that lands mid-key puts one into a job log. A
  test asserts both. The request is sent with `redirect: "error"`, because `fetch` keeps a custom
  header across a cross-origin redirect and follows one from `https` to `http`.
- **The fixtures are recorded, not written.** Copy a new recording in; never hand-edit a value. The
  JSON is formatted by `biome` (the root `biome.json` does not exclude this directory), which
  changes whitespace and nothing else.

## How to add

**A request field:** add it to the payload type in `src/types.ts`, set it in
`buildCaptionedSpeechPayload`, and assert the built body in a test. If the server does not document
the field, it does not go in.

**An endpoint:** add the path constant, add the method to `KokoroClient`, and record the contract
change against ADR 0006 before writing the code.

**An ElevenLabs request field:** add it to `ElevenLabsSpeechPayload` in `src/elevenlabs/types.ts`,
set it in `buildElevenLabsSpeechPayload` only when the caller asked for it, and assert the built
body with `toStrictEqual`. Every field the service charges or behaves differently for belongs to the
owner's configuration in the CLI, never to an MCP argument.

**An export:** add it to `src/index.ts` explicitly, run `pnpm api:report`, commit the `.api.md`.

Finish with `pnpm verify`.
