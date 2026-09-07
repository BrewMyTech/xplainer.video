#!/usr/bin/env node
/**
 * The batch-1 gate: `create → put_source → narrate`, driven entirely out of a relocated runtime
 * artefact, on a machine that behaves as though it has no Node at all.
 *
 * This is the proof that §2.1's payload 1 is what it claims to be. `xplainer runtime build`
 * assembles the artefact **inside the checkout**; this script then **moves it outside**, throws
 * away the environment, and talks MCP stdio to `<artefact>/bin/node
 * <artefact>/lib/node_modules/@xplainer/cli/dist/bin.js mcp` — no daemon, no `PATH`, no checkout in
 * any ancestor of the entry it runs. Everything the three tools need has to come from inside the
 * directory, and every payload site the round-3 review found is on that path:
 *
 * - `explainer_create` reads **both** of `render-core`'s template directories — `template/` for the
 *   four workspace files and `dist/scaffold/templates/*.txt` for the six scaffold files — through
 *   two `import.meta.url` sites no bundler could have rewritten. This script compares the bytes it
 *   got against the artefact's own copies, so "it ran" and "it read them from the payload" are two
 *   different assertions rather than one hopeful one.
 * - `explainer_narrate` spawns `dist/workers/narrate.js` with the artefact's own interpreter
 *   (`daemon/workers.ts`), which is the pattern D1 generalises to Remotion in T4.
 * - the process would not have started at all without `protocol/schemas/manifest.json`, and the
 *   expected scaffold list below is read out of the artefact's copy of exactly that file.
 *
 * **What it deliberately does not do.** `explainer_still` and `explainer_render` need
 * `<workspace>/node_modules/.bin/remotion` and a Chrome headless shell — payload 2 and the
 * toolchain, which `setup` acquires. They are **T33**, in B6, and putting them here is what made
 * round 2's gate unrunnable. This gate stops at narration, which is the last step that needs
 * nothing but the artefact.
 *
 * **Speech comes from `XPLAINER_TTS_FIXTURE`**, a directory this script records on the spot: one
 * real 16-bit PCM WAV and one set of word spans per segment, exactly the envelope Kokoro returns.
 * That substitutes the *server* and nothing else — decoding, measuring, planning, concatenating and
 * writing the three documents are the shipping code path — so `timings.json` is measured from real
 * frames and a job that reached `done` having written nothing cannot pass.
 *
 * **The scrubbed `PATH` is a directory this script creates and leaves empty**, rather than
 * `/usr/bin:/bin`. A directory we own is provably free of `node` on macOS, on Debian and on
 * Windows alike, where `/usr/bin:/bin` is a guess about the host and does not exist at all on the
 * third. It is asserted rather than assumed: nothing on that `PATH` resolves `node`, and on POSIX
 * `env -i PATH=<empty> /bin/sh -c 'command -v node'` is run and required to fail, which is the
 * literal form of the check D1 was written against.
 *
 * **It is not part of `pnpm verify` and must not become part of it.** It copies ~147 MB of
 * interpreter, npm and packages per run. The suites under `apps/cli` cover the assembler, the
 * manifest and the verifier against small fixtures and are what CI runs on every push; this script
 * is the periodic proof that a real payload, moved somewhere else, still does the job.
 *
 * ```bash
 * pnpm e2e:runtime
 * ```
 *
 * Environment it reads: `COLLIE_ARTIFACTS_DIR` (default `<repo>/.session/artifacts`). Nothing else
 * — every other coordinate is a throwaway directory this run creates, and the environment the
 * artefact sees is built from nothing rather than inherited.
 *
 * Everything it prints is also written to `<artifacts>/e2e-runtime.log`, line by line as it
 * happens, so a run that dies mid-narration still leaves its transcript behind.
 *
 * Exit codes: `0` the gate passed; `1` it failed, with the failed assertion named on the last line
 * and the scratch directory left behind for inspection.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** The repository root, three levels up from this file. */
const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** The built CLI that assembles the artefact. `pnpm turbo build` below makes it this commit's. */
const CLI = join(REPO, "apps", "cli", "dist", "bin.js");

