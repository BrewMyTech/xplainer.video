/**
 * The walking skeleton, walked: one real video, produced through the MCP tools, on this machine.
 *
 * This is roadmap **P1-1**, and the only place in the repository where every phase-1 piece is
 * exercised at once and against nothing fake:
 *
 * - a real `xplainer setup` in a scratch state directory — the headless shell and the pinned ffmpeg
 *   from the reviewed manifest this checkout commits, and the Kokoro server recorded as the
 *   `--tts-url` speech route;
 * - a real `xplainer serve` in that same state directory, reached the way an agent reaches it —
 *   `xplainer mcp --attach` over the daemon's unix socket, carrying no URL and no token;
 * - a real `@modelcontextprotocol/sdk` client driving `explainer_create → explainer_put_source →
 *   explainer_narrate → explainer_still → explainer_render`, polling `explainer_job` between them;
 * - real speech from a Kokoro container (**P1-3**), so every scene length is measured rather than
 *   estimated (**P1-2**);
 * - `ffprobe` on the finished MP4, and an `ffmpeg` frame extract compared against the same frame of
 *   a captions-disabled render, which is what makes "with burned captions" a measurement.
 *
 * **Why it pays for a whole `setup` on every run.** Batch 6 put a gate in front of
 * `explainer_still` and `explainer_render`: the daemon reads `<state>/toolchain.json` at the moment
 * a job leaves the queue and refuses by name when what `setup` recorded is not on the machine
 * (`apps/cli/src/setup/toolchain.ts`) — the browser and speech for both, and for a render an
 * ffmpeg as well (ADR 0031 §Note, 2026-11-12, D12). There is no honest shortcut past it:
 * `recordTestToolchain` in `apps/cli/src/setup/testing/` is excluded from the build on purpose and
 * must never ship, and writing a marker from here would be this gate asserting its own
 * precondition. So the proof runs the command the product tells a user to run, and pays what a
 * user pays: a ~100–130 MB browser and the platform's ffmpeg — 2 MB from our CDN on macOS, a
 * 153 MB BtbN `.tar.xz` on Linux. Until 2026-11-12 it also paid for the render workspace's
 * `npm ci`, which left with the previous renderer's payload 2.
 *
 * **The browser `setup` acquires is the browser the render uses.** The render worker launches
 * `toolchain.json`'s `chrome.path` and nothing else, so one headless shell serves the still, the
 * render and the control, and nothing is downloaded during a render. Until 2026-11-11 the previous
 * renderer fetched a second copy of the same build into a cache of its own, which this script
 * borrowed from the checkout to keep the download out of the measurement; the second copy and the
 * borrowing went together. **The ffmpeg `setup` acquires is the ffmpeg that encodes**: the worker
 * takes `XPLAINER_FFMPEG` when it is set and the marker's `ffmpeg.path` otherwise, and never looks
 * on `PATH` (D6), so this script removes `XPLAINER_FFMPEG` from everything it starts and asserts
 * that the render's `done` event — the last line of its log — names the recorded path.
 *
 * **Nothing in it is specific to *either POSIX platform*.** It resolves its own `ffmpeg` and
 * `ffprobe` — the tools it reads the MP4 back with, never handed to the daemon, and from the
 * system because our macOS build ships no `ffprobe` — from `PATH`, and takes every other
 * coordinate from the environment: P1-1 is judged on macOS **and** on headless Linux, and one
 * script settles both. The Linux half runs this same file inside the
 * container `infra/e2e/Dockerfile` builds — see `scripts/e2e/linux.mjs`, which is
 * `pnpm e2e:render:linux`.
 *
 * **It is not Windows-capable, and this is the list.** Worth writing down rather than discovering
 * on a runner, because the two faults that *would* have made a Windows dispatch fail silently — a
 * `runLogged` that never read `result.error`, and a spawn of the previous renderer's extensionless
 * `.bin` shim that `CreateProcess` refuses — were fixed on 2026-09-11 and moved into
 * `scripts/e2e/spawn.mjs`. What
 * is left fails loudly, by name, in the first seconds of a run: {@link resolveTool} spawns
 * `/usr/bin/which`, which does not exist there; the `pnpm turbo build` below is spawned as a bare
 * `pnpm`, and a `pnpm.cmd` is what libuv refuses without `shell: true` since the CVE-2024-27980 fix
 * (`runtime.mjs` and `speech.mjs` both carry a `PNPM_BUILD` for exactly this). A Windows leg would also need a Kokoro this proof can reach, which is a decision about what P1-1
 * claims rather than a portability fix. `pnpm e2e:speech` is the proof that runs on all three.
 *
 * **It is not part of `pnpm verify`, and it must not become part of it.** It needs Docker, a
 * multi-gigabyte model container and several minutes of Chrome; a gate that cannot run on a
 * developer's machine or in CI is a gate that gets disabled. The suites under `apps/cli` cover the
 * same code paths against recorded speech and are what CI runs. This script is the periodic proof
 * that the recording still matches the world.
 *
 * Run it on the host:
 *
 * ```bash
 * docker run -d --rm --name xplainer-e2e-kokoro -p 127.0.0.1:8880:8880 \
 *   ghcr.io/remsky/kokoro-fastapi-cpu:latest
 * pnpm e2e:render
 * docker stop xplainer-e2e-kokoro
 * ```
 *
 * Or on Linux in Docker, with the Kokoro container and the teardown handled for you:
 *
 * ```bash
 * pnpm e2e:render:linux
 * ```
 *
 * Environment it reads: `XPLAINER_TTS_URL` (default `http://127.0.0.1:8880`),
 * `XPLAINER_TTS_WAIT_MS` (default `120000`), `COLLIE_ARTIFACTS_DIR` (default
 * `<repo>/.session/artifacts`), `XPLAINER_FFMPEG` and `XPLAINER_FFPROBE` (default: whatever is on
 * `PATH`) for this script's own reads — and `XPLAINER_FFMPEG` only for that: it is removed from
 * the environment `setup`, the daemon and the shim are given.
 *
 * Everything it prints is also written to `<artifacts>/e2e-render.log`, line by line as it happens,
 * so a run that dies mid-render still leaves its transcript behind.
 */

