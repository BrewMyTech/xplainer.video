/**
 * The stager: the name a payload gets, and the one moment its directory appears.
 *
 * Two properties are asserted here and everything else follows from them. **The name is the
 * content** — `<version>-<digest>`, computed from the payload's own manifest — so re-staging the
 * same artefact copies nothing and staging a changed one cannot land on top of a runtime something
 * may be executing out of. And **the final name only ever appears complete**: every copy goes into
 * a temporary directory that is a *sibling* of the target, so the transition is one `rename`, and
 * every failure on either side of it leaves the slot absent.
 *
 * The payloads are real ones — a real manifest, produced by the shipped scanner, over real files —
 * but not runnable, because nothing here spawns anything: `launcher.test.ts` is where a staged
 * runtime is started, and copying an interpreter per case would buy these assertions nothing.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUNTIME_MANIFEST_FILE } from "../runtime/manifest.js";
import {
  listStagedRuntimes,
  RUNTIME_DIGEST_LENGTH,
  runtimeDigest,
  runtimeSlot,
  STAGE_TEMP_PREFIX,
  StageRefusal,
  stagedRuntimeRoot,
  stageRuntime,
} from "./stage.js";
import { buildFixturePayload, type FixturePayload } from "./testing/payload.js";

let scratch = "";
let alpha: FixturePayload;
let beta: FixturePayload;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "xplainer-stage-"));
  alpha = buildFixturePayload({
    outDir: join(scratch, "alpha"),
    version: "1.2.3",
    marker: "alpha",
    runnable: false,
  });
  beta = buildFixturePayload({
    outDir: join(scratch, "beta"),
    version: "9.9.9",
    marker: "beta",
    runnable: false,
  });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A state directory of this case's own, so no case can see another's slots. */
function freshState(name: string): string {
  const stateDir = join(scratch, "state", name);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return stateDir;
}

