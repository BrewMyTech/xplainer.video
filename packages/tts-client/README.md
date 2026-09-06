# @xplainer/tts-client

**Request and response shaping for [Kokoro-FastAPI][kokoro], and nothing else.** It builds the
exact JSON body posted to a Kokoro server, normalises the voice list, and types what comes back.
It does not synthesise, does not touch audio, does not compute timings and does not own a
process.

```bash
npm i @xplainer/tts-client
```

```ts
import { KokoroClient, resolveBaseUrl } from "@xplainer/tts-client";

const client = new KokoroClient({ baseUrl: resolveBaseUrl(process.env) });
const voices = await client.listVoices();
const speech = await client.captionedSpeech({ input: "…", voice: voices[0] });
```

## The two endpoints

| Path | Why it is the one used |
|---|---|
| `/v1/audio/voices` | The voice list, normalised to plain strings whichever shape the server returns |
| `/dev/captioned_speech` | The only endpoint that returns **word-level timestamps** alongside the audio |

`/dev/captioned_speech` is not a convenience: word timestamps are what every scene duration is
computed from, so a narration built on `/v1/audio/speech` would have no measured timing to
derive from.

The base URL defaults to `http://localhost:8880` and is overridden by the `KOKORO_URL`
environment variable. `fetch` is injectable, so a consumer can test against a fake without a
server. The exported surface is recorded in `api/tts-client.api.md` in the repository.

## Docs

- [Architecture][architecture] — the members and the dependency direction
- [Decision records][adr]
- [Roadmap][roadmap] — what is built and what is not

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`, both shipped inside this package.

[kokoro]: https://github.com/remsky/Kokoro-FastAPI
[architecture]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/ARCHITECTURE.md
[adr]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/adr/README.md
[roadmap]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/ROADMAP.md
