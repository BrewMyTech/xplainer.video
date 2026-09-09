/**
 * `connect --spawn`: the product delivered on a machine with no supervisor, and no daemon at all.
 *
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §Degraded paths prints this
 * as the **leading** remediation in both no-supervisor cases — "**The user is not stuck**, and the
 * message says so first: `xplainer connect claude --spawn` writes a stdio entry that starts
 * `xplainer mcp` per agent session, needs no supervision at all, and delivers the product — what is
 * lost is the warm process, the shared job queue and the desktop client, not the tools." This
 * module is that entry: the same configuration write as an ordinary `connect`, carrying `mcp`
 * **without** `--attach`, so the eight tools run inside the agent's own session over a
 * session-private job store (`mcp/stdio-server.ts`) and stop when it does.
 *
 * Two properties follow from *where* it is printed, and both are the reason it is a separate
 * resolver rather than a flag on the other one.
 *
 * **It bypasses `connect`'s daemon preflight.** `connect` refuses to write an entry pointing at a
 * daemon that has never answered — exit `3`, ADR 0020 §Ordering, because "a working-looking config
 * for a daemon that is not running is the single most likely first-run support ticket". `--spawn`
 * is offered at exactly the moment there is no daemon and `install` has just refused, so applying
 * that check would make the remediation refuse itself. The check is not weakened for the ordinary
 * path: `--force` remains what overrides it there, and this flag writes a **different entry**, one
 * that names no daemon to be wrong about.
 *
 * **It works with no launch record.** After a refused install there is no `daemon.json` launch
 * spec, and possibly no launcher: `install` writes `<state>/bin/xplainer` in its writing phase, and
 * a preflight refusal never reaches it. So the resolution has one more step than
 * `connect/entry.ts`'s — the **staged runtime** the refused install would have registered:
 *
 * 1. the stable launcher, when an install did write one;
 * 2. `<state>/runtime/<version>-<digest>/bin/node <entry> mcp`, resolved by `install/program.ts`
 *    from whatever `xplainer runtime build` staged;
 * 3. the bare name on `PATH`, then `npx`, which is `connect/entry.ts`'s own tail.
 *
 * Step 2 writes a **version-scoped directory**, which every other writer here refuses to do, and
 * the difference is not an inconsistency: that rule exists because an update renames the directory
 * out from under a configuration, and there is no update on a machine where the install was
 * refused. The moment one succeeds, `connect` rewrites the entry through step 1 and the path stops
 * being version-scoped. The cost is stated rather than hidden — an entry written this way is worth
 * re-running `connect` after an install — and it is strictly better than the alternative, which is
 * an entry pointing at a published package that does not exist yet.
 */

import process from "node:process";
import { ProgramRefusal, resolveProgram } from "../install/program.js";
import {
  ATTACH_ARGS,
  installedLauncher,
  type PathEnvironment,
  resolveStdioEntry,
  type StdioEntry,
} from "./entry.js";

/**
 * What the entry runs: `mcp`, and deliberately not `mcp --attach`.
 *
 * It is {@link ATTACH_ARGS} minus its flag, and the flag is the whole difference between "proxy
 * this session to the daemon that owns the state directory" and "there is no daemon; run the tools
 * here". Derived rather than written out, so the verb cannot be renamed in one place only.
 */
export const SPAWN_ARGS: readonly string[] = ATTACH_ARGS.filter(
  (argument) => argument !== "--attach",
);

/** What {@link resolveSpawnEntry} may consult. */
export type SpawnRequest = {
  /** The state directory holding the launcher, if any, and the staged runtimes. */
  stateDir: string;
  env?: PathEnvironment | undefined;
  platform?: string | undefined;
};

/** The command line an agent spawns per session when nothing supervises a daemon here. */
export function resolveSpawnEntry(request: SpawnRequest): StdioEntry {
  const platform = request.platform ?? process.platform;
  const env = request.env ?? process.env;
  const args = [...SPAWN_ARGS];

  const launcher = installedLauncher(request.stateDir, platform);
  if (launcher !== null) {
    return { command: launcher, args, source: "launcher" };
  }

  const staged = stagedRuntimeEntry(request.stateDir, args);
  if (staged !== null) {
    return staged;
  }

  // No launcher and nothing staged: fall through to the two forms an uninstalled machine has, with
  // no state directory offered, so the launcher is not looked for a second time.
  return resolveStdioEntry({ env, platform, args });
}

/**
 * The staged payload-1 runtime, as an interpreter and an entry file, or `null`.
 *
 * `install/program.ts` is asked rather than the directory listed here, because it is the module
 * that decides what "the runtime to run" means — one staged payload is an answer, two is a question
 * only a human can settle, and a directory whose manifest names a file that is not there is not a
 * payload at all. Every one of those is a {@link ProgramRefusal}, and every one of them means the
 * same thing to this caller: there is no runtime to name, so keep looking. The refusal is not
 * reported, because it is not a failure — `--spawn` is offered precisely to a machine that may have
 * nothing staged.
 */
function stagedRuntimeEntry(stateDir: string, args: readonly string[]): StdioEntry | null {
  let program: ReturnType<typeof resolveProgram>;
  try {
    program = resolveProgram({ stateDir });
  } catch (error) {
    if (error instanceof ProgramRefusal) {
      return null;
    }
    throw error;
  }
  return {
    command: program.executable,
    args: program.entry === null ? [...args] : [program.entry, ...args],
    source: "runtime",
  };
}