/**
 * The one spawn of pnpm in this script — `pnpm turbo build` — in the form `execFileSync` takes it.
 *
 * On POSIX that is pnpm's own name and two arguments, spawned directly. On Windows pnpm is a
 * `pnpm.cmd` shim, which is not an image the kernel can execute, and since the April 2024 security
 * release Node refuses to hand one to `CreateProcess` at all: `spawn`, `execFile` and their sync
 * forms throw `spawn EINVAL` on a `.bat` or a `.cmd` unless `shell` is set, which is the fix for
 * CVE-2024-27980. So Windows goes through `cmd.exe` — and as **one command string with no argument
 * array**, because passing arguments *and* `shell: true` is a runtime deprecation in Node 24
 * (DEP0190, measured: it prints a `DeprecationWarning` on every run) whose whole subject is the
 * escaping a shell hop skips. Nothing is interpolated into that string; it is the same two literals
 * the POSIX branch passes, and nothing else in this script is spawned through a shell at all.
 */
const PNPM_BUILD =
  process.platform === "win32"
    ? { command: "pnpm.cmd turbo build", args: [], shell: true }
    : { command: "pnpm", args: ["turbo", "build"], shell: false };

/** Where the transcript is left for a human to look at. */
const ARTIFACTS =
  (process.env.COLLIE_ARTIFACTS_DIR ?? "").trim() || join(REPO, ".session/artifacts");

/** Where the transcript is written, line by line. */
const LOG_PATH = join(ARTIFACTS, "e2e-runtime.log");

/**
 * Where the artefact is assembled: **inside the checkout**, because the move out of it is the
 * thing being tested. `.session/` is ignored by git, and the directory is emptied first because
 * `runtime build` refuses to write into one that is not.
 */
const STAGE_ROOT = join(REPO, ".session", "e2e-runtime");
const STAGE = join(STAGE_ROOT, "staged");

/** The video this gate builds. */
const SLUG = "runtime-gate";

/** How long the narration job may take before the gate gives up on it. */
const NARRATE_TIMEOUT_MS = 300_000;

/** How many log lines to ask `explainer_job` for, and how many of them to quote. */
const OUTPUT_LINES = 200;
const QUOTED_LINES = 12;

/**
 * The pacing `narrate` inserts around the recorded clips, in milliseconds.
 *
 * Copied from `packages/render-core/src/narrate/pacing.ts`, which exports all three, so this script
 * can state what the track's length *must* be rather than accepting whatever it finds. Silence is
 * inserted and never trimmed and every span is quantised to whole samples, so the expected total is
 * an exact number of milliseconds rather than a bound. A deliberate change to the pacing policy is
 * meant to change these three numbers too.
 */
const LEAD_IN_MS = 400;
const GAP_MS = 620;
const TAIL_MS = 800;

/** Kokoro's own output rate, which is the rate the recorded clips are written at. */
const SAMPLE_RATE = 24_000;

/** The narration's frame rate: what `timings.json`'s frame numbers are counted in. */
const FPS = 30;

/**
 * The two recorded segments: what the voice says, how long the clip is, and what note it is.
 *
 * Sine tones rather than silence, and a different frequency each, so a decoder that returned zeroes
 * or a track builder that concatenated the wrong clip fails here instead of passing quietly. The
 * lengths are whole numbers of samples at 24 kHz, so the arithmetic below is exact.
 */
const SEGMENTS = [
  {
    id: "hook",
    text: "The runtime is one directory and it carries its own interpreter.",
    seconds: 1.5,
    frequency: 440,
  },
  {
    id: "answer",
    text: "Nothing inside it names the machine that built it, so it still runs after it moves.",
    seconds: 2.25,
    frequency: 660,
  },
];

/**
 * The agent's half of the video, written through `explainer_put_source`.
 *
 * One component per narration segment id plus one shared component under `scenes/`, which is the
 * ownership boundary the tool enforces: `Scenes.tsx` is the agent's, the five engine files are
 * refused, and a nested path is allowed. Nothing here is rendered — no Remotion runs in this gate —
 * so what is asserted is that the writes landed where the tool said they would.
 */
