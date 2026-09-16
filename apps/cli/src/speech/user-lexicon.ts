/**
 * The pronunciation list a **user** owns, at `<state>/lexicon.txt`.
 *
 * **Why it exists.** Narration reports every word it had to guess at — "speech derived a
 * pronunciation for …" — and until now the only place to act on that was
 * `packages/render-core/src/g2p/data/lexicon.txt`, a file inside the installed package. That is
 * advice to edit `node_modules`, and the next `npm i -g xplainer@latest` throws the edit away. A
 * product that tells you a word sounds wrong owes you somewhere durable to say how it should sound.
 *
 * **Why the file is here and the lookup is not.** `@xplainer/render-core`'s g2p promises no I/O
 * beyond its three committed data files, and it has no business knowing where a state directory is.
 * So this module reads and parses, and hands `phonemise()` the result through its `extra` option —
 * the package stays pure and the path stays a CLI concern.
 *
 * **It never fails a narration.** `parseLexicon` collects bad lines instead of throwing, and a
 * missing or unreadable file is simply no overlay. The failure this avoids is specific: a stray
 * character typed between takes surfacing minutes into a render, on a job whose narration was
 * otherwise fine.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ExtraLexicon, type LexiconProblem, parseLexicon } from "@xplainer/render-core";

/** The file's name in the state directory, beside `toolchain.json`. */
export const USER_LEXICON_FILE = "lexicon.txt";

/** Where a user's pronunciations live. */
export function userLexiconPath(stateDir: string): string {
  return join(stateDir, USER_LEXICON_FILE);
}

/** What was found there: an overlay to use, the lines that could not be used, and how many worked. */
export type UserLexicon = {
  readonly path: string;
  readonly lexicon: ExtraLexicon | null;
  readonly entries: number;
  readonly problems: readonly LexiconProblem[];
};

/**
 * Read `<state>/lexicon.txt`, or answer that there is nothing to read.
 *
 * An absent file is the normal case and not a problem: most machines never write one.
 */
export function readUserLexicon(stateDir: string): UserLexicon {
  const path = userLexiconPath(stateDir);
  if (!existsSync(path)) {
    return { path, lexicon: null, entries: 0, problems: [] };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return {
      path,
      lexicon: null,
      entries: 0,
      problems: [{ line: 0, reason: error instanceof Error ? error.message : String(error) }],
    };
  }
  const parsed = parseLexicon(text, path);
  return {
    path,
    lexicon: parsed.entries.length === 0 ? null : parsed,
    entries: parsed.entries.length,
    problems: parsed.problems,
  };
}

/**
 * The file `setup` writes when there is none.
 *
 * **Seeded with worked examples rather than left empty**, because the format is the hard part: the
 * second column is Kokoro's IPA, not a spelling, and nobody guesses `ˌApˌiˈI` from a blank file.
 * Every example below is commented out, so a fresh file changes no pronunciation until somebody
 * deliberately uncomments or adds a line — and each one is copied from an entry that really ships,
 * so uncommenting it is a no-op that demonstrates the shape safely.
 */
export const USER_LEXICON_SEED = `# xplainer pronunciations — yours.
#
# One entry per line:   <spelling><spaces><IPA><spaces># optional gloss
#
# Consulted BEFORE the built-in lexicon and before CMUdict, so a line here also
# overrides a shipped pronunciation you disagree with. A lower-case spelling
# matches any case ("api" catches "API"); a spelling with a capital in it matches
# exactly, which is how you fix "ID" without touching the word "id".
#
# The second column is Kokoro's IPA, not English spelling. The quickest way to
# get one right is to copy the shape of a word that already sounds correct:
#
#   A = "ay"    I = "eye"    i = "ee"    O = "oh"    ɛ = "eh"    ˈ = stress
#
# Narration prints "speech derived a pronunciation for X" whenever it had to
# guess. That is the word to add here, and the line it prints is the IPA it
# guessed — paste it, then fix what sounds wrong.
#
# Examples, all commented out. Uncomment or edit freely; nothing here is read
# until the # is removed.
#
# kubectl        kjˈubkˌʌtəl               # koob-CUT-ul, not "cube-cuttle"
# grafana        ɡɹəfˈɑnə                  # gra-FAH-na
# nginx          ˈɛnʤɪnˌɛks                # engine-X
# ID             ˌIdˈi                     # capitalised, so the word "id" is untouched
#
# Delete this file to go back to the built-in pronunciations.
`;

/**
 * Write the seed file if there is none, and say whether it was written.
 *
 * Never overwrites: the whole point is that what a person put here survives an upgrade, and
 * `setup` runs again on every one of them.
 */
export function seedUserLexicon(stateDir: string): { path: string; written: boolean } {
  const path = userLexiconPath(stateDir);
  if (existsSync(path)) {
    return { path, written: false };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, USER_LEXICON_SEED);
  return { path, written: true };
}
