/**
 * `xplainer update` — reconcile this machine with the version of xplainer it has.
 *
 * **It does not replace the package, and that is a decision rather than an omission.** Spawning a
 * package manager from here would rewrite the files this process is executing: survivable on macOS
 * and Linux, where the running inode outlives the unlink, and a failure on Windows, where the
 * package is locked while it runs. The manager is also only knowable for a global npm install —
 * a pnpm, bun or yarn global differs, and an `npx -y xplainer` invocation has nothing installed to
 * update at all. So this reads the registry, says whether a newer version exists, and prints the
 * one command for the install it can actually identify.
 *
 * What it *does* own is the half that is safe and that people forget: after an upgrade, `setup` may
 * need to acquire something the new version wants, and `connect` has to be re-run or the agent keeps
 * yesterday's MCP entry and yesterday's `SKILL.md`. Both are idempotent, both report what changed,
 * and neither is obvious from the upgrade command alone — which is the whole reason this command
 * exists.
 *
 * **The steps are spawned rather than imported.** `commands/setup.ts` and `commands/connect.ts` are
 * orchestration-heavy, and calling into their internals would mean either refactoring both or
 * reimplementing a subset here that drifts the first time either changes. A child process running
 * this same binary cannot drift: whatever `xplainer setup` does today is what this runs.
 *
 * **It is `update`, not `self-update`.** Replacing the package is the half above; what this owns is
 * everything an upgrade leaves behind, and that includes the daemon.
 *
 * **It used to exclude the daemon, and that was the bug.** The rule here read "it is deliberately
 * not `daemon update` … a machine with a daemon still runs `daemon update` for that", which is a
 * true statement about the *verb* and was false as advice. `npm i -g` replaces the global CLI and
 * leaves the pinned runtime the supervisor executes exactly where it was, so the two drift with
 * nothing saying so — measured on the author's own machine at a 0.0.2 daemon under an 0.0.8 CLI,
 * four releases apart, which silently re-rendered a video with an engine four versions old. The
 * command that exists to reconcile a machine after an upgrade cannot be the one that skips the
 * largest stale thing on it. {@link reconcileDaemon} is that step, and it is a no-op on the
 * majority case of a machine with no daemon at all.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { Command } from "commander";
import { claudeUserConfigPath } from "../connect/claude.js";
import { codexConfigPath } from "../connect/codex.js";
import { copilotConfigPath } from "../connect/copilot.js";
import { PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import { resolveStateDir } from "../daemon/state-dir.js";
import {
  installedPackageRoot,
  type MaterialisedPayload,
  materialiseProgramPayload,
} from "../install/materialise.js";
import { resolveProgram } from "../install/program.js";
import { rootPackageOf } from "../install/stage.js";
import type { CliIo } from "../io.js";
import { CLI_VERSION } from "../version.js";

/** The published name a user installs, which is the alias rather than the scoped package. */
const PUBLISHED_NAME = "xplainer";

/** The key `connect` writes the entry under, in every supported client. */
const MCP_SERVER_NAME = "xplainer";

/** The TOML table `connect codex` writes, and the start of the window to scan for the transport. */
const CODEX_TABLE = `[mcp_servers.${MCP_SERVER_NAME}]`;

/** How long to wait on the registry before giving up and saying so. */
const REGISTRY_TIMEOUT_MS = 5_000;

/** What one reconcile step did, so the summary can be one line each. */
type Step = { label: string; line: string };

/** What `update` parses. */
type UpdateOptions = { check?: boolean };

/**
 * The latest published version, or `null` when the registry cannot be reached.
 *
 * **Unreachable is not an error here.** `update`'s useful half runs offline, so a machine behind a
 * proxy or on a plane should still get its `setup` and `connect` reconciled rather than a failure
 * about a version check it did not ask for. The summary says the check was skipped.
 */
