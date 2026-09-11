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
 * about 700 lines of orchestration between them, and calling into their internals would mean either
 * refactoring both or reimplementing a subset here that drifts the first time either changes. A
 * child process running this same binary cannot drift: whatever `xplainer setup` does today is what
 * this runs.
 *
 * **It is `update`, not `self-update`, and it is deliberately not `daemon update`.** That verb
 * already means something precise — switch the installed daemon to another staged runtime and roll
 * back if it will not start — and this touches neither the supervisor nor the payload. A machine
 * with a daemon still runs `daemon update` for that.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { Command } from "commander";
import { claudeUserConfigPath } from "../connect/claude.js";
import { codexConfigPath } from "../connect/codex.js";
import { installedPackageRoot } from "../install/materialise.js";
import type { CliIo } from "../io.js";
import { CLI_VERSION } from "../version.js";

/** The published name a user installs, which is the alias rather than the scoped package. */
const PUBLISHED_NAME = "xplainer";

/** The key `connect` writes the entry under, in both clients. */
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

/** Run one of this CLI's own verbs as a child, and say whether it succeeded. */
function runSelf(io: CliIo, argv: readonly string[]): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    io.writeErr("xplainer update: cannot identify this program's entry to re-run it.\n");
    return false;
  }
  const result = spawnSync(process.execPath, [entry, ...argv], { stdio: "inherit" });
  return result.status === 0;
}

/** One configured agent, and the argv that re-writes it in the form it already has. */
type ConfiguredAgent = { agent: "claude" | "codex"; argv: readonly string[] };

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
  return found;
}

/**
 * Whether this agent's own configuration declares the **attaching** form of the xplainer entry.
 *
 * **The window matters more than the flag.** A configuration holds several MCP servers, so
 * "does `--attach` appear after the word xplainer" is not the question — a neighbouring server
 * declared below ours carrying its own `--attach` would answer yes, and `update` would then rewrite
 * a working in-session entry as one that attaches to a daemon that does not exist. The scan has to
 * be bounded to our entry, which means respecting each format enough to find its end.
 *
 * Claude's is JSON, so it is parsed; Codex's is TOML, where a table runs until the next `[`, which
 * is a slice. Neither needs a dependency and both are exact for the shape `connect` writes.
 *
 * Every failure answers `false` — no file, no entry, unparseable, a shape this does not recognise.
 * `--spawn` is the form that works with nothing running, so it is the safe answer to a question
 * this cannot resolve.
 */
export function attachedForm(path: string, client: "claude" | "codex"): boolean {
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

      const agents = configuredAgents();
      if (agents.length === 0) {
        steps.push({
          label: "agents",
          line: "none configured — run `xplainer connect claude` or `connect codex` once",
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
