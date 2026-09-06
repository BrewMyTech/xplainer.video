# AGENTS.md — `@xplainer/tts-client`

Workspace rules and the post-change procedure: root [`AGENTS.md`](../../AGENTS.md).

## What this package is

**Request and response shaping for Kokoro-FastAPI**, and nothing else. It builds the exact JSON body
posted to the TTS server, normalises the voice list, and types what comes back. It does not
synthesise, does not touch audio, does not compute timings and does not own a process — those land
at roadmap phase 1 with the narration port.

It declares no workspace dependencies. It is published, emits declarations, and carries
`api/tts-client.api.md`.

## Public surface

From `src/index.ts`: `KokoroClient` and `KokoroClientOptions`, `KokoroError`,
`buildCaptionedSpeechPayload`, `resolveBaseUrl`, `normaliseVoiceList`, the constants
`DEFAULT_BASE_URL`, `BASE_URL_ENV_VAR`, `DEFAULT_SPEED`, `VOICES_PATH`, `CAPTIONED_SPEECH_PATH`, and
the request/response types including `WordTimestamp` and the `FetchLike` seam.

## Commands

```bash
pnpm --filter @xplainer/tts-client test
pnpm turbo build --filter @xplainer/tts-client   # where TS9010 appears

# The live half, against a real container (P1-3). Skipped when the variable is unset.
docker run -d --rm --name xplainer-e2e-kokoro -p 127.0.0.1:8880:8880 \
  ghcr.io/remsky/kokoro-fastapi-cpu:latest
XPLAINER_TTS_URL=http://127.0.0.1:8880 pnpm --filter @xplainer/tts-client test
```

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
  worker reads, so one export drives both it and `pnpm e2e:macos`. It is what catches a server that
  renamed an endpoint or stopped returning `timestamps`, which every stubbed test above it would
  stay green through. Making it mandatory would make `pnpm verify` fail on any machine with no
  container, which is most of them, so it stays a skip.
- **`isolatedDeclarations` is on `tsconfig.build.json`**, so `TS9010` surfaces under
  `pnpm turbo build` — not under `typecheck`, and not in your editor.

## How to add

**A request field:** add it to the payload type in `src/types.ts`, set it in
`buildCaptionedSpeechPayload`, and assert the built body in a test. If the server does not document
the field, it does not go in.

**An endpoint:** add the path constant, add the method to `KokoroClient`, and record the contract
change against ADR 0006 before writing the code.

**An export:** add it to `src/index.ts` explicitly, run `pnpm api:report`, commit the `.api.md`.

Finish with `pnpm verify`.