async function latestPublished(): Promise<string | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${PUBLISHED_NAME}`, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    if (!response.ok) {
      return null;
    }
    const document: unknown = await response.json();
    const tags = Reflect.get(Object(document), "dist-tags");
    const latest = Reflect.get(Object(tags), "latest");
    return typeof latest === "string" && latest.length > 0 ? latest : null;
  } catch {
    return null;
  }
}

/**
 * The command that upgrades *this* install, or `null` when it cannot be identified.
 *
 * Only one case is answerable with confidence: a package-manager install, which
 * {@link installedPackageRoot} already recognises by walking up to a `node_modules/xplainer` and
 * refusing a staged payload. Everything else — a checkout, a relocated payload, an `npx` cache —
 * either has no install to upgrade or upgrades by a route this command should not guess at.
 */
export function upgradeCommand(): string | null {
  return installedPackageRoot() === null ? null : `npm i -g ${PUBLISHED_NAME}@latest`;
}

/**
 * Which of two versions is later, for the only shape this project publishes.
 *
 * Numeric dot-separated parts and nothing else: a value carrying a pre-release tag, build metadata
 * or any non-numeric segment answers `"unknown"` rather than being guessed at. That is deliberate —
 * this command's only decision is whether to *offer an upgrade*, and offering the wrong direction is
 * worse than declining to offer one. An earlier version compared with `!==` and told a machine on
 * `0.0.3` that `0.0.2` was available.
 */
export function compareVersions(
  installed: string,
  published: string | null,
): "same" | "behind" | "ahead" | "unknown" {
  if (published === null) {
    return "unknown";
  }
  if (installed === published) {
    return "same";
  }
  const parse = (value: string): number[] | null => {
    const parts = value.split(".");
    const numbers = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
    return numbers.some((part) => Number.isNaN(part)) ? null : numbers;
  };
  const left = parse(installed);
  const right = parse(published);
  if (left === null || right === null) {
    return "unknown";
  }
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) {
      return a < b ? "behind" : "ahead";
    }
  }
  return "same";
}

/**
 * Run one of this CLI's own verbs as a child and return its exit code, or `null` when it could not
 * be started at all.
 *
 * The code rather than a boolean because one caller needs to tell two failures apart: the daemon
 * step treats `PRECONDITION_UNMET_EXIT_CODE` — nothing installed here to update — as a machine that
 * is simply not in that shape, and anything else as a real failure worth the word FAILED.
 */
function runSelfStatus(io: CliIo, argv: readonly string[]): number | null {
  const entry = process.argv[1];
  if (entry === undefined) {
    io.writeErr("xplainer update: cannot identify this program's entry to re-run it.\n");
    return null;
  }
  const result = spawnSync(process.execPath, [entry, ...argv], { stdio: "inherit" });
  return result.status;
}

/** Run one of this CLI's own verbs as a child, and say whether it succeeded. */
function runSelf(io: CliIo, argv: readonly string[]): boolean {
  return runSelfStatus(io, argv) === 0;
}

/**
 * The version of the runtime the supervisor executes, or `null` when this machine has none staged.
 *
 * Read from the staged payload's own manifest rather than from the daemon over HTTP, because the
 * question this answers is "what would start" and not "what is answering" — a daemon that is
 * stopped, crash-looping or mid-rollback still has a version, and a machine with no daemon at all
 * must produce a skip rather than a timeout.
 */
function stagedRuntimeVersion(stateDir: string): string | null {
  try {
    const program = resolveProgram({ stateDir });
    return program.manifest === null ? null : rootPackageOf(program.manifest).version;
  } catch {
    return null;
  }
}

/**
 * Bring an installed daemon onto this version, or say in one line why it was left alone.
 *
 * **This is the seam that made a 0.0.2 daemon survive four upgrades of the CLI above it.** The
 * docblock at the top of this file used to say updating the daemon was `daemon update`'s job and
 * not this command's, which is true of the *verb* and was false as advice: a package manager
 * replaces the global CLI and leaves the pinned copy the supervisor executes exactly where it was,
 * so the machine ends up running two versions at once with nothing saying so. `update` already
 * exists to reconcile the things an upgrade leaves stale, and the runtime under the supervisor is
 * the largest of them.
 *
 * **ADR 0025's "never a default" is not weakened here.** That rule is about `daemon update`
 * inventing a source nobody named — "whatever is on `PATH`" — and it still refuses to. What this
 * does is *name* one: the payload assembled from the package this very process is executing, handed
 * over as an explicit `--from`. The source is as specific as a path the user typed, and it is the
 * only one that can be correct, because reconciling this install is the whole of what `update` is.
 */
function reconcileDaemon(io: CliIo): Step {
  const label = "daemon";
  const plan = planDaemonReconcile(
    stagedRuntimeVersion(resolveStateDir()),
    CLI_VERSION,
    installedPackageRoot(),
  );
  if (plan.kind === "skip") {
    return { label, line: plan.line };
  }
  let payload: MaterialisedPayload;
  try {
    payload = materialiseProgramPayload({ locateInstall: () => plan.installRoot });
  } catch (error) {
    return {
      label,
      line: `${plan.staged} left alone: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    const status = runSelfStatus(io, ["daemon", "update", "--from", payload.payloadDir]);
    if (status === 0) {
      return { label, line: `${plan.staged} → ${CLI_VERSION}` };
    }
    // **Exit 3 is "this machine is not in that shape", not "the update broke".** A staged runtime
    // with no supervisor registration behind it is a real state — `runtime build` leaves one — and
    // calling that FAILED would teach people to ignore the word the first time they hit it.
    if (status === PRECONDITION_UNMET_EXIT_CODE) {
      return { label, line: `${plan.staged} left alone — see the refusal above` };
    }
    return { label, line: "FAILED — see the output above" };
  } finally {
    payload.discard();
  }
}