describe("the runtime stager", () => {
  it("materialises the payload at `<state>/runtime/<version>-<digest>`", () => {
    const stateDir = freshState("materialise");
    const outcome = stageRuntime({ payloadDir: alpha.outDir, stateDir });

    expect(outcome.slot).toBe(`1.2.3-${runtimeDigest(alpha.manifest)}`);
    expect(outcome.path).toBe(join(stagedRuntimeRoot(stateDir), outcome.slot));
    expect(outcome.reused).toBe(false);
    expect(
      readFileSync(join(outcome.path, "lib/node_modules/@xplainer/cli/package.json"), "utf8"),
    ).toBe(readFileSync(join(alpha.outDir, "lib/node_modules/@xplainer/cli/package.json"), "utf8"));
    expect(runtimeDigest(alpha.manifest)).toHaveLength(RUNTIME_DIGEST_LENGTH);
  });

  it("copies through a sibling temporary directory, and leaves none behind", () => {
    const stateDir = freshState("temp-dir");
    const outcome = stageRuntime({ payloadDir: alpha.outDir, stateDir });
    const temporary = String(outcome.copiedVia);

    // A sibling, because `rename` is atomic only within one filesystem — which is the whole reason
    // the half-copied tree is never at the final name rather than merely usually not at it.
    expect(dirname(temporary)).toBe(dirname(outcome.path));
    expect(basename(temporary).startsWith(STAGE_TEMP_PREFIX)).toBe(true);
    expect(readdirSync(stagedRuntimeRoot(stateDir))).toEqual([outcome.slot]);
  });

  it("re-stages the same payload by copying nothing", () => {
    const stateDir = freshState("idempotent");
    const first = stageRuntime({ payloadDir: alpha.outDir, stateDir });
    const again = stageRuntime({ payloadDir: alpha.outDir, stateDir });

    expect(again.path).toBe(first.path);
    expect(again.reused).toBe(true);
    expect(again.copiedVia).toBeNull();
  });

  it("gives two payloads that differ by one byte two different names", () => {
    const changed = buildFixturePayload({
      outDir: join(scratch, "alpha-changed"),
      version: "1.2.3",
      marker: "alpha but different",
      runnable: false,
    });
    expect(runtimeSlot(changed.manifest)).not.toBe(runtimeSlot(alpha.manifest));
    expect(runtimeSlot(changed.manifest).startsWith("1.2.3-")).toBe(true);
  });

  it("does not put the build's timestamp in the name", () => {
    // Two manifests of the same tree taken a moment apart are the same runtime, and a digest that
    // moved with `created_at` would stage a second 160 MB copy on every rebuild.
    const later = { ...alpha.manifest, created_at: new Date(Date.now() + 60_000).toISOString() };
    expect(runtimeDigest(later)).toBe(runtimeDigest(alpha.manifest));
  });

  it("refuses a payload that does not match its own manifest, having written nothing", () => {
    const stateDir = freshState("unverified");
    const damaged = buildFixturePayload({
      outDir: join(scratch, "damaged"),
      version: "2.0.0",
      marker: "damaged",
      runnable: false,
    });
    writeFileSync(join(damaged.outDir, "lib/node_modules/npm/bin/npm-cli.js"), "tampered\n");

    expect(() => stageRuntime({ payloadDir: damaged.outDir, stateDir })).toThrow(StageRefusal);
    // Not "empty": the refusal happens before the directory is made, so there is nothing at all.
    expect(existsSync(stagedRuntimeRoot(stateDir))).toBe(false);
  });

  it("refuses a directory that is not a payload at all", () => {
    const stateDir = freshState("not-a-payload");
    const empty = join(scratch, "empty");
    mkdirSync(empty, { recursive: true });

    expect(() => stageRuntime({ payloadDir: empty, stateDir })).toThrow(
      new RegExp(`is not a payload-1 artefact.+${RUNTIME_MANIFEST_FILE}`, "s"),
    );
  });

  it("refuses when the slot is held by something that is not that payload", () => {
    const stateDir = freshState("occupied");
    const root = stagedRuntimeRoot(stateDir);
    mkdirSync(root, { recursive: true });
    // A regular file where the slot would go. The name is the content, so this is not the payload
    // it claims to be whatever is inside it, and staging over it would replace a directory a daemon
    // may be executing out of.
    const occupied = join(root, runtimeSlot(beta.manifest));
    writeFileSync(occupied, "not a directory\n");

    expect(() => stageRuntime({ payloadDir: beta.outDir, stateDir })).toThrow(StageRefusal);
    expect(readFileSync(occupied, "utf8")).toBe("not a directory\n");
    expect(readdirSync(root)).toEqual([basename(occupied)]);
  });

  it("skips an interrupted stage's temporary directory when it lists what is there", () => {
    const stateDir = freshState("interrupted");
    const staged = stageRuntime({ payloadDir: alpha.outDir, stateDir });
    const abandoned = join(stagedRuntimeRoot(stateDir), `${STAGE_TEMP_PREFIX}9.9.9-abc.999`);
    mkdirSync(join(abandoned, "bin"), { recursive: true });

    expect(listStagedRuntimes(stateDir).map((entry) => entry.slot)).toEqual([staged.slot]);
  });

  it("lists every staged runtime, and nothing where none is staged", () => {
    const stateDir = freshState("list");
    expect(listStagedRuntimes(stateDir)).toEqual([]);

    const first = stageRuntime({ payloadDir: alpha.outDir, stateDir });
    const second = stageRuntime({ payloadDir: beta.outDir, stateDir });
    expect(
      listStagedRuntimes(stateDir)
        .map((entry) => entry.path)
        .sort(),
    ).toEqual([first.path, second.path].sort());
  });

  it("refuses a slot whose contents are no longer what its name says", () => {
    const stateDir = freshState("edited");
    const staged = stageRuntime({ payloadDir: alpha.outDir, stateDir });
    // Somebody edited the staged runtime: its manifest now describes a different digest, so the
    // directory is not the one its name claims and re-staging must not quietly write over it.
    const manifest = JSON.parse(readFileSync(join(staged.path, RUNTIME_MANIFEST_FILE), "utf8"));
    manifest.node_version = "v0.0.0";
    writeFileSync(join(staged.path, RUNTIME_MANIFEST_FILE), JSON.stringify(manifest));

    expect(() => stageRuntime({ payloadDir: alpha.outDir, stateDir })).toThrow(/is not the one/);
  });
});
