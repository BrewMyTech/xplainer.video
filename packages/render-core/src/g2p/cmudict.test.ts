import { describe, expect, it } from "vitest";
import { arpabetPhoneToIpa, arpabetToIpa } from "./arpabet.js";
import { cmudictSize, lookUpCmudict, lookUpCmudictPhones } from "./cmudict.js";

/**
 * Layer 2, and the two format details that would fail silently if they were
 * wrong.
 *
 * A variant read as a separate word and an annotation read as a phone both fail
 * the same way: the word falls through to the letter-to-sound layer and comes
 * out subtly wrong, with nothing in the output saying anything happened. Both
 * are asserted against real lines of the vendored file rather than against a
 * fixture, because the thing being checked is the file.
 */

describe("the vendored dictionary", () => {
  it("parses to the whole distribution rather than to a truncated prefix", () => {
    expect(cmudictSize()).toBeGreaterThan(125_000);
  });

  it("takes the first pronunciation of a word that has several", () => {
    // `read` is in the file twice — the bare entry and `read(2)` — and the bare
    // one is the past tense, "red". Which is right depends on the tense of the
    // sentence, which needs a part-of-speech tagger; taking the first is what
    // makes this a function, and the price is written down here rather than
    // discovered later.
    expect(lookUpCmudictPhones("read")).toEqual(["R", "EH1", "D"]);
    expect(lookUpCmudictPhones("read(2)")).toBeNull();
    expect(lookUpCmudict("read")).toBe("ɹˈɛd");
  });

  it("cuts the trailing annotation some lines carry", () => {
    // `aalborg AO1 L B AO0 R G # place, danish`. Read as phones, `#`, `place,`
    // and `danish` are not ARPAbet, so the whole word would be refused.
    const phones = lookUpCmudictPhones("aalborg");
    expect(phones).toEqual(["AO1", "L", "B", "AO0", "R", "G"]);
    expect(lookUpCmudict("aalborg")).not.toBeNull();
  });

  it("is case insensitive", () => {
    expect(lookUpCmudict("Docker")).toBe(lookUpCmudict("docker"));
  });

  it("answers null for a word it does not carry", () => {
    expect(lookUpCmudict("frobnicator")).toBeNull();
    expect(lookUpCmudict("kubernetes")).toBeNull();
  });
});

describe("the affricate against the genuine cluster", () => {
  /**
   * The distinction the single-character spelling exists to preserve, and the
   * reason it has to live in the ARPAbet table rather than in a contraction pass
   * over the finished IPA string.
   *
   * Kokoro reads a two-symbol sequence as two segments — measured at x1.70 on
   * the affricate and x1.66 on the diphthong — so the affricate and the
   * diphthong must be single characters. But English also has real `t`+`ʃ` and
   * `ɔ`+`ɪ` sequences, and in an IPA string those are character-identical to
   * the affricate and the diphthong. A contraction pass cannot tell them apart
   * and would turn "nutshell" into "nu-chell" and "drawing" into "droy-ing".
   *
   * ARPAbet still carries the distinction, so the table gets it right by
   * construction with no rule and no exception list. **These assertions are what
   * fail if somebody later adds a contraction pass**, which is the whole reason
   * they are here rather than in a comment.
   */

  it("keeps a genuine T + SH as two symbols", () => {
    // N AH1 T SH EH2 L. The /t/ and the /ʃ/ belong to different morphemes.
    expect(lookUpCmudict("nutshell")).toBe("nˈʌtʃˌɛl");
    expect(lookUpCmudict("nutshell")).not.toContain("ʧ");
  });

  it("keeps a genuine AO + IH as two symbols", () => {
    // D R AO1 IH0 NG — "draw" plus "-ing", not the ɔɪ of "choice".
    expect(lookUpCmudict("drawing")).toBe("dɹˈɔɪŋ");
    expect(lookUpCmudict("drawing")).not.toContain("Y");
  });

  it("writes a real affricate and a real diphthong as one symbol each", () => {
    // CH EY1 N JH — the same word misaki renders ʧˈAnʤ, which is the string
    // Kokoro was trained on.
    expect(lookUpCmudict("change")).toBe("ʧˈAnʤ");
    expect(lookUpCmudict("choice")).toBe("ʧˈYs");
    expect(lookUpCmudict("stage")).toBe("stˈAʤ");
  });

  it("follows CMUdict rather than the spelling, which is not the same thing", () => {
    // Two of the words usually cited as `t`+`ʃ` clusters are not clusters in
    // CMUdict at all, and that is the point of keying on the phone: "courtship"
    // is transcribed K AO1 R CH IH2 P, with the /t/ and /ʃ/ already fused, and
    // "hotshot" is HH AA1 SH AA2 T with no /t/ before the /ʃ/ at all. A rule
    // over letters would have had to guess at both; the table does not guess.
    expect(lookUpCmudict("courtship")).toBe("kˈɔɹʧˌɪp");
    expect(lookUpCmudict("hotshot")).toBe("hˈɑʃˌɑt");
  });

  it("reproduces misaki own reading of a sentence full of both", () => {
    // misaki, the G2P Kokoro was trained against, answers
    //   ðə ʧˈAnʤ mˈænɪʤd tʊ əʤˈʌst ðə mˈAʤəɹ stˈAʤ.
    // Ours differs only where CMUdict transcribes a vowel differently from
    // misaki — mˈænəʤd for mˈænɪʤd, tˈu for tʊ, mˈAʤɚ for mˈAʤəɹ. Every
    // affricate and every diphthong agrees, which is what this asserts.
    const words = ["the", "change", "managed", "to", "adjust", "the", "major", "stage"];
    expect(words.map((word) => lookUpCmudict(word)).join(" ")).toBe(
      "ðə ʧˈAnʤ mˈænəʤd tˈu əʤˈʌst ðə mˈAʤɚ stˈAʤ",
    );
  });
});

describe("ARPAbet to IPA", () => {
  it("puts the stress mark immediately before the vowel", () => {
    expect(arpabetToIpa(["K", "AE1", "SH", "T"])).toBe("kˈæʃt");
    expect(arpabetToIpa(["K", "UW2", "B"])).toBe("kˌub");
  });

  it("reduces unstressed AH to schwa and keeps stressed AH as the STRUT vowel", () => {
    expect(arpabetPhoneToIpa("AH0")).toBe("ə");
    expect(arpabetPhoneToIpa("AH1")).toBe("ˈʌ");
    expect(arpabetPhoneToIpa("AH2")).toBe("ˌʌ");
  });

  it("writes G as the script g the model has a token for", () => {
    expect(arpabetPhoneToIpa("G")).toBe("ɡ");
    expect(arpabetPhoneToIpa("G")).not.toBe("g");
  });

  it("refuses a token that is not an ARPAbet phone, rather than dropping it", () => {
    expect(arpabetPhoneToIpa("#")).toBeNull();
    expect(arpabetToIpa(["K", "danish"])).toBeNull();
  });

  it("translates a whole sentence's worth of real entries", () => {
    expect(lookUpCmudict("the")).toBe("ðə");
    expect(lookUpCmudict("observed")).toBe("əbzˈɚvd");
    expect(lookUpCmudict("record")).toBe("ɹəkˈɔɹd");
    expect(lookUpCmudict("value")).toBe("vˈælju");
  });
});