const SOURCE_FILES = [
  {
    path: "Scenes.tsx",
    content: `import type { SceneMap } from "./Video";
import { Panel } from "./scenes/Panel";

const Hook: React.FC = () => <Panel accent="#4C8DFF" title="One directory" />;
const Answer: React.FC = () => <Panel accent="#F2B33D" title="It moved, and it ran" />;

export const scenes: SceneMap = { hook: Hook, answer: Answer };
`,
  },
  {
    path: "scenes/Panel.tsx",
    content: `import { AbsoluteFill } from "remotion";

export const Panel: React.FC<{ accent: string; title: string }> = ({ accent, title }) => (
  <AbsoluteFill style={{ backgroundColor: "#0A0C10", justifyContent: "center", padding: 160 }}>
    <div style={{ color: accent, fontSize: 96, fontWeight: 800 }}>{title}</div>
  </AbsoluteFill>
);
`,
  },
];

/** Every status this run saw, in order, for the summary at the end. */
const observed = [];

/** The scratch directory, removed when the run succeeds and kept when it does not. */
let scratch = null;

function stamp() {
  return new Date().toISOString();
}

/** Say something, once, to both the terminal and the transcript. */
function say(text) {
  const line = `${text}\n`;
  process.stdout.write(line);
  appendFileSync(LOG_PATH, line);
}

function section(title) {
  say("");
  say(`── ${title} ${"─".repeat(Math.max(0, 76 - title.length))}`);
}

/** A failed assertion is the whole point of this script, so it carries its own sentence. */
function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
  say(`  ok  ${message}`);
}

/** Run a command to completion and return its stdout, refusing a non-zero exit. */
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

/**
 * Run a command with both its streams captured into the transcript.
 *
 * `execFileSync` forwards a child's stderr to this process's own, which leaves it out of the log
 * file — and the log file is the artefact. Anything whose output is evidence goes through here.
 */