import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { transcript, workerStill } from "./spawn.mjs";

/** The repository root, three levels up from this file. */
const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** The built CLI. `pnpm turbo build` below is what guarantees it is this commit's. */
const CLI = join(REPO, "apps", "cli", "dist", "bin.js");

/**
 * The reviewed manifest this checkout commits, which is what `setup --manifest` names.
 *
 * Named rather than left to the default, because the version-2 document this build reads is
 * uploaded to `cdn.xplainer.video/toolchain/v2/manifest.json` as a release step, and until then a
 * run without it would ask that address for a document that is not there. A proof also has no
 * business checking a published copy instead of the one under review. `scripts/e2e/toolchain.mjs`
 * names the same file.
 */
const MANIFEST = join(REPO, "apps", "cli", "src", "setup", "toolchain.manifest.json");

/**
 * How long `setup` may take.
 *
 * Generous by two orders of magnitude on purpose: on a fast link the browser and ffmpeg arrive in
 * seconds, and on a cold CI runner they are a ~130 MB browser and a 153 MB `.tar.xz` decoded in
 * process. What this bound is for is a hung download, not a slow one.
 */
const SETUP_TIMEOUT_MS = 1_800_000;

/** Where the Kokoro container answers. */
const TTS_URL = (process.env.XPLAINER_TTS_URL ?? "").trim() || "http://127.0.0.1:8880";

/**
 * How long {@link requireKokoro} waits for that container.
 *
 * A knob because the two ways this script is started wait for different things. Run by hand, the
 * container is already up and this is a precondition check that should fail fast with the command
 * that starts one; run by `scripts/e2e/linux.mjs`, the container was created seconds ago and its
 * voice pack takes minutes, so that wrapper passes its own budget. That is the whole reason it
 * needs no separate readiness probe of its own.
 */
const TTS_WAIT_MS = Number.parseInt(process.env.XPLAINER_TTS_WAIT_MS ?? "", 10) || 120_000;

/** Where the transcript and the sample MP4 are left for a human to look at. */
const ARTIFACTS =
  (process.env.COLLIE_ARTIFACTS_DIR ?? "").trim() || join(REPO, ".session/artifacts");

/** The video this script builds. */
const SLUG = "walking-skeleton";

/** The control render: the same video with the caption layer taken out. */
const CONTROL_SLUG = "walking-skeleton-nocaptions";

/** How long each job may take before the script gives up on it. */
const JOB_TIMEOUT_MS = {
  explainer_narrate: 600_000,
  explainer_still: 900_000,
  explainer_render: 1_800_000,
};

/** How long to wait for `serve` to announce readiness. */
const READY_TIMEOUT_MS = 60_000;

/** How many log lines to ask `explainer_job` for, and how many of them to quote. */
const OUTPUT_LINES = 200;
const QUOTED_LINES = 12;

/**
 * The two-scene narration. Real sentences, because the point is measured speech: a placeholder
 * would produce word spans of a shape Kokoro never actually returns.
 */
const NARRATION = {
  voice: "af_heart",
  fps: 30,
  segments: [
    {
      id: "hook",
      text: "Every explainer video starts the same way: a script, a timeline, and an afternoon of dragging clips around.",
    },
    {
      id: "answer",
      text: "xplainer measures the narration first, so every scene length comes from the speech itself, never from a number you guessed.",
    },
  ],
};

