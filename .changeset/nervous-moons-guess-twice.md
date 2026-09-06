---
"@xplainer/tts-client": minor
---

Make `TtsError.status` a required property that may be `undefined`.

It was `readonly status?: number`. Under `exactOptionalPropertyTypes` an optional
property and a defined-but-`undefined` one are different types, and the second is
what this field means: every `TtsError` either carries an HTTP status or is a
transport failure that has none. `readonly status: number | undefined` says that,
so a consumer reads the absence instead of guessing whether the property exists.
The constructor still takes `status?: number`, so every existing call site
compiles unchanged; only code that builds a `TtsError`-shaped object literal by
hand has to add the field.
