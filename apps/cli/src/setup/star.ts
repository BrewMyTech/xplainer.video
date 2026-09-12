/**
 * The one question `xplainer setup` asks, and the three ways it can act on a yes.
 *
 * **This is the only prompt in the CLI, and it is deliberate rather than incidental.**
 * `connect/vendor-cli.ts` records the standing position — stdin is closed when spawning a vendor
 * CLI "because nothing here is interactive and a CLI that decided to prompt would otherwise hang
 * `connect` for ever". That position is right, and this does not overturn it: the question is asked
 * only when a human is demonstrably on the other end, it is asked at most once per machine, and
 * every path that is not a person at a terminal skips it in silence.
 *
 * Three rules keep it from becoming the thing that position warns about:
 *
 * 1. **A TTY on both ends, or nothing.** `xplainer update` runs `setup` as a child with inherited
 *    stdio, and `scripts/e2e/*.mjs` and CI run it with no terminal at all. A prompt that blocked on
 *    a pipe would hang an upgrade and every proof, so the absence of a TTY is not an error and not
 *    a warning — it is simply not asking.
 * 2. **Asked at most once.** `setup` is idempotent and is re-run by `xplainer update` on every
 *    upgrade. A question that returned each time would be nagging, so the answer — yes *or* no — is
 *    recorded, and a recorded answer is never revisited.
 * 3. **Never fatal.** Starring is a courtesy, not a step of the install. A GitHub outage, a revoked
 *    token, a machine with no browser: each is a line of output, never a non-zero exit.
 *
 * The answer is kept in its own file rather than in `toolchain.json`, because that marker is a
 * generated protocol type shared with the Python side — whether someone starred a repository is
 * local preference, not part of the tool contract.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { writeJsonDurably } from "../daemon/durable-write.js";

/** The repository the question is about. */
export const STAR_REPO = "BrewMyTech/xplainer.video";

/** Where it lives on the web, for the fallback that opens a browser. */
export const STAR_URL: string = `https://github.com/${STAR_REPO}`;

/** What a previous run decided, if anything. */
export type StarDecision = "starred" | "declined" | "failed";

/** The recorded answer, plus how it was reached. */
export type StarRecord = {
  decision: StarDecision;
  /** `gh`, a token, an opened browser, or the person saying no. */
  via: "gh" | "token" | "browser" | "declined";
  at: string;
};

/** `<state>/star.json` — local preference, deliberately not part of the toolchain marker. */
export function starMarkerPath(stateDir: string): string {
  return join(stateDir, "star.json");
}

/** What a previous run recorded, or `null` when the question has never been answered here. */
export function readStarRecord(stateDir: string): StarRecord | null {
  const path = starMarkerPath(stateDir);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    const decision = Reflect.get(parsed, "decision");
    return decision === "starred" || decision === "declined" || decision === "failed"
      ? (parsed as StarRecord)
      : null;
  } catch {
    // An unreadable marker means the question gets asked again, which is the harmless direction:
    // the alternative is a corrupt byte silencing it for ever.
    return null;
  }
}

/** Whether a person is actually on the other end of both streams. */
export function isInteractive(env: NodeJS.ProcessEnv = process.env): boolean {
  // `CI` is honoured because a runner can allocate a TTY and still have nobody watching it.
  if (env.CI !== undefined && env.CI !== "" && env.CI !== "0" && env.CI !== "false") {
    return false;
  }
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** How long the question waits for a person before giving up on one being there. */
export const ASK_TIMEOUT_MS = 10_000;

/** No answer arrived in time. Distinct from "no", because nobody said no. */
export const NO_ANSWER: unique symbol = Symbol("no answer");

/**
 * Ask one yes/no question, defaulting to yes, and give up after ten seconds.
 *
 * **The timeout is the difference between a prompt and a hang.** A TTY on both ends says a terminal
 * is attached, not that a person is reading it: a session driven by an agent, a `tmux` pane nobody
 * has open, a terminal left on a laptop that got closed. Without a deadline the install simply
 * stops there, and the last thing printed is a question. Ten seconds is long enough to read one
 * line and press a key, and short enough that an unattended run is barely delayed.
 *
 * Timing out answers {@link NO_ANSWER} rather than `false`, which is what stops it being recorded —
 * see {@link offerStar}. Somebody who walked away has not declined.
 */
export async function askYesNo(question: string): Promise<boolean | typeof NO_ANSWER> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ASK_TIMEOUT_MS);
  try {
    const answer = await rl.question(question, { signal: abort.signal });
    const trimmed = answer.trim().toLowerCase();
    // Empty is yes, because the prompt shows `[Y/n]` and Enter has to mean the capital one.
    return trimmed === "" || trimmed === "y" || trimmed === "yes";
  } catch {
    // The only way out of `question` other than an answer is the abort above.
    return NO_ANSWER;
  } finally {
    clearTimeout(timer);
    rl.close();
  }
}

