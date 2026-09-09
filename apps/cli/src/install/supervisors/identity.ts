/**
 * The consistency check, on **identity** rather than on paths: three rows, compared.
 *
 * A two-way comparison cannot see the failure this exists to catch. An update rewrites the
 * supervisor artefact and records a new launch spec; if the supervisor never reloads the definition
 * — `launchctl bootstrap` does not refresh an already-loaded job, and `systemctl show` keeps
 * reporting the cached unit until `daemon-reload` — then the daemon that is answering is still the
 * old one, and every file we own says otherwise. Reading our own file back reports success.
 *
 * So three things are read, never two:
 *
 * | # | Row | Where it comes from |
 * |---|---|---|
 * | 1 | **Desired** — what we meant to install | `daemon.json`'s `launch_spec` and `runtime_dir` ({@link readDesired}) |
 * | 2 | **Loaded** — what the supervisor actually holds | `systemctl --user show …` on Linux, `Get-ScheduledTask` on Windows; **unavailable on macOS** ({@link readLoaded}) |
 * | 3 | **Responding** — what is actually answering | `/healthz`'s `run_id` and `runtime_digest`, advertised by the process itself |
 *
 * **macOS has no row 2, and that is a decision (§1.3b D7).** The only launchd surface that would
 * answer is `launchctl print`, whose manual says "Do NOT rely on the structure or information
 * emitted for ANY reason" — and the measurement behind the decision found duplicate keys and
 * `state = active` lines interleaved *inside* the `arguments` block (§7.17). macOS therefore
 * detects a failed switch through row 3 alone, and {@link IdentityReport.detectors} is what lets
 * `daemon status` say which detector fired rather than leaving a reader to infer it.
 *
 * **Row 3 is advertised, not inferred, and never read from `daemon.json`.** {@link identityDigest}
 * is computed on the responding side from what the process was *launched with* — its effective
 * argv, the settings it resolved, its working directory and the content hash of the payload it is
 * running out of. Computing it from the desired record instead would collapse row 3 into row 1 on
 * the one platform where row 3 is the only detector, which is the failure D7 exists to avoid: a
 * hand-edited `daemon.json` must move row 1 and leave row 3 exactly where it was.
 *
 * **Release version is not identity.** Two runtimes can share a `CLI_VERSION` and differ in argv,
 * in settings or in content, so nothing here compares version strings: the digest carries the
 * payload's content hash — `../stage.ts`'s `runtimeDigest`, the one that already names the staged
 * directory —
 * and the settings and the working directory besides, which is what makes a *settings-only* change
 * to otherwise identical runtime bytes a mismatch.
 *
 * **Nothing here writes**, and the only reads are `daemon.json`, a payload's own manifest, and one
 * `realpath` — a consistency check that repaired something would be reporting on itself.
 * {@link readLoaded} in particular is handed the supervisor's raw answer rather than a runner,
 * which is the pattern `../lifecycle.ts`'s `readSwitch` follows and for the same reason: all three
 * platforms' vocabularies are then asserted from one machine.
 */

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DaemonState, SupervisorKind } from "../../daemon/daemon-state.js";
import { readDaemonState } from "../../daemon/daemon-state.js";
import { emitSettings, type LaunchSettings, type LaunchSpec } from "../../runtime/launch-spec.js";
import { RUNTIME_MANIFEST_FILE, readRuntimeManifest } from "../../runtime/manifest.js";
import { runtimeDigest } from "../stage.js";
import { windowsArgumentLine } from "./schtasks.js";

/**
 * How much of the SHA-256 an identity digest carries.
 *
 * Sixteen hex characters — 64 bits — because this value is printed twice side by side in a
 * `daemon status` transcript and read by a person deciding whether two runs are the same run. The
 * comparison it serves is equality between two digests computed by the same function minutes apart,
 * not resistance to a chosen-prefix attack, and there is nothing here an attacker who could already
 * write the state directory would gain by colliding.
 */
export const IDENTITY_DIGEST_LENGTH = 16;