function runLogged(label, command, args, options = {}) {
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
        appendFileSync(LOG_PATH, `  [${label} ${stream}] ${line}\n`);
      }
    }
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} exited ${result.status ?? result.signal}: ${(result.stderr ?? "").trim().slice(-800)}`,
    );
  }
  return result.stdout ?? "";
}

/** Whether `path` is outside the checkout, which is what "moved out of it" has to mean. */
function outsideCheckout(path) {
  const inside = relative(REPO, path);
  return inside === "" ? false : inside.startsWith("..") || isAbsolute(inside);
}

/**
 * Move a directory, falling back to copy-and-remove across a device boundary.
 *
 * `rename(2)` is the move being tested — the artefact has to survive being given a different
 * absolute path — and it is what runs whenever the staging directory and the destination share a
 * filesystem, which is the case on a developer's machine and on all three runners. `EXDEV` is the
 * one case it cannot serve: a `/tmp` mounted separately from the checkout, which some containers
 * do. The copy is the same move as far as the payload is concerned, and the transcript says which
 * one happened.
 */
function moveDirectory(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
    return "rename";
  } catch (error) {
    if (error.code !== "EXDEV") {
      throw error;
    }
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
    return "copy across devices";
  }
}

/** The names `node` can go by on this platform, for the `PATH` scan below. */
function nodeNames() {
  return process.platform === "win32" ? ["node.exe", "node.cmd", "node.bat"] : ["node"];
}

/** The first `node` a `PATH` resolves, or `null` when it resolves none. */
function nodeOnPath(pathValue) {
  for (const directory of pathValue.split(delimiter)) {
    if (directory.trim() === "") {
      continue;
    }
    for (const name of nodeNames()) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * The whole environment the artefact is allowed to see.
 *
 * Built from nothing rather than filtered from this process's, because a filter is a list of the
 * variables someone remembered. What is left is a `PATH` naming one empty directory, the platform
 * minimum a process needs to start at all, and the three `XPLAINER_*` coordinates this run is
 * about.
 * There is deliberately no `NODE_PATH` and no `NODE_OPTIONS`: with the entry inside the artefact
 * and the working directory outside the checkout, Node's own ancestor-directory resolution cannot
 * reach the repository's `node_modules`, and those two variables are the only things that could
 * have let it.
 */
function scrubbedEnvironment(paths) {
  const base = {
    PATH: paths.emptyBin,
    XPLAINER_STATE_DIR: paths.state,
    XPLAINER_VIDEOS_DIR: paths.videos,
    XPLAINER_TTS_FIXTURE: paths.fixtures,
  };
  if (process.platform === "win32") {
    return {
      ...base,
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      SystemDrive: process.env.SystemDrive ?? "C:",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      USERPROFILE: paths.home,
      TEMP: paths.temp,
      TMP: paths.temp,
    };
  }
  return { ...base, HOME: paths.home, TMPDIR: paths.temp };
}

/** One clip: `seconds` of a sine at `frequency`, mono 16-bit at Kokoro's own rate. */
function sineWav(seconds, frequency) {
  const frames = Math.round(SAMPLE_RATE * seconds);
  const data = Buffer.alloc(frames * 2);
  for (let n = 0; n < frames; n += 1) {
    data.writeInt16LE(
      Math.round(8000 * Math.sin((2 * Math.PI * frequency * n) / SAMPLE_RATE)),
      n * 2,
    );
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * The word spans a server would have reported for one clip: one token per word, evenly spaced.
 *
 * Every token carries its own punctuation rather than arriving as a token of its own, which is the
 * one shape `captions.ts` treats specially. That keeps the caption count equal to the word count
 * and makes the assertion below an equality instead of an inequality.
 */
function wordSpans(text, seconds) {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const step = seconds / words.length;
  return words.map((word, index) => ({
    word,
    start_time: Number((index * step).toFixed(6)),
    end_time: Number(((index + 1) * step).toFixed(6)),
  }));
}

/** Record the fixture directory `XPLAINER_TTS_FIXTURE` names, and return the narration spec. */
function writeFixtures(dir) {
  mkdirSync(dir, { recursive: true });
  const manifest = [];
  for (const segment of SEGMENTS) {
    const audio = `${segment.id}.wav`;
    const words = `${segment.id}-words.json`;
    writeFileSync(join(dir, audio), sineWav(segment.seconds, segment.frequency));
    writeFileSync(
      join(dir, words),
      `${JSON.stringify(wordSpans(segment.text, segment.seconds), null, 2)}\n`,
    );
    manifest.push({ text: segment.text, audio, words });
  }
  writeFileSync(join(dir, "fixtures.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    voice: "af_heart",
    speed: 1,
    fps: FPS,
    segments: SEGMENTS.map((segment) => ({ id: segment.id, text: segment.text })),
  };
}

/**
 * The duration of a 16-bit PCM WAV, from its own header.
 *
 * Read here rather than asked of a tool because the claim being tested is that `timings.json`
 * agrees with the file the narration port wrote. Walking the chunk list is the independent
 * measurement, and it needs nothing on `PATH`.
 */
function wavDurationMs(path) {
  const wav = readFileSync(path);
  if (
    wav.subarray(0, 4).toString("ascii") !== "RIFF" ||
    wav.subarray(8, 12).toString("ascii") !== "WAVE"
  ) {
    throw new Error(`${path} is not a RIFF/WAVE file`);
  }
  let offset = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.subarray(offset, offset + 4).toString("ascii");
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      byteRate = wav.readUInt32LE(offset + 16);
    } else if (id === "data") {
      dataBytes = Math.min(size, wav.length - offset - 8);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (byteRate === 0 || dataBytes === 0) {
    throw new Error(`${path} has no fmt or data chunk`);
  }
  return (dataBytes / byteRate) * 1000;
}

/**
 * Call one tool and return its structured result, refusing a tool error.
 *
 * The refusal is read **before** anything is parsed. A tool that fails answers with prose in
 * `content[0].text` and no structured content at all, so parsing first turns "explainer_create
 * refused: ENOENT …" — the sentence that says what is missing from the payload — into a JSON syntax
 * error about the letter E, and the gate then reports the wrong failure.
 */
async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  if (result.isError === true) {
    throw new Error(`${name} refused: ${text === "" ? JSON.stringify(result) : text}`);
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${name} answered with content this gate cannot read as JSON: ${text.slice(0, 400)}`,
    );
  }
}

/**
 * Poll `explainer_job` to a conclusion, recording every state this run actually saw.
 *
 * The first poll goes out with no delay and the next few follow immediately, because `queued` is a
 * state a job leaves in milliseconds: sleeping first is how a poller misses it and then reports a
 * sequence P1-5 does not describe.
 */
