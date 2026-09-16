/**
 * The user's own pronunciation list, and the three properties that make it safe to hand someone.
 *
 * It overrides what ships, it survives an upgrade, and a typo in it never costs a render. The last
 * is the one worth testing hardest: this file is edited by hand, between takes, by someone who is
 * thinking about how a word sounds rather than about a file format — and a narration that died
 * minutes into a render because of a stray character would be a worse product than one that
 * mispronounced the word.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PhonemiseOptions, phonemise } from "@xplainer/render-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  readUserLexicon,
  seedUserLexicon,
  USER_LEXICON_SEED,
  userLexiconPath,
} from "./user-lexicon.js";

const dirs: string[] = [];
function stateDir(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "xplainer-lex-"));
  dirs.push(dir);
  if (contents !== undefined) {
    writeFileSync(userLexiconPath(dir), contents);
  }
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The overlay in the shape `phonemise` takes, or nothing when the machine has none.
 *
 * The property is omitted rather than set to `undefined`, because `exactOptionalPropertyTypes` is
 * on and `{ extra: undefined }` is not the same type as `{}` under it — the same distinction the
 * production caller in `speech-locate.ts` has to make.
 */
function options(dir: string): PhonemiseOptions {
  const lexicon = readUserLexicon(dir).lexicon;
  return lexicon === null ? {} : { extra: lexicon };
}

describe("readUserLexicon", () => {
  it("answers with no overlay when the machine has no file", () => {
    const dir = stateDir();
    const read = readUserLexicon(dir);

    expect(read.lexicon).toBeNull();
    expect(read.entries).toBe(0);
    expect(read.problems).toEqual([]);
    // The ordinary machine never writes one, so absence is not a problem to report.
    expect(read.path).toBe(join(dir, "lexicon.txt"));
  });

  it("wins over the shipped lexicon, which is the point of having one", () => {
    // `api` is curated as "A-P-I". Someone who wants it said as a word gets to say so.
    const dir = stateDir("api  ˈæpi  # AP-ee\n");

    expect(phonemise("api").ipa).toBe("ˌApˌiˈI");
    expect(phonemise("api", options(dir)).ipa).toBe("ˈæpi");
  });

  it("wins over CMUdict too, which is where most wrong pronunciations come from", () => {
    // CMUdict carries one reading of a heteronym and cannot know which one a script means: it
    // says "read" is /ɹˈɛd/, the past tense. A narration using the present tense has no
    // recourse but this file, because CMUdict answers before the letter rules are ever reached.
    expect(phonemise("read").ipa).toBe("ɹˈɛd");

    const dir = stateDir("read  ɹˈid  # REED, the present tense\n");

    expect(phonemise("read", options(dir)).ipa).toBe("ɹˈid");
  });

  it("matches any case for a lower-case spelling, and exactly for a capitalised one", () => {
    const folded = stateDir("kubectl  kˈubctl  # x\n");
    expect(phonemise("KUBECTL", options(folded)).ipa).toBe("kˈubctl");

    // A capital in the spelling makes it exact, which is how "ID" is fixed without touching "id".
    const exact = stateDir("ID  ˌIdˈi  # I-D\n");
    expect(phonemise("ID", options(exact)).ipa).toBe("ˌIdˈi");
    expect(phonemise("id", options(exact)).ipa).toBe(phonemise("id").ipa);
  });

  it("reports a broken line and keeps every good one, rather than failing the narration", () => {
    const dir = stateDir(["good  ˈɡʊd  # fine", "oops", "also  ˈɔlso  # fine too"].join("\n"));
    const read = readUserLexicon(dir);

    expect(read.entries).toBe(2);
    expect(read.problems).toHaveLength(1);
    expect(read.problems[0]?.line).toBe(2);
    // The surviving entries still apply — one bad line does not discard the file.
    expect(phonemise("good", options(dir)).ipa).toBe("ˈɡʊd");
    expect(phonemise("also", options(dir)).ipa).toBe("ˈɔlso");
  });

  it("lets the last of two entries win, because that is the line someone just added", () => {
    const dir = stateDir("word  ˈwun  # first\nword  ˈtu  # second\n");

    // The shipped loader refuses a duplicate outright, which is right for a reviewed file and wrong
    // for one being edited: the fix somebody just appended should be the one that counts.
    expect(readUserLexicon(dir).problems).toEqual([]);
    expect(phonemise("word", options(dir)).ipa).toBe("ˈtu");
  });

  it("treats a file of nothing but comments as no overlay at all", () => {
    const dir = stateDir(USER_LEXICON_SEED);
    const read = readUserLexicon(dir);

    // Every example in the seed is commented out, so a freshly seeded machine sounds exactly like
    // one that was never seeded. That is what makes writing the file on setup safe.
    expect(read.entries).toBe(0);
    expect(read.lexicon).toBeNull();
    expect(read.problems).toEqual([]);
  });
});

it("refuses a pronunciation the speech model has no symbol for, and says which", () => {
  // The trap this exists for: ASCII `g` and IPA `\u0261` are near-identical in most fonts, and the
  // line parses perfectly. Without this check it reached tokenisation and killed the narration
  // minutes into a render — the exact failure the skip-and-report policy promises not to have.
  const dir = stateDir(`good  ${"g"}\u028ad  # ASCII g\nfine  f\u02c8In  # valid\n`);
  const read = readUserLexicon(dir);

  expect(read.entries).toBe(1);
  expect(read.problems).toHaveLength(1);
  expect(read.problems[0]?.reason).toContain("no symbol for");
  // The good line beside it still applies.
  expect(phonemise("fine", options(dir)).ipa).toBe("f\u02c8In");
});

describe("seedUserLexicon", () => {
  it("writes the examples when there is no file", () => {
    const dir = stateDir();
    const seeded = seedUserLexicon(dir);

    expect(seeded.written).toBe(true);
    const text = readFileSync(seeded.path, "utf8");
    // The format is the hard part, so the seed has to carry a worked example and the IPA key.
    expect(text).toContain("kubectl");
    expect(text).toMatch(/A = "ay"/);
  });

  it("never overwrites, because an upgrade runs setup again", () => {
    const mine = "kubectl  kjˈubkˌʌtəl  # mine\n";
    const dir = stateDir(mine);

    const seeded = seedUserLexicon(dir);

    expect(seeded.written).toBe(false);
    // `xplainer update` re-runs `setup` on every upgrade; a seed that overwrote would delete the
    // pronunciations somebody spent a session getting right.
    expect(readFileSync(seeded.path, "utf8")).toBe(mine);
  });
});
