---
"@xplainer/tts-client": patch
---

Adds an ElevenLabs client for `POST /v1/text-to-speech/{voice_id}/with-timestamps`:
`ElevenLabsClient`, `ElevenLabsError` (with `status`, `code` and `retryable`),
`buildElevenLabsSpeechPayload`, and `alignmentToWordTimestamps`, which turns the response's
character alignment into the same word spans Kokoro returns — never reading `normalized_alignment`,
and refusing an alignment it cannot time rather than repairing it. `HttpRequestInit` gains an
optional `signal`.
