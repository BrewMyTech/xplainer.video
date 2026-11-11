---
"@xplainer/cli": patch
---

Narration can now be spoken by ElevenLabs instead of the built-in Kokoro voice, chosen by the
machine's owner with the new `xplainer config` command (`set`, `get`, `unset`, `list`); the API key
is stored `0600` in `credentials.json`, is never accepted on the command line or printed, and
`xplainer status` gains a `speech` line naming the provider and whether a key is stored. Every
ElevenLabs narration is billed per character to that account and sends its text to ElevenLabs; a
failure is a failed job that says why, never a silent switch back to Kokoro, and Kokoro remains the
default with its behaviour unchanged.