/** Run a command, and say whether it both existed and succeeded. */
function run(command: string, args: readonly string[]): boolean {
  try {
    const result = spawnSync(command, [...args], { stdio: "ignore", timeout: 15_000 });
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Star with the GitHub CLI, using whatever account it is already signed in as.
 *
 * Preferred over a token because it needs nothing from the environment and asks nobody for a
 * secret: if `gh` is installed and authenticated, the credential already exists and is already
 * scoped. `gh auth status` is checked first so an installed-but-signed-out `gh` falls through to
 * the next route rather than reporting a failure.
 */
export function starViaGh(): boolean {
  if (!run("gh", ["auth", "status"])) {
    return false;
  }
  return run("gh", ["api", "--silent", "-X", "PUT", `/user/starred/${STAR_REPO}`]);
}

/**
 * Star with a token from the environment, for a machine that has one but no `gh`.
 *
 * `PUT /user/starred/:owner/:repo` answers `204` when it worked and `304` when it was already
 * starred; both mean the star is there, which is what is being asked.
 */
export async function starViaToken(token: string): Promise<boolean> {
  try {
    const response = await fetch(`https://api.github.com/user/starred/${STAR_REPO}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-length": "0",
        "user-agent": "xplainer-cli",
      },
      signal: AbortSignal.timeout(10_000),
    });
    return response.status === 204 || response.status === 304;
  } catch {
    return false;
  }
}

/** Open a URL in whatever this platform calls a browser. */
export function openInBrowser(url: string): boolean {
  if (process.platform === "darwin") {
    return run("open", [url]);
  }
  if (process.platform === "win32") {
    return run("cmd", ["/c", "start", "", url]);
  }
  return run("xdg-open", [url]);
}

/** What {@link offerStar} needs, all injectable so the suite never touches a terminal or a network. */
export type StarOptions = {
  stateDir: string;
  log: (line: string) => void;
  /** Overridden in tests; the default is the real prompt. */
  ask?: (question: string) => Promise<boolean | typeof NO_ANSWER>;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
  gh?: () => boolean;
  token?: (token: string) => Promise<boolean>;
  browser?: (url: string) => boolean;
};

/**
 * Ask about starring, act on a yes, and record the answer either way.
 *
 * Returns what was recorded, or `null` when nothing was asked — a machine with no terminal, or one
 * that has already answered. The caller treats `null` as "say nothing".
 */
export async function offerStar(options: StarOptions): Promise<StarRecord | null> {
  const env = options.env ?? process.env;
  const already = readStarRecord(options.stateDir);
  if (already !== null) {
    return null;
  }
  const interactive = options.interactive ?? isInteractive(env);
  if (!interactive) {
    return null;
  }

  const ask = options.ask ?? askYesNo;
  const yes = await ask(`Star ${STAR_REPO} on GitHub? [Y/n] (skipping in 10s) `);
  if (yes === NO_ANSWER) {
    // Deliberately not recorded. A recorded answer is never revisited, and nobody answered this —
    // so treating silence as "no" would quietly retire the question on a machine whose owner simply
    // was not looking. The newline keeps whatever prints next off the end of the prompt.
    options.log("no answer, so nothing was starred. `xplainer setup` will ask again.");
    return null;
  }
  if (!yes) {
    const record: StarRecord = {
      decision: "declined",
      via: "declined",
      at: new Date().toISOString(),
    };
    writeJsonDurably(starMarkerPath(options.stateDir), record);
    return record;
  }

  const gh = options.gh ?? starViaGh;
  if (gh()) {
    const record: StarRecord = { decision: "starred", via: "gh", at: new Date().toISOString() };
    writeJsonDurably(starMarkerPath(options.stateDir), record);
    options.log(`starred ${STAR_REPO} with the GitHub CLI. Thank you.`);
    return record;
  }

  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (token !== undefined && token !== "") {
    const viaToken = options.token ?? starViaToken;
    if (await viaToken(token)) {
      const record: StarRecord = {
        decision: "starred",
        via: "token",
        at: new Date().toISOString(),
      };
      writeJsonDurably(starMarkerPath(options.stateDir), record);
      options.log(`starred ${STAR_REPO} with the token in the environment. Thank you.`);
      return record;
    }
  }

  // Nothing here can star on this machine's behalf, so hand the question to the browser rather than
  // reporting a failure the person cannot act on from a terminal.
  const browser = options.browser ?? openInBrowser;
  const opened = browser(STAR_URL);
  const record: StarRecord = {
    decision: opened ? "starred" : "failed",
    via: "browser",
    at: new Date().toISOString(),
  };
  writeJsonDurably(starMarkerPath(options.stateDir), record);
  options.log(
    opened
      ? `no GitHub CLI or token here, so ${STAR_URL} is open in your browser.`
      : `no GitHub CLI, token or browser here — ${STAR_URL} if you would like to.`,
  );
  return record;
}
