#!/usr/bin/env node
/**
 * The batch-6 toolchain gate: `xplainer setup`, and then `still → render` out of what it acquired.
 *
 * `scripts/e2e/runtime.mjs` proves payload 1 can create and narrate out of a relocated artefact and
 * deliberately stops there — its own transcript says `explainer_still` and `explainer_render` "need
 * payload 2 and the toolchain, which are T33 in B6". This is T33: that the one command in the
 * product which downloads can acquire a browser, record a speech route and materialise the render
 * workspace on a machine that behaves as though it has no Node, that what it wrote is what the
 * daemon then reads, and that **a picture comes out the other end**.
 *
 * Seven phases, and each one is a decision the plan took rather than a step in a script.
 *
 * **1 — the artefact.** `runtime build` assembles payload 1 inside the checkout and this script
 * moves it out, exactly as the runtime gate does. Everything after this point runs the artefact's
 * own interpreter and its own entry, under an environment built from nothing.
 *
 * **2 — D8, end to end.** `node` is asserted not to resolve for the parent process; then
 * `setup --workspace` is run under that scrubbed environment and must exit `0`. It cannot, unless
 * `<runtime>/bin` reaches the install subprocess's `PATH`: npm runs lifecycle scripts through
 * `sh -c` and `esbuild`'s `postinstall` calls bare `node`, which was measured at exit **127**
 * (§7.19). Then `<runtime>/bin/node <workspace>/<remotion entry> versions` — the call D1 is about —
 * must exit `0` under the same environment, which is what says the tree that arrived is one Remotion
 * itself accepts.
 *
 * **3 — the speech provider, and who owns its lifetime.** Round 4 left that unowned:
 * `render.mjs`'s `requireKokoro()` only *waits for* a server, and T19 decides the daemon never
 * starts a container. The rule here, in precedence order — and it is the gate's own, not the
 * daemon's:
 *
 *   1. **`XPLAINER_TTS_URL` is set.** An operator or a workflow `services:` block already provides
 *      one; this gate waits for it and starts nothing.
 *   2. **Otherwise it starts one itself**, from the image digest `setup` pulled, on a port the OS
 *      chose, and **stops it in a `finally`**. Owning a container for the length of one gate run is
 *      not the daemon owning one, so T19's decision is undisturbed. Whether that route exists is
 *      asked **as `setup` will see it** — of a process with the scrubbed `PATH` — because a probe
 *      from this script's own `PATH` promises a route the artefact then cannot take.
 *   3. **Otherwise the narration leg is skipped with its reason.** On **Windows** that is always the
 *      case this phase (§2.5, P2-4), and the skip is printed as a skip — never as a pass.
 *
 * **4 — the marker, over the copy route.** The workspace phase 2 resolved is staged as a payload 2
 * and `setup` is run again against it, so the *other* route D3 requires is exercised on the same
 * machine: no network, `node_modules` replaced whole, symlinks kept. The browser is acquired for
 * real, against the **expected** digest the committed manifest carries for this configuration, and
 * every path `toolchain.json` records is then asserted to exist. Where there is no live provider the
 * browser-and-workspace-only form runs first — `setup --skip-speech --workspace`, which is what a
 * Windows user has — and the marker is then completed with `--tts-url`, because `toolchain.json`
 * records all three components or it is not a valid document.
 *
 * **5 — the wiring.** A real `serve` out of the artefact, against that state directory:
 * `/healthz` answers `ok`; one recorded path is moved aside and it answers
 * `{"status":"degraded","reason":"toolchain_missing"}`; the path is put back and it answers `ok`
 * again. That is ADR 0020 §Degraded paths made observable.
 *
 * **6 — narrate, still, render, and the MP4 read back with `ffprobe`.** Against the **materialised**
 * workspace: `scripts/e2e/render.mjs:658` symlinks the checkout's own `node_modules` into its
 * workspace with its reasoning written out, and that proof keeps doing so — this one deliberately
 * does not, because the thing under test is whether `setup` produced a workspace a render can use.
 * The assertions are `workers/render.test.ts`'s, because a render that "succeeded" and produced a
 * silent, mistimed or 300-frame placeholder file looks like success from inside Node: the video
 * stream's size, rate and codec, an **AAC** stream beside it, the duration within 100 ms of
 * `timings.json`, and a frame count that equals `timings.durationInFrames` exactly and is not the
 * `Root.tsx` placeholder's 300. Nothing is written through `explainer_put_source`, so `Video.tsx`
 * draws its `MissingScene` marker per segment and the boundary frames are readable in the picture.
 *
 * **7 — T16's rollback cases, rerun.** B5 ends every rollback with readiness rather than a render,
 * and the plan splits the remaining half here (§12.3). `apps/cli/src/setup/testing/rollback-render.ts`
 * is handed this run's workspace, marker and narrated video, and reruns every case that ends in a
 * rollback — the five durable boundaries and the replacement that never becomes ready — asserting a
 * PNG out of the daemon that came back.
 *
 * **It is not part of `pnpm verify` and must not become part of it.** It copies ~147 MB of payload,
 * installs ~234 MB of workspace from the registry, downloads a ~100 MB browser, renders a video and
 * then stages two more payloads six times over.
 *
 * ```bash
 * pnpm e2e:toolchain
 * XPLAINER_TTS_URL=http://127.0.0.1:8880 pnpm e2e:toolchain   # reuse a server you already run
 * ```
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { get } from "node:http";
import { createServer } from "node:net";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { remotionEntry, transcript, WORKSPACE_MANIFEST_FILE, workspaceShim } from "./spawn.mjs";

/** The repository root, two levels up from this file. */
const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** The built CLI that assembles the artefact. `pnpm turbo build` below makes it this commit's. */
const CLI = join(REPO, "apps", "cli", "dist", "bin.js");

/** The reviewed manifest this checkout commits, which is what `--manifest` names. */
const MANIFEST = join(REPO, "apps", "cli", "src", "setup", "toolchain.manifest.json");

/** The rollback rerun, spawned through the source hook exactly as the daemon suites spawn a child. */
const ROLLBACK_PROOF = join(REPO, "apps", "cli", "src", "setup", "testing", "rollback-render.ts");

/**
 * The hook that lets a spawned `node` resolve this package's `.ts` sources, as a **file URL**.
 *
 * `--import` takes a URL, and a bare Windows path (`C:\…`) is parsed as a URL with the scheme `c:`
 * — `ERR_UNSUPPORTED_ESM_URL_SCHEME`, measured on `windows-latest` on 2026-09-08.
 */
