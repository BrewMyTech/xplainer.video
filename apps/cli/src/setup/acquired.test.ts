/**
 * The record a committed acquisition carries, and every verdict a warm cache can get.
 *
 * The two provider suites exercise this through the routes that use it; this one is the module's
 * own, because its **refusal reasons are the product**. Each one sends a user somewhere different,
 * and "the destination is already there so it must be fine" — the behaviour this module replaced —
 * was one branch that sent them nowhere at all.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACQUIRED_FILE,
  ACQUIRED_FORMAT_VERSION,
  type AcquiredExpectation,
  readAcquired,
  stageAcquired,
  verifyAcquired,
  witnessPath,
} from "./acquired.js";
import { sha256Of } from "./archive.js";

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratchDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-acquired-"));
  scratch.push(directory);
  return directory;
}

const EXPECTATION: AcquiredExpectation = {
  url: "https://example.test/artefact.tgz",
  sha256: sha256Of(Buffer.from("the archive\n")),
  size: 12,
};

/** A committed tree with one witness in it, as a provider would have left it. */
function committed(expectation: AcquiredExpectation = EXPECTATION): {
  root: string;
  witness: string;
} {
  const root = join(scratchDir(), "tree");
  mkdirSync(join(root, "bin"), { recursive: true });
  const witness = join(root, "bin", "native.node");
  writeFileSync(witness, "the native binding\n");
  stageAcquired(root, expectation, ["bin/native.node"]);
  return { root, witness };
}

describe("stageAcquired", () => {
  it("records the reviewed digest and hashes each witness as it goes", () => {
    const { root, witness } = committed();

    const record = readAcquired(root);

    expect(record?.format_version).toBe(ACQUIRED_FORMAT_VERSION);
    expect(record?.url).toBe(EXPECTATION.url);
    expect(record?.sha256).toBe(EXPECTATION.sha256);
    expect(record?.size).toBe(EXPECTATION.size);
    expect(record?.files).toEqual([
      { path: "bin/native.node", sha256: sha256Of(Buffer.from("the native binding\n")), bytes: 19 },
    ]);
    // Relative, `/`-separated, so the tree stays relocatable — a state directory is moved and
    // restored for a living.
    expect(record?.files[0]?.path).not.toContain(witness);
    expect(record?.acquired_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("refuses a witness the extraction did not produce", () => {
    const root = join(scratchDir(), "tree");
    mkdirSync(root, { recursive: true });

    expect(() => stageAcquired(root, EXPECTATION, ["bin/missing.node"])).toThrow(
      /does not contain bin\/missing\.node/,
    );
  });

  it("accepts an empty witness list, for a layout this build cannot name anything inside", () => {
    const root = join(scratchDir(), "tree");
    mkdirSync(root, { recursive: true });

    stageAcquired(root, EXPECTATION, []);

    expect(readAcquired(root)?.files).toEqual([]);
    expect(verifyAcquired(root, EXPECTATION).ok).toBe(true);
  });
});

describe("verifyAcquired", () => {
  it("admits a tree whose record and witnesses both still agree", () => {
    const { root, witness } = committed();

    const verdict = verifyAcquired(root, EXPECTATION);

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      // Absolute on the way out, because that is what the marker records and what a later
      // existence check has to be able to `stat`.
      expect(verdict.files).toEqual([
        { path: witness, sha256: sha256Of(Buffer.from("the native binding\n")), bytes: 19 },
      ]);
    }
  });

  it("refuses a tree with no record at all, which is the defect this module replaced", () => {
    const root = join(scratchDir(), "cold");
    mkdirSync(root, { recursive: true });

    const verdict = verifyAcquired(root, EXPECTATION);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("no-record");
      expect(verdict.detail).toContain("does not exist");
      expect(verdict.detail).toContain("will not record a digest it has not checked");
    }
  });

  it("tells a record it cannot read apart from one that is not there", () => {
    const { root } = committed();
    writeFileSync(join(root, ACQUIRED_FILE), "{not json\n");

    const verdict = verifyAcquired(root, EXPECTATION);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("unreadable-record");
      expect(verdict.detail).toContain("cannot be read");
    }
  });

  /** The same rule the marker and the job store apply: a newer format is a rollback signal. */
  it("reports a record from a newer build rather than treating it as corruption", () => {
    const { root } = committed();
    const record = readAcquired(root);
    writeFileSync(
      join(root, ACQUIRED_FILE),
      JSON.stringify({ ...record, format_version: ACQUIRED_FORMAT_VERSION + 7 }),
    );

    const verdict = verifyAcquired(root, EXPECTATION);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("newer-record");
      expect(verdict.detail).toContain("rollback signal, not corruption");
    }
  });

  it("refuses the same name at a different digest, which is a republish", () => {
    const { root } = committed();

    const verdict = verifyAcquired(root, { ...EXPECTATION, sha256: "a".repeat(64) });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("different-artefact");
      expect(verdict.detail).toContain("Same name, different artefact");
    }
  });

  it("refuses the same digest at a different length", () => {
    const { root } = committed();

    const verdict = verifyAcquired(root, { ...EXPECTATION, size: EXPECTATION.size + 1 });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("different-artefact");
    }
  });

  it("refuses a witness that has been removed since it was acquired", () => {
    const { root, witness } = committed();
    rmSync(witness);

    const verdict = verifyAcquired(root, EXPECTATION);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("file-missing");
      expect(verdict.detail).toContain(witness);
    }
  });

  it("refuses a witness whose length still matches and whose bytes do not", () => {
    const { root, witness } = committed();
    // The same nineteen bytes, different content: the length check cannot see this and the digest
    // is the only thing that can, which is why both are recorded.
    writeFileSync(witness, "the NATIVE binding\n");

    const verdict = verifyAcquired(root, EXPECTATION);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("file-changed");
      expect(verdict.detail).toContain("changed since it was acquired");
    }
  });

  it("refuses a truncated witness without hashing it", () => {
    const { root, witness } = committed();
    writeFileSync(witness, "short\n");

    const verdict = verifyAcquired(root, EXPECTATION);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("file-changed");
      expect(verdict.detail).toContain("the length already disagrees");
    }
  });
});

describe("readAcquired", () => {
  it("answers null for a record whose fields are the wrong shape", () => {
    const { root } = committed();
    const record = readAcquired(root);

    for (const broken of [
      { ...record, files: "not an array" },
      { ...record, files: [{ path: "bin/native.node", sha256: 1, bytes: 19 }] },
      { ...record, files: [{ path: "", sha256: "a".repeat(64), bytes: 19 }] },
      { ...record, sha256: 42 },
    ]) {
      writeFileSync(join(root, ACQUIRED_FILE), JSON.stringify(broken));
      expect(readAcquired(root)).toBeNull();
    }
  });
});

describe("witnessPath", () => {
  it("is relative and `/`-separated whatever the host's separator is", () => {
    const root = join("a", "b");
    expect(witnessPath(root, join(root, "c", "d.node"))).toBe("c/d.node");
    expect(witnessPath(root, join(root, "c", "d.node"))).not.toContain(sep === "/" ? "\\" : "\\\\");
  });
});
