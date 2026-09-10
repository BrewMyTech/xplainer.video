/**
 * Layer 2 of four: CMUdict (plan §5, S0b).
 *
 * 126,052 words transcribed by hand at Carnegie Mellon, under a 2-clause BSD
 * licence whose own words are "use ... for any research or commercial purpose is
 * completely unrestricted". The S0b spike measured it at **50 of 50** on
 * ordinary narration prose, which is why the layer above it can be small and the
 * layer below it is rarely reached: everything a sentence is made of — the
 * verbs, the articles, the connectives — is in here and correct.
 *
 * `data/cmudict.dict` is the cmusphinx distribution verbatim, sha256
 * `81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22`, with
 * `data/cmudict.LICENSE` beside it as clause 1 requires. Vendored rather than
 * fetched: this is a pure module with no network, and a G2P that needed a
 * download would fail on the machine `setup` has not run on yet.
 *
 * **The two things about its format that are not obvious.**
 *
 * 1. **Variants are `word(2)`, `word(3)`, …** — alternative pronunciations of
 *    the same spelling, in no particular order of preference. We take the
 *    **first** one, which is the unparenthesised entry, because a G2P has to be
 *    a function: the same word must always produce the same phonemes, or a
 *    caption written on one run does not match the audio of the next. Choosing
 *    between "reed" and "red" for `read` needs a part-of-speech tagger, which is
 *    a model, which is what D8 chose not to have.
 * 2. **Some lines carry a trailing ` # …` annotation** — `aalborg AO1 L B AO0 R
 *    G # place, danish`. Read as phones those become the tokens `#`, `place,`
 *    and `danish`, none of which is ARPAbet; the translation would then refuse
 *    the whole word and a perfectly good pronunciation would fall through to
 *    layer 3. The comment is cut before the split.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { arpabetToIpa } from "./arpabet.js";

/** Where the vendored dictionary sits, beside this module in `src/` and in `dist/`. */
const CMUDICT_PATH = fileURLToPath(new URL("data/cmudict.dict", import.meta.url));

/**
 * The lower bound on entries a healthy parse produces.
 *
 * The distribution has 126,052 distinct spellings. This is not an equality
 * check — a dictionary update is allowed to add words — but a parse that
 * produced far fewer would mean the format changed under us, and the symptom of
 * that is not an error: it is every ordinary word quietly falling through to the
 * letter-to-sound layer and the narration coming out subtly wrong everywhere.
 */
const MINIMUM_ENTRIES = 120_000;

/** Spelling → the first pronunciation's ARPAbet phones. Parsed once, on first use. */
let cached: ReadonlyMap<string, readonly string[]> | null = null;

/**
 * Read and index the dictionary.
 *
 * Costs about 60 ms and about 30 MB for the whole file, so it is lazy: a
 * `xplainer status` that never narrates must not pay for it. Once loaded it
 * serves every word of every segment in a narration job, so nothing finer
 * grained than "all of it, once" is worth the complexity.
 */
function loadCmudict(): ReadonlyMap<string, readonly string[]> {
  if (cached !== null) {
    return cached;
  }
  const dictionary = new Map<string, readonly string[]>();
  for (const rawLine of readFileSync(CMUDICT_PATH, "utf8").split("\n")) {
    const hash = rawLine.indexOf("#");
    const line = (hash < 0 ? rawLine : rawLine.slice(0, hash)).trim();
    if (line === "") {
      continue;
    }
    const separator = line.search(/\s/);
    if (separator < 0) {
      continue;
    }
    const spelling = line
      .slice(0, separator)
      .replace(/\(\d+\)$/, "")
      .toLowerCase();
    if (dictionary.has(spelling)) {
      continue;
    }
    const phones = line.slice(separator).trim().split(/\s+/);
    dictionary.set(spelling, phones);
  }
  if (dictionary.size < MINIMUM_ENTRIES) {
    throw new Error(
      `${CMUDICT_PATH}: parsed ${dictionary.size} entries, expected at least ` +
        `${MINIMUM_ENTRIES}. The vendored dictionary is truncated or its format has changed, ` +
        "and the symptom would be ordinary English silently falling through to letter-to-sound.",
    );
  }
  cached = dictionary;
  return cached;
}

/** How many spellings the vendored dictionary carries, for the coverage tests. */
export function cmudictSize(): number {
  return loadCmudict().size;
}

/** `word`'s ARPAbet phones — the first pronunciation — or `null` if it is not in the dictionary. */
export function lookUpCmudictPhones(word: string): readonly string[] | null {
  return loadCmudict().get(word.toLowerCase()) ?? null;
}

/**
 * `word`'s pronunciation as Kokoro IPA, or `null` if the dictionary does not
 * carry it — or carries it in phones this package cannot translate, which is the
 * same answer for the caller and is why the two cases are not distinguished
 * here: either way the next layer down has to try.
 */
export function lookUpCmudict(word: string): string | null {
  const phones = lookUpCmudictPhones(word);
  return phones === null ? null : arpabetToIpa(phones);
}