const TS_SOURCE_HOOK = pathToFileURL(
  join(REPO, "apps", "cli", "src", "daemon", "testing", "ts-source-hook.ts"),
).href;

/** `pnpm turbo build`, in the form `execFileSync` takes it (see `runtime.mjs` for the Windows why). */
const PNPM_BUILD =
  process.platform === "win32"
    ? { command: "pnpm.cmd turbo build", args: [], shell: true }
    : { command: "pnpm", args: ["turbo", "build"], shell: false };

/** Where the transcript is left for a human to look at. */
const ARTIFACTS =
  (process.env.COLLIE_ARTIFACTS_DIR ?? "").trim() || join(REPO, ".session/artifacts");

/** Where the transcript is written, line by line. */
const LOG_PATH = join(ARTIFACTS, "e2e-toolchain.log");

/** Where the artefact is assembled: inside the checkout, because the move out of it is the test. */
const STAGE_ROOT = join(REPO, ".session", "e2e-toolchain");
const STAGE = join(STAGE_ROOT, "staged");

/** The marker `setup` writes, at the root of the state directory. */
const TOOLCHAIN_MARKER_FILE = "toolchain.json";

/** The port the TTS sidecar's own default `base_url` names, inside its container. */
const KOKORO_PORT = 8880;

/** The name the container this gate starts is given, so it is never somebody else's to stop. */
const KOKORO_CONTAINER = `xplainer-t33-kokoro-${process.pid}`;

/** How long the two long acquisitions may take. `npm ci` of 268 packages, and a ~100 MB browser. */
const SETUP_TIMEOUT_MS = 900_000;

/** How long the daemon has to print its ready line. */
const READY_TIMEOUT_MS = 60_000;

/** How long a job may take. The first render of a run also downloads a headless shell. */
const JOB_TIMEOUT_MS = 1_800_000;

/** How long a provider gets to answer with a non-empty voice list, per route. */
const TTS_WAIT_MS = {
  /** Somebody else's server: this is a precondition check that should fail fast. */
  external: Number.parseInt(process.env.XPLAINER_TTS_WAIT_MS ?? "", 10) || 120_000,
  /** One this gate just started: a cold Kokoro-FastAPI loads its voice pack first. */
  started: Number.parseInt(process.env.XPLAINER_TTS_WAIT_MS ?? "", 10) || 600_000,
};

/** The video this gate builds. */
const SLUG = "toolchain";

/** The frame every still is taken at, and the scale, which is `render.test.ts`'s pair. */
const STILL_FRAME = 30;
const STILL_SCALE = 0.5;

/**
 * The two **spoken** segments, and the tones the fixture route stands in for them with.
 *
 * Real sentences, because the point is measured speech: a placeholder would produce word spans of a
 * shape Kokoro never returns. Two of them rather than one, because a boundary between segments is
 * what the picture is read for below. {@link HOLD} goes between them, so the narration this gate
 * drives has the same three-segment shape `workers/render.test.ts` renders and the same **two**
 * boundaries — which is what lets the two assert the same number rather than one of them settling
 * for "at least one".
 */
const SEGMENTS = [
  {
    id: "hook",
    text: "Setup acquired a browser, a speech route and a render workspace.",
    seconds: 1.6,
    frequency: 440,
  },
  {
    id: "answer",
    text: "This is the picture that came out of them.",
    seconds: 1.3,
    frequency: 660,
  },
];

/**
 * The silent beat between the two spoken segments: `text: ""` plus `holdSeconds`.
 *
 * `packages/protocol/schemas/narration.json` says "empty text yields a silent segment of
 * holdSeconds length", so this one reaches no speech route at all — neither Kokoro nor the fixture
 * directory — and exists to make the scene change **twice**. It is `render.test.ts`'s `beat`, and
 * without it this gate had two segments, one boundary, and no way to assert the number that suite
 * pins.
 */
const HOLD = { id: "beat", holdSeconds: 0.5 };

/** Kokoro's own output rate, which is the rate the recorded clips are written at. */
const SAMPLE_RATE = 24_000;

/** The narration's frame rate: what `timings.json`'s frame numbers are counted in. */
const FPS = 30;

/**
 * The band of the frame the `MissingScene` marker occupies, copied from `workers/render.test.ts`.
 *
 * `Video.tsx`'s placeholder centres the segment id in a box with 200px of bottom padding, so it
 * lands around y = 440 in a 1080-high frame. The crop is deliberately well above the caption track,
 * which changes *within* a segment as well as across one.
 */
const MARKER = { width: 1000, height: 220, x: 460, y: 340 };

/** How far apart two grey levels must be before the pixel counts as changed. */
const CHANGED_LEVEL = 32;

/** The scratch directory, removed when the run succeeds and kept when it does not. */
let scratch = null;

function stamp() {
  return new Date().toISOString();
}

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

/** A leg this machine cannot run, recorded as a skip with its reason — never as a pass. */
function skip(message) {
  say(`  skip  ${message}`);
}

/**
 * Both streams into the transcript, and a child that never started named as such.
 *
 * `spawnLogged` returns the whole result, for the assertions here whose subject *is* the exit code;
 * `runLogged` is the same spawn for the commands whose non-zero exit is simply the end of the run.
 * Both live in `scripts/e2e/spawn.mjs` now, because four private copies of this helper had three
 * different behaviours and its docblock is that argument.
 */
const { spawnLogged, runLogged } = transcript(LOG_PATH);

/** Whether `path` is outside the checkout, which is what "moved out of it" has to mean. */
function outsideCheckout(path) {
  const inside = relative(REPO, path);
  return inside === "" ? false : inside.startsWith("..") || isAbsolute(inside);
}

/** Move a directory, falling back to copy-and-remove across a device boundary. */
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

/** The names a program can go by on this platform, for the `PATH` scans below. */
function executableNames(stem) {
  return process.platform === "win32" ? [`${stem}.exe`, `${stem}.cmd`, `${stem}.bat`] : [stem];
}