/** What an identity digest is computed over, and nothing else. */
export type LaunchIdentity = {
  /**
   * The **effective** argv: the interpreter followed by every word it was given.
   *
   * `[spec.executable, ...spec.argv]` on the desired side and `process.argv` on the responding
   * side, which are the same vector by construction — `process.argv[0]` is the interpreter and
   * `process.argv[1]` is the entry file the launch contract names.
   */
  argv: readonly string[];
  /** The three settings as they were resolved, not as they were requested. */
  settings: LaunchSettings;
  /** The working directory. */
  cwd: string;
  /**
   * The payload's content hash, or `null` when this program is not running out of one.
   *
   * `null` is a value rather than a failure: a daemon started from a checkout has no payload and
   * two such daemons are still told apart by their argv, their settings and their directory.
   */
  runtimeDigest: string | null;
};

/**
 * The digest, over the four fields and in one fixed order.
 *
 * Field-labelled lines rather than a concatenation, so that moving a value from one field to
 * another cannot produce the same input: `cwd=/a` with no settings and `settings.socket=/a` with no
 * cwd are different documents here, and a digest that agreed on them would agree on two daemons
 * that are not the same daemon.
 */
export function identityDigest(identity: LaunchIdentity): string {
  const hash = createHash("sha256");
  const lines = [
    `argv-length ${String(identity.argv.length)}`,
    ...identity.argv.map((word, index) => `argv[${String(index)}] ${word}`),
    `settings.stateDir ${identity.settings.stateDir}`,
    `settings.tokenFile ${identity.settings.tokenFile}`,
    `settings.socket ${identity.settings.socket}`,
    `cwd ${identity.cwd}`,
    `runtime ${identity.runtimeDigest ?? "none"}`,
  ];
  for (const line of lines) {
    hash.update(`${line}\n`);
  }
  return hash.digest("hex").slice(0, IDENTITY_DIGEST_LENGTH);
}

/**
 * How far up a directory chain a payload's manifest is looked for.
 *
 * The entry a launch contract names sits five directories inside its payload
 * (`<payload>/lib/node_modules/@xplainer/cli/dist/bin.js`), so eight is slack rather than a guess —
 * and a bound is what stops a program started from a checkout from walking to `/` and adopting an
 * unrelated `runtime.manifest.json` that happens to be an ancestor of it.
 */
const MANIFEST_SEARCH_DEPTH = 8;

/**
 * The content hash of the payload a directory sits inside, or `null` when it sits inside none.
 *
 * The manifest is found by walking **up** rather than by deriving the payload root from a known
 * layout: row 3 starts from the directory of the file that is actually running, which is a fact
 * about this process rather than an assumption about how it was installed. A manifest that cannot
 * be read as one is `null` and not a throw — a daemon whose payload has been damaged still has to
 * answer `/healthz` and say what it is.
 */
