---
"@xplainer/render-core": minor
---

Add the grapheme-to-phoneme port under `src/g2p/`: English text to Kokoro's IPA phoneme string,
plus a character span per word so the model's own per-token duration predictions can be accumulated
back into word-level timings.

A word resolves through four layers, in order, and the order is the design:

1. a **curated domain lexicon** (`src/g2p/data/lexicon.txt`), committed as reviewable data with a
   gloss on every line — "nginx" is "engine X" and "PostgreSQL" is "post-gres-Q-L", and no rule
   about English would ever produce either;
2. **CMUdict**, vendored verbatim under its 2-clause BSD licence, which covers ordinary narration
   prose completely;
3. a **deterministic letter-to-sound ruleset** for the long tail, plus an initialism speller, both
   of which report what they derived so the caller can log it;
4. a **named refusal** — `G2pError`, carrying the word — never an empty string.

That last point is the reason for the shape. Kokoro's own pipeline builds its G2P with `unk=''` and
filters unknown symbols away, so an out-of-dictionary word becomes silence and the narration is
quietly missing a word. Nothing here can produce that: `phonemise()` refuses, and `kokoroTokenIds()`
refuses a phoneme outside the model's 115-symbol vocabulary rather than dropping it — a property
asserted over every symbol every layer can emit.

Affricates and diphthongs are emitted as misaki's single characters — `ʧ ʤ A I O W Y` — rather than
as `tʃ dʒ eɪ aɪ oʊ aʊ ɔɪ`. Kokoro was trained against misaki and reads a two-symbol sequence as two
segments: measured against misaki's own output, the affricate region stretches ×1.70 and the
diphthong ×1.66, and a sentence with eight of them ran 9.5% long. The choice is made in the
ARPAbet table, which is the only place that can make it correctly — English has genuine `t`+`ʃ` and
`ɔ`+`ɪ` sequences ("nutshell", "drawing") that are character-identical in IPA, and ARPAbet is the
last representation that still separates them.

New exports: `phonemise`, `kokoroVocabulary`, `kokoroTokenIds`, `unsupportedSymbols`, `G2pError`,
and the types `Phonemisation`, `WordSpan`, `DerivedPronunciation`, `PhonemeSource` and
`G2pErrorCode`. The package now ships `dist/g2p/data/`, which includes CMUdict and its licence.