/** Either a line to print and nothing to do, or the install to assemble the new runtime from. */
export type DaemonPlan =
  | { kind: "skip"; line: string }
  | { kind: "update"; installRoot: string; staged: string };

/**
 * Decide what the daemon step should do, given three facts and no filesystem.
 *
 * Split out from {@link reconcileDaemon} because the branches are the part worth testing and the
 * execution is a `spawnSync` of this same binary: a test that could only reach this table through a
 * child process would be an integration test for a decision that is pure.
 */
export function planDaemonReconcile(
  staged: string | null,
  cliVersion: string,
  installRoot: string | null,
): DaemonPlan {
  if (staged === null) {
    return { kind: "skip", line: "none installed — nothing to update" };
  }
  if (staged === cliVersion) {
    return { kind: "skip", line: `${staged}, already current` };
  }
  if (installRoot === null) {
    // A checkout or an `npx` invocation has no installed package to assemble a payload from, and
    // `--build` is the flag that covers exactly that case — so name it rather than fail.
    return {
      kind: "skip",
      line:
        `${staged} installed, ${cliVersion} here — this build is not a package install, so run ` +
        "`xplainer daemon update --build` from the checkout",
    };
  }
  return { kind: "update", installRoot, staged };
}

/** One configured agent, and the argv that re-writes it in the form it already has. */
type ConfiguredAgent = {
  agent: "claude" | "codex" | "copilot";
  argv: readonly string[];
};

/**
 * Which agents have a configuration worth refreshing, and how to refresh each **in place**.
 *
 * **The form has to be preserved, and getting this wrong breaks exactly the users who chose the
 * simpler setup.** `connect <agent>` writes an entry that *attaches* to a daemon and refuses with
 * exit `3` when none has ever bound; `connect <agent> --spawn` writes one that starts the tools
 * inside each agent session and needs no daemon. A first version of this command re-ran the bare
 * verb for every agent, which would have turned `update` into a guaranteed failure on any machine
 * without a daemon — the majority case, since the daemon is opt-in.
 *
 * So the existing entry decides: `--attach` among **its own** arguments means re-run the attaching
 * form, anything else means `--spawn`. Reading the answer out of the file the user already has is
 * also the only way to get it right without asking them a question they answered once already.
 */
function configuredAgents(): readonly ConfiguredAgent[] {
  const found: ConfiguredAgent[] = [];
  const spawnUnless = (attached: boolean): readonly string[] => (attached ? [] : ["--spawn"]);

  const claudeConfig = claudeUserConfigPath();
  if (existsSync(claudeConfig)) {
    found.push({
      agent: "claude",
      argv: ["connect", "claude", ...spawnUnless(attachedForm(claudeConfig, "claude"))],
    });
  }
  const codexConfig = codexConfigPath();
  if (existsSync(codexConfig)) {
    found.push({
      agent: "codex",
      argv: ["connect", "codex", ...spawnUnless(attachedForm(codexConfig, "codex"))],
    });
  }
  const copilotConfig = copilotConfigPath();
  if (existsSync(copilotConfig)) {
    found.push({
      agent: "copilot",
      argv: ["connect", "copilot", ...spawnUnless(attachedForm(copilotConfig, "copilot"))],
    });
  }
  return found;
}

/**
 * Whether this agent's own configuration declares the **attaching** form of the xplainer entry.
 *
 * **The window matters more than the flag.** A configuration holds several MCP servers, so
 * "does `--attach` appear after the word xplainer" is not the question — a neighbouring server
 * declared below ours carrying its own `--attach` would answer yes. Codex's TOML therefore gets a
 * bounded table scan; Claude and Copilot use JSON and can read the exact entry directly.
 *
 * Every failure answers `false` — no file, no entry, unparseable, a shape this does not recognise.
 * `--spawn` is the form that works with nothing running, so it is the safe answer to a question
 * this cannot resolve.
 */