/** The first `stem` a `PATH` resolves, or `null` when it resolves none. */
function onPath(pathValue, stem) {
  for (const directory of pathValue.split(delimiter)) {
    if (directory.trim() === "") {
      continue;
    }
    for (const name of executableNames(stem)) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/** The first `node` a `PATH` resolves, or `null` when it resolves none. */
function nodeOnPath(pathValue) {
  return onPath(pathValue, "node");
}

/**
 * The `PATH` D8 is proved against: a shell, and no interpreter.
 *
 * `/usr/bin:/bin` on POSIX, which is the plan's own form (§T19) and is **not** the empty directory
 * `scripts/e2e/runtime.mjs` uses. That difference is a measurement rather than a preference. D8 is
 * about `node`, and the mechanism it fixes is npm running lifecycle scripts **through `sh -c`** —
 * so a `PATH` with no `sh` on it fails one step earlier, at `spawn sh ENOENT`, and would report a
 * missing shell as though it were the missing interpreter. Measured here on 2026-09-08: with a
 * `PATH` naming one empty directory, `npm ci` exits **254** with `npm error syscall spawn sh`, and
 * the D8 assertion would have passed for the wrong reason. `/usr/bin:/bin` resolves `sh` and
 * resolves no `node`, which is exactly the machine the whole runtime artefact exists for.
 *
 * On Windows there is no `/usr/bin`, so the shell directory is `%SystemRoot%\System32` — where
 * `cmd.exe` lives and no `node.exe` does.
 */
function shellPath() {
  if (process.platform === "win32") {
    const root = process.env.SystemRoot ?? "C:\\Windows";
    return `${join(root, "System32")}${delimiter}${root}`;
  }
  return `/usr/bin${delimiter}/bin`;
}

/**
 * The whole environment the artefact is allowed to see, built from nothing rather than filtered.
 *
 * A filter is a list of the variables someone remembered. What is left is {@link shellPath}, the
 * platform minimum a process needs to start at all, and the coordinates this run is about. `npm`
 * needs a writable home for its cache, which is why `HOME` points inside the scratch.
 */
function scrubbedEnvironment(paths, extra = {}) {
  const base = {
    PATH: shellPath(),
    XPLAINER_STATE_DIR: paths.state,
    XPLAINER_VIDEOS_DIR: paths.videos,
    ...extra,
  };
  if (process.platform === "win32") {
    return {
      ...base,
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      SystemDrive: process.env.SystemDrive ?? "C:",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      USERPROFILE: paths.home,
      APPDATA: join(paths.home, "AppData", "Roaming"),
      LOCALAPPDATA: join(paths.home, "AppData", "Local"),
      TEMP: paths.temp,
      TMP: paths.temp,
    };
  }
  return { ...base, HOME: paths.home, TMPDIR: paths.temp };
}

/** The payload's interpreter and its CLI entry — the pair every command below is spawned as. */
function payloadEntry(runtime) {
  return {
    interpreter: join(runtime, "bin", process.platform === "win32" ? "node.exe" : "node"),
    entry: join(runtime, "lib", "node_modules", "@xplainer", "cli", "dist", "bin.js"),
  };
}

/** The first of `candidates` that exists, or the bare name for whatever is on `PATH`. */
function resolveTool(name, override) {
  const configured = (override ?? "").trim();
  if (configured !== "") {
    return configured;
  }
  const homebrew = `/opt/homebrew/bin/${name}`;
  return existsSync(homebrew) ? homebrew : name;
}

const ffmpeg = resolveTool("ffmpeg", process.env.XPLAINER_FFMPEG);
const ffprobe = resolveTool("ffprobe", process.env.XPLAINER_FFPROBE);

/**
 * One stream field of one file, asked for one at a time.
 *
 * `ffprobe` prints `-show_entries stream=a,b` in the *stream's* field order rather than in the order
 * asked for, so a multi-field query compares a list against an order nothing guarantees.
 */
function probeStream(path, stream, field) {
  return execFileSync(
    ffprobe,
    [
      "-v",
      "error",
      "-select_streams",
      stream,
      "-show_entries",
      `stream=${field}`,
      "-of",
      "default=nw=1:nk=1",
      path,
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  ).trim();
}

/**
 * One frame's marker band, as raw 8-bit grey.
 *
 * Piped as `rawvideo` rather than through a file so the bytes measured are the bytes ffmpeg
 * produced, and `-fps_mode passthrough` so the one selected frame is not duplicated to fill a rate.
 */
function markerBand(mp4, frame) {
  const raw = execFileSync(
    ffmpeg,
    [
      "-v",
      "error",
      "-i",
      mp4,
      "-vf",
      `select=eq(n\\,${frame}),crop=${MARKER.width}:${MARKER.height}:${MARKER.x}:${MARKER.y},format=gray`,
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
  const expected = MARKER.width * MARKER.height;
  if (raw.length !== expected) {
    throw new Error(`frame ${frame} produced ${raw.length} bytes of band, expected ${expected}`);
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

/** The word spans a server would have reported for one clip: one token per word, evenly spaced. */
function wordSpans(text, seconds) {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const step = seconds / words.length;
  return words.map((word, index) => ({
    word,
    start_time: Number((index * step).toFixed(6)),
    end_time: Number(((index + 1) * step).toFixed(6)),
  }));
}

/** Record the fixture directory `XPLAINER_TTS_FIXTURE` names — T3's own stand-in for a server. */
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
}

/** The narration document both routes are driven with. */
function narrationRequest() {
  return {
    voice: "af_heart",
    speed: 1,
    fps: FPS,
    // Spoken, held, spoken — the shape `workers/render.test.ts` renders, so the two agree on how
    // many boundaries there are to read the picture at.
    segments: [
      { id: SEGMENTS[0].id, text: SEGMENTS[0].text },
      { id: HOLD.id, text: "", holdSeconds: HOLD.holdSeconds },
      { id: SEGMENTS[1].id, text: SEGMENTS[1].text },
    ],
  };
}

/** Whether a Docker **engine** answers to a process whose `PATH` is `pathValue`. */
function dockerAnswers(pathValue) {
  const probe = spawnLogged("docker", "docker", ["version", "--format", "{{.Server.Version}}"], {
    env: { PATH: pathValue },
  });
  return probe.error === undefined && probe.status === 0 ? probe.stdout.trim() : null;
}

/**
 * Which speech route this gate can own the lifetime of, in the precedence the gate owns (phase 3's
 * docblock).
 *
 * **It answers a narrower question than "what speech does this machine have", and since the `onnx`
 * route landed the difference matters.** Every platform has a working speech route now; what this
 * function looks for is a *provider* — a server somebody else runs, or a container this gate can
 * start on a free port and stop in a `finally`. The in-process synthesiser is neither, and taking it
 * here would add ~204 MB from three upstream hosts to a gate whose subject is the browser, the
 * workspace, the degraded `/healthz` and the rollback rerun. `pnpm e2e:speech` is the proof that
 * owns that route, and `--speech docker` is what this gate passes so that `setup` records the
 * provider this file is about rather than the first one the precedence offers.
 *
 * Who starts what follows from the answer and is {@link startProvider}'s. The `docker` question is asked **as `setup` will see it** — with the
 * scrubbed `PATH`, because that is the environment the artefact is run under and a probe from this
 * script's own `PATH` would promise a route `setup` then cannot take. Measured on 2026-09-08: with
 * `PATH=/usr/bin:/bin` a macOS `setup` exits `3` with "docker is not on this machine's PATH", while
 * this script's own probe answered `29.4.0` — the gate reported `docker` and the run died at the
 * acquisition it had just promised.
 *
 * Where an engine answers but its client is not on that `PATH` — Docker Desktop and OrbStack both
 * install into `/usr/local/bin`, and a Linux machine's `/usr/bin/docker` needs none of this — the
 * **one directory holding it** is added, and only after it is measured to resolve no interpreter.
 * That is the property the scrubbed `PATH` is protecting: D8 is about `node`, and a directory with
 * a container client and no `node` in it leaves that claim exactly where it was.
 */
function speechPlan() {
  const configured = (process.env.XPLAINER_TTS_URL ?? "").trim();
  if (configured !== "") {
    return {
      kind: "external",
      url: configured,
      path: shellPath(),
      why: `XPLAINER_TTS_URL names ${configured}, so this gate waits for it and starts nothing`,
    };
  }
  if (process.platform === "win32") {
    return {
      kind: "none",
      path: shellPath(),
      why:
        "Windows has no route **this gate can own the lifetime of**: the docker provider cannot " +
        "pull a linux/amd64 image and nothing is published for the bundle provider to fetch " +
        "(§2.5). It is no longer true that Windows has no speech at all — the in-process onnx " +
        "route runs there and `pnpm e2e:speech` is its proof — and this gate deliberately does " +
        "not take it: what it exercises is a provider somebody starts and stops around one run",
    };
  }

  const scrubbed = dockerAnswers(shellPath());
  if (scrubbed !== null) {
    return {
      kind: "docker",
      path: shellPath(),
      why: `a Docker engine answered (${scrubbed}) to a process with the scrubbed PATH itself`,
    };
  }
  const client = onPath(process.env.PATH ?? "", "docker");
  if (client !== null && nodeOnPath(dirname(client)) === null) {
    const augmented = `${shellPath()}${delimiter}${dirname(client)}`;
    const answered = dockerAnswers(augmented);
    if (answered !== null) {
      return {
        kind: "docker",
        path: augmented,
        why:
          `a Docker engine answered (${answered}) once ${dirname(client)} was added to the ` +
          "scrubbed PATH, and that directory resolves no node",
      };
    }
  }
  return {
    kind: "none",
    path: shellPath(),
    why:
      "XPLAINER_TTS_URL is unset and no Docker engine answers to a process with the scrubbed " +
      `PATH${client === null ? "" : `, or with ${dirname(client)} added to it`}, so there is no ` +
      "provider on this machine whose lifetime this gate can own. The in-process onnx route is " +
      "available here and is not taken: it would add ~204 MB from three upstream hosts to a gate " +
      "whose subject is the browser, the workspace and the rollback rerun, and `pnpm e2e:speech` " +
      "is the proof that owns it",
  };
}

/** A port nobody is listening on, asked of the OS rather than guessed. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * Wait until a Kokoro-FastAPI answers with a **non-empty** voice list.
 *
 * A server that has bound its port but not finished loading its voices answers `/v1/audio/voices`
 * with an empty list, so the readiness condition is a non-empty one — anything less lets the
 * narration start against a server that cannot speak yet. `render.mjs`'s condition, and its reason.
 */
async function awaitVoices(url, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (let attempt = 1; ; attempt += 1) {
    let described = "";
    try {
      const response = await fetch(`${url}/v1/audio/voices`, { signal: AbortSignal.timeout(5000) });
      const voices = response.ok ? (await response.json()).voices : null;
      if (Array.isArray(voices) && voices.length > 0) {
        return { voices: voices.length, attempt };
      }
      described = `HTTP ${response.status}`;
    } catch (error) {
      described = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) {
      throw new Error(`no Kokoro server at ${url} after ${attempt} attempts (${described})`);
    }
    if (attempt % 15 === 0) {
      say(`  ..  waiting for ${url} (attempt ${attempt}): ${described}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * Bring up the narration provider this run will use, and answer with how to stop it.
 *
 * Route 2's image is the one **`setup` pulled**, read out of the receipt `toolchain.json` records
 * for the docker provider — not a constant restated here, so the container started is the digest
 * that was acquired and verified rather than whatever a tag resolves to now.
 */
async function startProvider(plan, marker) {
  if (plan.kind === "external") {
    const ready = await awaitVoices(plan.url, TTS_WAIT_MS.external);
    say(`  ..  ${plan.url} answered with ${ready.voices} voice(s) on attempt ${ready.attempt}`);
    return { url: plan.url, owner: "the operator", started: false, stop: () => {} };
  }
  const receipt = JSON.parse(readFileSync(marker.speech.path, "utf8"));
  const port = await freePort();
  const started = spawnLogged("docker run", "docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    KOKORO_CONTAINER,
    "-p",
    `127.0.0.1:${port}:${KOKORO_PORT}`,
    receipt.image,
  ]);
  if (started.status !== 0) {
    throw new Error(
      `docker run of ${receipt.image} exited ${started.status}: ${(started.stderr ?? "").trim()}`,
    );
  }
  const stop = () => {
    spawnLogged("docker stop", "docker", ["stop", "-t", "2", KOKORO_CONTAINER]);
  };
  const url = `http://127.0.0.1:${port}`;
  say(`  ..  started ${KOKORO_CONTAINER} from ${receipt.image} on ${url}`);
  try {
    const ready = await awaitVoices(url, TTS_WAIT_MS.started);
    say(`  ..  it answered with ${ready.voices} voice(s) on attempt ${ready.attempt}`);
  } catch (error) {
    stop();
    throw error;
  }
  return { url, owner: "this gate, and it is stopped in a finally", started: true, stop };
}

/**
 * The environment the rollback rerun is spawned with.
 *
 * It keeps this process's `PATH` — it runs the checkout's own sources through the source hook and
 * assembles two payloads with them, which is not the scrubbed machine phase 2 is about — and it
 * takes this run's `HOME` so the headless shell Remotion downloaded during the render is the one
 * six more renders find already there. **`XPLAINER_STATE_DIR` is removed rather than overridden**:
 * every case makes a state directory of its own, and a variable naming this run's would be
 * inherited by every daemon those cases start.
 */
function rollbackEnvironment(paths, markerFile) {
  const { XPLAINER_STATE_DIR: _removed, ...inherited } = process.env;
  return {
    ...inherited,
    HOME: paths.home,
    XPLAINER_VIDEOS_DIR: paths.videos,
    XPLAINER_ROLLBACK_WORKSPACE: paths.videos,
    XPLAINER_ROLLBACK_MARKER: markerFile,
    XPLAINER_ROLLBACK_SLUG: SLUG,
    XPLAINER_ROLLBACK_FRAME: String(STILL_FRAME),
  };
}

/** `GET /healthz` over the daemon's TCP listener, with the token it minted. */
function healthz(port, token) {
  return new Promise((resolve, reject) => {
    const request = get(
      {
        host: "127.0.0.1",
        port,
        path: "/healthz",
        headers: { Authorization: `Bearer ${token}`, Host: `127.0.0.1:${port}` },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(15_000, () => {
      request.destroy(new Error("/healthz did not answer inside 15 s"));
    });
  });
}

/** Start the daemon out of the artefact and resolve when its ready line arrives. */
function startDaemon(runtime, paths, extraEnv = {}) {
  const { interpreter, entry } = payloadEntry(runtime);
  const child = spawn(interpreter, [entry, "serve", "--port", "0"], {
    env: scrubbedEnvironment(paths, extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the daemon printed no ready line inside ${READY_TIMEOUT_MS} ms`));
    }, READY_TIMEOUT_MS);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      for (const line of String(chunk).trim().split("\n")) {
        if (line.trim() !== "") {
          appendFileSync(LOG_PATH, `  [serve err] ${line}\n`);
        }
      }
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = stdout.slice(0, newline);
      appendFileSync(LOG_PATH, `  [serve out] ${line}\n`);
      try {
        const ready = JSON.parse(line);
        clearTimeout(timer);
        resolve({ child, ready });
      } catch (error) {
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error(`the first stdout line was not the ready line: ${line} (${error})`));
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Stop the daemon and wait for it, so the next phase never races a running one. */
function stopDaemon(child) {
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
    child.kill("SIGTERM");
  });
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

/** Enqueue one job and poll `explainer_job` to a conclusion, asserting P1-5's sequence. */
async function runJob(client, name, args) {
  const queued = await callTool(client, name, args);
  say(`  ..  ${name} queued job ${queued.job_id}: ${queued.what}`);
  const started = Date.now();
  const sequence = [queued.status];
  for (;;) {
    const job = await callTool(client, "explainer_job", {
      job_id: queued.job_id,
      output_lines: 80,
    });
    if (sequence[sequence.length - 1] !== job.status) {
      sequence.push(job.status);
    }
    if (job.status !== "queued" && job.status !== "running") {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      say(`  ..  job ${queued.job_id} finished ${job.status} after ${elapsed}s`);
      if (job.status !== "done") {
        for (const line of job.output.lines.slice(-16)) {
          say(`      | ${line}`);
        }
        throw new Error(`${name} ended ${job.status}: ${job.error ?? "no message"}`);
      }
      check(
        sequence.join(" → ") === "queued → running → done",
        `${name} went queued → running → done (P1-5), observed ${sequence.join(" → ")}`,
      );
      return job;
    }
    if (Date.now() - started > JOB_TIMEOUT_MS) {
      throw new Error(`${name} was still ${job.status} after ${JOB_TIMEOUT_MS} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, sequence.length < 4 ? 25 : 500));
  }
}

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true });
  rmSync(LOG_PATH, { force: true });
  say(`xplainer toolchain gate — ${stamp()}`);
  say(`platform ${process.platform}-${process.arch}, node ${process.version}`);
  say(`ffmpeg ${ffmpeg}, ffprobe ${ffprobe}`);

  section("1 — the artefact, moved out of the checkout");
  runLogged("build", PNPM_BUILD.command, PNPM_BUILD.args, {
    cwd: REPO,
    shell: PNPM_BUILD.shell,
  });
  check(existsSync(CLI), `${CLI} exists after the build`);
  rmSync(STAGE_ROOT, { recursive: true, force: true });
  mkdirSync(STAGE_ROOT, { recursive: true });
  runLogged("runtime build", process.execPath, [CLI, "runtime", "build", "--out", STAGE], {
    cwd: REPO,
  });

  scratch = join(
    process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp",
    `xplainer-toolchain-${process.pid}`,
  );
  rmSync(scratch, { recursive: true, force: true });
  const paths = {
    runtime: join(scratch, "runtime"),
    state: join(scratch, "state"),
    videos: join(scratch, "videos"),
    home: join(scratch, "home"),
    temp: join(scratch, "temp"),
    payload2: join(scratch, "payload2"),
    fixtures: join(scratch, "fixtures"),
  };
  for (const directory of [paths.home, paths.temp]) {
    mkdirSync(directory, { recursive: true });
  }
  const how = moveDirectory(STAGE, paths.runtime);
  check(
    outsideCheckout(paths.runtime),
    `the artefact is at ${paths.runtime}, outside the checkout`,
  );
  say(`  ..  moved by ${how}`);

  section("2 — D8: setup --workspace under a scrubbed PATH");
  check(nodeOnPath(shellPath()) === null, `no node resolves on the scrubbed PATH (${shellPath()})`);
  if (process.platform !== "win32") {
    const noNode = spawnLogged("command -v node", "/bin/sh", ["-c", "command -v node"], {
      env: { PATH: shellPath() },
    });
    check(
      noNode.status !== 0,
      `\`env -i PATH=${shellPath()} sh -c 'command -v node'\` fails: the parent has no interpreter`,
    );
    const hasShell = spawnLogged("command -v sh", "/bin/sh", ["-c", "command -v sh"], {
      env: { PATH: shellPath() },
    });
    check(
      hasShell.status === 0,
      "`sh` does resolve there, so what the next step measures is the missing node and not a " +
        "missing shell (measured: an empty PATH makes npm exit 254 at `spawn sh ENOENT`)",
    );
  }

  const { interpreter, entry } = payloadEntry(paths.runtime);
  const workspaceRun = spawnLogged(
    "setup --workspace",
    interpreter,
    [entry, "setup", "--workspace"],
    { env: scrubbedEnvironment(paths), timeout: SETUP_TIMEOUT_MS },
  );
  check(
    workspaceRun.status === 0,
    `\`setup --workspace\` exited 0 under the scrubbed environment (D8; it exits 127 without the ` +
      `runtime bin on the install subprocess's PATH)`,
  );

  const manifestFile = join(paths.videos, WORKSPACE_MANIFEST_FILE);
  check(existsSync(manifestFile), `${manifestFile} describes what the resolve route installed`);
  const resolved = JSON.parse(readFileSync(manifestFile, "utf8"));
  check(
    resolved.installer === "npm ci",
    `the installer recorded is \`npm ci\`, never \`npm install\``,
  );
  check(
    resolved.platform === process.platform && resolved.arch === process.arch,
    `the workspace records this machine (${resolved.platform}-${resolved.arch})`,
  );
  const pinSkew = Object.entries(resolved.pins).find(
    ([name, range]) => resolved.resolved[name] !== range,
  );
  check(pinSkew === undefined, "every version the tree resolved matches the pins it was asked for");

  // And those pins are the checkout's, not merely the payload's own copy of them. The payload
  // carries `@xplainer/render-core`'s `template/` because the `files` allowlist ships it, so a
  // comparison against the payload alone would agree with itself; this is the loop closed.
  const template = JSON.parse(
    readFileSync(join(REPO, "packages", "render-core", "template", "package.json"), "utf8"),
  );
  const templatePins = { ...template.dependencies, ...template.devDependencies };
  const templateSkew = Object.entries(templatePins).find(
    ([name, range]) => resolved.resolved[name] !== range,
  );
  check(
    templateSkew === undefined,
    "and they are this checkout's own template/package.json pins, package for package",
  );

  const shim = workspaceShim(paths.videos, "remotion");
  check(existsSync(shim), `${shim} resolves, which is what says npm linked the CLI`);

  // The shim is what says npm *linked* the CLI; the entry the manifest names is what is spawnable
  // on all three platforms, under an explicit interpreter. `scripts/e2e/spawn.mjs` spells both.
  const versions = spawnLogged(
    "remotion versions",
    interpreter,
    [remotionEntry(paths.videos, resolved), "versions"],
    { cwd: paths.videos, env: scrubbedEnvironment(paths), timeout: 120_000 },
  );
  check(
    versions.status === 0,
    "`<runtime>/bin/node <workspace>/<remotion entry> versions` exits 0 under the same environment",
  );

  section("3 — the speech provider, and who owns its lifetime");
  const plan = speechPlan();
  say(`  ..  route: ${plan.kind} — ${plan.why}`);
  check(
    nodeOnPath(plan.path) === null,
    `the PATH the acquisition runs under still resolves no node (${plan.path})`,
  );

  section("4 — the marker, over the copy route");
  mkdirSync(paths.payload2, { recursive: true });
  for (const name of [
    "node_modules",
    "package.json",
    "package-lock.json",
    WORKSPACE_MANIFEST_FILE,
  ]) {
    cpSync(join(paths.videos, name), join(paths.payload2, name), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  say(`  ..  the resolved workspace is staged as a payload 2 at ${paths.payload2}`);
  rmSync(paths.videos, { recursive: true, force: true });

  // `plan.path` rather than `shellPath()`: the speech acquisition is the one step that may need a
  // container client, and phase 3 has already measured that adding its directory resolves no node.
  const copyEnvironment = scrubbedEnvironment(paths, {
    XPLAINER_WORKSPACE_PAYLOAD: paths.payload2,
    PATH: plan.path,
  });
  if (plan.kind === "none") {
    // The browser-and-workspace-only form: `--skip-speech` is what a user runs who does not want a
    // speech acquisition in this run at all, and it is the form this gate needs, because the route
    // it could otherwise take here is the ~204 MB in-process one it deliberately does not exercise.
    const partial = spawnLogged(
      "setup --skip-speech --workspace",
      interpreter,
      [entry, "setup", "--skip-speech", "--workspace", "--manifest", MANIFEST],
      { env: copyEnvironment, timeout: SETUP_TIMEOUT_MS },
    );
    check(
      partial.status === 0,
      "`setup --skip-speech --workspace` exited 0, having acquired the browser and the workspace " +
        "without acquiring any speech route",
    );
    check(
      !existsSync(join(paths.state, TOOLCHAIN_MARKER_FILE)),
      "and it wrote no toolchain.json: the marker records all three components or it is not a " +
        "valid document, which is why the run below completes it with --tts-url",
    );
  }

  const setupArgv = [entry, "setup", "--manifest", MANIFEST];
  if (plan.kind === "docker") {
    // `--speech docker` NAMES THE ROUTE THIS GATE IS PROVING, and it is required rather than
    // tidy. Phase 5 below opens `marker.speech.path` **as the docker receipt** to read
    // `receipt.image`, and since 2026-09-10 `onnx` sits *above* `docker` in `setup`'s precedence
    // (`setup/providers/speech.ts`) — so a bare `setup` on this machine would acquire the model
    // graph, record it at that path, and this gate would `JSON.parse` 92 MB of ONNX. Pinning is
    // also the honest form: what this leg is here to exercise is T19's docker provider, and a gate
    // that inferred its subject from a precedence it does not own was one reordering away from
    // proving something else. The in-process route has a proof of its own, `pnpm e2e:speech`.
    setupArgv.push("--speech", "docker");
  } else {
    setupArgv.push(
      "--tts-url",
      plan.kind === "external" ? plan.url : `http://127.0.0.1:${KOKORO_PORT}`,
    );
  }
  const full = spawnLogged("setup", interpreter, setupArgv, {
    env: copyEnvironment,
    timeout: SETUP_TIMEOUT_MS,
  });
  check(full.status === 0, "`setup` exited 0, having acquired all three components");
  check(
    full.stdout.includes("workspace: copy route"),
    "the workspace came from the staged payload, which is D3's offline route",
  );
  check(existsSync(shim), "the copied workspace's .bin/remotion resolves too");

  const markerFile = join(paths.state, TOOLCHAIN_MARKER_FILE);
  check(existsSync(markerFile), `${markerFile} was written`);
  const marker = JSON.parse(readFileSync(markerFile, "utf8"));
  for (const component of ["chrome", "speech"]) {
    check(
      existsSync(marker[component].path),
      `the recorded ${component} path exists: ${marker[component].path}`,
    );
  }
  check(
    marker.chrome.provider === "remotion",
    "the browser was acquired through the pinned Remotion line",
  );
  // The digest has to be **this host's** row, not any row. `chrome.expected`'s keys are
  // `<platform>-<arch>` with an optional distribution or libc suffix — `darwin-arm64`,
  // `linux-x64-glibc235`, `win32-x64` — so the rows this machine could legitimately have used are
  // the ones under its own `<platform>-<arch>` prefix. Accepting any row, which is what stood here
  // until 2026-09-08, would have passed a digest correct for `linux-x64` on a darwin-arm64 machine:
  // the assertion would then be "the manifest has some digest in it" rather than "setup admitted
  // the artefact this host's reviewed row names".
  const expected = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const hostPrefix = `${process.platform}-${process.arch}`;
  const hostRows = Object.entries(expected.chrome.expected).filter(
    ([key]) => key === hostPrefix || key.startsWith(`${hostPrefix}-`),
  );
  check(
    hostRows.length > 0,
    `the reviewed manifest carries at least one ${hostPrefix} row to check against ` +
      `(${hostRows.map(([key]) => key).join(", ") || "none"})`,
  );
  const matchedRow = hostRows.find(
    ([, row]) => row.status === "recorded" && row.sha256 === marker.chrome.sha256,
  );
  check(
    matchedRow !== undefined,
    matchedRow === undefined
      ? `no ${hostPrefix} row in the reviewed manifest carries ${marker.chrome.sha256}, so the ` +
          "digest recorded came from somewhere other than this host's own row"
      : `the digest recorded is the one this host's own row carries (${matchedRow[0]}), not a ` +
          "digest taken from the bytes and not another platform's",
  );
  check(
    marker.workspace.platform === `${process.platform}-${process.arch}`,
    `the workspace recorded is this machine's (${marker.workspace.platform})`,
  );

  section("5 — the wiring: /healthz degrades when a recorded path goes");
  const wiring = await startDaemon(paths.runtime, paths);
  const token = readFileSync(join(paths.state, "token"), "utf8").trim();
  try {
    const healthy = await healthz(wiring.ready.port, token);
    check(
      healthy.status === 200 && JSON.parse(healthy.body).status === "ok",
      `/healthz answers ok while the toolchain is whole: ${healthy.body}`,
    );

    const moved = `${marker.chrome.path}.moved-aside`;
    renameSync(marker.chrome.path, moved);
    const degraded = await healthz(wiring.ready.port, token);
    const body = JSON.parse(degraded.body);
    check(
      degraded.status === 200 && body.status === "degraded" && body.reason === "toolchain_missing",
      `/healthz answers {"status":"degraded","reason":"toolchain_missing"}: ${degraded.body}`,
    );

    renameSync(moved, marker.chrome.path);
    const restored = await healthz(wiring.ready.port, token);
    check(
      JSON.parse(restored.body).status === "ok",
      "/healthz answers ok again once the recorded path is back, so the check is asked per request",
    );
  } finally {
    const stopped = await stopDaemon(wiring.child);
    say(`  ..  the daemon exited ${stopped.code ?? stopped.signal}`);
  }

  section("6 — narrate, still, render, and the MP4 read back with ffprobe");
  let provider = null;
  try {
    let narrationEnv = {};
    if (plan.kind === "none") {
      skip(
        `the live narration leg cannot run here, so this render is driven from T3's fixture ` +
          `audio (XPLAINER_TTS_FIXTURE) and nothing is synthesised: ${plan.why}`,
      );
      writeFixtures(paths.fixtures);
      narrationEnv = { XPLAINER_TTS_FIXTURE: paths.fixtures };
    } else {
      provider = await startProvider(plan, marker);
      say(`  ..  the provider's lifetime is owned by ${provider.owner}`);
      narrationEnv = { XPLAINER_TTS_URL: provider.url };
    }

    const daemon = await startDaemon(paths.runtime, paths, narrationEnv);
    const transport = new StdioClientTransport({
      command: interpreter,
      args: [entry, "mcp", "--attach"],
      env: scrubbedEnvironment(paths, narrationEnv),
      stderr: "pipe",
    });
    const client = new Client({ name: "xplainer-toolchain-gate", version: "1.0.0" });
    await client.connect(transport);
    transport.stderr?.setEncoding("utf8");
    transport.stderr?.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim() !== "") {
          appendFileSync(LOG_PATH, `  [shim] ${line}\n`);
        }
      }
    });

    try {
      await callTool(client, "explainer_create", { slug: SLUG });
      // Nothing is written through `explainer_put_source`: the scaffolded `Scenes.tsx` is empty on
      // purpose, so `Video.tsx` draws its `MissingScene` marker — the segment's own id — for every
      // segment, which is what makes the boundary readable in the picture below.
      const narrated = await runJob(client, "explainer_narrate", {
        slug: SLUG,
        narration: narrationRequest(),
      });
      const provenance = narrated.output.lines.join("\n");
      if (plan.kind === "none") {
        check(
          provenance.includes("XPLAINER_TTS_FIXTURE"),
          "the narration worker says its speech came from the fixture directory, not a server",
        );
      } else {
        check(
          provenance.includes(`kokoro at ${provider.url}`),
          `the narration worker says its speech came from ${provider.url}, with ` +
            "XPLAINER_TTS_FIXTURE unset: this is real synthesis",
        );
      }

      const publicDir = join(paths.videos, "public", SLUG);
      const timings = JSON.parse(readFileSync(join(publicDir, "timings.json"), "utf8"));
      const audio = join(publicDir, timings.audio);
      const measured = wavDurationMs(audio);
      const drift = Math.abs(measured - timings.totalMs);
      say(
        `  ..  ${timings.segments.length} segments, ${timings.durationInFrames} frames at ` +
          `${timings.fps} fps, ${timings.totalMs.toFixed(2)} ms`,
      );
      check(
        measured > 500,
        `narration.wav has ${measured.toFixed(0)} ms of samples in it, not an empty header`,
      );
      check(
        drift < 1,
        `timings.json's total equals the WAV's own duration within 1 ms (drift ${drift.toFixed(3)} ms)`,
      );
      check(
        JSON.parse(readFileSync(join(publicDir, "captions.json"), "utf8")).length > 0,
        "captions.json carries word-level captions measured from that audio",
      );

      await runJob(client, "explainer_still", {
        slug: SLUG,
        frame: STILL_FRAME,
        scale: STILL_SCALE,
      });
      const png = join(paths.videos, "out", SLUG, `frame-${STILL_FRAME}.png`);
      check(existsSync(png), `explainer_still wrote ${png}`);
      check(probeStream(png, "v:0", "width") === "960", "the still is 960 wide at scale 0.5");
      check(probeStream(png, "v:0", "height") === "540", "the still is 540 high at scale 0.5");

      await runJob(client, "explainer_render", { slug: SLUG });
      const mp4 = join(paths.videos, "out", SLUG, "explainer.mp4");
      check(existsSync(mp4), `explainer_render wrote ${mp4}`);

      check(probeStream(mp4, "v:0", "width") === "1920", "the MP4 is 1920 wide");
      check(probeStream(mp4, "v:0", "height") === "1080", "the MP4 is 1080 high");
      check(probeStream(mp4, "v:0", "r_frame_rate") === "30/1", "the MP4 runs at 30/1 fps");
      check(probeStream(mp4, "v:0", "codec_name") === "h264", "the video stream is h264");
      // Audio is the half that fails invisibly: a silent MP4 plays, and nothing downstream notices.
      check(
        probeStream(mp4, "a:0", "codec_name") === "aac",
        "and there is an aac stream beside it",
      );

      const seconds = Number(probeStream(mp4, "v:0", "duration"));
      const durationDrift = Math.abs(seconds * 1000 - timings.totalMs);
      check(
        durationDrift < 100,
        `the MP4 lasts as long as timings.json says (drift ${durationDrift.toFixed(2)} ms)`,
      );
      check(
        Number(probeStream(mp4, "v:0", "nb_frames")) === timings.durationInFrames,
        `the MP4 has exactly timings.json's ${timings.durationInFrames} frames`,
      );
      check(
        timings.durationInFrames !== 300,
        "and that number is not Root.tsx's 300-frame Studio placeholder, which is what a " +
          "composition that had stopped reading the measured narration would produce",
      );

      // The picture changes **on** each segment boundary and is steady either side of it, compared
      // against the frame-to-frame noise this very clip produces rather than against a number
      // chosen here. `workers/render.test.ts`'s third assertion, on the same marker band.
      const boundaries = timings.segments.slice(1).map((segment) => segment.from);
      // Two, exactly, and pinned rather than "at least one": the fixture is three segments — two
      // spoken with a silent hold between them — and `workers/render.test.ts:314` pins the same
      // number for the same clip. `> 0` passed on a narration that had lost a segment, which is the
      // failure this whole phase exists to catch, so the count is the assertion.
      check(
        boundaries.length === 2,
        `timings.json names ${boundaries.length} boundaries between segments to read the picture ` +
          "at, which is the two render.test.ts pins for this fixture",
      );
      for (const from of boundaries) {
        const [twoBefore, before, on, after] = [from - 2, from - 1, from, from + 1].map((frame) =>
          markerBand(mp4, frame),
        );
        const across = changedShare(before, on);
        const noise = Math.max(changedShare(twoBefore, before), changedShare(on, after));
        check(
          across > 0.002 && across > noise * 10,
          `the scene changes on boundary frame ${from}: ${percent(across)} of the marker band ` +
            `against ${percent(noise)} of frame-to-frame noise either side of it`,
        );
      }

      // The two files the transcript is about, kept where a human can look at them — and kept
      // **before** phase 7, which deletes the still six times over and may not finish.
      copyFileSync(mp4, join(ARTIFACTS, "e2e-toolchain.mp4"));
      copyFileSync(png, join(ARTIFACTS, "e2e-toolchain-still.png"));
      say(`  ..  kept ${join(ARTIFACTS, "e2e-toolchain.mp4")} and e2e-toolchain-still.png`);
    } finally {
      await client.close();
      const stopped = await stopDaemon(daemon.child);
      say(`  ..  the daemon exited ${stopped.code ?? stopped.signal}`);
    }

    section("7 — T16's rollback cases, rerun: the recovered daemon renders");
    const rollback = spawnSync(process.execPath, ["--import", TS_SOURCE_HOOK, ROLLBACK_PROOF], {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: rollbackEnvironment(paths, markerFile),
    });
    for (const [stream, text] of [
      ["out", rollback.stdout ?? ""],
      ["err", rollback.stderr ?? ""],
    ]) {
      for (const line of text.split("\n")) {
        if (line.trim() !== "") {
          say(stream === "out" ? `  ${line}` : `  [rollback err] ${line}`);
        }
      }
    }
    // Thrown rather than asserted through `check`, because a `check` message is a claim and the
    // sentence a reader needs when this fails is what stopped it — which the rerun's own lines,
    // quoted above, have just said.
    if (rollback.status !== 0) {
      throw new Error(
        `the rollback rerun exited ${rollback.status ?? rollback.signal}: not every T16 rollback ` +
          "case ended in a PNG. Its own lines are above and name what stopped it.",
      );
    }
    say(
      "  ok  every T16 rollback case was rerun against this run's browser and workspace, and each " +
        "recovered daemon produced a PNG",
    );
  } finally {
    if (provider?.started === true) {
      provider.stop();
      say(`  ..  ${KOKORO_CONTAINER}, the container this gate started, was stopped`);
    }
  }

  say("");
  say("TOOLCHAIN GATE PASSED");
  rmSync(scratch, { recursive: true, force: true });
  rmSync(STAGE_ROOT, { recursive: true, force: true });
}

main().catch((error) => {
  say("");
  say(`TOOLCHAIN GATE FAILED: ${error.message}`);
  if (scratch !== null) {
    say(`the scratch directory is kept at ${scratch}`);
  }
  say(`the transcript is at ${LOG_PATH}`);
  process.exitCode = 1;
});