/**
 * The agent's half of the video: one component per narration segment id, and one component under
 * `scenes/` that they share. Nothing here touches an engine-owned file — `Video.tsx`, `Root.tsx`,
 * `Captions.tsx`, `index.ts` and `types.ts` are written by `explainer_create` and refused by
 * `explainer_put_source`, which is the ownership boundary this script also exercises.
 */
const SOURCE_FILES = [
  {
    path: "Scenes.tsx",
    content: `import { useCurrentFrame } from "@xplainer/motion";
import type { SceneMap } from "./Video";
import { Panel } from "./scenes/Panel";

const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Panel
      accent="#4C8DFF"
      kicker="the old way"
      title="A script, a timeline, an afternoon"
      body="Writing the words is the easy part. Assembling the video is what costs the day."
      frame={frame}
    />
  );
};

const Answer: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Panel
      accent="#F2B33D"
      kicker="the xplainer way"
      title="Measured speech, then scenes"
      body="Every duration comes from the narration the engine measured, never from a number you chose."
      frame={frame}
    />
  );
};

export const scenes: SceneMap = { hook: Hook, answer: Answer };
`,
  },
  {
    path: "scenes/Panel.tsx",
    content: `import { AbsoluteFill, interpolate } from "@xplainer/motion";

export const Panel: React.FC<{
  accent: string;
  kicker: string;
  title: string;
  body: string;
  frame: number;
}> = ({ accent, kicker, title, body, frame }) => {
  const rise = interpolate(frame, [0, 18], [48, 0], { extrapolateRight: "clamp" });
  const fade = interpolate(frame, [0, 18], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#0A0C10",
        justifyContent: "center",
        padding: "0 160px 260px",
        opacity: fade,
        transform: \`translateY(\${rise}px)\`,
      }}
    >
      <div style={{ color: accent, fontSize: 34, fontWeight: 700, letterSpacing: 6, textTransform: "uppercase" }}>
        {kicker}
      </div>
      <div style={{ color: "#E6EAF2", fontSize: 96, fontWeight: 800, lineHeight: 1.1, marginTop: 24 }}>
        {title}
      </div>
      <div style={{ color: "#8A94A8", fontSize: 44, fontWeight: 500, lineHeight: 1.4, marginTop: 32, maxWidth: 1300 }}>
        {body}
      </div>
      <div style={{ backgroundColor: accent, height: 10, width: 220, marginTop: 48, borderRadius: 5 }} />
    </AbsoluteFill>
  );
};
`,
  },
];

/**
 * The caption layer, disabled.
 *
 * The control render cannot go through `explainer_still`: the daemon runs `scaffoldVideo()` in the
 * moment before Chrome starts (ADR 0018, layer 4), so an engine-owned file edited on disk is put
 * back before it can affect a frame. That guard is the product working as designed, and stepping
 * around it is exactly what a control has to do — so the control is rendered by the product's own
 * render worker spawned directly, which is the renderer `explainer_still` uses without the factory
 * in front of it (`workerStill` in `scripts/e2e/spawn.mjs`).
 */
const CAPTIONS_DISABLED = `export const Captions: React.FC<{ captions: unknown[] }> = () => null;
`;

/** The band of the frame the caption box occupies, and a band of the same size that it never can. */
const CAPTION_BAND = { width: 1480, height: 190, x: 220, y: 820 };
const CONTROL_BAND = { width: 1480, height: 190, x: 220, y: 120 };

/** A grey level two frames must differ by before the pixel counts as changed. */
const CHANGED_LEVEL = 24;

/**
 * How much of the caption band a burned-in caption has to move, and how still the rest of the
 * frame has to be.
 *
 * The number is small on purpose, because the thing on screen is *text*. `Captions.tsx` draws its
 * line on a `rgba(10, 12, 16, 0.78)` plate over a `#0A0C10` scene — the same colour — so the plate
 * itself is invisible and the only pixels that can move are the glyphs. One line of 48 px type
 * across the middle of a 1480×190 band inks something like a twentieth of it, which is what a
 * measured run reports (3.9%). A quarter of that is a caption that is unmistakably there; anything
 * at all in the *control* band would mean the two renders differ for some reason other than the
 * captions, and then the comparison would be proving nothing.
 */
const CAPTION_BAND_MIN_CHANGE = 0.01;
const CONTROL_BAND_MAX_CHANGE = 0.005;

/** Where the transcript is written, line by line. */
const LOG_PATH = join(ARTIFACTS, "e2e-render.log");

/** Every status this run saw, in order, for the summary at the end. */
const observed = [];

/** Directories to remove when the run succeeds. */
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

