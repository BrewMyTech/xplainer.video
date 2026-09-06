/**
 * Running somebody else's CLI, which is what both `connect` verbs would rather do than write a file.
 *
 * `claude mcp add` and `codex mcp add` are the vendors' own writers: each knows which file its
 * scopes live in, each merges rather than replaces, and each keeps working when that layout changes
 * under it. A configuration writer that reimplements another program's file format is a
 * configuration writer that is one release behind for ever, so the direct writers in `claude.ts` and
 * `codex.ts` are the *fallback* — for the machine where that CLI is not installed, and for a
 * `--config` naming a file its CLI has no way to be pointed at.
 *
 * This module is the one place a vendor CLI is spawned, so that both verbs agree about the three
 * things that matter: the **resolved absolute path** is run rather than the bare name, because the
 * caller has already looked it up on `PATH` to choose this branch and a second lookup could
 * disagree; stdin is closed, because nothing here is interactive and a CLI that decided to prompt
 * would otherwise hang `connect` for ever; and both output streams are captured rather than
 * inherited, because a refusal from the vendor is a sentence `connect` has to be able to quote back.
 *
 * A spawn that fails to *start* — the file vanished between the lookup and the run — throws, and
 * `commands/connect.ts` turns it into exit `70`. A spawn that starts and exits non-zero is not an
 * error here at all: it is a result, and what it means is the caller's to decide.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";
import type { PathEnvironment } from "./entry.js";

/** What running a vendor CLI produced, in the three parts a caller has to report. */
export type VendorCliResult = {
  /** The exit status, or `null` when a signal ended it. */
  status: number | null;
  /** Everything it wrote to stdout. */
  stdout: string;
  /** Everything it wrote to stderr — the half a refusal is usually in. */
  stderr: string;
};

/** Run `program` with `argv`, capture both streams, and report what happened. */
export function runVendorCli(
  program: string,
  argv: readonly string[],
  env: PathEnvironment = process.env,
): VendorCliResult {
  const result = spawnSync(program, [...argv], {
    encoding: "utf8",
    env: env as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
