/**
 * How the proofs in this directory spawn a child, and how they say what happened to it.
 *
 * The scripts in `scripts/e2e/` are standalone plain-Node programs on purpose — nothing to build,
 * nothing to install, each one runnable on its own — and this module keeps that true: it imports
 * nothing but `node:`, and joining it costs a proof one relative `import`. What it is here to end
 * is **one helper with three different behaviours**, which is how a defect that had already been
 * found and fixed sat untouched in the file next door.
 *
 * **The silent failure this exists to prevent.** `runLogged` was written four times.
 * `runtime.mjs` and `toolchain.mjs` appended `result.error` to the transcript; `render.mjs` did
 * neither that nor name it in the error it threw; `speech.mjs` did both, and only after run
 * 34492604497 spent a diagnosis round trip on a Windows `CreateProcess` refusal that reported
 * itself as `control exited null:` — a sentence naming neither the errno nor the argv, over a
 * transcript with no line about the child at all. A child that never started has no `status`, no
 * `signal` and neither stream, so `result.error` is the only field holding the answer, and three of
 * the four copies threw it away. One copy of a helper cannot be right in one file and wrong in
 * another, so {@link transcript} is the only spawn in this directory: `result.error` reaches both
 * the transcript and the thrown message, and a child that never started says so in those words,
 * naming the command it tried to run rather than borrowing the vocabulary of a child that ran and
 * exited.
 *
 * **On Windows, reachability is a question only `spawn` can answer, and `stat` answers it wrongly —
 * in both directions.** This rule is worth more than either fix that taught it, and it is why the
 * two path helpers below are here rather than spelled at each call site. Two measured instances,
 * failing *opposite* ways:
 *
 * - **Absent to `stat`, runnable by `spawn`.** `%LOCALAPPDATA%\Microsoft\WindowsApps` holds *app
 *   execution aliases* — `APPEXECLINK` reparse points Windows ships for `python.exe` and
 *   `python3.exe` whether or not any Python is installed. `existsSync` (and every `stat`, `lstat`
 *   and `realpath` under it) reports such a path as **absent**; `CreateProcess`, and therefore
 *   `spawn`, launches it. Measured on `windows-latest`, run 34490218766.
 * - **Present to `stat`, unspawnable.** npm writes **three** files per binary into
 *   `node_modules/.bin` on Windows — `remotion`, `remotion.cmd` and `remotion.ps1` — and the
 *   extensionless one is a `#!/bin/sh` script. `existsSync` says yes and `CreateProcess` refuses
 *   it, so `spawnSync` returns with no `status`, no `signal` and neither stream: **no process was
 *   created**. Measured on `windows-latest`, run 34492604497, where an `existsSync` gate on that
 *   exact path passed and the spawn 320 lines later died as `control exited null`. And the shim
 *   with the extension is no answer either — a `.cmd` is what libuv refuses without `shell: true`
 *   since the CVE-2024-27980 fix, the defect `apps/cli/src/setup/providers/workspace.ts` was fixed
 *   for one layer down.
 *
 * So a filesystem check is not a weaker version of the real check, it is a **different answer**.
 * Probe executable reachability by spawning; where a gate must be a `stat`, make it a `stat` of the
 * file that will actually be spawned, so the arrangement fails on the arrangement. What is
 * spawnable on every platform is a **script under an explicit interpreter**, which is what
 * {@link remotionEntry} names; {@link workspaceShim} is for the other question — whether npm
 * *linked* a CLI — and it spells the `.cmd` on Windows because that is the file npm's linking
 * writes and the extensionless one npm also writes proves nothing.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

/**
 * Payload 2's manifest, at the root of an installed workspace.
 *
 * Spelled here rather than imported from the CLI: these scripts run outside its module graph on
 * purpose, so the name they look for is the name a consumer of the artefact would have to know. It
 * is `apps/cli/src/runtime/manifest.ts`'s `WORKSPACE_MANIFEST_FILE`, and a rename there that did
 * not reach this line is a failure these gates should report.
 */
export const WORKSPACE_MANIFEST_FILE = "workspace.manifest.json";

/** How much of a child's stderr a thrown message carries. */
const STDERR_TAIL = 800;

/**
 * The pair of spawns every proof in this directory uses, bound to one transcript.
 *
 * `spawnLogged` is for a command whose non-zero exit is a fact the caller goes on to judge, and
 * returns the whole `spawnSync` result. `runLogged` is for a command whose non-zero exit is simply
 * the end of the run, and returns its stdout. Both capture both streams into `logPath`, because
 * `execFileSync` forwards a child's stderr to this process's own and leaves it out of the log file
 * — and the log file is the artefact. Anything whose output is evidence goes through here.
 */
export function transcript(logPath) {
  function spawnLogged(label, command, args, options = {}) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
    for (const [stream, text] of [
      ["out", result.stdout ?? ""],
      ["err", result.stderr ?? ""],
    ]) {
      for (const line of text.trim().split("\n")) {
        if (line.trim() !== "") {
          appendFileSync(logPath, `  [${label} ${stream}] ${line}\n`);
        }
      }
    }
    // A child that never started has no streams at all and would otherwise leave the transcript
    // silent about the one thing that happened to it. The docblock's first section is the cost.
    if (result.error !== undefined) {
      appendFileSync(logPath, `  [${label} error] ${result.error.message}\n`);
    }
    return result;
  }

  function runLogged(label, command, args, options = {}) {
    const result = spawnLogged(label, command, args, options);
    if (result.status !== 0) {
      throw new Error(
        result.error === undefined
          ? `${label} exited ${result.status ?? result.signal}: ${(result.stderr ?? "").trim().slice(-STDERR_TAIL)}`
          : `${label} never started: ${result.error.message} — the command was ${command} ${args.join(" ")}`,
      );
    }
    return result.stdout ?? "";
  }

  return { spawnLogged, runLogged };
}

/**
 * The `node_modules/.bin` shim for `stem` inside `workspace`, under the name npm's linking writes.
 *
 * This is the file to **`stat`** when the question is whether npm linked a CLI rather than merely
 * unpacking it — the property `apps/cli/src/setup/providers/workspace.ts` requires of both its
 * routes. It is not the file to spawn: on Windows neither name in `.bin` is spawnable, and the
 * docblock's second bullet is why. Asking for the extensionless name on Windows is not a harmless
 * simplification — npm writes that file too, as a `#!/bin/sh` script, so the check passes there and
 * proves nothing about the shim npm actually generated.
 */
export function workspaceShim(workspace, stem) {
  return join(
    workspace,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${stem}.cmd` : stem,
  );
}

/**
 * The Remotion CLI entry `workspace`'s own manifest names, as an absolute path.
 *
 * This is the file to **spawn**, and it is spawned under an explicit interpreter — the payload's
 * own `node` where the proof has one, `process.execPath` where it runs from a checkout. Taking it
 * from the manifest rather than from `.bin` is what makes the call platform-independent, and taking
 * it from the manifest rather than from a path spelled at the call site is what makes it the
 * product's own answer: `@remotion/cli`'s `bin` field is what the workspace route recorded there.
 *
 * `manifest` is the already-parsed document where the caller has one; otherwise the manifest is
 * read from {@link WORKSPACE_MANIFEST_FILE} at the root of the workspace.
 */
export function remotionEntry(workspace, manifest = null) {
  const document =
    manifest ?? JSON.parse(readFileSync(join(workspace, WORKSPACE_MANIFEST_FILE), "utf8"));
  return join(workspace, ...document.remotion_entry.split("/"));
}