export function attachedForm(path: string, client: "claude" | "codex" | "copilot"): boolean {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  if (client === "codex") {
    const at = text.indexOf(CODEX_TABLE);
    if (at === -1) {
      return false;
    }
    const rest = text.slice(at + CODEX_TABLE.length);
    const next = rest.search(/^\s*\[/m);
    return (next === -1 ? rest : rest.slice(0, next)).includes("--attach");
  }
  try {
    const servers = Reflect.get(Object(JSON.parse(text)), "mcpServers");
    const entry = Reflect.get(Object(servers), MCP_SERVER_NAME);
    const args: unknown = Reflect.get(Object(entry), "args");
    return Array.isArray(args) && args.includes("--attach");
  } catch {
    return false;
  }
}

export function createUpdateCommand(io: CliIo): Command {
  return new Command("update")
    .description(
      "Reconcile this machine after an upgrade: re-acquire the toolchain and refresh each " +
        "configured agent's MCP entry and skill",
    )
    .option("--check", "report the version comparison and change nothing")
    .action(async (options: UpdateOptions) => {
      const latest = await latestPublished();
      const steps: Step[] = [];

      const comparison = compareVersions(CLI_VERSION, latest);
      if (latest === null) {
        steps.push({ label: "version", line: `${CLI_VERSION} installed, registry unreachable` });
      } else if (comparison === "same") {
        steps.push({ label: "version", line: `${CLI_VERSION} installed, up to date` });
      } else if (comparison !== "behind") {
        // **Ahead of the registry, or not comparable — reconcile, do not offer an upgrade.** A
        // checkout and a pre-release both sit here, and an earlier version of this command treated
        // any difference as "newer on npm" and told a machine running 0.0.3 to install 0.0.2.
        steps.push({
          label: "version",
          line:
            comparison === "ahead"
              ? `${CLI_VERSION} installed, ${latest} on npm — this build is ahead of the registry`
              : `${CLI_VERSION} installed, ${latest} on npm — not comparable, so neither is offered`,
        });
      } else {
        const upgrade = upgradeCommand();
        steps.push({ label: "version", line: `${CLI_VERSION} installed, ${latest} on npm` });
        // **Stop rather than reconcile an install that is about to be replaced.** Running `setup`
        // and `connect` now would write this version's entry and skill, and the upgrade would
        // immediately make both stale — so the user would have to run this command twice anyway.
        // Saying so once is better than doing the work twice and not mentioning it.
        steps.push({
          label: "upgrade",
          line:
            upgrade === null
              ? "this install was not made by a package manager, so there is no command to print — " +
                "upgrade it the way you installed it, then run `xplainer update` again"
              : `${upgrade}   ← run this, then \`xplainer update\` again`,
        });
        report(io, steps);
        return;
      }

      if (options.check === true) {
        report(io, steps);
        return;
      }

      steps.push({
        label: "setup",
        line: runSelf(io, ["setup"]) ? "reconciled" : "FAILED — see the output above",
      });

      // Before the agents, because an attaching entry points at the daemon: refreshing the entry
      // first would announce a reconciled machine while the thing it points at was still stale.
      steps.push(reconcileDaemon(io));

      const agents = configuredAgents();
      if (agents.length === 0) {
        steps.push({
          label: "agents",
          line: "none configured — run `xplainer connect claude`, `connect codex` or `connect copilot` once",
        });
      }
      for (const { agent, argv } of agents) {
        const form = argv.includes("--spawn") ? "in-session" : "attached";
        steps.push({
          label: agent,
          line: runSelf(io, argv)
            ? `entry (${form}) and skill refreshed`
            : "FAILED — see the output above",
        });
      }

      report(io, steps);
    });
}

/** The summary, one labelled line per step, in the shape `connect` and `daemon status` use. */
function report(io: CliIo, steps: readonly Step[]): void {
  const width = Math.max(...steps.map((step) => step.label.length)) + 1;
  io.writeOut(
    `xplainer update:\n${steps
      .map((step) => `  ${`${step.label}:`.padEnd(width + 1)} ${step.line}`)
      .join("\n")}\n`,
  );
}
