/**
 * A CLI that records what it was run as, at both of decision D10's two stages.
 *
 * The two one-click controls are asserted by **which program ran and with what arguments**, so the
 * arrangement each case needs is a real program on a temporary path that writes its own invocation
 * down and exits — the pattern `apps/cli/src/commands/connect.test.ts` uses for a vendor CLI, one
 * level up: there the recorder stands in for `claude`, here it stands in for `xplainer` itself.
 *
 * Nothing is mocked. The payload recorder is a real Node program under a real payload layout,
 * reached through the same `spawn` the packaged app makes; the launcher recorder is a real
 * executable at `<state>/bin/xplainer`, which is the file `daemon install` writes and the only
 * evidence this app accepts that an install has happened. Running the *real* CLI would be running
 * `connect`, which writes an agent configuration into the home directory of whoever runs the
 * suite — the one thing a test of "what did it run" must not do.
 *
 * **`process.argv0`, not `process.execPath`.** The fixture links the interpreter where the platform
 * allows it, and `execPath` resolves a symlink back to the real `node`, which would make the
 * assertion pass for any interpreter on the machine. `argv0` is the path the parent actually
 * spawned, which is exactly what D10 is a claim about.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { launcherPath } from "../discovery";
import { payloadResources, temporaryDirectory } from "./live-daemon";

/** The line that separates one recorded run from the next. No argv this app builds is this string. */
const RUN_MARKER = "#run";

/** One invocation the recorder saw. */
export type RecordedRun = {
  /** The program that was executed, as the parent named it. */
  executable: string;
  /** Everything after it, entry script included when the payload stage is what ran. */
  argv: string[];
};

/** A `Resources` directory whose payload entry records its invocation into `record`. */
export function recordingPayload(record: string): string {
  return payloadResources({ entry: payloadRecorder(record) });
}

/**
 * Write a stable launcher at `<state>/bin/xplainer` that records its invocation into `record`.
 *
 * It runs nothing else. `daemon install` is what puts a launcher there and a launcher carries its
 * own interpreter and entry, so a control that resolved this file is a control that would have run
 * the installed runtime — which is the whole of what the second case asserts.
 */
export function recordingLauncher(stateDir: string, record: string): string {
  const path = launcherPath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  if (process.platform === "win32") {
    writeFileSync(path, windowsRecorder(record));
    return path;
  }
  writeFileSync(path, shellRecorder(record), { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

/** A temporary file to record into, in a directory the fixtures already clean up. */
export function recordFile(): string {
  return join(temporaryDirectory("xd-record-"), "argv.txt");
}

/** Every run the recorder saw, in the order it saw them. */
export function readRuns(record: string): RecordedRun[] {
  let text: string;
  try {
    text = readFileSync(record, "utf8");
  } catch {
    // Nothing ran at all, which is an answer a case may be asserting.
    return [];
  }
  const runs: RecordedRun[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === RUN_MARKER) {
      runs.push({ executable: "", argv: [] });
      continue;
    }
    const current = runs[runs.length - 1];
    if (current === undefined || line === "") {
      continue;
    }
    if (current.executable === "") {
      current.executable = line;
    } else {
      current.argv.push(line);
    }
  }
  return runs;
}

/** The one run the recorder saw, or a failure naming how many it saw instead. */
export function onlyRun(record: string): RecordedRun {
  const runs = readRuns(record);
  if (runs.length !== 1) {
    throw new Error(`expected exactly one recorded run, and the recorder saw ${runs.length}.`);
  }
  const [only] = runs;
  if (only === undefined) {
    throw new Error("expected exactly one recorded run, and the recorder saw none.");
  }
  return only;
}

/** The payload's CLI entry: a Node module that appends its invocation and exits `0`. */
function payloadRecorder(record: string): string {
  return [
    'import { appendFileSync } from "node:fs";',
    'import process from "node:process";',
    `const lines = [${JSON.stringify(RUN_MARKER)}, process.argv0, ...process.argv.slice(1)];`,
    `appendFileSync(${JSON.stringify(record)}, \`\${lines.join("\\n")}\\n\`);`,
    "",
  ].join("\n");
}

/** The launcher on POSIX: `$0` is the path it was invoked by, which is what the case asserts. */
function shellRecorder(record: string): string {
  return [
    "#!/bin/sh",
    `printf '%s\\n' ${JSON.stringify(RUN_MARKER)} >> "${record}"`,
    `printf '%s\\n' "$0" >> "${record}"`,
    'for arg in "$@"; do',
    `  printf '%s\\n' "$arg" >> "${record}"`,
    "done",
    "exit 0",
    "",
  ].join("\n");
}

/** The launcher on Windows, which is a `.cmd` and has to walk its arguments one `shift` at a time. */
function windowsRecorder(record: string): string {
  return [
    "@echo off",
    `>>"${record}" echo ${RUN_MARKER}`,
    `>>"${record}" echo %~f0`,
    ":xplainer_arg",
    'if "%~1"=="" goto xplainer_done',
    `>>"${record}" echo %~1`,
    "shift",
    "goto xplainer_arg",
    ":xplainer_done",
    "exit /b 0",
    "",
  ].join("\r\n");
}
