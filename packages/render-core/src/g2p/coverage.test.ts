import { describe, expect, it } from "vitest";
import { lookUpCmudict } from "./cmudict.js";
import { phonemise } from "./phonemise.js";
import { type PhonemeSource, resolveWord } from "./resolve.js";

/**
 * The S0b spike's coverage measurement, re-run as a test.
 *
 * `.omc/artifacts/spike-speech-onnx.md` measured CMUdict alone at **50/50 on
 * ordinary narration prose** and **5/47 on software vocabulary**, and that
 * second number is the whole reason `data/lexicon.txt` exists: "the curated
 * lexicon is not a polish item — it is the component that makes this product's
 * actual subject matter pronounceable".
 *
 * A measurement that lived only in an artefact would drift. Here it is a gate:
 *
 *   * ordinary prose still resolves from CMUdict, at the rate the spike found —
 *     so a change that broke the dictionary parse (a variant read as a word, an
 *     annotation read as a phone) shows up as prose falling through to the
 *     letter-to-sound layer rather than as narration that is subtly wrong;
 *   * every seeded domain term still resolves from **layer 1**, so a term that
 *     is silently removed from the lexicon, or shadowed, fails here.
 *
 * The spike's exact 47-term list was not committed. What is asserted is the
 * thirteen terms it names in full, plus the seed list this module was built
 * from — a superset of what was measured, which is the direction that matters.
 */

/** How each word of a text was resolved. */
const sourcesOf = (text: string): readonly PhonemeSource[] =>
  phonemise(text).words.map((word) => word.source);

/**
 * Fifty words of the kind of prose an explainer narrates: no product names, no
 * jargon, the vocabulary of explanation itself.
 */
const ORDINARY_PROSE = [
  "The cached value was stale, so the reader observed an old record.",
  "Each request arrives at a queue and waits until a worker becomes available.",
  "When the process starts it reads the file back from disk.",
  "Notice that the second attempt succeeds because the lock was released.",
  "This diagram helps.",
].join(" ");

/**
 * The domain terms the lexicon was seeded with: the thirteen the spike names
 * plus the rest of the seed list. Every one of these is a term this product
 * narrates and CMUdict does not carry — or carries with a reading that is wrong
 * for software, which is the same problem.
 */
const SEEDED_DOMAIN_TERMS: readonly string[] = [
  "Kubernetes",
  "nginx",
  "PostgreSQL",
  "TypeScript",
  "systemd",
  "gRPC",
  "YAML",
  "JSON",
  "OAuth",
  "npm",
  "webhook",
  "idempotent",
  "ONNX",
  "Remotion",
  "Redis",
  "Kafka",
  "Docker",
  "launchd",
  "localhost",
  "UUID",
  "GraphQL",
  "WebSocket",
  "JWT",
  "SQLite",
  "Terraform",
  "Kotlin",
  "mutex",
  "goroutine",
  "middleware",
  "serverless",
  "eslint",
  "webpack",
  "vite",
  "async",
  "await",
];

describe("ordinary narration prose", () => {
  const sources = sourcesOf(ORDINARY_PROSE);

  it("is fifty words, as the spike's corpus was", () => {
    expect(sources.length).toBe(50);
  });

  it("resolves entirely from CMUdict, which is what the spike measured", () => {
    const fromDictionary = sources.filter((source) => source === "cmudict").length;
    expect(fromDictionary).toBe(sources.length);
  });

  it("reaches the guessing layers not at all, so nothing needs reporting", () => {
    expect(phonemise(ORDINARY_PROSE).derived).toEqual([]);
  });
});

describe("software vocabulary", () => {
  it("resolves every seeded term from the curated lexicon", () => {
    const wrong = SEEDED_DOMAIN_TERMS.map((term) => ({
      term,
      source: resolveWord(term)?.source ?? null,
    })).filter((entry) => entry.source !== "lexicon");
    expect(wrong).toEqual([]);
  });

  it("resolves them the same way inside a sentence as on their own", () => {
    // Casing, a following comma and a sentence position must not change which
    // layer answers — a lexicon that only worked on a bare token would pass the
    // test above and fail every real narration.
    for (const term of SEEDED_DOMAIN_TERMS) {
      const { words } = phonemise(`We deployed ${term}, then waited.`);
      expect({ term, source: words[2]?.source }).toEqual({ term, source: "lexicon" });
    }
  });

  it("would have fallen through without the lexicon, which is why it exists", () => {
    // The claim the spike made: CMUdict alone covers almost none of this. Asserted
    // by counting how many of the seeded terms CMUdict itself carries.
    const known = SEEDED_DOMAIN_TERMS.filter((term) => lookUpCmudict(term) !== null);
    expect(known.length).toBeLessThan(SEEDED_DOMAIN_TERMS.length / 2);
  });
});