async function pollJob(client, jobId, jobType) {
  const started = Date.now();
  const sequence = [];
  let polls = 0;
  let last = null;

  for (;;) {
    polls += 1;
    const job = await callTool(client, "explainer_job", {
      job_id: jobId,
      output_lines: OUTPUT_LINES,
    });
    const elapsed = ((Date.now() - started) / 1000).toFixed(2);
    if (job.status !== last) {
      sequence.push(job.status);
      observed.push(`${jobType}#${jobId}:${job.status}`);
      say(`  job ${jobId} ${jobType}: observed "${job.status}" at poll ${polls}, t+${elapsed}s`);
      last = job.status;
    }
    if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
      say(
        `  job ${jobId} finished ${job.status} with exit code ${job.exit_code} after ${elapsed}s`,
      );
      for (const line of job.output.lines.slice(-QUOTED_LINES)) {
        say(`    | ${line}`);
      }
      if (job.status !== "done") {
        throw new Error(
          `job ${jobId} (${jobType}) ended ${job.status}: ${job.error ?? "no message"}`,
        );
      }
      return { job, sequence };
    }
    if (Date.now() - started > NARRATE_TIMEOUT_MS) {
      throw new Error(
        `job ${jobId} (${jobType}) was still ${job.status} after ${NARRATE_TIMEOUT_MS} ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, polls < 8 ? 20 : 500));
  }
}

/** Enqueue one job, then poll it, asserting the sequence P1-5 requires. */
async function runJob(client, name, args) {
  const queued = await callTool(client, name, args);
  say(`  ${name} queued job ${queued.job_id}: ${queued.what}`);
  observed.push(`${name}#${queued.job_id}:${queued.status}(from ${name})`);
  const finished = await pollJob(client, queued.job_id, name);
  const seen = [queued.status, ...finished.sequence].filter(
    (status, index, all) => index === 0 || status !== all[index - 1],
  );
  check(
    seen.join(" → ") === "queued → running → done",
    `${name} went queued → running → done (P1-5), observed ${seen.join(" → ")}`,
  );
  return finished.job;
}

/** The two files that make up the launch contract, as absolute paths under the moved artefact. */
function launchPaths(runtimeDir) {
  const manifest = JSON.parse(readFileSync(join(runtimeDir, "runtime.manifest.json"), "utf8"));
  return {
    manifest,
    interpreter: join(runtimeDir, manifest.launch.interpreter),
    entry: join(runtimeDir, manifest.launch.entry),
  };
}

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(LOG_PATH, "");

  say(`xplainer runtime gate — ${stamp()}`);
  say(`  repository:  ${REPO}`);
  say(`  node:        ${process.version} (${process.platform} ${process.arch})`);
  say(`  artifacts:   ${ARTIFACTS}`);

  section("build");
  const built = run(PNPM_BUILD.command, PNPM_BUILD.args, {
    cwd: REPO,
    shell: PNPM_BUILD.shell,
  });
  for (const line of built.trim().split("\n").slice(-4)) {
    say(`  ${line}`);
  }
  check(existsSync(CLI), `the CLI is built at ${CLI}`);

  section("assemble, inside the checkout");
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE_ROOT, { recursive: true });
  const staged = join(STAGE, "runtime");
  const assembled = runLogged(
    "build",
    process.execPath,
    [CLI, "runtime", "build", "--out", staged],
    {
      cwd: REPO,
    },
  );
  for (const line of assembled.trim().split("\n")) {
    say(`  ${line}`);
  }
  check(!outsideCheckout(staged), `the artefact was assembled inside the checkout, at ${staged}`);

  section("move, outside the checkout");
  // `realpathSync`, because macOS answers `os.tmpdir()` with `/var/folders/…` and resolves it to
  // `/private/var/folders/…` the moment a process reports its own `execPath`. Canonicalising here
  // means every path this run prints, passes in the environment and asserts against is the one
  // form, rather than two forms that have to be compared through a resolver at every use.
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "xplainer-runtime-gate-")));
  const runtimeDir = join(scratch, "artefact", "runtime");
  const how = moveDirectory(staged, runtimeDir);
  say(`  moved by ${how}`);
  check(
    outsideCheckout(runtimeDir),
    `the artefact now lives outside the checkout, at ${runtimeDir}`,
  );
  check(
    !existsSync(staged),
    "nothing was left behind at the staging path, so what runs below is the moved copy",
  );

  const launch = launchPaths(runtimeDir);
  say(`  interpreter: ${launch.interpreter}`);
  say(`  entry:       ${launch.entry}`);
  say(
    `  payload:     ${launch.manifest.packages.length} packages, ${launch.manifest.files.length} files, ` +
      `node ${launch.manifest.node_version}, npm ${launch.manifest.npm_version}`,
  );
  check(existsSync(launch.interpreter), "the launch contract's interpreter exists after the move");
  check(existsSync(launch.entry), "the launch contract's entry exists after the move");

  section("a machine with no node");
  const paths = {
    emptyBin: join(scratch, "empty-bin"),
    home: join(scratch, "home"),
    temp: join(scratch, "temp"),
    state: join(scratch, "state"),
    videos: join(scratch, "videos"),
    fixtures: join(scratch, "fixtures"),
  };
  for (const directory of [paths.emptyBin, paths.home, paths.temp, paths.state, paths.videos]) {
    mkdirSync(directory, { recursive: true });
  }
  const env = scrubbedEnvironment(paths);
  say(`  PATH:        ${env.PATH}`);
  say(`  environment: ${Object.keys(env).sort().join(", ")}`);
  check(
    nodeOnPath(env.PATH) === null,
    `nothing on that PATH resolves node (${nodeNames().join(", ")})`,
  );
  check(
    env.NODE_PATH === undefined && env.NODE_OPTIONS === undefined,
    "the environment carries no NODE_PATH and no NODE_OPTIONS, so nothing can widen the resolver",
  );
  check(
    outsideCheckout(paths.home) && outsideCheckout(paths.videos),
    "the working directory and the workspace are both outside the checkout",
  );
  if (process.platform !== "win32") {
    const resolved = spawnSync(
      "/usr/bin/env",
      ["-i", `PATH=${env.PATH}`, "/bin/sh", "-c", "command -v node"],
      {
        encoding: "utf8",
      },
    );
    check(
      resolved.status !== 0,
      `env -i PATH=<empty> sh -c 'command -v node' exits ${resolved.status} and prints ` +
        `${JSON.stringify((resolved.stdout ?? "").trim())}: a \`#!/usr/bin/env node\` shebang run ` +
        "on this PATH is §7.13's exit 127, which is why nothing below is started through one",
    );
  }
  const probed = runLogged("probe", launch.interpreter, ["-p", "process.execPath"], {
    cwd: paths.home,
    env,
  }).trim();
  check(
    probed === launch.interpreter,
    `the artefact's own interpreter runs under that environment and reports itself as ${probed}`,
  );

  section("verify, from where it now is");
  const verified = runLogged(
    "verify",
    launch.interpreter,
    [launch.entry, "runtime", "verify", runtimeDir],
    { cwd: paths.home, env },
  );
  say(`  ${verified.trim()}`);

  section("fixtures");
  const narration = writeFixtures(paths.fixtures);
  const clipsMs = SEGMENTS.reduce((total, segment) => total + segment.seconds * 1000, 0);
  const spokenWords = SEGMENTS.reduce(
    (total, segment) => total + wordSpans(segment.text, segment.seconds).length,
    0,
  );
  say(`  fixtures:    ${paths.fixtures}`);
  for (const segment of SEGMENTS) {
    say(
      `    "${segment.id}": ${segment.seconds.toFixed(2)} s at ${segment.frequency} Hz, ${JSON.stringify(segment.text)}`,
    );
  }

  section("mcp stdio, out of the artefact");
  const transport = new StdioClientTransport({
    command: launch.interpreter,
    args: [launch.entry, "mcp"],
    cwd: paths.home,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "xplainer-runtime-gate", version: "1.0.0" });
  await client.connect(transport);
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim() !== "") {
        appendFileSync(LOG_PATH, `  [mcp] ${line}\n`);
      }
    }
  });

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  say(`  tools:       ${names.join(", ")}`);
  check(tools.length === 8, `the artefact offers all eight tools over stdio, saw ${tools.length}`);
  check(
    names.includes("explainer_still") && names.includes("explainer_render"),
    "explainer_still and explainer_render are offered and are deliberately not called here: they " +
      "need payload 2 and the toolchain, which are T33 in B6",
  );

  section("create");
  const created = await callTool(client, "explainer_create", { slug: SLUG });
  say(`  created:     ${created.created.join(", ")}`);
  say(`  write to:    ${created.write_source_to}`);

  // The expected list is read out of the artefact's own copy of the contract manifest — the file
  // the process could not have started without — rather than restated here.
  const manifestPath = join(
    runtimeDir,
    "lib/node_modules/@xplainer/protocol/schemas/manifest.json",
  );
  check(existsSync(manifestPath), "the artefact carries protocol/schemas/manifest.json");
  const engineOwned = JSON.parse(readFileSync(manifestPath, "utf8")).engine_owned_files;
  check(
    created.created.join(",") === [...engineOwned, "Scenes.tsx"].join(","),
    `explainer_create scaffolded ${created.created.length} files, in the manifest's own order`,
  );

  // Both `import.meta.url` payload sites, compared byte for byte against the artefact's copies:
  // `dist/scaffold/templates/*.txt` for the six scaffold files, `template/` for the four workspace
  // files. This is what makes "it read them from inside the payload" an assertion.
  const scaffoldTemplates = join(
    runtimeDir,
    "lib/node_modules/@xplainer/render-core/dist/scaffold/templates",
  );
  const workspaceTemplates = join(runtimeDir, "lib/node_modules/@xplainer/render-core/template");
  for (const name of created.created) {
    const wrote = readFileSync(join(created.write_source_to, name));
    const template = readFileSync(join(scaffoldTemplates, `${name}.txt`));
    check(
      Buffer.compare(wrote, template) === 0,
      `${name} is byte-identical to the artefact's dist/scaffold/templates/${name}.txt`,
    );
  }
  for (const name of ["package.json", "remotion.config.ts", "tailwind.css", "tsconfig.json"]) {
    const wrote = readFileSync(join(paths.videos, name));
    const template = readFileSync(join(workspaceTemplates, name));
    check(
      Buffer.compare(wrote, template) === 0,
      `the workspace's ${name} is byte-identical to the artefact's template/${name}`,
    );
  }

  section("put_source");
  const written = await callTool(client, "explainer_put_source", {
    slug: SLUG,
    files: SOURCE_FILES,
  });
  say(`  wrote:       ${written.written.join(", ")}`);
  check(
    written.written.join(",") === SOURCE_FILES.map((file) => file.path).join(","),
    "explainer_put_source wrote both agent-owned files and nothing else",
  );
  for (const file of SOURCE_FILES) {
    check(
      readFileSync(join(created.write_source_to, file.path), "utf8") === file.content,
      `${file.path} is on disk with the bytes the tool was given`,
    );
  }

  section("narrate");
  const job = await runJob(client, "explainer_narrate", { slug: SLUG, narration });
  const log = job.output.lines.join("\n");
  check(
    log.includes(`recorded speech from ${paths.fixtures} (XPLAINER_TTS_FIXTURE)`),
    "the narration worker says its speech came from the fixture directory, not from a server",
  );

  section("what it wrote");
  const publicDir = join(paths.videos, "public", SLUG);
  const timings = JSON.parse(readFileSync(join(publicDir, "timings.json"), "utf8"));
  const captions = JSON.parse(readFileSync(join(publicDir, "captions.json"), "utf8"));
  const audio = join(publicDir, timings.audio);
  say(
    `  timings:     ${timings.segments.length} segments, ${timings.durationInFrames} frames at ` +
      `${timings.fps} fps, ${timings.totalMs.toFixed(2)} ms`,
  );
  for (const segment of timings.segments) {
    say(
      `    segment ${segment.index} "${segment.id}": frames ${segment.from}..` +
        `${segment.from + segment.durationInFrames - 1} (${segment.startMs.toFixed(0)}–${segment.endMs.toFixed(0)} ms)`,
    );
  }
  say(`  wav:         ${audio} (${statSync(audio).size} bytes)`);

  check(
    statSync(audio).size > 44,
    "narration.wav is a file with samples in it, not an empty header",
  );
  const measured = wavDurationMs(audio);
  const drift = Math.abs(measured - timings.totalMs);
  say(
    `  narration.wav is ${measured.toFixed(3)} ms; timings.json says ${timings.totalMs.toFixed(3)} ms ` +
      `(drift ${drift.toFixed(3)} ms)`,
  );
  check(
    drift < 1,
    `timings.json total equals the WAV duration within 1 ms (drift ${drift.toFixed(3)} ms)`,
  );

  // The length this track must have if every recorded clip really travelled into it: the lead-in,
  // then each clip with the gap that follows it, then the tail. `plan.ts` gives every segment its
  // own trailing gap rather than only putting one between two segments, and quantises every silence
  // to whole samples, so at 24 kHz these milliseconds are exact rather than approximate.
  const expectedMs = LEAD_IN_MS + clipsMs + GAP_MS * SEGMENTS.length + TAIL_MS;
  say(
    `  expected:    ${expectedMs} ms — ${LEAD_IN_MS} lead-in, ${clipsMs} of recorded clips, ` +
      `${GAP_MS} × ${SEGMENTS.length} gap, ${TAIL_MS} tail`,
  );
  check(
    Math.abs(timings.totalMs - expectedMs) < 1,
    `the track is ${timings.totalMs.toFixed(2)} ms: both recorded clips and the pacing around ` +
      "them, and nothing invented",
  );
  check(
    timings.fps === FPS &&
      timings.durationInFrames === Math.round((timings.totalMs / 1000) * timings.fps),
    `${timings.durationInFrames} frames at ${timings.fps} fps is the track's own length in frames`,
  );
  check(
    timings.segments.map((segment) => segment.id).join(",") ===
      SEGMENTS.map((segment) => segment.id).join(","),
    "timings.json names both segments, in narration order",
  );
  check(
    timings.segments[0].startMs === LEAD_IN_MS,
    `the first segment starts at ${LEAD_IN_MS} ms, after the lead-in silence`,
  );
  check(
    timings.segments.every(
      (segment, index) => index === 0 || segment.startMs === timings.segments[index - 1].endMs,
    ),
    "each segment starts exactly where the one before it ended, so the track has no hole in it",
  );
  check(
    timings.segments[timings.segments.length - 1].endMs === timings.totalMs - TAIL_MS,
    `the tail's ${TAIL_MS} ms of silence closes the track after the last segment`,
  );
  check(
    captions.length === spokenWords,
    `captions.json carries one caption per spoken word (${captions.length} of ${spokenWords})`,
  );
  check(
    captions.every((caption) => caption.timestampMs >= 0 && caption.timestampMs <= timings.totalMs),
    "every caption lands inside the track it was measured against",
  );

  const listed = await callTool(client, "explainer_list", {});
  const summary = listed.videos.find((video) => video.slug === SLUG);
  say(`  explainer_list: ${JSON.stringify(summary)}`);
  check(summary?.has_narration === true, "explainer_list reports the video as narrated");
  check(
    summary?.rendered === false,
    "and as not rendered: this gate stops before still and render, which are T33 in B6",
  );

  section("shutdown");
  await client.close();
  const reverified = runLogged(
    "verify",
    launch.interpreter,
    [launch.entry, "runtime", "verify", runtimeDir],
    { cwd: paths.home, env },
  );
  say(`  ${reverified.trim()}`);
  check(
    reverified.includes("matches its manifest"),
    "the artefact still matches its manifest afterwards: the run wrote nothing into the payload",
  );

  say("");
  say(`observed job states, in order: ${observed.join(", ")}`);
  say(`transcript: ${LOG_PATH}`);
  say(`RUNTIME GATE PASSED — ${stamp()}`);
}

main().then(
  () => {
    if (scratch !== null) {
      rmSync(scratch, { recursive: true, force: true });
    }
    rmSync(STAGE_ROOT, { recursive: true, force: true });
    process.exit(0);
  },
  (error) => {
    const message = error instanceof Error ? error.message : String(error);
    try {
      say("");
      say(`RUNTIME GATE FAILED: ${message}`);
      if (scratch !== null) {
        say(`  the scratch directory is left at ${scratch} for inspection`);
      }
    } catch {
      process.stderr.write(`RUNTIME GATE FAILED: ${message}\n`);
    }
    process.exit(1);
  },
);
