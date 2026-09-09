/**
 * `<state>/bin/xplainer`, the one name a consumer may hold across an update.
 *
 * The plan's §2.1: "A stable launcher, because consumers must not hold a version-scoped path.
 * `install` also writes `<state>/bin/xplainer[.cmd]`, a generated two-line launcher that execs the
 * current runtime's `bin/node` and `dist/bin.js`." Every consumer that needs a name surviving an
 * update takes this path — `connect`'s written entry, the desktop's shell-outs and `attach.ts`'s
 * skew remediation — because a runtime directory is named `<version>-<digest>` and the next update
 * points that name at a directory that no longer exists.
 *
 * **Two lines, and both of them are load-bearing.** On POSIX the first is `#!/bin/sh` and the
 * second is `exec "<interpreter>" "<entry>" "$@"`: `exec` is what makes the launcher cost nothing —
 * measured, a shell that `exec`s keeps the **same pid** (§7.18), so signals, process groups and a
 * supervisor's own accounting all reach the daemon exactly as they would without it. On Windows the
 * file is `xplainer.cmd`, `@echo off` and the command with `%*`; `cmd.exe` has no `exec`, so the
 * launcher is a parent there and its exit status is the child's.
 *
 * **The rewrite is the same `temp → rename` as everything else.** §2.2 decides that an update
 * rewrites the supervisor artefact rather than flipping a symlink, and that "every other thing that
 * must change with it — the stable launcher, the mirrored task XML — is the same operation on a
 * different small file. One mechanism everywhere." `fs.renameSync` replacing an existing file is
 * measured on POSIX (§7.11); on Windows it is measured by `daemon-windows.yml` (T11), because this
 * rewrite is what depends on it.
 *
 * **Why not `connect/atomic-write.ts`.** That module preserves the mode of a file *somebody else*
 * owns and defaults to `0600`. This file is ours and must be executable, and it must be executable
 * **before** its name appears: a rename that published a `0600` launcher and chmod'ed it on the next
 * line would give a consumer a window in which the stable path exists and cannot be run. So the
 * mode is set on the temporary file, and the rename publishes something already runnable.
 */

import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { flushDirectory } from "../daemon/durable-write.js";
import { STATE_DIR_MODE } from "../daemon/state-dir.js";
import { CLI_BIN_NAME } from "../runtime/launch-spec.js";
import type { ResolvedProgram } from "./program.js";

/** The subdirectory of the state directory the launcher lives in. */
export const LAUNCHER_DIR = "bin";

/** The launcher's mode: runnable by its owner, and by nobody else, like the directory above it. */
export const LAUNCHER_MODE = 0o700;

/** What one written launcher is. */
export type WrittenLauncher = {
  /** `<state>/bin/xplainer`, or `<state>/bin/xplainer.cmd` on Windows. */
  path: string;
  /** The exact bytes at {@link WrittenLauncher.path}. */
  script: string;
  /** Whether a launcher was already there and this call replaced it. */
  replaced: boolean;
};

/** What {@link writeLauncher} needs. */
export type LauncherRequest = {
  /** The durable state directory the launcher is written under. */
  stateDir: string;
  /** The program it should exec, as `install/program.ts` resolved it. */
  program: ResolvedProgram;
  /** The platform whose form is written. Defaults to this process's. */
  platform?: NodeJS.Platform | undefined;
};

/** `<state>/bin/xplainer`, or `<state>/bin/xplainer.cmd` on Windows. */
export function launcherPath(
  stateDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const name = platform === "win32" ? `${CLI_BIN_NAME}.cmd` : CLI_BIN_NAME;
  return join(stateDir, LAUNCHER_DIR, name);
}

/**
 * The two lines that exec `program` and forward everything they were given.
 *
 * The interpreter and the entry are quoted because a state directory can contain spaces on every
 * platform this installs on — `~/Library/Application Support/video.xplainer` is the macOS default —
 * and `"$@"` rather than `$@` for the same reason at the other end: an argument with a space in it
 * is one argument, and a video slug is a user-supplied string.
 */
export function renderLauncher(
  program: ResolvedProgram,
  platform: NodeJS.Platform = process.platform,
): string {
  const words = program.entry === null ? [program.executable] : [program.executable, program.entry];
  if (platform === "win32") {
    return `@echo off\r\n${words.map((word) => `"${word}"`).join(" ")} %*\r\n`;
  }
  return `#!/bin/sh\nexec ${words.map((word) => `"${word}"`).join(" ")} "$@"\n`;
}

/**
 * Write the launcher, replacing whatever was there, without ever publishing half of one.
 *
 * The temporary file is created in the launcher's own directory, because `rename` is atomic only
 * within a filesystem, and it carries this pid so two installs running side by side cannot collide
 * on it. The directory is flushed afterwards for the reason `daemon/durable-write.ts` gives: on
 * Linux and macOS the *name* is not durable until the directory is.
 */
export function writeLauncher(request: LauncherRequest): WrittenLauncher {
  const platform = request.platform ?? process.platform;
  const path = launcherPath(request.stateDir, platform);
  const directory = join(request.stateDir, LAUNCHER_DIR);
  mkdirSync(directory, { recursive: true, mode: STATE_DIR_MODE });
  const script = renderLauncher(request.program, platform);
  const replaced = existsSync(path);

  const temporary = join(directory, `.${CLI_BIN_NAME}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, script, { mode: LAUNCHER_MODE });
    // `writeFileSync`'s mode applies only when it creates the file, and a temporary left by a
    // crashed install would otherwise hand its own mode to the launcher a consumer then cannot run.
    chmodSync(temporary, LAUNCHER_MODE);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  flushDirectory(directory);
  return { path, script, replaced };
}
