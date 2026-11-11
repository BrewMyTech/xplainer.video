---
"@xplainer/protocol": patch
---

`narration.json`'s `voice`, `speed` and `langCode` descriptions now say what each means under the
speech provider the machine is configured with: under ElevenLabs, `voice` is omitted (or the
default) for the owner's configured voice or a 20-character ElevenLabs voice id, `speed` must be
0.7–1.2, and `langCode` is ignored. Descriptions only — no property, type, default or bound changed.
