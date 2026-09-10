/**
 * ARPAbet → IPA, restricted to symbols Kokoro has a token for.
 *
 * CMUdict is written in ARPAbet: 39 phones, each vowel carrying a stress digit
 * (`0` none, `1` primary, `2` secondary). Kokoro's input is IPA with `ˈ` and `ˌ`
 * stress marks. This module is the whole of the translation, and every value it
 * can produce is checked against the model's 115-symbol vocabulary by
 * `vocab.test.ts` — a symbol outside it is dropped by the model, which is the
 * class of defect D5 exists to prevent.
 *
 * **Three choices in this table are not the obvious ones, and each is written
 * down because the obvious one is silently wrong.**
 *
 * 1. **`G` is `ɡ` U+0261 LATIN SMALL LETTER SCRIPT G, never ASCII `g`.** The
 *    vocabulary carries `a`–`f` and `h`–`z` and skips id 49 exactly where `g`
 *    would sit: ASCII `g` was removed deliberately, because it is a letter and
 *    `ɡ` is a phoneme. They are indistinguishable in most editors, so a `g`
 *    typed here would be dropped by the model and "go" would come out as "oh".
 *
 * 2. **`AH0` is `ə`, while `AH1` and `AH2` are `ʌ`.** CMUdict spells both the
 *    stressed STRUT vowel and the unstressed schwa `AH`, and separates them only
 *    by the stress digit. Collapsing them to `ʌ` — which the S0b prototype did —
 *    makes every unstressed syllable in the language a full vowel, so "about"
 *    becomes "a-BOWT" with a hard first vowel. `ə` is in the vocabulary; the
 *    distinction costs one branch and buys natural reduction.
 *
 * 3. **Affricates and diphthongs are single characters — misaki's forms — and
 *    this table is the only place that can get that right.** `CH` is `ʧ` (id
 *    133), `JH` is `ʤ` (82), and `EY`/`AY`/`OW`/`AW`/`OY` are misaki's uppercase
 *    shorthands `A`/`I`/`O`/`W`/`Y` (24, 25, 31, 39, 41) rather than the
 *    sequences `eɪ`/`aɪ`/`oʊ`/`aʊ`/`ɔɪ`.
 *
 *    **Settled by measurement, 2026-09-10**, by the synthesiser lane against a
 *    real model; the full reading is in `apps/cli/src/speech/tokens.ts`. Both
 *    spellings are in the vocabulary, so both synthesise and the question looked
 *    cosmetic. It is not. Kokoro was *trained* against misaki, `/dev/phonemize`
 *    emits the single characters without exception — "The change managed to
 *    adjust the major stage." is `ðə ʧˈAnʤ mˈænɪʤd tʊ əʤˈʌst ðə mˈAʤəɹ stˈAʤ.`
 *    — and the model's duration predictor treats a sequence as **two segments**:
 *    holding everything else identical, the affricate region stretches **×1.70
 *    in 24 of 24 occurrences** and the diphthong region **×1.66 in 18 of 18**. A
 *    sentence with eight of them ran 9.5% long. `tʃ` is spoken as a stop *then*
 *    a fricative; `eɪ` as two vowels.
 *
 *    **And this is the only place the fix can go.** Contracting `tʃ`→`ʧ` in a
 *    finished IPA string would be a mispronunciation, because English also has
 *    genuine `t`+`ʃ` and `ɔ`+`ɪ` sequences and in an IPA string those are
 *    character-identical to the affricate and the diphthong: "nutshell" is
 *    `nˈʌtʃˌɛl` (`N AH1 T SH EH2 L` — two morphemes) and "drawing" is `dɹˈɔɪŋ`
 *    (`D R AO1 IH0 NG` — "draw" plus "-ing"), not the `ɔɪ` of "choice". A
 *    contraction pass makes those "nu-chell" and "droy-ing", trading a 70%
 *    timing error for an outright wrong word. **ARPAbet still carries the
 *    distinction** — `CH` against `T SH`, `OY` against `AO IH` — so a table
 *    keyed on the phone emits `ʧ` for one and `tʃ` for the other by
 *    construction, with no rule and no exception list.
 *
 *    Keying on the phone buys one more thing, which is easy to miss: it follows
 *    **CMUdict's transcription rather than the spelling**, and those disagree.
 *    Two words usually cited as `t`+`ʃ` clusters are not clusters in CMUdict at
 *    all — "courtship" is `K AO1 R CH IH2 P`, with the /t/ and /ʃ/ already fused
 *    to an affricate, and "hotshot" is `HH AA1 SH AA2 T` with no /t/ before the
 *    /ʃ/ whatsoever. A rule over letters would have had to guess at both. All of
 *    this is pinned in `cmudict.test.ts` §"the affricate against the genuine
 *    cluster", so a contraction pass added later fails loudly rather than
 *    quietly.
 *
 * `ER` is `ɚ` at every stress level. The vocabulary has no `ɝ` — the stressed
 * r-coloured vowel — so the distinction cannot be represented at all, and `ɚ`
 * with a stress mark in front of it is what is left.
 */