/** Both streams into the transcript, and a child that never started named as such. */
const { runLogged } = transcript(LOG_PATH);

/** Resolve a tool by explicit override, then by `PATH`. */
function resolveTool(name, override) {
  const configured = (override ?? "").trim();
  if (configured !== "") {
    return configured;
  }
  const found = run("/usr/bin/which", [name]).trim();
  if (found === "") {
    throw new Error(`${name} is not on PATH; set XPLAINER_${name.toUpperCase()} to its path.`);
  }
  return found;
}

const ffmpeg = resolveTool("ffmpeg", process.env.XPLAINER_FFMPEG);
const ffprobe = resolveTool("ffprobe", process.env.XPLAINER_FFPROBE);

/** One `ffprobe` field of one stream, as a string. */
function probeStream(path, stream, field) {
  return run(ffprobe, [
    "-v",
    "error",
    "-select_streams",
    stream,
    "-show_entries",
    `stream=${field}`,
    "-of",
    "default=nw=1:nk=1",
    path,
  ]).trim();
}

/**
 * One band of one frame, as raw 8-bit grey.
 *
 * Piped as `rawvideo` rather than written to a file so the bytes compared are the bytes ffmpeg
 * produced, and `-fps_mode passthrough` so the one selected frame is not duplicated to fill a rate.
 * The same function reads a frame out of the MP4 and a frame out of the control PNG, which is what
 * makes the two comparable pixel for pixel.
 */