export function payloadDigestIn(start: string): string | null {
  let directory = start;
  for (let depth = 0; depth <= MANIFEST_SEARCH_DEPTH; depth += 1) {
    if (existsSync(join(directory, RUNTIME_MANIFEST_FILE))) {
      try {
        return runtimeDigest(readRuntimeManifest(directory));
      } catch {
        return null;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
  return null;
}

/**
 * A path as the *answering process* would report the same path, or the string itself.
 *
 * Two of the four digest inputs arrive canonicalised on the responding side and only there, which
 * is measured rather than assumed (Node 24.20.0, macOS, a symlinked directory):
 *
 * ```
 * $ cd <tmp>/link && node <tmp>/link/probe.mjs --flag <tmp>/link/x
 * argv[0] (execPath) → /Users/…/bin/node          resolved
 * argv[1]            → <tmp>/link/probe.mjs       NOT resolved
 * argv[2…]           → <tmp>/link/x               NOT resolved
 * cwd                → /private/<tmp>/real        resolved
 * ```
 *
 * So the interpreter and the working directory are canonicalised here, on the row that was read out
 * of a file, and **nothing else is** — `argv[1]` and the flags arrive verbatim on both sides and
 * normalising them would move one side away from the other. A path that does not exist keeps its
 * own spelling, which is what an edit pointing at a runtime that is not there should produce: a
 * mismatch, and not an exception.
 */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// ── row 1: desired ───────────────────────────────────────────────────────────────────────────

/** What `daemon.json` says this machine meant to install. */
export type DesiredIdentity = {
  /** Whether a launch spec was recorded at all. */
  available: boolean;
  /** The identity digest the recorded spec would produce, or `null` when nothing was recorded. */
  digest: string | null;
  /** The recorded launch contract, exactly as it was read. */
  spec: LaunchSpec | null;
  /** The staged payload the record names. */
  runtimeDir: string | null;
  /** That payload's content hash, or `null` when it could not be read. */
  runtimeDigest: string | null;
  /** What was read, or why nothing was. */
  detail: string;
};

/** What {@link readDesired} may be given instead of reading the file itself. */
export type DesiredRequest = {
  /** The durable state directory `daemon.json` lives in. */
  stateDir: string;
  /** An already-read `daemon.json`, so `daemon status` reads the file once rather than twice. */
  state?: DaemonState | undefined;
};

/**
 * Row 1, from the record and from the payload it names.
 *
 * The payload's manifest is read **from `runtime_dir`** rather than from the executable the spec
 * names, because what row 1 states is the whole of what an install intended: a record pointing at a
 * runtime directory that no longer holds the payload it was written for is itself a desired
 * configuration that cannot be delivered, and the `null` digest that produces is a mismatch against
 * a responding daemon rather than a silent agreement.
 */
export function readDesired(request: DesiredRequest): DesiredIdentity {
  const state = request.state ?? readDaemonState(request.stateDir);
  const spec = state.launch_spec;
  if (spec === null) {
    return {
      available: false,
      digest: null,
      spec: null,
      runtimeDir: state.runtime_dir,
      runtimeDigest: null,
      detail:
        "`daemon.json` records no launch spec, so nothing has been installed here and there is " +
        "no desired configuration to compare against",
    };
  }
  const runtimeDir = state.runtime_dir;
  const payload = runtimeDir === null ? null : payloadDigestIn(runtimeDir);
  return {
    available: true,
    digest: identityDigest({
      argv: [canonicalPath(spec.executable), ...spec.argv],
      settings: spec.settings,
      cwd: canonicalPath(spec.cwd),
      runtimeDigest: payload,
    }),
    spec,
    runtimeDir,
    runtimeDigest: payload,
    detail:
      runtimeDir === null
        ? "read from `daemon.json`'s launch spec; the record names no runtime directory"
        : payload === null
          ? `read from \`daemon.json\`'s launch spec; ${runtimeDir} carries no readable ` +
            `${RUNTIME_MANIFEST_FILE}`
          : `read from \`daemon.json\`'s launch spec, over the payload at ${runtimeDir}`,
  };
}

// ── row 2: loaded ────────────────────────────────────────────────────────────────────────────

/** What the supervisor answered when asked what it is actually holding. */
export type LoadedIdentity = {
  /** Whether this platform has a documented query for what the supervisor loaded. */
  available: boolean;
  /** Whether that query ran to completion. */
  answered: boolean;
  /** The command line the supervisor says it would run, interpreter included. */
  command: string | null;
  /**
   * The environment the supervisor carries: one `NAME=value` assignment per line, unquoted.
   *
   * `null` on a supervisor that has no environment map at all — Task Scheduler's `<Exec>` is the
   * one, which is why every setting travels in the argv on every platform.
   */
  environment: string | null;
  /** The working directory the supervisor holds. */
  cwd: string | null;
  /** What was read, or why nothing was. */
  detail: string;
};

/**
 * The systemd row, and it is stale on purpose.
 *
 * Measured in `infra/e2e/Dockerfile.systemd` on systemd 252 on 2026-09-08. A unit rewritten on disk
 * and **not** reloaded keeps answering with the definition the manager has in memory:
 *
 * ```
 * # the file on disk now says `sleep "8000"` and `WorkingDirectory=/tmp`
 * $ systemctl --user show -p ExecStart -p Environment -p WorkingDirectory --value t17.service
 * { path=/usr/bin/sleep ; argv[]=/usr/bin/sleep 9000 ; ignore_errors=no ; … }
 * XPLAINER_STATE_DIR=… XPLAINER_TOKEN_FILE=…
 * /home/xplainer
 * $ systemctl --user daemon-reload && systemctl --user show … --value t17.service
 * { path=/usr/bin/sleep ; argv[]=/usr/bin/sleep 8000 ; … }
 * …
 * /tmp
 * ```
 *
 * That staleness is the whole value of the row: it is what tells a rewritten artefact apart from a
 * *reloaded* one, and it is why reading our own file back would answer a different question.
 *
 * The same measurement settled two things about the shape. **The order is systemd's, not ours** —
 * asking for `-p WorkingDirectory -p ExecStart -p Environment` printed the same three lines in the
 * same order — so this parser keys on the shape of each line rather than on the position it was
 * asked for. And **an unset value still occupies its line**: a unit with no `Environment=` printed
 * an empty second line, so the count is three either way.
 */
function parseSystemdShow(output: string): LoadedIdentity {
  const lines = output.split("\n");
  const exec = lines.filter((line) => line.startsWith("{"));
  const rest = lines.filter((line) => !line.startsWith("{"));
  const cwd = rest.length > 0 ? (rest[rest.length - 1] ?? "") : "";
  const environment = rest.slice(0, -1).join(" ").trim();
  // `argv[]=` is the vector systemd would exec, interpreter first, and the surrounding record
  // carries a `start_time` and a `pid` that change while nothing about the configuration does.
  // Only the vector is taken, so a restart is not a configuration mismatch.
  const argv = exec
    .map((line) => /argv\[\]=([^;}]*)/.exec(line)?.[1]?.trim() ?? "")
    .filter((line) => line !== "")
    .join(" ; ");
  return {
    available: true,
    answered: true,
    command: argv,
    environment: parseSystemdEnvironment(environment).join("\n"),
    // systemd prefixes a working directory with `!` when it is the manager's own default and with
    // `-` when a missing one is not fatal. Neither character is part of the path.
    cwd: cwd.replace(/^[!-]+/, ""),
    detail: "read from the running systemd user manager",
  };
}

/**
 * systemd's `Environment` value, back into the assignments it was written from.
 *
 * It has to be unquoted rather than compared as printed, because systemd quotes an assignment that
 * carries whitespace and a state directory with a space in it is an ordinary thing to have.
 * Measured in `infra/e2e/Dockerfile.systemd` on systemd 252 on 2026-09-08 — the bytes are in
 * `__fixtures__/systemctl-show-spaces.txt`:
 *
 * ```
 * Environment=… → "XPLAINER_STATE_DIR=/home/xplainer/state with space" "XPLAINER_TOKEN_FILE=…/token"
 * WorkingDirectory → /home/xplainer/state with space          (a single value, printed raw)
 * ```
 *
 * Comparing that display against the assignments the unit was rendered from would report a mismatch
 * for every such machine, which is a consistency check crying wolf at the one user who did nothing
 * wrong. Inside a quoted run, `\` escapes the next character; outside one, whitespace separates.
 */
function parseSystemdEnvironment(value: string): string[] {
  const assignments: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  let index = 0;
  while (index < value.length) {
    const character = value[index] ?? "";
    if (character === "\\" && quoted && index + 1 < value.length) {
      current += value[index + 1] ?? "";
      index += 2;
      started = true;
      continue;
    }
    index += 1;
    if (character === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && (character === " " || character === "\t")) {
      if (started) {
        assignments.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) {
    assignments.push(current);
  }
  return assignments;
}

/**
 * The Task Scheduler row.
 *
 * The registered task is asked, never the XML this project mirrors under `%LOCALAPPDATA%`: a task
 * that has drifted from its local mirror is exactly the failed switch this row exists for, and the
 * mirror is a file we wrote — row 1 under another name.
 *
 * The three values arrive as `Key=value` lines because `Format-List` wraps a long value across
 * lines at the console width and an installed `Arguments` is two absolute paths and six flags long.
 * The query composes the lines itself for that reason; see {@link loadedConfigurationQuery}.
 */
function parseTaskScheduler(output: string): LoadedIdentity {
  const fields = new Map<string, string>();
  for (const line of output.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) {
      fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
  }
  const execute = fields.get("Execute") ?? "";
  const args = fields.get("Arguments") ?? "";
  // A registered task always has something to execute, so an empty `Execute` is the query having
  // found no task rather than a task with no command — and reporting it as a *read* value turns a
  // correct install into two mismatches against `""`. That is what `-TaskName '\folder\leaf'`
  // produced before `scheduledTaskSelector` addressed the folder and the leaf separately: a
  // non-terminating `ObjectNotFound`, three empty values and exit `0` (`windows-latest`,
  // 2026-09-09). The query now stops on that error, and this is the second line of defence.
  if (execute === "") {
    const said = output.trim().split(/\r?\n/)[0]?.trim() ?? "";
    return {
      available: true,
      answered: false,
      command: null,
      environment: null,
      cwd: null,
      detail:
        "the registered scheduled task named no command, which is a task the query did not find " +
        `rather than one with nothing to run: it answered ${said === "" ? "nothing at all" : JSON.stringify(said)}`,
    };
  }
  return {
    available: true,
    answered: true,
    command: args === "" ? execute : `${execute} ${args}`,
    environment: null,
    cwd: fields.get("WorkingDirectory") ?? "",
    detail: "read from the registered scheduled task, not from the local XML mirror",
  };
}

/** The answer a supervisor query came back with, in the shape `../preflight.ts` produces it. */
export type SupervisorAnswer = {
  started: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
};

/**
 * Row 2, from one supervisor's own answer.
 *
 * `launchd` returns `available: false` and says why, which is §1.3b D7 and the whole of it. Every
 * other refusal — a query that did not start, a task that is not there — is `answered: false` with
 * the supervisor's own first line, because "the supervisor said nothing" and "the supervisor said
 * something different" must not reduce to the same report.
 */
export function readLoaded(
  kind: SupervisorKind,
  identity: string,
  answer: SupervisorAnswer,
): LoadedIdentity {
  if (kind === "launchd") {
    return {
      available: false,
      answered: false,
      command: null,
      environment: null,
      cwd: null,
      detail:
        "launchd has no documented query for what it loaded — `launchctl print`'s own manual says " +
        '"Do NOT rely on the structure … for ANY reason" — so on macOS the responding identity in ' +
        "`/healthz` is the detector instead (§1.3b D7)",
    };
  }
  if (!answer.started || answer.status !== 0) {
    const said = (answer.stderr.trim() || answer.stdout.trim()).split("\n")[0]?.trim() ?? "";
    return {
      available: true,
      answered: false,
      command: null,
      environment: null,
      cwd: null,
      detail: `the query did not answer for ${identity}: ${said === "" ? "it said nothing" : said}`,
    };
  }
  const parsed =
    kind === "systemd"
      ? parseSystemdShow(answer.stdout.replace(/\n+$/, ""))
      : parseTaskScheduler(answer.stdout);
  return { ...parsed, detail: `${parsed.detail}, as ${identity}` };
}

/**
 * What row 1 would look like if this platform's supervisor were holding it.
 *
 * The desired spec is put into the *supervisor's* vocabulary rather than the loaded answer being
 * put into ours, because only one of the two directions is lossless: `systemctl show` prints an
 * argv it has already split and unquoted, and reconstructing the unit's own quoting from it would
 * be a guess. The environment is taken from `emitSettings` rather than from `spec.settings`, which
 * is the same seam the three renderers go through, so a setting dropped from the contract is a
 * mismatch here rather than something this comparison has to know about separately.
 */
export function expectedLoaded(kind: SupervisorKind, spec: LaunchSpec): LoadedIdentity {
  if (kind === "systemd") {
    const emission = emitSettings(spec, "linux");
    return {
      available: true,
      answered: true,
      command: [spec.executable, ...spec.argv].join(" "),
      environment: emission.form === "systemd" ? emission.environment.join("\n") : "",
      cwd: spec.cwd,
      detail: "the launch spec `daemon.json` records, in systemd's own spelling",
    };
  }
  if (kind === "task-scheduler") {
    return {
      available: true,
      answered: true,
      command: `${spec.executable} ${windowsArgumentLine(spec.argv)}`,
      environment: null,
      cwd: spec.cwd,
      detail: "the launch spec `daemon.json` records, in Task Scheduler's own spelling",
    };
  }
  return {
    available: false,
    answered: false,
    command: null,
    environment: null,
    cwd: null,
    detail: "launchd has no loaded-configuration query, so there is nothing to expect (§1.3b D7)",
  };
}

// ── row 3: responding ────────────────────────────────────────────────────────────────────────

/** What the process that answered `/healthz` said about itself. */
export type RespondingIdentity = {
  /** Whether anything answered with both fields. */
  available: boolean;
  /** The ownership acquisition's `boot_nonce`: a fresh value per run. */
  run_id: string | null;
  /** The immutable startup snapshot's digest. */
  runtime_digest: string | null;
  /** What answered, or why nothing did. */
  detail: string;
};

/** Row 3, out of a `/healthz` body that may be anything at all. */
export function readResponding(body: {
  run_id?: unknown;
  runtime_digest?: unknown;
}): RespondingIdentity {
  const runId = typeof body.run_id === "string" && body.run_id !== "" ? body.run_id : null;
  const digest =
    typeof body.runtime_digest === "string" && body.runtime_digest !== ""
      ? body.runtime_digest
      : null;
  if (runId === null || digest === null) {
    return {
      available: false,
      run_id: runId,
      runtime_digest: digest,
      detail:
        "`/healthz` did not advertise both `run_id` and `runtime_digest`; nothing is answering, " +
        "or what answered is older than the release that advertises them",
    };
  }
  return {
    available: true,
    run_id: runId,
    runtime_digest: digest,
    detail: "advertised by the process that answered `/healthz`",
  };
}

// ── the comparison ───────────────────────────────────────────────────────────────────────────

/** Which of the two detectors found a difference. */
export type IdentityDetector = "loaded-configuration" | "responding-identity";

/** One difference between two rows, named on both sides. */
export type IdentityMismatch = {
  /** Which detector found it. `daemon status` prints this so a reader knows what fired. */
  detector: IdentityDetector;
  /** The field the two rows disagree about. */
  field: string;
  /** Row 1's value. */
  desired: string;
  /** The other row's value. */
  found: string;
  /** What it means. */
  detail: string;
};

/** The three rows, compared. */
export type IdentityReport = {
  /** Whether every comparison that could be made agreed. */
  consistent: boolean;
  desired: DesiredIdentity;
  loaded: LoadedIdentity;
  responding: RespondingIdentity;
  /** Every difference found, in the order the detectors are tried. */
  mismatches: readonly IdentityMismatch[];
  /**
   * Which detectors fired, in that same order.
   *
   * Empty when nothing did. On macOS this can only ever hold `responding-identity`, which is what
   * makes "`status` names which detector fired" a sentence with content there rather than a
   * restatement of the platform.
   */
  detectors: readonly IdentityDetector[];
  /** One sentence, for the line `daemon status` prints. */
  detail: string;
};

/** What {@link checkIdentity} compares. */
export type IdentityRequest = {
  /** Which supervisor holds the daemon, or `null` on a machine with none. */
  kind: SupervisorKind | null;
  desired: DesiredIdentity;
  loaded: LoadedIdentity;
  responding: RespondingIdentity;
  /**
   * `runtime.json`'s `run_id`, when a run has recorded one.
   *
   * The one thing the digest cannot say: two runs of the *same* configuration have the same digest
   * and different run ids, so a process still answering after a newer run has recorded itself is
   * visible here and nowhere else.
   */
  recordedRunId?: string | null | undefined;
};

/**
 * Compare the three rows, and say which detector found what.
 *
 * A comparison that cannot be made is not a pass. `consistent` is true only when at least one
 * detector actually ran and none of the ones that ran disagreed, and {@link IdentityReport.detail}
 * says which of those two it is — because "nothing is installed" and "everything agrees" are the
 * two answers a consistency check must never conflate.
 */
export function checkIdentity(request: IdentityRequest): IdentityReport {
  const mismatches: IdentityMismatch[] = [];
  const detectors: IdentityDetector[] = [];
  const { desired, loaded, responding } = request;

  if (desired.available && desired.spec !== null && request.kind !== null && loaded.answered) {
    const expected = expectedLoaded(request.kind, desired.spec);
    for (const [field, want, got] of [
      ["command", expected.command, loaded.command],
      ["environment", expected.environment, loaded.environment],
      ["cwd", expected.cwd, loaded.cwd],
    ] as const) {
      if (want === null || got === null || want === got) {
        continue;
      }
      mismatches.push({
        detector: "loaded-configuration",
        field,
        desired: want,
        found: got,
        detail:
          `the supervisor is holding a different ${field} from the one \`daemon.json\` records. ` +
          "That is an artefact that was rewritten and never reloaded, or one edited behind this " +
          "installer's back.",
      });
    }
    if (mismatches.some((entry) => entry.detector === "loaded-configuration")) {
      detectors.push("loaded-configuration");
    }
  }

  if (desired.available && desired.digest !== null && responding.available) {
    if (desired.digest !== responding.runtime_digest) {
      mismatches.push({
        detector: "responding-identity",
        field: "runtime_digest",
        desired: desired.digest,
        found: responding.runtime_digest ?? "",
        detail:
          "the daemon that is answering was launched with a different argv, settings, working " +
          "directory or payload from the one `daemon.json` records. Restart it with `xplainer " +
          "daemon restart` to pick up the recorded configuration.",
      });
    }
    const recorded = request.recordedRunId ?? null;
    if (recorded !== null && responding.run_id !== null && recorded !== responding.run_id) {
      mismatches.push({
        detector: "responding-identity",
        field: "run_id",
        desired: recorded,
        found: responding.run_id,
        detail:
          "`runtime.json` names a different run from the one answering, so the process on the " +
          "port is not the run this machine last recorded as ready.",
      });
    }
    if (mismatches.some((entry) => entry.detector === "responding-identity")) {
      detectors.push("responding-identity");
    }
  }

  const compared =
    (desired.available && desired.digest !== null && responding.available) ||
    (desired.available && request.kind !== null && loaded.answered);

  return {
    consistent: compared && mismatches.length === 0,
    desired,
    loaded,
    responding,
    mismatches,
    detectors,
    detail: describe({ compared, mismatches, detectors, loaded }),
  };
}

/** The one sentence `daemon status` prints for the whole check. */
function describe(facts: {
  compared: boolean;
  mismatches: readonly IdentityMismatch[];
  detectors: readonly IdentityDetector[];
  loaded: LoadedIdentity;
}): string {
  if (!facts.compared) {
    return (
      "nothing could be compared: there is no recorded launch spec, or nothing answered " +
      "`/healthz` and no supervisor query could be made"
    );
  }
  if (facts.mismatches.length === 0) {
    return facts.loaded.available
      ? "desired, loaded and responding agree"
      : "desired and responding agree; this platform has no loaded-configuration query (§1.3b D7)";
  }
  const fired = facts.detectors.join(" and ");
  return `${String(facts.mismatches.length)} mismatch(es), found by ${fired}`;
}
