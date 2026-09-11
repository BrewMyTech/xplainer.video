/**
 * Building a payload out of an installed `@xplainer/cli`: where it lands, and what a refusal leaves.
 *
 * Colocated with the module, like every other one in `src/install/` — these cases lived in
 * `program.test.ts` while the materialising did, and leaving them there coupled the resolver's
 * suite to a module it is the whole point of `install/materialise.ts` that it cannot reach.
 *
 * **One real assemble, and everything is asserted off it.** Each one copies `process.execPath` and
 * npm, so the cost is fixed and the temptation is a case per property; the docblock this file
 * replaced already recorded what that costs — four assembles, and the first timing out at vitest's
 * 5 s default under a full suite's concurrent disk work. So the payload is built once and the entry,
 * its location and its symlinks are read off the same result. Heavier proofs belong in
 * `scripts/e2e/`, outside `pnpm verify`.
 *
 * **Both refusals carry an explicit timeout, because a refusal here is not cheap.** `not-a-payload`
 * is decided by the *assembler*, which copies the interpreter and npm before it discovers the root
 * package is missing — so it does nearly all the work of a success and then throws. Left on the 5 s
 * default it passed alone and timed out in the full suite.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import { MaterialiseRefusal, materialiseProgramPayload } from "./materialise.js";
import { stagedRuntimeRoot } from "./stage.js";
import { writeInstalledPackage } from "./testing/installed-package.js";

/** Long enough for a real assemble under a full suite's disk contention, not a guess at its cost. */
const ASSEMBLE_TIMEOUT_MS = 60_000;

let scratch = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "xplainer-materialise-test-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("materialiseProgramPayload", () => {
  it(
    "resolves through the alias to the CLI's entry, outside the state directory, links intact",
    () => {
      const root = mkdtempSync(join(scratch, "installed-"));
      const aliasDir = writeInstalledPackage({ root, version: "0.0.1" });
      const cliDir = join(aliasDir, "node_modules", "@xplainer", "cli");
      const stateDir = join(scratch, "state-success");
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });

      // A package shipping a directory of its own that holds a RELATIVE link into its `dist/`,
      // which is the shape `files: ["dist/**", "vendor/**"]` produces and what the copy traverses.
      mkdirSync(join(cliDir, "vendor"), { recursive: true });
      const linkTarget = join("..", "dist", "bin.js");
      symlinkSync(linkTarget, join(cliDir, "vendor", "entry.js"));
      writeFileSync(
        join(cliDir, "package.json"),
        JSON.stringify({
          name: "@xplainer/cli",
          version: "0.0.1",
          bin: { xplainer: "./dist/bin.js" },
          files: ["dist/**/*.js", "vendor/**"],
        }),
      );

      const built = materialiseProgramPayload({ locateInstall: () => aliasDir });

      // The entry inside the payload is the CLI's, never the alias's forwarder — which has no
      // daemon in it and would register a supervisor pointing at a file that exits immediately.
      const manifest = JSON.parse(
        readFileSync(join(built.payloadDir, "runtime.manifest.json"), "utf8"),
      ) as { launch: { entry: string }; links: { path: string; target: string }[] };
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

      // **The relative link stayed relative, so the payload can still move.** `cpSync` does not do
      // this by default: Node resolves a symlink's target against the source location unless
      // `verbatimSymlinks` is set, so this arrived as an absolute path back into the npm install —
      // the directory a payload exists to stop depending on, since a `PATH` copy dies on the next
      // `nvm install` and so does an absolute link into it. It was silent twice over: `scanTree`
      // records whatever the copy produced, so `runtime verify` compared the link against the
      // rewritten value and answered `ok: true`; and `bin/npm` is correct however the option is
      // set, because the assembler creates that one with `symlinkSync` — so the one link a reader
      // would spot-check is the one that cannot be wrong.
      const vendored = manifest.links.find((link) => link.path.endsWith("vendor/entry.js"));
      expect(vendored?.target).toBe(linkTarget.split(sep).join("/"));
      expect(manifest.links.every((link) => !isAbsolute(link.target))).toBe(true);
      // And it resolves to a file inside the payload from where the payload now is, which is the
      // property a relative target is only evidence for.
      const resolved = realpathSync(
        join(built.payloadDir, "lib", "node_modules", "@xplainer", "cli", "vendor", "entry.js"),
      );
      expect(resolved.startsWith(realpathSync(built.payloadDir))).toBe(true);
      expect(statSync(resolved).isFile()).toBe(true);

      // And `discard` really removes it, which is all the caller's `finally` relies on — twice,
      // because the caller's `finally` may run after an inner one already did.
      built.discard();
      expect(existsSync(built.payloadDir)).toBe(false);
      expect(() => {
        built.discard();
      }).not.toThrow();
    },
    ASSEMBLE_TIMEOUT_MS,
  );

  it("refuses when the locator finds no installed package, and names what to do instead", () => {
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
    // Decided before `mkdtemp`, so this arm has nothing to discard and says so.
    expect(refusal.discarded).toBeNull();
  });

  /**
   * The other refusal, which had no case at all: an install that is *found* and will not assemble.
   *
   * Reachable in production on `ENOSPC`, on `EACCES`, on a partial npm tree, or on any layout the
   * assembler refuses — and it needs asserting because the temp directory already exists by the
   * time the assembler throws, so this is the one arm where the module cleans up after itself
   * rather than handing the job to the caller's `finally`.
   *
   * **It is checked against the path the refusal names, not by counting the temp directory.** The
   * first version counted `xplainer-materialise-*` entries in the shared `os.tmpdir()` before and
   * after; the module builds there, `install.test.ts` builds payloads of its own, vitest runs the
   * files concurrently, and so the count answered for somebody else's work. `discarded` makes the
   * claim checkable about this call alone.
   */
  it(
    "refuses `not-a-payload` for an install that will not assemble, leaving nothing behind",
    () => {
      // A directory with no `node_modules/@xplainer/cli` in it: found by the locator (it is handed
      // over directly) and impossible to assemble a closure from.
      const notAnInstall = mkdtempSync(join(scratch, "not-an-install-"));

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
      // It made a temp directory, it says which, and it is gone.
      expect(refusal.discarded).not.toBeNull();
      expect(existsSync(String(refusal.discarded))).toBe(false);
    },
    ASSEMBLE_TIMEOUT_MS,
  );
});