/**
 * The stress mark for each CMUdict stress digit.
 *
 * The mark goes immediately **before the vowel**, not before the syllable's
 * onset consonants: `kˈæʃt`, not `ˈkæʃt`. That is misaki's convention and
 * therefore Kokoro's — `kˈOkəɹO` for "Kokoro" — and it is also what falls out of
 * ARPAbet naturally, since stress there is a property of the vowel. The curated
 * lexicon in `data/lexicon.txt` is written to the same convention, so all four
 * resolution layers agree about where a mark sits.
 */
export const STRESS_MARKS: Readonly<Record<string, string>> = {
  "0": "",
  "1": "ˈ",
  "2": "ˌ",
};

/** Primary stress, as the letter-name table and the initialism speller need it. */
export const PRIMARY_STRESS = "ˈ";

/** Secondary stress, likewise. */
export const SECONDARY_STRESS = "ˌ";

/**
 * The 39 ARPAbet phones, minus `AH`, which needs the stress digit to be
 * translated and is handled in {@link arpabetPhoneToIpa}.
 */
const ARPABET_TO_IPA: Readonly<Record<string, string>> = {
  AA: "ɑ",
  AE: "æ",
  AO: "ɔ",
  AW: "W",
  AY: "I",
  B: "b",
  CH: "ʧ",
  D: "d",
  DH: "ð",
  EH: "ɛ",
  ER: "ɚ",
  EY: "A",
  F: "f",
  G: "ɡ",
  HH: "h",
  IH: "ɪ",
  IY: "i",
  JH: "ʤ",
  K: "k",
  L: "l",
  M: "m",
  N: "n",
  NG: "ŋ",
  OW: "O",
  OY: "Y",
  P: "p",
  R: "ɹ",
  S: "s",
  SH: "ʃ",
  T: "t",
  TH: "θ",
  UH: "ʊ",
  UW: "u",
  V: "v",
  W: "w",
  Y: "j",
  Z: "z",
  ZH: "ʒ",
};

/** The stressed STRUT vowel. */
const AH_STRESSED = "ʌ";

/** The unstressed schwa `AH0` reduces to. See choice 2 in the module docblock. */
const AH_REDUCED = "ə";

/**
 * Every IPA symbol this table can put into an output string, stress marks
 * included, so `vocab.test.ts` can assert the whole set is tokenisable without
 * having to re-derive it from the mapping.
 */
export const ARPABET_IPA_SYMBOLS: readonly string[] = [
  ...new Set(
    [
      ...Object.values(ARPABET_TO_IPA),
      AH_STRESSED,
      AH_REDUCED,
      PRIMARY_STRESS,
      SECONDARY_STRESS,
    ].flatMap((value) => [...value]),
  ),
];

/**
 * One ARPAbet phone — `K`, `AH0`, `EH1` — as IPA with its stress mark, or `null`
 * for a token that is not an ARPAbet phone at all.
 *
 * `null` rather than an empty string, because an empty string is precisely the
 * thing D5 forbids: it would append nothing and carry on, and the word would
 * come out of the model a consonant short with no failure anywhere.
 */
export function arpabetPhoneToIpa(phone: string): string | null {
  const digit = phone.slice(-1);
  const stressed = digit >= "0" && digit <= "9";
  const base = stressed ? phone.slice(0, -1) : phone;
  const mark = stressed ? (STRESS_MARKS[digit] ?? "") : "";
  if (base === "AH") {
    return `${mark}${digit === "0" ? AH_REDUCED : AH_STRESSED}`;
  }
  const ipa = ARPABET_TO_IPA[base];
  return ipa === undefined ? null : `${mark}${ipa}`;
}

/**
 * A whitespace-separated ARPAbet pronunciation as one IPA string, or `null` if
 * any phone in it is unrecognised.
 *
 * Whole-pronunciation `null` rather than a partial result, for the reason above:
 * half a word is a mispronunciation the caller cannot see, and a refusal is a
 * defect the caller can act on.
 */
export function arpabetToIpa(phones: readonly string[]): string | null {
  let ipa = "";
  for (const phone of phones) {
    const translated = arpabetPhoneToIpa(phone);
    if (translated === null) {
      return null;
    }
    ipa += translated;
  }
  return ipa === "" ? null : ipa;
}
