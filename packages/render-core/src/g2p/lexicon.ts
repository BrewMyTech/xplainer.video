/**
 * Layer 1 of four: the curated domain lexicon (plan §6 S4).
 *
 * Highest precedence, deliberately. Every layer below this one is a *rule* about
 * English — CMUdict is a rule about words somebody has already transcribed,
 * letter-to-sound is a rule about spelling — and a product name is not governed
 * by rules about English. "nginx" is "engine X" because its author said so;
 * nothing derivable from the letters would ever produce that. So the lexicon
 * wins over CMUdict too, and not only over the fallback: CMUdict happens to
 * carry `sql` and `mac`, and its readings of them are not the ones a narration
 * about software wants.
 *
 * The file is `data/lexicon.txt` — one entry per line, with a gloss, because a
 * reviewer has to be able to check it without reading IPA. Its own header
 * documents the format and the conventions; this module is only the parser.
 *
 * **Why it is a text file rather than a TypeScript object.** It is data an
 * expert edits, and the diff of a data file is the review. A `Record<string,
 * string>` would put a few hundred lines of content through Biome's formatter,
 * make the alignment that carries the gloss unstable, and tempt somebody into
 * computing an entry.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Where the lexicon sits, beside this module in `src/` and in `dist/`. */
const LEXICON_PATH = fileURLToPath(new URL("data/lexicon.txt", import.meta.url));

/** One parsed line: the spelling as written, its IPA, and the reviewer's gloss. */
export interface LexiconEntry {
  /** The spelling exactly as the file writes it — the casing is significant. */
  readonly spelling: string;
  /** The pronunciation, in Kokoro's IPA. May contain spaces; never punctuation. */
  readonly ipa: string;
  /** The `#` gloss, or `null` where the line carried none. */
  readonly gloss: string | null;
  /**
   * Whether this entry matches only its exact spelling.
   *
   * True when the spelling contains an upper-case letter. A lower-case spelling
   * matches any casing of a token, which is what almost every entry wants;
   * writing one in mixed case is a deliberate claim that the same letters in
   * another casing are a different word.
   */
  readonly caseSensitive: boolean;
}

/** The parsed file: the ordered entries, and the two lookup maps built from them. */
interface Lexicon {
  readonly entries: readonly LexiconEntry[];
  /** Lower-cased spelling → IPA, for the entries written in lower case. */
  readonly folded: ReadonlyMap<string, string>;
  /** Exact spelling → IPA, for the entries that contain an upper-case letter. */
  readonly exact: ReadonlyMap<string, string>;
}

/** Parsed once. The file is committed data and cannot change while the process runs. */
let cached: Lexicon | null = null;

/**
 * Split one entry line into its three parts.
 *
 * The spelling never contains whitespace, so the first whitespace run is the
 * separator and everything after it is the pronunciation — which is why the
 * pronunciation is allowed to contain spaces, and it needs to: a space is
 * Kokoro token 16 and a short pause, and it is what puts the beat between
 * "post-gres" and "Q-L".
 */
function parseLine(line: string): LexiconEntry | null {
  const withoutComment = line.split("#");
  const body = (withoutComment[0] ?? "").trim();
  if (body === "") {
    return null;
  }
  const separator = body.search(/\s/);
  if (separator < 0) {
    throw new Error(
      `${LEXICON_PATH}: entry ${JSON.stringify(body)} has a spelling and no pronunciation. ` +
        "Every line is `<spelling><whitespace><IPA>`.",
    );
  }
  const spelling = body.slice(0, separator);
  const ipa = body.slice(separator).trim();
  if (ipa === "") {
    throw new Error(`${LEXICON_PATH}: entry ${JSON.stringify(spelling)} has an empty IPA field.`);
  }
  const gloss = withoutComment.slice(1).join("#").trim();
  return {
    spelling,
    ipa,
    gloss: gloss === "" ? null : gloss,
    caseSensitive: spelling !== spelling.toLowerCase(),
  };
}

/** Parse the whole file, refusing a duplicate spelling rather than letting one win silently. */
function loadLexicon(): Lexicon {
  if (cached !== null) {
    return cached;
  }
  const entries: LexiconEntry[] = [];
  const folded = new Map<string, string>();
  const exact = new Map<string, string>();
  for (const line of readFileSync(LEXICON_PATH, "utf8").split("\n")) {
    const entry = parseLine(line);
    if (entry === null) {
      continue;
    }
    const target = entry.caseSensitive ? exact : folded;
    const key = entry.caseSensitive ? entry.spelling : entry.spelling.toLowerCase();
    const existing = target.get(key);
    if (existing !== undefined) {
      throw new Error(
        `${LEXICON_PATH}: ${JSON.stringify(entry.spelling)} is defined twice, as ` +
          `${JSON.stringify(existing)} and ${JSON.stringify(entry.ipa)}. One of the two would ` +
          "win silently and nobody would know which.",
      );
    }
    target.set(key, entry.ipa);
    entries.push(entry);
  }
  cached = { entries, folded, exact };
  return cached;
}

/**
 * Every entry, in file order, for the tests that review this data: the
 * vocabulary-subset assertion and the gloss spot-check.
 */
export function lexiconEntries(): readonly LexiconEntry[] {
  return loadLexicon().entries;
}

/**
 * `word`'s curated pronunciation, or `null` if the lexicon does not carry it.
 *
 * The exact spelling is tried before the case-folded one, so a case-sensitive
 * entry beats a lower-case entry for the same letters.
 */
export function lookUpLexicon(word: string): string | null {
  const lexicon = loadLexicon();
  return lexicon.exact.get(word) ?? lexicon.folded.get(word.toLowerCase()) ?? null;
}
