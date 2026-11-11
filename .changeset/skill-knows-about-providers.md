---
"@xplainer/skill": patch
---

The skill now tells the agent which voice is speaking and what that changes: under ElevenLabs every
real narration is billed per character, so iterate with `dry_run: true`; leave `voice` out unless
the user named one; keep `speed` within 0.7–1.2; respell a mispronounced word rather than editing
`lexicon.txt`; and never ask for, read or write the API key or change the provider — those are the
user's, through `xplainer config`.
