/**
 * Building a payload out of an installed `@xplainer/cli`: where it lands, and what a refusal leaves.
 *
 * Colocated with the module, like every other one in `src/install/` — these cases lived in
 * `program.test.ts` while the materialising did, and leaving them there coupled the resolver's
 * suite to a module it is the whole point of `install/materialise.ts` that it cannot reach.
 *
 * **The success path assembles a real payload and is exercised once, deliberately.** It copies npm
 * — about 17 MB — so a case per assertion cost four of those and the first timed out at vitest's
 * 5 s default under a full suite's concurrent disk work. Heavy real work belongs in `scripts/e2e/`,
 * outside `pnpm verify`; what a unit suite can honestly do is assemble once and assert everything
 * about the result. The two refusals reach no assembler and stay separate.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import { MaterialiseRefusal, materialiseProgramPayload } from "./materialise.js";
import { stagedRuntimeRoot } from "./stage.js";
import { writeInstalledPackage } from "./testing/installed-package.js";

/** The prefix `mkdtemp` is given, so a case can count what the module left in the OS temp dir. */
const TEMP_PREFIX = "xplainer-materialise-";

/** How many of this module's temp directories exist right now, wherever the OS puts them. */
function temporaries(): number {
  return readdirSync(tmpdir()).filter((entry) => entry.startsWith(TEMP_PREFIX)).length;
}

let scratch = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "xplainer-materialise-test-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("materialiseProgramPayload", () => {
  it("resolves through the alias to the CLI's entry, outside the state directory", () => {
    const root = mkdtempSync(join(scratch, "installed-"));
    const aliasDir = writeInstalledPackage({ root, version: "0.0.1" });
    const stateDir = join(scratch, "state-success");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });

    const built = materialiseProgramPayload({ locateInstall: () => aliasDir });

    // The entry inside the payload is the CLI's, never the alias's forwarder — which has no
    // daemon in it and would register a supervisor pointing at a file that exits immediately.
    const manifest = JSON.parse(
      readFileSync(join(built.payloadDir, "runtime.manifest.json"), "utf8"),
    ) as { launch: { entry: string } };
    expect(manifest.launch.entry).toBe("lib/node_modules/@xplainer/cli/dist/bin.js");

    // **Outside the state directory entirely**, which is the correction that matters. The first
    // shape built it under `<state>/runtime/` behind the prefix `listStagedRuntimes` filters, so
    // a payload left behind was invisible to the product AND to the test written to catch a leak
    // — a failed install kept ~146 MB while reporting it had undone everything. A temp directory
    // is visible to nobody by construction rather than by filter, so the UNFILTERED read of the
    // staging root is the assertion, not `listStagedRuntimes`.
    expect(built.payloadDir.startsWith(stateDir)).toBe(false);
    // Absent rather than empty: building a payload must not so much as create the staging root.
    expect(existsSync(stagedRuntimeRoot(stateDir))).toBe(false);

    // And `discard` really removes it, which is all the caller's `finally` relies on — twice,
    // because the caller's `finally` may run after an inner one already did.
    built.discard();
    expect(existsSync(built.payloadDir)).toBe(false);
    expect(() => {
      built.discard();
    }).not.toThrow();
  }, 60_000);

  it("refuses when the locator finds no installed package, and names what to do instead", () => {
    const before = temporaries();
    let refusal: MaterialiseRefusal | null = null;
    try {
      materialiseProgramPayload({ locateInstall: () => null });
    } catch (error) {
      refusal = error instanceof MaterialiseRefusal ? error : null;
    }
    if (refusal === null) {
      throw new Error("the call was expected to refuse and did not");
    }

    expect(refusal.reason).toBe("not-installed");
    expect(refusal.exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
    expect(refusal.message).toContain("xplainer runtime build --out <dir>");
    expect(refusal.message).not.toContain("nothing is published yet");
    // The refusal is decided before `mkdtemp`, so this arm creates nothing to clean up.
    expect(temporaries()).toBe(before);
  });

  /**
   * The other refusal, which had no case at all: an install that is *found* and will not assemble.
   *
   * Reachable in production on `ENOSPC`, on `EACCES`, on a partial npm tree, or on any layout the
   * assembler refuses — and the reason it needs asserting is that the temp directory already
   * exists by the time the assembler throws, so this is the one arm where the module has to clean
   * up after itself rather than handing the job to the caller's `finally`.
   */
  it("refuses `not-a-payload` for an install that will not assemble, leaving nothing behind", () => {
    // A directory with no `node_modules/@xplainer/cli` in it: found by the locator (it is handed
    // over directly) and impossible to assemble a closure from.
    const notAnInstall = mkdtempSync(join(scratch, "not-an-install-"));
    const before = temporaries();

    let refusal: MaterialiseRefusal | null = null;
    try {
      materialiseProgramPayload({ locateInstall: () => notAnInstall });
    } catch (error) {
      refusal = error instanceof MaterialiseRefusal ? error : null;
    }
    if (refusal === null) {
      throw new Error("the call was expected to refuse and did not");
    }

    expect(refusal.reason).toBe("not-a-payload");
    expect(refusal.exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
    // The assembler's own sentence passes through verbatim: a reader who is out of disk needs to
    // see `ENOSPC` rather than a code, so the message names the install and then quotes the cause.
    expect(refusal.message).toContain(notAnInstall);
    expect(refusal.message.length).toBeGreaterThan(`the install at ${notAnInstall} `.length);
    // And the temp directory it had already created is gone, counted rather than assumed: the
    // caller never received a handle, so nothing else can reclaim it.
    expect(temporaries()).toBe(before);
  });
});
