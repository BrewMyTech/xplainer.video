/**
 * `xplainer runtime`, driven through the real commander program.
 *
 * What a *user* sees is an exit code and two streams, so this file builds the real program with a
 * recording `CliIo` — the shape `program.test.ts` set — and asserts against those. The assembler
 * and the verifier underneath are the real ones over real directories; nothing is substituted. The
 * assembler's own rules are asserted in `runtime/assemble.test.ts` and the verifier's in
 * `runtime/verify.test.ts`, so what is left here is the part only the command owns: which exit code
 * each outcome takes, and that a refusal says which thing went wrong.
 *
 * `build` is exercised only through its refusals. Its success path copies 130 MB of interpreter and
 * is asserted where that cost buys something — once, in `runtime/assemble.test.ts`.
 */

import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAEMON_INTERNAL_EXIT_CODE,
  PRECONDITION_UNMET_EXIT_CODE,
  USAGE_EXIT_CODE,
} from "../daemon/exit-codes.js";
import type { CliIo } from "../io.js";
import { createProgram } from "../program.js";
import {
  MANIFEST_VERSION,
  RUNTIME_MANIFEST_FILE,
  type RuntimeManifest,
  scanTree,
} from "../runtime/manifest.js";
import { runtimeRefusalExitCode } from "./runtime.js";

/** Thrown in place of `process.exit`, carrying the code the command asked for. */
class ExitSignal extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit ${code}`);
    this.name = "ExitSignal";
    this.code = code;
  }
}

/** What one invocation produced. */
type Invocation = { exitCode: number | undefined; stdout: string; stderr: string };

/** Run `xplainer <argv…>` through the real program and collect what a user would have seen. */
async function run(argv: string[]): Promise<Invocation> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    writeOut(text) {
      out.push(text);
    },
    writeErr(text) {
      err.push(text);
    },
    exit(code): never {
      throw new ExitSignal(code);
    },
  };

  let exitCode: number | undefined;
  try {
    await createProgram(io).parseAsync(argv, { from: "user" });
  } catch (error) {
    if (!(error instanceof ExitSignal)) {
      throw error;
    }
    exitCode = error.code;
  }
  return { exitCode, stdout: out.join(""), stderr: err.join("") };
}

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "xplainer-runtime-cmd-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("xplainer runtime verify", () => {
  it("exits 0 and says how much it checked when the payload matches", async () => {
    writePayload();

    const { stdout, stderr, exitCode } = await run(["runtime", "verify", scratch]);

    expect(stderr).toBe("");
    expect(stdout).toContain("matches its manifest (3 entries)");
    expect(exitCode).toBeUndefined();
  });

  it("exits 3 naming the reason and the path when one file changed", async () => {
    writePayload();
    writeFileSync(join(scratch, "lib", "a.js"), "ZZ");

    const { stdout, stderr, exitCode } = await run(["runtime", "verify", scratch]);

    expect(stdout).toBe("");
    expect(stderr).toContain("does not match its manifest");
    expect(stderr).toContain("changed: lib/a.js");
    expect(exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
  });

  it("exits 3 when there is no manifest to verify against", async () => {
    writePayload();
    unlinkSync(join(scratch, RUNTIME_MANIFEST_FILE));

    const { stderr, exitCode } = await run(["runtime", "verify", scratch]);

    expect(stderr).toContain("manifest-unreadable");
    expect(exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
  });

  it("asks a different document for --workspace, and names it when it is not there", async () => {
    writePayload();

    const { stderr, exitCode } = await run(["runtime", "verify", "--workspace", scratch]);

    // The two payload kinds carry differently named manifests on purpose, so pointing the
    // workspace verifier at a runtime payload is a missing `workspace.manifest.json` rather than a
    // runtime manifest read as though it described a workspace.
    expect(stderr).toContain("runtime verify --workspace");
    expect(stderr).toContain("workspace.manifest.json");
    expect(stderr).toContain("manifest-unreadable");
    expect(exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
  });

  it("is a usage error, not a refusal, when no directory is named", async () => {
    const { exitCode } = await run(["runtime", "verify"]);

    expect(exitCode).toBe(USAGE_EXIT_CODE);
  });
});

describe("xplainer runtime build", () => {
  it("refuses an output directory that already holds something, and leaves it alone", async () => {
    const occupied = join(scratch, "occupied");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "keep-me"), "");

    const { stdout, stderr, exitCode } = await run(["runtime", "build", "--out", occupied]);

    expect(stdout).toBe("");
    expect(stderr).toContain("is not empty");
    expect(exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
  });

  it("refuses a --from-runtime that is not a runtime payload", async () => {
    const { stderr, exitCode } = await run([
      "runtime",
      "build",
      "--workspace",
      "--from-runtime",
      scratch,
      "--out",
      join(scratch, "out"),
    ]);

    expect(stderr).toContain("is not a runtime payload");
    expect(exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
  });

  it("is a usage error when --out is missing", async () => {
    const { exitCode } = await run(["runtime", "build"]);

    expect(exitCode).toBe(USAGE_EXIT_CODE);
  });
});

describe("runtimeRefusalExitCode", () => {
  it("gives an npm that ran and failed the same code connect gives a vendor CLI that did", () => {
    expect(runtimeRefusalExitCode("install-failed")).toBe(DAEMON_INTERNAL_EXIT_CODE);
  });

  it.each([
    "host",
    "output-dir",
    "no-checkout",
    "no-npm",
    "no-allowlist",
    "unresolved-dependency",
    "unbuilt-entry",
    "malformed-manifest",
    "template",
    "runtime-payload",
    "install-incomplete",
  ] as const)(
    "treats %s as a precondition that was unmet before anything was written",
    (reason) => {
      expect(runtimeRefusalExitCode(reason)).toBe(PRECONDITION_UNMET_EXIT_CODE);
    },
  );
});

/** A three-file payload with a real manifest, so `verify` has something real to answer about. */
function writePayload(): void {
  mkdirSync(join(scratch, "bin"), { recursive: true });
  mkdirSync(join(scratch, "lib"), { recursive: true });
  writeFileSync(join(scratch, "bin", "node"), "interpreter");
  writeFileSync(join(scratch, "lib", "a.js"), "aa");
  writeFileSync(join(scratch, "lib", "b.js"), "bb");

  const scan = scanTree(scratch, { exclude: [RUNTIME_MANIFEST_FILE] });
  const manifest: RuntimeManifest = {
    kind: "runtime",
    manifest_version: MANIFEST_VERSION,
    created_at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node_version: process.version,
    npm_version: "11.19.0",
    host: "node",
    launch: {
      interpreter: "bin/node",
      entry: "lib/a.js",
      npm_cli: "lib/b.js",
      argv: ["bin/node", "lib/a.js"],
    },
    packages: [],
    files: scan.files,
    links: scan.links,
  };
  writeFileSync(join(scratch, RUNTIME_MANIFEST_FILE), JSON.stringify(manifest));
}