function band(path, region, frame) {
  const crop = `crop=${region.width}:${region.height}:${region.x}:${region.y}`;
  const filters =
    frame === null ? `${crop},format=gray` : `select=eq(n\\,${frame}),${crop},format=gray`;
  const raw = execFileSync(
    ffmpeg,
    [
      "-v",
      "error",
      "-i",
      path,
      "-vf",
      filters,
      "-fps_mode",
      "passthrough",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const expected = region.width * region.height;
  if (raw.length !== expected) {
    throw new Error(`${path}: expected ${expected} bytes of band, got ${raw.length}`);
  }
  return raw;
}

/** The share of a band whose grey level moved by more than {@link CHANGED_LEVEL}. */
function changedShare(a, b) {
  let changed = 0;
  for (let index = 0; index < a.length; index += 1) {
    if (Math.abs(a[index] - b[index]) > CHANGED_LEVEL) {
      changed += 1;
    }
  }
  return changed / a.length;
}

function percent(share) {
  return `${(share * 100).toFixed(3)}%`;
}

/**
 * The duration of a 16-bit PCM WAV, from its own header.
 *
 * Read here rather than asked of ffprobe because the claim being tested is that `timings.json`
 * agrees with the file the narration port wrote, and ffprobe would answer from the same container
 * metadata the writer produced. Walking the chunk list is the independent measurement.
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
 * Wait until Kokoro answers with a voice list, or say exactly how to start one.
 *
 * A server that has bound its port but not finished loading its voices answers `/v1/audio/voices`
 * with an empty list, so the readiness condition is a non-empty one — anything less lets the
 * narration start against a server that cannot speak yet. Every attempt keeps why it failed, so the
 * message at the deadline names the reason rather than only the address.
 */
async function requireKokoro() {
  const deadline = Date.now() + TTS_WAIT_MS;
  for (let attempt = 1; ; attempt += 1) {
    let described = "";
    try {
      const response = await fetch(`${TTS_URL}/v1/audio/voices`, {
        signal: AbortSignal.timeout(5000),
      });
      const voices = response.ok ? (await response.json()).voices : null;
      if (Array.isArray(voices) && voices.length > 0) {
        say(
          `  kokoro at ${TTS_URL} answers /v1/audio/voices with ${voices.length} voice(s), on attempt ${attempt}`,
        );
        return;
      }
      described = `HTTP ${response.status}`;
    } catch (error) {
      described = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `no Kokoro server at ${TTS_URL} after ${attempt} attempts (${described}). Start one with:\n` +
          "  docker run -d --rm --name xplainer-e2e-kokoro -p 127.0.0.1:8880:8880 " +
          "ghcr.io/remsky/kokoro-fastapi-cpu:latest",
      );
    }
    if (attempt % 10 === 0) {
      say(`  waiting for kokoro at ${TTS_URL} (attempt ${attempt}): ${described}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** Start `xplainer serve` and resolve on its one line of stdout. */
function startDaemon(env) {
  const child = spawn(process.execPath, [CLI, "serve", "--port", "0"], {
    cwd: REPO,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim() !== "") {
        appendFileSync(LOG_PATH, `  [daemon] ${line}\n`);
      }
    }
  });

  const ready = new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => {
      reject(new Error(`the daemon did not announce readiness within ${READY_TIMEOUT_MS} ms`));
    }, READY_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        appendFileSync(LOG_PATH, `  [daemon stdout] ${line}\n`);
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = null;
        }
        if (parsed !== null && parsed.event === "ready") {
          clearTimeout(timer);
          resolve(parsed);
        }
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(`the daemon exited before announcing readiness (code ${code}, signal ${signal})`),
      );
    });
  });

  return { child, ready };
}

/**
 * Call one tool and return its structured result, refusing a tool error.
 *
 * The refusal is read **before** anything is parsed. A tool that fails answers with prose in
 * `content[0].text` and no structured content at all, so parsing first turns the sentence that
 * says what is wrong into a JSON syntax error about its first character. Measured: the toolchain
 * gate's refusal opens with the marker's path, and this script reported it as `Unexpected token
 * '/', "/tmp/xplai"... is not valid JSON` — a message about the letter that named nothing.
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
 * The first poll goes out with no delay and the next few follow immediately, because `queued` is
 * a state a job leaves in milliseconds: sleeping first is how a poller misses it and then reports a
 * sequence P1-5 does not describe.
 */
async function pollJob(client, jobId, jobType) {
  const started = Date.now();
  const timeout = JOB_TIMEOUT_MS[jobType];
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
      const tail = job.output.lines.slice(-QUOTED_LINES);
      for (const line of tail) {
        say(`    | ${line}`);
      }
      if (job.status !== "done") {
        throw new Error(
          `job ${jobId} (${jobType}) ended ${job.status}: ${job.error ?? "no message"}`,
        );
      }
      return { job, sequence, polls };
    }
    if (Date.now() - started > timeout) {
      throw new Error(`job ${jobId} (${jobType}) was still ${job.status} after ${timeout} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, polls < 8 ? 20 : 500));
  }
}

/**
 * The worker's final `{"event":"done",…}` line, parsed, or `null` when the job's log has none.
 *
 * Read from the end, because the job keeps a sixty-line tail: a long render's progress lines push
 * the worker's start line — the one that names the encoder in prose — out of it, and the `done`
 * event, which names it as `ffmpeg: { path, source }`, is the last line the worker prints.
 */
function doneEvent(job) {
  const line = job.output.lines.findLast((entry) => entry.startsWith('{"event":"done"'));
  return line === undefined ? null : JSON.parse(line);
}

/**
 * Enqueue one job, then poll it, asserting the sequence P1-5 requires.
 *
 * The first `queued` is the enqueueing tool's own answer — the schema requires it to report that
 * state, and it is the only place `queued` can be *seen* for a job the runner starts within
 * milliseconds. Everything after it is `explainer_job`, which is the poll ADR 0008 defines. The
 * transcript keeps the two apart rather than blurring them into one sequence.
 */
async function runJob(client, name, args) {
  const queued = await callTool(client, name, args);
  say(`  ${name} queued job ${queued.job_id}: ${queued.what}`);
  say(`  ${name} answered status "${queued.status}", poll with ${queued.poll}`);
  observed.push(`${name}#${queued.job_id}:${queued.status}(from ${name})`);
  const finished = await pollJob(client, queued.job_id, name);
  const seen = [queued.status, ...finished.sequence].filter(
    (status, index, all) => index === 0 || status !== all[index - 1],
  );
  say(`  ${name} state sequence: ${seen.join(" → ")}`);
  check(
    seen.join(" → ") === "queued → running → done",
    `${name} went queued → running → done (P1-5), observed ${seen.join(" → ")}`,
  );
  return finished.job;
}

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(LOG_PATH, "");

  say(`xplainer end-to-end — ${stamp()}`);
  say(`  repository:  ${REPO}`);
  say(`  node:        ${process.version} (${process.platform} ${process.arch})`);
  say(`  ffmpeg:      ${ffmpeg}`);
  say(`  ffprobe:     ${ffprobe}`);
  say(`  artifacts:   ${ARTIFACTS}`);

  section("build");
  const built = run("pnpm", ["turbo", "build"], { cwd: REPO });
  for (const line of built.trim().split("\n").slice(-6)) {
    say(`  ${line}`);
  }
  check(existsSync(CLI), `the CLI is built at ${CLI}`);

  section("kokoro");
  await requireKokoro();

  section("setup");
  scratch = mkdtempSync(join(tmpdir(), "xplainer-e2e-"));
  const stateDir = join(scratch, "state");
  const workspace = join(scratch, "workspace");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  say(`  state dir:   ${stateDir}`);
  say(`  workspace:   ${workspace}`);

  // The provider level (ADR 0030) is removed rather than inherited: a shell left at
  // `XPLAINER_TTS_PROVIDER=elevenlabs` would send this proof's script to a paid service, and this
  // proof is about Kokoro speech at TTS_URL.
  // `XPLAINER_FFMPEG` goes too: it is this script's own reading tool, and in the daemon it would be
  // the override that wins over the ffmpeg `setup` records — the one this proof renders with.
  const {
    XPLAINER_TTS_PROVIDER: _provider,
    ELEVENLABS_API_KEY: _key,
    XPLAINER_FFMPEG: _encoder,
    ...inherited
  } = process.env;
  const env = {
    ...inherited,
    XPLAINER_STATE_DIR: stateDir,
    XPLAINER_VIDEOS_DIR: workspace,
    XPLAINER_TTS_URL: TTS_URL,
  };

  // The product's own command, with the product's own flags: the reviewed manifest this checkout
  // commits (the version-2 document is not uploaded until a release), and the Kokoro this proof
  // already needs recorded as the `--tts-url` speech route — which acquires nothing, and is the
  // route `e2e-linux.yml`'s `services:` block gives a runner.
  const setupStarted = Date.now();
  const setupOutput = runLogged(
    "setup",
    process.execPath,
    [CLI, "setup", "--state-dir", stateDir, "--manifest", MANIFEST, "--tts-url", TTS_URL],
    { cwd: REPO, env, timeout: SETUP_TIMEOUT_MS },
  );
  say(`  setup took ${((Date.now() - setupStarted) / 1000).toFixed(1)}s`);
  for (const line of setupOutput.trim().split("\n")) {
    say(`  ${line}`);
  }

  const markerPath = join(stateDir, "toolchain.json");
  check(existsSync(markerPath), `setup recorded ${markerPath}`);
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  check(
    existsSync(marker.chrome.path),
    `the browser it recorded is on this machine at ${marker.chrome.path}`,
  );
  check(
    marker.speech.provider === "url" && existsSync(marker.speech.path),
    `the speech route it recorded is the external server, receipted at ${marker.speech.path}`,
  );
  check(
    marker.ffmpeg?.provider === "manifest" && existsSync(marker.ffmpeg.path),
    `the ffmpeg it recorded is this platform's pinned build (${marker.ffmpeg?.version}, ` +
      `${marker.ffmpeg?.licence}), on this machine at ${marker.ffmpeg?.path}`,
  );

  section("daemon");
  const daemon = startDaemon(env);
  const announcement = await daemon.ready;
  say(`  ready line:  ${JSON.stringify(announcement)}`);
  check(typeof announcement.socket === "string", "the ready line names an IPC socket to attach to");
  check(existsSync(announcement.socket), `the socket exists at ${announcement.socket}`);

  section("mcp --attach");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp", "--attach"],
    cwd: REPO,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "xplainer-e2e", version: "1.0.0" });
  await client.connect(transport);
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim() !== "") {
        appendFileSync(LOG_PATH, `  [shim] ${line}\n`);
      }
    }
  });

  const { tools } = await client.listTools();
  say(`  tools:       ${tools.map((tool) => tool.name).join(", ")}`);
  check(tools.length === 8, `the attached daemon offers all eight tools, saw ${tools.length}`);

  section("create → put_source");
  const created = await callTool(client, "explainer_create", { slug: SLUG });
  say(`  created:     ${created.created.join(", ")}`);
  say(`  write to:    ${created.write_source_to}`);
  const written = await callTool(client, "explainer_put_source", {
    slug: SLUG,
    files: SOURCE_FILES,
  });
  say(`  wrote:       ${written.written.join(", ")}`);
  check(
    written.written.join(",") === "Scenes.tsx,scenes/Panel.tsx",
    "put_source wrote both agent-owned files and nothing else",
  );

  section("narrate");
  await runJob(client, "explainer_narrate", { slug: SLUG, narration: NARRATION });

  const publicDir = join(workspace, "public", SLUG);
  const timings = JSON.parse(readFileSync(join(publicDir, "timings.json"), "utf8"));
  const captions = JSON.parse(readFileSync(join(publicDir, "captions.json"), "utf8"));
  const audio = join(publicDir, timings.audio);
  say(
    `  timings:     ${timings.segments.length} segments, ${timings.durationInFrames} frames at ${timings.fps} fps, ${timings.totalMs.toFixed(2)} ms`,
  );
  say(`  captions:    ${captions.length} word-level captions`);
  for (const segment of timings.segments) {
    say(
      `    segment ${segment.index} "${segment.id}": frames ${segment.from}..${segment.from + segment.durationInFrames - 1} (${segment.startMs.toFixed(0)}–${segment.endMs.toFixed(0)} ms)`,
    );
  }

  const measured = wavDurationMs(audio);
  const drift = Math.abs(measured - timings.totalMs);
  say(
    `  narration.wav is ${measured.toFixed(3)} ms; timings.json says ${timings.totalMs.toFixed(3)} ms (drift ${drift.toFixed(3)} ms)`,
  );
  check(
    drift < 1,
    `timings.json total equals the WAV duration within 1 ms (drift ${drift.toFixed(3)} ms, P1-2)`,
  );
  check(captions.length > 0, "captions.json carries word-level captions");

  // The frame the caption proof is made on: the middle of a word roughly halfway through the
  // narration, so a caption page is certainly on screen and the frame is certainly inside a scene.
  const middle = captions[Math.floor(captions.length / 2)];
  const captionFrame = Math.floor((middle.timestampMs / 1000) * timings.fps);
  const inSegment = timings.segments.find(
    (segment) =>
      captionFrame >= segment.from && captionFrame < segment.from + segment.durationInFrames,
  );
  check(
    inSegment !== undefined,
    `frame ${captionFrame} (caption "${middle.text.trim()}" at ${middle.timestampMs} ms) is inside segment "${inSegment?.id ?? "none"}"`,
  );

  section("still");
  await runJob(client, "explainer_still", { slug: SLUG, frame: captionFrame, scale: 0.5 });
  const stillPath = join(workspace, "out", SLUG, `frame-${captionFrame}.png`);
  check(existsSync(stillPath), `explainer_still wrote ${stillPath}`);
  check(probeStream(stillPath, "v:0", "width") === "960", "the still is 960 wide at scale 0.5");
  check(probeStream(stillPath, "v:0", "height") === "540", "the still is 540 high at scale 0.5");

  section("render");
  const rendered = await runJob(client, "explainer_render", { slug: SLUG });
  const mp4 = join(workspace, "out", SLUG, "explainer.mp4");
  check(existsSync(mp4), `explainer_render wrote ${mp4}`);
  const encodedWith = doneEvent(rendered)?.ffmpeg;
  check(
    encodedWith?.path === marker.ffmpeg.path && encodedWith?.source === "toolchain.json",
    `the render's done event names the encoder it used: ${marker.ffmpeg.path} (toolchain.json) — ` +
      `it said ${JSON.stringify(encodedWith ?? null)}`,
  );

  const listed = await callTool(client, "explainer_list", {});
  const summary = listed.videos.find((video) => video.slug === SLUG);
  say(`  explainer_list: ${JSON.stringify(summary)}`);
  check(summary?.rendered === true, "explainer_list reports the video as rendered");
  check(summary?.has_narration === true, "explainer_list reports the video as narrated");
  // The path an agent would actually be handed, rather than one this script worked out for itself.
  check(
    summary?.mp4 === mp4,
    `explainer_list returns the MP4's path, and it is the file probed below`,
  );

  section("ffprobe");
  const probed = run(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "stream=index,codec_name,codec_type,width,height,r_frame_rate,duration,nb_frames,sample_rate,channels",
    "-show_entries",
    "format=format_name,duration,size",
    "-of",
    "default=noprint_wrappers=0",
    mp4,
  ]);
  for (const line of probed.trim().split("\n")) {
    say(`  ${line}`);
  }

  check(probeStream(mp4, "v:0", "width") === "1920", "the MP4 is 1920 wide");
  check(probeStream(mp4, "v:0", "height") === "1080", "the MP4 is 1080 high");
  check(probeStream(mp4, "v:0", "r_frame_rate") === "30/1", "the MP4 runs at 30/1 fps");
  check(probeStream(mp4, "v:0", "codec_name") === "h264", "the video stream is h264");
  check(probeStream(mp4, "a:0", "codec_name") === "aac", "the audio stream is aac");

  const videoSeconds = Number(probeStream(mp4, "v:0", "duration"));
  const durationDrift = Math.abs(videoSeconds * 1000 - timings.totalMs);
  say(
    `  video duration ${(videoSeconds * 1000).toFixed(2)} ms vs timings.json ${timings.totalMs.toFixed(2)} ms (drift ${durationDrift.toFixed(2)} ms)`,
  );
  check(
    durationDrift < 100,
    `the MP4 duration is within 100 ms of timings.json (drift ${durationDrift.toFixed(2)} ms)`,
  );
  check(
    Number(probeStream(mp4, "v:0", "nb_frames")) === timings.durationInFrames,
    `the MP4 has exactly timings.json's ${timings.durationInFrames} frames`,
  );

  section("burned captions");
  // The control: the same sources, the same measured narration, the same frame — with the caption
  // component replaced by one that draws nothing. Rendered by the product's own render worker,
  // spawned directly because the daemon restores an engine-owned file before every still: the same
  // bundler, browser and capture `explainer_still` used a moment ago, with only the factory's
  // restore stepped around. The worker is a script under this process's own interpreter, which is
  // spawnable on every platform; `scripts/e2e/spawn.mjs` carries both halves of that argument.
  const controlSource = join(workspace, "videos", CONTROL_SLUG);
  const controlPublic = join(workspace, "public", CONTROL_SLUG);
  cpSync(join(workspace, "videos", SLUG), controlSource, { recursive: true });
  cpSync(publicDir, controlPublic, { recursive: true });
  writeFileSync(join(controlSource, "Captions.tsx"), CAPTIONS_DISABLED, "utf8");
  const controlPng = workerStill({
    runLogged,
    label: "control",
    repo: REPO,
    workspace,
    stateDir,
    env,
    slug: CONTROL_SLUG,
    frame: captionFrame,
    scale: 1,
  });
  check(existsSync(controlPng), `the captions-disabled control rendered frame ${captionFrame}`);
  check(probeStream(controlPng, "v:0", "width") === "1920", "the control frame is 1920 wide");

  const captioned = band(mp4, CAPTION_BAND, captionFrame);
  const control = band(controlPng, CAPTION_BAND, null);
  const captionedElsewhere = band(mp4, CONTROL_BAND, captionFrame);
  const controlElsewhere = band(controlPng, CONTROL_BAND, null);

  const inCaptions = changedShare(captioned, control);
  const elsewhere = changedShare(captionedElsewhere, controlElsewhere);
  say(
    `  caption band  ${CAPTION_BAND.width}x${CAPTION_BAND.height} at (${CAPTION_BAND.x},${CAPTION_BAND.y}): ${percent(inCaptions)} of pixels differ`,
  );
  say(
    `  control band  ${CONTROL_BAND.width}x${CONTROL_BAND.height} at (${CONTROL_BAND.x},${CONTROL_BAND.y}): ${percent(elsewhere)} of pixels differ`,
  );
  check(
    inCaptions > CAPTION_BAND_MIN_CHANGE,
    `the MP4's caption band differs from the captions-disabled render (${percent(inCaptions)} of ` +
      `pixels, at least ${percent(CAPTION_BAND_MIN_CHANGE)} required): the captions are burned in`,
  );
  check(
    elsewhere < CONTROL_BAND_MAX_CHANGE,
    `everywhere else the two frames are the same picture (${percent(elsewhere)} of pixels differ), ` +
      "so the caption band is the only thing that changed",
  );
  check(
    inCaptions > elsewhere * 10,
    `that difference is the captions and not codec noise: ${percent(inCaptions)} in the caption ` +
      `band against ${percent(elsewhere)} elsewhere`,
  );

  section("artifacts");
  copyFileSync(mp4, join(ARTIFACTS, "e2e-sample.mp4"));
  copyFileSync(stillPath, join(ARTIFACTS, "e2e-still.png"));
  copyFileSync(controlPng, join(ARTIFACTS, "e2e-frame-nocaptions.png"));
  run(ffmpeg, [
    "-v",
    "error",
    "-y",
    "-i",
    mp4,
    "-vf",
    `select=eq(n\\,${captionFrame})`,
    "-fps_mode",
    "passthrough",
    "-frames:v",
    "1",
    join(ARTIFACTS, "e2e-frame-captioned.png"),
  ]);
  const megabytes = statSync(mp4).size / 1_048_576;
  say(
    `  e2e-sample.mp4 (${megabytes.toFixed(2)} MB), e2e-still.png, e2e-frame-captioned.png, e2e-frame-nocaptions.png`,
  );
  say(`  transcript:  ${LOG_PATH}`);

  section("shutdown");
  await client.close();
  const stopped = new Promise((resolve) => {
    daemon.child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
  daemon.child.kill("SIGTERM");
  const exited = await stopped;
  say(
    `  the daemon exited ${exited.code === null ? `on ${exited.signal}` : `with code ${exited.code}`}`,
  );
  check(exited.code === 0, "SIGTERM shut the daemon down cleanly (exit 0)");
  check(
    !existsSync(join(stateDir, "runtime.json")),
    "runtime.json is gone after the clean shutdown",
  );

  say("");
  say(`observed job states, in order: ${observed.join(", ")}`);
  say(`END-TO-END PASSED — ${stamp()}`);
}

main().then(
  () => {
    if (scratch !== null) {
      rmSync(scratch, { recursive: true, force: true });
    }
    process.exit(0);
  },
  (error) => {
    const message = error instanceof Error ? error.message : String(error);
    try {
      say("");
      say(`END-TO-END FAILED: ${message}`);
      if (scratch !== null) {
        say(`  the scratch directory is left at ${scratch} for inspection`);
      }
    } catch {
      process.stderr.write(`END-TO-END FAILED: ${message}\n`);
    }
    process.exit(1);
  },
);
