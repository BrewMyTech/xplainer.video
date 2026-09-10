#!/usr/bin/env node
/**
 * Speech with no Docker, no `--tts-url`, no server and no Python: one real video, on this machine.
 *
 * This is the proof the whole ONNX speech plan rests on (`.omc/plans/ralplan-speech-onnx.md` §S6,
 * AC 1–3). Every other route to speech this product has ever had needed something else running: a
 * Kokoro-FastAPI container (route 2), a server somebody else runs (route 1), or a recorded fixture
 * (the test route). The claim here is that a machine with **none of those, and no Python
 * interpreter anywhere on it**, runs `xplainer setup` and then narrates, stills and renders a real
 * MP4 — and that every word of the script comes out the other end audible.
 *
 * `scripts/e2e/render.mjs` is the model for the render half and this file mirrors its assertions
 * deliberately: the same `create → put_source → narrate → still → render` over `mcp --attach`, the
 * same `ffprobe` on the finished MP4, the same frame diff against a captions-disabled control. What
 * is new is everything about *where the speech came from*, and there are five claims:
 *
 * **1 — the machine. Proved, not assumed.** A proof that says "no Docker" and then runs on a laptop
 * with Docker Desktop running has proved nothing. So the child environment is built with `docker`,
 * `python` and `python3` unreachable, and the proof then *asks the product's own question*: it
 * spawns each of the three exactly as `setup/providers/speech-docker.ts` spawns `docker` and
 * requires the answer to be `ENOENT`. `XPLAINER_TTS_URL`, `XPLAINER_TTS_FIXTURE` and `KOKORO_URL`
 * are removed from the environment and asserted absent — all three, because
 * `workers/speech.ts`'s precedence is fixture, then either URL variable, then the in-process
 * engine, and a `KOKORO_URL` a developer exported months ago for the reference implementation would
 * silently win. The transcript prints what it checked and what it dropped to check it.
 *
 * **Why the `PATH` is composed rather than filtered, which is a correction.** This proof first
 * *subtracted*: it dropped every directory of the parent's `PATH` that resolved any of the three
 * whole, since a directory is the only unit a `PATH` has. That form passed on macOS by luck of
 * layout and failed on both other platforms inside its own arrangement — workflow run 34488355426
 * is the record. On Linux `/usr/bin` resolves `python3`, so it was dropped, and it took **`sh`**
 * with it; `npm ci` then died in `esbuild`'s `postinstall` with `npm error syscall spawn sh` and
 * exit `254`, which is the exact hazard `apps/cli/AGENTS.md` §`src/setup/` documents for D8. On
 * Windows it dropped `C:\Windows\system32`, where nearly every system tool lives, and *still* found
 * `python` afterwards, because a Windows Store execution alias is a reparse point `existsSync`
 * cannot see and `spawn` launches anyway. A subtraction therefore removed what the run needed and
 * missed what it was for, in one go.
 *
 * So the child's `PATH` is **one directory this proof creates and fills**, holding nothing but the
 * executables named in {@link allowList} — a symlink where the platform allows one, a hard link or
 * a copy where it does not, and a forwarding `.cmd` for the one Windows entry that reads its own
 * location. A forbidden binary cannot resolve because nothing ever put it within reach, and nothing
 * essential can go missing because the list is explicit, printed with the reason each entry is on
 * it, and asserted twice: every name on it must resolve in the child, and the directory must
 * contain nothing else. The parent's `PATH` is then audited for the record — every directory
 * `spawn` can still reach `docker`, `python` or `python3` through is named, and so is whether
 * `existsSync` could see the file, which is how the Windows alias is caught saying one thing to a
 * scan and another to a spawn.
 *
 * **On Windows, reachability is a question only `spawn` can answer, and `stat` answers it wrongly —
 * in both directions.** This is the general rule, it is worth more than either fix that taught it,
 * and anything in this repository that decides "can this file be executed on this machine" will meet
 * it. Two measured instances, and they fail *opposite* ways, which is what makes the rule a rule
 * rather than a workaround for one platform quirk:
 *
 * - **Absent to `stat`, runnable by `spawn`.** `%LOCALAPPDATA%\Microsoft\WindowsApps` holds *app
 *   execution aliases* — `APPEXECLINK` reparse points that Windows ships for `python.exe` and
 *   `python3.exe` whether or not any Python is installed. `existsSync` (and every `stat`, `lstat`
 *   and `realpath` under it) reports such a path as **absent**; `CreateProcess`, and therefore
 *   `spawn`, launches it. Measured on `windows-latest`, run 34490218766: the audit reaches `python`
 *   and `python3` through that directory and sees no file at either name. A subtractive `PATH`
 *   filter could therefore never have removed them.
 * - **Present to `stat`, unspawnable.** npm writes **three** files per binary into
 *   `node_modules/.bin` on Windows — `remotion`, `remotion.cmd` and `remotion.ps1` — and the
 *   extensionless one is a `#!/bin/sh` script. `existsSync` says yes and `CreateProcess` refuses it,
 *   so `spawnSync` returns with no `status`, no `signal` and neither stream: **no process was
 *   created**. Measured on `windows-latest`, run 34492604497, where an `existsSync` gate on that
 *   exact path passed and the spawn 320 lines later died as `control exited null`. And the shim with
 *   the extension is no answer either — a `.cmd` is what libuv refuses without `shell: true` since
 *   the CVE-2024-27980 fix, which is the defect `apps/cli/src/setup/providers/workspace.ts` was
 *   fixed for one layer down. What is spawnable on every platform is a **script under an explicit
 *   interpreter**, which is why the control render below runs the manifest's own `remotion_entry`
 *   under `process.execPath`, exactly as `toolchain.mjs` and `runtime.mjs` do.
 *
 * So a filesystem check is not a weaker version of the real check, it is a **different answer**.
 * Probe executable reachability by spawning; where a gate must be a `stat`, make it a `stat` of the
 * file that will actually be spawned, so the arrangement fails on the arrangement.
 *
 * **2 — the acquisition.** A real `xplainer setup` in a scratch state directory, with the reviewed
 * manifest this checkout commits (nothing is published to the address `setup` would otherwise read,
 * `docs/ROADMAP.md` §2.5) and **no `--tts-url`**. `providers/speech.ts` then walks its four routes
 * in order: `--tts-url` is not given, `docker` is unavailable — which is what the composed `PATH`
 * is *for*, and not a side effect of it — and `onnx` acquires the model graph, one voice and this
 * platform's ONNX Runtime, each pinned by digest and each from its own upstream home. That is
 * ~204 MB across two hosts (HuggingFace twice, the npm registry twice), on top of the ~100 MB
 * browser and the workspace install. The marker is then read back the way the install preflight
 * reads it: `provider` is `onnx`, and **every** path in `speech.files[]` exists and is still the
 * length it was recorded at.
 *
 * **3 — every word in the script is audible (AC 2, plan D5).** This is the assertion this file
 * exists for, and it is the one the superseded plan did not know it needed. Upstream Kokoro builds
 * its G2P with `unk=''` and filters unknown symbols away, so an out-of-dictionary word does not
 * mispronounce — it *vanishes*, logging a warning nobody reads, and in a product where the
 * narration fixes every scene boundary that is a correctness defect. So the narration is written to
 * be hostile: seven terms that only the curated lexicon can pronounce (`Kubernetes`, `nginx`,
 * `PostgreSQL`, `gRPC`, `systemd`, `webhook`, `idempotent`), a possessive, ordinary prose that must
 * come from CMUdict, and one word — `frobnicator` — that no dictionary anywhere carries and that
 * therefore *must* arrive through the letter-to-sound ruleset. Then `captions.json` is compared
 * against the script as a **multiset**: not "is every distinct word present" but "does every
 * occurrence appear", so a dropped second `the` fails as loudly as a dropped `Kubernetes`, and the
 * failure names the words on both sides rather than a count.
 *
 * **4 — the timings are the model's own.** `timing.ts` derives every word span from `pred_dur`,
 * the graph's per-token duration array, so the properties worth asserting are the ones an alignment
 * estimate would break: monotonic, non-overlapping, inside the audio, and — the sharp one — the
 * first word's start against the **audible onset of the WAV itself**, found here by walking the
 * samples for the first one above −40 dBFS. The synthesiser lane measured that gap at 13–41 ms
 * (mean 29) against the same measurement and this proof measures 51.9 ms on its own first word, so
 * {@link FIRST_WORD_ONSET_MS} is 100 — twice the headroom, and a small fraction of what a
 * mis-derived duration-unit-to-seconds ratio would put it out by. Every pronunciation the G2P
 * *derived* rather than looked up is then read out of the job's own log tail, which is how D5's
 * "never silent" holds in practice rather than in principle.
 *
 * **The narration worker's exit code is asserted explicitly, and that is a guard rather than
 * tidiness.** The synthesiser lane saw the ONNX Runtime addon abort once at process teardown —
 * `libc++abi: recursive_mutex lock failed`, after every segment had been written and the worker had
 * nothing left to do — and could not reproduce it in eleven further runs. A proof that runs four
 * segments through one worker process is the shape most likely to surface it again, and a job whose
 * files are all on disk looks like success from the outside. `explainer_job` reports `exit_code`;
 * this asserts it is `0`, so a teardown abort is a red proof rather than a green one.
 *
 * **5 — the product selects the route, and this proof supplies no coordinate at all.** It used to
 * supply three: the narration worker resolved the engine through `speech/locate.ts`'s
 * `onnxSpeechFromEnvironment`, so until plan S5 landed it spoke only for a caller who exported
 * `XPLAINER_ONNX_MODEL`, `XPLAINER_ONNX_VOICE` and `XPLAINER_ONNX_RUNTIME` — and this file read
 * those three paths out of the `toolchain.json` `setup` had just written and exported them. That is
 * exactly the gap S5 closed (`setup/speech-locate.ts`): `resolveSpeech()` now reads the marker, so
 * **the three lines are gone** and the whole `XPLAINER_ONNX_*` set is scrubbed from the child rather
 * than set by it. What proves the selection is the daemon's own provenance line, and it is asserted
 * in two halves: that it says `kokoro in this process`, and that the route it names is
 * `recorded by setup in <state>/toolchain.json` — the record, not a variable. A regression that put
 * the engine back behind three variables would leave this proof unable to narrate at all, which is
 * the point of taking them away.
 *
 * **It is not part of `pnpm verify`, and it must not become part of it.** One run downloads ~204 MB
 * of model, voice and runtime, a ~100 MB browser, and a 247-package workspace; then it renders a
 * video twice. Measured end to end on darwin-arm64 on 2026-09-10: **84.1 s**, of which `setup` is
 * 35.7 s and the four-segment narration 14.8 s. That is a warm npm cache and a fast link, and a
 * cold CI runner pays a great deal more — from three upstream hosts, none of which a gate on every
 * commit may depend on. `apps/cli`'s own suites cover this code against a fake runtime and a
 * recorded voice pack and are what CI runs; this is the periodic proof that the recording still
 * matches the world.
 *
 * Run it:
 *
 * ```bash
 * pnpm e2e:speech
 * ```
 *
 * Environment it reads: `COLLIE_ARTIFACTS_DIR` (default `<repo>/.session/artifacts`),
 * `XPLAINER_FFMPEG` and `XPLAINER_FFPROBE` (default: whatever is on `PATH`). It reads
 * `XPLAINER_TTS_URL`, `XPLAINER_TTS_FIXTURE`, `KOKORO_URL` and the `XPLAINER_ONNX_*` set only to
 * refuse to pass them on.
 *
 * Everything it prints is also written to `<artifacts>/e2e-speech.log`, line by line as it happens,
 * so a run that dies mid-render still leaves its transcript behind.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** The repository root, two levels up from this file. */
const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** The built CLI. `pnpm turbo build` below is what guarantees it is this commit's. */
const CLI = join(REPO, "apps", "cli", "dist", "bin.js");

/**
 * The reviewed manifest this checkout commits, which is what `setup --manifest` names.
 *
 * Named rather than left to the default for the reason `render.mjs` and `toolchain.mjs` both name
 * it: nothing is published to the address `setup` would otherwise read (`docs/ROADMAP.md` §2.5), so
 * a run without it refuses at the manifest instead of acquiring a browser. The **speech** half
 * needs no manifest at all on this route — the ONNX artefacts are pinned in the source — which is
 * why the refusal that would stop this proof is the browser's and not the model's.
 */
const MANIFEST = join(REPO, "apps", "cli", "src", "setup", "toolchain.manifest.json");

/** `pnpm turbo build`, in the form `execFileSync` takes it (see `runtime.mjs` for the Windows why). */
const PNPM_BUILD =
  process.platform === "win32"
    ? { command: "pnpm.cmd turbo build", args: [], shell: true }
    : { command: "pnpm", args: ["turbo", "build"], shell: false };

/**
 * How long `setup` may take.
 *
 * ~304 MB from three hosts plus a package install, so this is a bound on a *hung* download and
 * nothing tighter. The ONNX runtime tarball alone is 111,735,068 bytes and the npm registry is not
 * always quick about it.
 */
const SETUP_TIMEOUT_MS = 2_700_000;

/** Where the transcript and the sample MP4 are left for a human to look at. */
const ARTIFACTS =
  (process.env.COLLIE_ARTIFACTS_DIR ?? "").trim() || join(REPO, ".session/artifacts");

/** Where the transcript is written, line by line. */
const LOG_PATH = join(ARTIFACTS, "e2e-speech.log");

/** The video this script builds. */
const SLUG = "speech-onnx";

/** The control render: the same video with the caption layer taken out. */
const CONTROL_SLUG = "speech-onnx-nocaptions";

/**
 * The executables that must be unreachable, and each one is load-bearing.
 *
 * `docker` is what selects the route: `providers/speech.ts` puts `onnx` *below* `docker` on
 * purpose, so a machine with an engine records `docker` and this proof would be about a container.
 * `python` and `python3` are the plan's own claim — the Python closure is gone, not merely
 * unused — and the way to prove a closure is gone is to take the interpreter away and still narrate.
 */
const HIDDEN_EXECUTABLES = ["docker", "python", "python3"];

/**
 * Variables that must not reach the child, and why each would invalidate the run.
 *
 * The first three are `workers/speech.ts`'s two higher-precedence routes: a fixture directory beats
 * everything, and either URL variable beats the in-process engine. The `XPLAINER_ONNX_*` set is
 * the step *above* the marker — three explicit paths are an instruction and the marker is a
 * discovery — so a value inherited from a developer's shell would point the engine at a model
 * `setup` did not acquire and this proof would be about that model. Nothing here sets one: since
 * plan S5 the product finds its own engine, and claim 5 in the docblock is what that means.
 */
const SCRUBBED_VARIABLES = [
  "XPLAINER_TTS_FIXTURE",
  "XPLAINER_TTS_URL",
  "KOKORO_URL",
  "XPLAINER_ONNX_MODEL",
  "XPLAINER_ONNX_VOICE",
  "XPLAINER_ONNX_RUNTIME",
  "XPLAINER_ONNX_VOICE_NAME",
];

/** How long each job may take before the script gives up on it. */
const JOB_TIMEOUT_MS = {
  explainer_narrate: 900_000,
  explainer_still: 900_000,
  explainer_render: 1_800_000,
};

/** How long to wait for `serve` to announce readiness. */
const READY_TIMEOUT_MS = 60_000;

/**
 * How many log lines to ask `explainer_job` for, and how many of them to quote.
 *
 * Higher than `render.mjs`'s 200 because two of this proof's assertions are *about* the log: the
 * provenance line the worker writes first, and every derived pronunciation after it. The tail is
 * bounded at the store, so asking for more than exists is free.
 */
const OUTPUT_LINES = 400;
const QUOTED_LINES = 20;

/**
 * The narration, written to be hostile to a G2P (claim 3 in the docblock).
 *
 * Four segments rather than two, because the teardown abort this proof watches for is a
 * many-inferences-in-one-process failure and two segments is a thin test of it. Every word here has
 * been checked against `phonemise()`: the seven lexicon terms resolve from `data/lexicon.txt`, the
 * prose from CMUdict, `timings` and `frobnicator` from the letter-to-sound ruleset, and the
 * possessive `model's` through `resolve.ts`'s possessive rule. Nothing in it is a placeholder — a
 * script of invented words would exercise exactly one of the four layers.
 */
const NARRATION = {
  voice: "af_heart",
  fps: 30,
  segments: [
    {
      id: "before",
      text: "Narration used to need a container, a Python interpreter, and a model server listening on a port.",
    },
    {
      id: "lexicon",
      text: "Now Kubernetes, nginx, PostgreSQL, gRPC and systemd are words this lexicon already knows.",
    },
    {
      id: "timings",
      text: "Every webhook stays idempotent, and the timings come from the model's own duration predictor.",
    },
    {
      id: "tail",
      text: "Even a word like frobnicator, which no dictionary carries, is spoken rather than dropped.",
    },
  ],
};

/**
 * The word that must arrive through the letter-to-sound ruleset, and it is asserted by name.
 *
 * The other derived words in this script are derived by accident of what CMUdict happens to carry
 * (`timings` is not in it, `timing` is), and a lexicon that grows could take any of them over.
 * `frobnicator` is not a word, so no curated lexicon will ever claim it, which is what makes it a
 * stable assertion about layer 3 rather than a hostage to layers 1 and 2.
 */
const MUST_BE_DERIVED = "frobnicator";

/**
 * The agent's half of the video: one component per narration segment id, and one panel under
 * `scenes/` that they share. Nothing here touches an engine-owned file — `Video.tsx`, `Root.tsx`,
 * `Captions.tsx`, `index.ts` and `types.ts` are written by `explainer_create` and refused by
 * `explainer_put_source`, which is the ownership boundary this script also exercises.
 */
const SOURCE_FILES = [
  {
    path: "Scenes.tsx",
    content: `import { useCurrentFrame } from "remotion";
import type { SceneMap } from "./Video";
import { Panel } from "./scenes/Panel";

const PANELS = {
  before: {
    accent: "#4C8DFF",
    kicker: "the old way",
    title: "A container, and a Python closure",
    body: "Speech meant a server somebody had to be running, and a dependency tree nobody could ship.",
  },
  lexicon: {
    accent: "#F2B33D",
    kicker: "the lexicon",
    title: "Kubernetes, nginx, PostgreSQL",
    body: "A curated pronunciation for the words this product is actually about.",
  },
  timings: {
    accent: "#5BD6A0",
    kicker: "the timings",
    title: "From the model's own predictor",
    body: "Every word span is accumulated from the per-token durations the graph returned.",
  },
  tail: {
    accent: "#E2668F",
    kicker: "the rule",
    title: "Nothing is dropped in silence",
    body: "A word no dictionary carries is derived and logged, never deleted from the audio.",
  },
} as const;

const panel = (id: keyof typeof PANELS): React.FC => {
  const Scene: React.FC = () => <Panel {...PANELS[id]} frame={useCurrentFrame()} />;
  return Scene;
};

export const scenes: SceneMap = {
  before: panel("before"),
  lexicon: panel("lexicon"),
  timings: panel("timings"),
  tail: panel("tail"),
};
`,
  },
  {
    path: "scenes/Panel.tsx",
    content: `import { AbsoluteFill, interpolate } from "remotion";

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
 * around it is exactly what a control has to do — so the control video is rendered by the pinned
 * Remotion CLI directly, out of the daemon's sight.
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
 * frame has to be. `render.mjs`'s numbers, for `render.mjs`'s reason: the caption plate is the same
 * colour as the scene behind it, so the only pixels that can move are the glyphs of one line of
 * 48 px type, which inks something like a twentieth of the band.
 */
const CAPTION_BAND_MIN_CHANGE = 0.01;
const CONTROL_BAND_MAX_CHANGE = 0.005;

/**
 * How far the first word's recorded start may sit from the audible onset of the track.
 *
 * The synthesiser lane measured 13–41 ms, mean 29, against this same measurement — the duration
 * predictor's own small lateness rather than any arithmetic here. **This proof measured 51.9 ms**
 * (darwin-arm64, 2026-09-10), and the difference is the word rather than the mechanism: its first
 * word opens with the nasal of `Narration`, which crosses −40 dBFS while it is still ramping, so
 * the onset is found early and the gap reads long. So the bound has roughly twice the observed
 * headroom rather than three times it, and it is deliberately not tighter, because the regressions
 * it is for are large. A duration-unit ratio taken as the published `/80` instead of being derived
 * from `waveform.length` (plan D6) puts the first word out by hundreds of milliseconds and the last
 * by seconds; a style row read as `pack[0]` instead of `pack[len-1]` moves a clip's length by 17%
 * on average. Neither survives 100 ms, and CPU inference over a pinned graph and a pinned voice is
 * deterministic, so what a tighter bound would buy is flakiness rather than sensitivity.
 */
const FIRST_WORD_ONSET_MS = 100;

/**
 * The amplitude the first audible sample must exceed, as a fraction of full scale.
 *
 * 0.01 is −40 dBFS. The clip this engine returns is untrimmed and carries a head of noise floor
 * below −66 dBFS before the first phoneme, and the track builder prepends `LEAD_IN_MS` of digital
 * silence in front of that. So any threshold near zero lands on that noise floor — 329 ms before
 * the voice, in the run measured here — and reports an onset that has nothing to do with speech.
 * −40 dBFS is over the floor and under the voice, which is the only band that finds the voice.
 */
const AUDIBLE_LEVEL = 0.01;

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

/**
 * Run a command with both its streams captured into the transcript.
 *
 * `execFileSync` forwards a child's stderr to this process's own, which leaves it out of the log
 * file — and the log file is the artefact. Anything whose output is evidence goes through here.
 *
 * **`result.error` is read, and that is a correction rather than a nicety.** A child that never
 * started has no `status`, no `signal` and neither stream, so every field this helper used to look
 * at is empty and `result.error` is the only one holding the answer. Leaving it unread made a
 * `CreateProcess` refusal on Windows report itself as `control exited null:` with nothing after the
 * colon — a failure that names neither the errno nor the argv, over a transcript with no line about
 * the child at all (run 34492604497). It is now both appended to the transcript and put in the
 * thrown message, and a child that never started says so in those words rather than borrowing the
 * vocabulary of one that ran and exited. `runtime.mjs` and `toolchain.mjs` do the transcript half of
 * this in their own `spawnLogged`; `render.mjs` does neither, and its `.bin` spawn is the same
 * arrangement this file has just stopped using.
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
  if (result.error !== undefined) {
    appendFileSync(LOG_PATH, `  [${label} error] ${result.error.message}\n`);
  }
  if (result.status !== 0) {
    throw new Error(
      result.error === undefined
        ? `${label} exited ${result.status ?? result.signal}: ${(result.stderr ?? "").trim().slice(-800)}`
        : `${label} never started: ${result.error.message} — the command was ${command} ${args.join(" ")}`,
    );
  }
  return result.stdout ?? "";
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

/** `%SystemRoot%\System32`, where every bare-named Windows tool below actually lives. */
function system32() {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32");
}

/** The first `stem` the parent's own `PATH` resolves, or `fallback` when it resolves none. */
function fromParentPath(stem, fallback) {
  return onPath(process.env.PATH ?? "", stem) ?? fallback;
}

/**
 * Every executable the child is allowed to resolve, and the reason each one is on the list.
 *
 * This *is* the child's `PATH` — one directory, this many files — so the list is the whole security
 * argument and every entry has to earn its place out of something the product genuinely spawns by
 * name. Read as a table:
 *
 * - `file` is what lands in the toolbox directory, and `spawnedAs` is the string the product hands
 *   to `spawn`. They differ only on Windows, where `node` is reached through `PATHEXT` and
 *   `installCommand()` spells npm's `.cmd` out in full.
 * - `target` is the real executable on this machine, taken from the parent's own `PATH` wherever
 *   there is one to take it from, so the child runs the same `node` and the same `npm` the run
 *   itself is using rather than some other copy.
 * - `probe` is an argv that is cheap and cannot hang, used only to ask whether `spawn` resolves the
 *   name at all. Its exit status is not asserted — `sh -c 'exit 0'` and `icacls /?` do not agree
 *   about what success looks like, and the question here is resolution.
 *
 * **`git` and `ffmpeg` are deliberately not here, and that is a measurement rather than an
 * oversight — do not add them back.** Both are the obvious guesses for "what an install and a
 * render need", and the subtractive form of this proof settled the question by accident: it dropped
 * `/usr/bin`, `/usr/local/bin` and `/opt/homebrew/bin` on macOS, which between them are every `git`
 * and every `ffmpeg` on that machine, and `npm ci` still resolved the template's 247 packages and
 * both renders still came out. The reasons hold generally, not just on that machine: the template's
 * lockfile carries no `git+` dependency, so npm never shells out to git; Remotion ships its own
 * compositor and invokes it by absolute path, so no render reads `ffmpeg` from `PATH`; and the
 * `ffmpeg` and `ffprobe` *this script* runs are the **parent's**, resolved by {@link resolveTool}
 * outside the child entirely. An entry added here on suspicion rather than on a spawn the product
 * actually makes is one more executable the child can reach, which is the one thing this
 * arrangement exists to prevent.
 */
function allowList() {
  if (process.platform === "win32") {
    return [
      {
        file: "node.exe",
        spawnedAs: "node",
        target: process.execPath,
        probe: ["--version"],
        why: "esbuild's postinstall calls bare `node`, reached through PATHEXT as node.exe",
      },
      {
        file: "npm.cmd",
        spawnedAs: "npm.cmd",
        target: fromParentPath("npm", join(dirname(process.execPath), "npm.cmd")),
        probe: ["--version"],
        forward: true,
        why:
          "npm's own lifecycle scripts may invoke `npm` by name. The product no longer does — the " +
          "resolve route spawns `<interpreter> npm-cli.js` since the EINVAL fix — and this entry " +
          "is kept rather than dropped because no run has ever been made without it, so its " +
          "necessity is untested either way and a 2x runner is the wrong place to find out",
      },
      {
        file: "cmd.exe",
        spawnedAs: "cmd.exe",
        target: process.env.ComSpec ?? join(system32(), "cmd.exe"),
        probe: ["/c", "exit 0"],
        why: "npm runs every lifecycle script through it, and libuv runs every `.cmd` through it",
      },
      {
        file: "powershell.exe",
        spawnedAs: "powershell.exe",
        target: fromParentPath(
          "powershell",
          join(system32(), "WindowsPowerShell", "v1.0", "powershell.exe"),
        ),
        probe: ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
        why: "the daemon's Job Object keeper, its pipe descriptor and worker-identity all use it",
      },
      {
        file: "taskkill.exe",
        spawnedAs: "taskkill",
        target: fromParentPath("taskkill", join(system32(), "taskkill.exe")),
        probe: ["/?"],
        why: "`treeKillCommand()`, the teardown a worker with no Job Object keeper falls back to",
      },
      {
        file: "icacls.exe",
        spawnedAs: "icacls",
        target: fromParentPath("icacls", join(system32(), "icacls.exe")),
        probe: ["/?"],
        why: "`windows-acl.ts` restricts the state directory and the token to their owner with it",
      },
    ];
  }
  const posix = [
    {
      file: "node",
      spawnedAs: "node",
      target: process.execPath,
      probe: ["--version"],
      why: "esbuild's postinstall calls bare `node`, and every `#!/usr/bin/env node` shim npm links into the workspace's `.bin` resolves it through PATH",
    },
    {
      file: "npm",
      spawnedAs: "npm",
      target: fromParentPath("npm", join(dirname(process.execPath), "npm")),
      probe: ["--version"],
      why:
        "npm's own lifecycle scripts may invoke `npm` by name. The product no longer does — the " +
        "resolve route spawns `<interpreter> npm-cli.js` on every platform now — and this entry is " +
        "kept because no run has ever been made without it",
    },
    {
      file: "sh",
      spawnedAs: "sh",
      target: fromParentPath("sh", "/bin/sh"),
      probe: ["-c", "exit 0"],
      why: "npm runs every lifecycle script through `sh -c`, so a PATH with no shell fails at `spawn sh ENOENT` before an interpreter could be looked for at all",
    },
  ];
  if (process.platform === "darwin") {
    posix.push(
      {
        file: "ps",
        spawnedAs: "ps",
        target: fromParentPath("ps", "/bin/ps"),
        probe: ["-o", "pid=", "-p", String(process.pid)],
        why: "`processStartToken()` reads a worker's start time from it on darwin (linux uses /proc)",
      },
      {
        file: "sysctl",
        spawnedAs: "sysctl",
        target: fromParentPath("sysctl", "/usr/sbin/sysctl"),
        probe: ["-n", "kern.boottime"],
        why: "`machineBootId()` reads kern.boottime from it on darwin (linux uses /proc)",
      },
    );
  }
  return posix;
}

/**
 * `base` with every spelling of `PATH` removed and exactly one put back.
 *
 * Windows environment names are case-insensitive and the parent's is spelled `Path`, so a filtered
 * copy of `process.env` that then assigns `PATH` hands the child **two** of them — and which one a
 * lookup answers with is settled by a `qsort` over keys libuv compares case-insensitively, not by
 * anything written here. Dropping every variant first is what makes the composed `PATH` the child's
 * only one. `PATHEXT` is not a variant and is left alone: Windows needs it to resolve `node` from
 * `node.exe` at all.
 */
function withPath(base, value) {
  const env = {};
  for (const [name, existing] of Object.entries(base)) {
    if (name.toLowerCase() !== "path") {
      env[name] = existing;
    }
  }
  env.PATH = value;
  return env;
}

/**
 * Put one allow-list entry in the toolbox, by the cheapest mechanism the platform allows.
 *
 * A symlink where there is one to be had, a hard link where a symlink needs a privilege the runner
 * may not have — Windows — and a copy where neither works. All three are equivalent for the entries
 * here, because every one of them is either a self-contained executable or a script that locates
 * its own package through the parent directory of its *real* path.
 *
 * The exception is `npm.cmd`, and it is why `forward` exists. That file reads `%~dp0` to find
 * `node_modules\npm\bin\npm-cli.js` beside itself, so a link or a copy of it in a directory holding
 * six files looks for npm inside the toolbox and does not find it. A two-line forwarding shim keeps
 * the real one in the place it can still read.
 */
function place(directory, entry) {
  const destination = join(directory, entry.file);
  if (entry.forward === true) {
    writeFileSync(
      destination,
      `@ECHO OFF\r\nCALL "${entry.target}" %*\r\nEXIT /B %ERRORLEVEL%\r\n`,
      "utf8",
    );
    return `a forwarding .cmd shim to ${entry.target}`;
  }
  const failures = [];
  for (const [how, attempt] of [
    ["symlinked", () => symlinkSync(entry.target, destination)],
    ["hard-linked", () => linkSync(entry.target, destination)],
    ["copied", () => copyFileSync(entry.target, destination)],
  ]) {
    try {
      attempt();
      return `${how} from ${entry.target}`;
    } catch (error) {
      failures.push(`${how}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`${entry.file} could not be placed in ${directory} — ${failures.join("; ")}`);
}

/**
 * Ask the product's own question of an executable: does `spawn` find it?
 *
 * `setup/providers/speech-docker.ts` decides whether this machine has an engine with
 * `spawnSync("docker", …)` and treats an `ENOENT` as "no docker here". So the assertion is that
 * exact spawn, under the exact environment and the exact cwd the artefact will run in — not a
 * `PATH` scan, which would be this proof checking its own arithmetic instead of the mechanism, and
 * which is precisely the check a Windows execution alias walks past.
 */
function spawnFinds(stem, argv, env) {
  const result = spawnSync(stem, argv, {
    cwd: REPO,
    env,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error !== undefined && result.error.code === "ENOENT") {
    return null;
  }
  return {
    status: result.status,
    error: result.error === undefined ? null : result.error.code,
    said: (result.stdout ?? "").trim().split("\n")[0] ?? "",
  };
}

/**
 * Every directory of the parent's `PATH` a hidden executable is still reachable through, and how.
 *
 * Not used to build anything — the child's `PATH` is composed and this audit changes none of it.
 * It is the evidence, and it earns its place by reporting **two** answers per hit: what `existsSync`
 * can see, and what `spawn` can reach. Those disagree on Windows, where an execution alias under
 * `%LOCALAPPDATA%\Microsoft\WindowsApps` is a reparse point `stat` reports as absent and
 * `CreateProcess` launches happily — the thing that made the subtractive form of this proof fail
 * its own assertion. Each directory is probed with a `PATH` of exactly itself, so a hit names the
 * directory responsible rather than the first one in the list.
 */
function parentPathReach(pathValue) {
  const reach = [];
  for (const directory of pathValue.split(delimiter)) {
    if (directory.trim() === "") {
      continue;
    }
    for (const stem of HIDDEN_EXECUTABLES) {
      const visible =
        executableNames(stem)
          .map((name) => join(directory, name))
          .find((candidate) => existsSync(candidate)) ?? null;
      // Only the invisible case is spawned. Where the file is there to be seen the answer is
      // already known, and running `docker --version` once per directory that has one is the
      // expensive half of this audit for no extra evidence.
      const found =
        visible !== null ||
        spawnFinds(stem, ["--version"], withPath(process.env, directory)) !== null;
      if (found) {
        reach.push({ directory, stem, visible });
      }
    }
  }
  return reach;
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
 * A 16-bit PCM WAV, from its own chunk list.
 *
 * Walked here rather than asked of ffprobe because two claims below are about whether
 * `timings.json` and `captions.json` agree with the file the narration port wrote, and ffprobe
 * would answer from the same container metadata the writer produced. The chunk walk is the
 * independent measurement, and it is also the only way to reach the *samples* — which is what the
 * onset assertion needs.
 */
function readWav(path) {
  const wav = readFileSync(path);
  if (
    wav.subarray(0, 4).toString("ascii") !== "RIFF" ||
    wav.subarray(8, 12).toString("ascii") !== "WAVE"
  ) {
    throw new Error(`${path} is not a RIFF/WAVE file`);
  }
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let byteRate = 0;
  let data = null;
  while (offset + 8 <= wav.length) {
    const id = wav.subarray(offset, offset + 4).toString("ascii");
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = wav.readUInt16LE(offset + 10);
      sampleRate = wav.readUInt32LE(offset + 12);
      byteRate = wav.readUInt32LE(offset + 16);
      bitsPerSample = wav.readUInt16LE(offset + 22);
    } else if (id === "data") {
      data = wav.subarray(offset + 8, offset + 8 + Math.min(size, wav.length - offset - 8));
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (byteRate === 0 || data === null || data.length === 0) {
    throw new Error(`${path} has no fmt or data chunk`);
  }
  if (bitsPerSample !== 16) {
    throw new Error(`${path} is ${bitsPerSample}-bit; this gate reads 16-bit integer PCM only`);
  }
  return { channels, sampleRate, byteRate, data, durationMs: (data.length / byteRate) * 1000 };
}

/**
 * Where the voice starts, in milliseconds from the beginning of the track.
 *
 * The first sample whose magnitude exceeds {@link AUDIBLE_LEVEL}, which on this track means the
 * first sample of speech: everything before it is the lead-in silence and the model's own noise
 * floor. Returned with the peak, because a track that never crosses the threshold is a silent
 * render — the failure that looks identical to success from inside Node — and the number is what
 * says so.
 */
function audibleOnset(wav) {
  const samples = wav.data.length / 2;
  let peak = 0;
  let onset = null;
  for (let index = 0; index < samples; index += 1) {
    const level = Math.abs(wav.data.readInt16LE(index * 2)) / 32768;
    if (level > peak) {
      peak = level;
    }
    if (onset === null && level > AUDIBLE_LEVEL) {
      onset = index;
    }
  }
  return {
    peak,
    sample: onset,
    ms: onset === null ? null : (onset / wav.channels / wav.sampleRate) * 1000,
  };
}

/**
 * The words a listener must hear, as the script spells them.
 *
 * Whitespace-separated, stripped of the punctuation around each token and of nothing inside it, so
 * `frobnicator,` is `frobnicator` and `model's` stays `model's`. It agrees with `g2p/tokenise.ts`
 * on this script and shares no code with it, deliberately: a comparison drawn through the product's
 * own tokeniser would agree with the product about a word the product had lost.
 */
function scriptWords(text) {
  return text
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((word) => word !== "");
}

/** How many times each member of `words` appears. */
function tally(words) {
  const counts = new Map();
  for (const word of words) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

/**
 * What one multiset has that the other does not, as `word×n` strings.
 *
 * A multiset and not a set: "every distinct word survived" is a weaker claim than "every
 * occurrence survived", and the failure D5 is about — a word filtered out of the phoneme string —
 * can perfectly well take the second `the` and leave the first.
 */
function missingFrom(expected, actual) {
  const short = [];
  for (const [word, wanted] of expected) {
    const got = actual.get(word) ?? 0;
    if (got < wanted) {
      short.push(`${word}×${wanted - got}`);
    }
  }
  return short;
}

/** Every file under `root`, recursively, as absolute paths. */
function walkFiles(root) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkFiles(path));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
  return found;
}

/** Start `xplainer serve` and resolve on its one line of stdout. */
/**
 * The drain route, spelled here because this script cannot import `apps/cli/src/server.ts`.
 *
 * `DRAIN_PATH` there is the definition. A divergence does not pass silently: the acknowledgement
 * assertion below quotes the status and the body, so a renamed route fails as a `404` naming the
 * path that was asked for rather than as a shutdown that mysteriously did not happen.
 */
const DRAIN_PATH = "/api/daemon/drain";

/**
 * `POST /api/daemon/drain` over the IPC endpoint, in `node:http` rather than `fetch`.
 *
 * `request({ socketPath })` names a unix socket on POSIX and a **named pipe** on Windows, which is
 * why this needs no new machinery for the platform it exists for. `fetch` has no supported way to
 * name either — that is why the product ships `mcp/socket-fetch.ts`, and that file is TypeScript
 * this script cannot import. The route is registered on the **socket only**, so there is no TCP
 * spelling of this request to fall back to. Mirrors `commands/serve.test.ts`'s `postDrain`.
 */
function postDrain(socketPath) {
  return new Promise((resolve, reject) => {
    const call = request(
      { socketPath, path: DRAIN_PATH, method: "POST", headers: { host: "xplainer.ipc" } },
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
    call.once("error", reject);
    call.end();
  });
}

/**
 * Ask the daemon to stop the way a supervisor on **this** platform asks, and answer with which way.
 *
 * `SIGTERM` on POSIX — what `systemctl --user stop` and `launchctl kill SIGTERM` send, and what
 * ADR 0024's drain is written against. **Windows has no such signal.** `child.kill("SIGTERM")`
 * there is `TerminateProcess`: no handler runs, the six steps never start, and `runtime.json` is
 * left behind. That is not a deduction, it is what this proof measured — `windows-latest`, run
 * 34494707551, where every one of the 90 assertions before this section passed and the section
 * itself reported `the daemon exited on SIGTERM` with no `[daemon]` drain line at all, against
 * macOS's two.
 *
 * So the planned stop there is `POST /api/daemon/drain` over the named pipe, which
 * `apps/cli/src/install/lifecycle.ts` calls "the daemon's own six steps and the only graceful stop
 * Windows has at all", and which `xplainer daemon restart` sends.
 * `commands/serve.test.ts`'s `beginPlannedShutdown` is the same branch in the unit suite and this
 * is the proof's copy of it; the two must not diverge.
 *
 * **The six steps that follow are identical on all three platforms**, which is why every assertion
 * after this call is identical too. The mechanism differs; the outcome asserted does not — and it
 * is asserted rather than assumed: `serve.test.ts`'s own drain-route case measures `exit.code === 0`
 * and a removed `runtime.json` after a `202`, exactly as the signal produces them. This is a branch
 * in the arrangement and deliberately **not** a `.skipIf`: both platforms have a documented,
 * working route to the same end state, so there is nothing here to decline to prove.
 */
async function beginPlannedShutdown(child, socketPath) {
  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    return "SIGTERM";
  }
  const acknowledgement = await postDrain(socketPath);
  check(
    acknowledgement.status === 202,
    `POST ${DRAIN_PATH} over ${socketPath} was acknowledged (${acknowledgement.status} ` +
      `${acknowledgement.body.trim()}) — Windows has no SIGTERM, so this is the planned stop there`,
  );
  return `POST ${DRAIN_PATH}`;
}

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
 * The refusal is read **before** anything is parsed, for the reason `render.mjs` records: a tool
 * that fails answers with prose in `content[0].text` and no structured content, so parsing first
 * turns the sentence that says what is wrong into a JSON syntax error about its first character.
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
      return { job, sequence, polls, seconds: (Date.now() - started) / 1000 };
    }
    if (Date.now() - started > timeout) {
      throw new Error(`job ${jobId} (${jobType}) was still ${job.status} after ${timeout} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, polls < 8 ? 20 : 500));
  }
}

/**
 * Enqueue one job, then poll it, asserting the sequence P1-5 requires and the exit code the
 * teardown-abort watch is about.
 *
 * The first `queued` is the enqueueing tool's own answer — the schema requires it to report that
 * state, and it is the only place `queued` can be *seen* for a job the runner starts within
 * milliseconds. `exit_code` is asserted here rather than at one call site because every worker this
 * proof runs is a process that could abort after finishing its work, and a job whose files are all
 * on disk looks like success from the outside.
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
  check(
    finished.job.exit_code === 0,
    `${name}'s worker process exited 0 — not merely "done" — so nothing aborted after it had ` +
      `finished its work (observed ${String(finished.job.exit_code)})`,
  );
  return { job: finished.job, seconds: finished.seconds };
}

async function main() {
  const wallClockStarted = Date.now();
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(LOG_PATH, "");

  say(`xplainer speech end-to-end — ${stamp()}`);
  say(`  repository:  ${REPO}`);
  say(`  node:        ${process.version} (${process.platform} ${process.arch})`);
  say(`  ffmpeg:      ${ffmpeg}`);
  say(`  ffprobe:     ${ffprobe}`);
  say(`  artifacts:   ${ARTIFACTS}`);

  section("build");
  const built = run(PNPM_BUILD.command, PNPM_BUILD.args, { cwd: REPO, shell: PNPM_BUILD.shell });
  for (const line of built.trim().split("\n").slice(-6)) {
    say(`  ${line}`);
  }
  check(existsSync(CLI), `the CLI is built at ${CLI}`);

  section("the machine: no docker, no python, no server");
  scratch = mkdtempSync(join(tmpdir(), "xplainer-e2e-speech-"));
  const stateDir = join(scratch, "state");
  const workspace = join(scratch, "workspace");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  say(`  state dir:   ${stateDir}`);
  say(`  workspace:   ${workspace}`);

  // THE CHILD'S `PATH` IS BUILT, NOT FILTERED. One directory, filled with the executables
  // `allowList()` names and nothing else, so `docker`, `python` and `python3` are unreachable
  // because no directory that holds one is on it — and `sh` cannot go missing on the way, which is
  // how the subtractive form of this arrangement broke Linux.
  const toolbox = join(scratch, "path");
  mkdirSync(toolbox, { recursive: true });
  const allowed = allowList();
  for (const entry of allowed) {
    check(
      existsSync(entry.target),
      `the ${entry.spawnedAs} this run is itself using is at ${entry.target}, so the child can ` +
        "have the same one",
    );
  }
  for (const entry of allowed) {
    say(`  PATH/${entry.file}: ${place(toolbox, entry)}`);
    say(`    ${entry.why}`);
  }

  const env = withPath(
    Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !SCRUBBED_VARIABLES.includes(name)),
    ),
    toolbox,
  );
  env.XPLAINER_STATE_DIR = stateDir;
  env.XPLAINER_VIDEOS_DIR = workspace;
  say(`  the child's whole PATH is ${toolbox}`);

  for (const variable of SCRUBBED_VARIABLES) {
    check(
      env[variable] === undefined,
      `${variable} does not reach the child (it was ` +
        `${process.env[variable] === undefined ? "unset here too" : `${JSON.stringify(process.env[variable])} in this shell`})`,
    );
  }

  // What is in the directory *is* the allow-list, so the directory is read back rather than
  // trusted. An extra file here would be an extra executable the child can reach, and the one
  // mechanism this arrangement rests on is that there is no such thing.
  const placed = readdirSync(toolbox).sort();
  const wanted = allowed.map((entry) => entry.file).sort();
  check(
    placed.join(", ") === wanted.join(", "),
    `the child's PATH is one directory holding exactly the ${wanted.length} executables this proof ` +
      `put there — ${placed.join(", ")} — so a forbidden binary cannot resolve because nothing ` +
      "ever put it within reach",
  );

  // The negative, asked the way the product asks it. `spawnSync(stem)` is `speech-docker.ts`'s own
  // probe, so an `ENOENT` here is the same `ENOENT` that makes route 2 unavailable — and a route
  // this proof believed unavailable while `docker` answered would produce a green run about a
  // container. A `PATH` scan would not do: on Windows it says a Store execution alias is not there
  // and `spawn` launches it anyway, which is what the audit below reports.
  for (const stem of HIDDEN_EXECUTABLES) {
    const found = spawnFinds(stem, ["--version"], env);
    check(
      found === null,
      `spawning ${stem} in the child environment fails with ENOENT — the way ` +
        "providers/speech-docker.ts asks whether this machine has an engine" +
        `${found === null ? "" : `, but it answered ${JSON.stringify(found)}`}`,
    );
  }

  // …and the positive, for every name on the list rather than for the two someone remembered. A
  // machine that can no longer install anything would fail this proof minutes later, inside npm,
  // for a reason that has nothing to do with speech; this is where a missing `sh` is caught.
  for (const entry of allowed) {
    const found = spawnFinds(entry.spawnedAs, entry.probe, env);
    check(
      found !== null,
      `spawning ${entry.spawnedAs} in the child environment resolves ${entry.file}` +
        `${found === null ? "" : ` (${found.said === "" ? `exit ${String(found.status)}` : found.said})`}`,
    );
  }

  // The audit: not used to build anything, and printed because "no Python" is only as good as the
  // evidence that there was a Python to hide. It is also the record of what a subtractive filter
  // would have had to catch, and of the one case it provably cannot.
  const reach = parentPathReach(process.env.PATH ?? "");
  say(`  the parent's PATH reaches a hidden executable through ${reach.length} directory/ies:`);
  for (const hit of reach) {
    say(
      `    ${hit.stem} through ${hit.directory} — ` +
        (hit.visible === null
          ? "and existsSync sees no such file there, so spawn reaches it through an execution " +
            "alias or an extension this scan does not spell: a subtractive filter cannot drop it"
          : `existsSync sees it at ${hit.visible}`),
    );
  }

  section("setup");
  const setupStarted = Date.now();
  const setupOutput = runLogged(
    "setup",
    process.execPath,
    [CLI, "setup", "--state-dir", stateDir, "--manifest", MANIFEST],
    { cwd: REPO, env, timeout: SETUP_TIMEOUT_MS },
  );
  const setupSeconds = (Date.now() - setupStarted) / 1000;
  say(`  setup took ${setupSeconds.toFixed(1)}s`);
  for (const line of setupOutput.trim().split("\n")) {
    say(`  ${line}`);
  }
  check(
    setupOutput.includes("speech: in-process ONNX synthesiser at"),
    "setup took the in-process ONNX route — with no --tts-url given and no docker to be found, " +
      "which is providers/speech.ts's second route and the one this plan is about",
  );
  check(
    setupOutput.includes("speech: took the onnx route"),
    "…and said so in as many words, which is the line a user reads after a 200 MB acquisition",
  );
  // The other half of "print which route it took and why the others were not taken". A route
  // *above* the winner was probed and said why; a route *below* it was never asked, and the two
  // are different facts — "docker was not needed" is not "this machine has no Docker".
  check(
    setupOutput.includes("onnx was chosen over --tts-url <url>"),
    "and it named --tts-url, the one route above the one it took, as not given",
  );
  check(
    setupOutput.includes("docker and bundle sit below it in the precedence and were not probed"),
    "and named the two routes below it as never probed rather than as unavailable — on this " +
      "machine docker is hidden, but setup did not look and must not claim it did",
  );
  check(
    setupOutput.includes("workspace: resolve route"),
    "the workspace came from `npm ci` over the template's own pins, which is the route a machine " +
      "with no staged payload 2 takes",
  );

  const markerPath = join(stateDir, "toolchain.json");
  check(existsSync(markerPath), `setup recorded ${markerPath}`);
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  say(`  speech component: ${marker.speech.version} (${marker.speech.provider})`);
  check(
    marker.speech.provider === "onnx",
    `toolchain.json records the speech provider as ${JSON.stringify(marker.speech.provider)}, and ` +
      '"onnx" is the token `status` and the install preflight branch on',
  );
  check(
    existsSync(marker.speech.path),
    `the model graph it recorded is on this machine at ${marker.speech.path}`,
  );
  check(
    Array.isArray(marker.speech.files) && marker.speech.files.length > 0,
    `the component records the ${marker.speech.files?.length ?? 0} files it is made of, which is ` +
      "what makes the preflight's existence check meaningful for a multi-file component",
  );
  const wrongFiles = marker.speech.files.filter(
    (file) => !existsSync(file.path) || statSync(file.path).size !== file.bytes,
  );
  check(
    wrongFiles.length === 0,
    `every one of the ${marker.speech.files.length} recorded speech files exists and is still the ` +
      `length it was recorded at${wrongFiles.length === 0 ? "" : `; wrong: ${wrongFiles.map((file) => file.path).join(", ")}`}`,
  );
  check(
    existsSync(marker.chrome.path),
    `the browser it recorded is on this machine at ${marker.chrome.path}`,
  );
  const workspaceManifest = join(workspace, "workspace.manifest.json");
  check(
    existsSync(workspaceManifest),
    "the workspace describes what it resolved, which is the half of the render gate a borrowed " +
      "node_modules can never satisfy",
  );
  // The shim and the entry it points at are two different assertions, and this proof needs both.
  //
  // The **shim** is what says npm *linked* the CLI rather than merely unpacking it, which is the
  // property `providers/workspace.ts` requires of both its routes — and it is spelled `remotion.cmd`
  // on Windows. Asking for the extensionless name there is not a harmless simplification: npm writes
  // that file too, as a `#!/bin/sh` script, so the check passed on `windows-latest` and proved
  // nothing about the shim npm had actually generated.
  //
  // The **entry** is the file the burned-captions section spawns, and it is checked here so a
  // missing one fails in the section that is about the workspace rather than 300 lines later in the
  // section that is about captions. It is also the only one of the two that is spawnable on all
  // three platforms; the docblock's second bullet is why.
  const remotionShim = join(
    workspace,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "remotion.cmd" : "remotion",
  );
  check(
    existsSync(remotionShim),
    `and ${remotionShim} resolves in it, which is what says npm linked the CLI`,
  );
  const remotionEntry = join(
    workspace,
    ...JSON.parse(readFileSync(workspaceManifest, "utf8")).remotion_entry.split("/"),
  );
  check(
    existsSync(remotionEntry),
    `…and so does ${remotionEntry}, the entry its own manifest names and the file the control ` +
      "render below is actually spawned as",
  );

  // The three artefacts the synthesiser needs, derived from the layout
  // `providers/speech-onnx.ts` documents and then asserted against the marker's own inventory. The
  // derivation is one line of `join`; the assertion is what makes it a reading of the product's
  // record rather than a guess that happens to be right.
  const speechDir = dirname(marker.speech.path);
  const voicePath = join(speechDir, "voices", "af_heart.bin");
  const runtimeLocation = join(speechDir, "runtime", "onnxruntime-node");
  const recorded = marker.speech.files.map((file) => file.path);
  check(
    recorded.includes(marker.speech.path) && recorded.includes(voicePath),
    `the marker's own file list names both the model and the voice pack at ${voicePath}`,
  );
  check(
    existsSync(join(runtimeLocation, "dist", "index.js")) &&
      existsSync(join(runtimeLocation, "package.json")),
    `the ONNX Runtime is unpacked at ${runtimeLocation}, with Microsoft's own loader in it`,
  );

  // "No Python" is a claim about the closure as well as about the machine, so the acquired tree is
  // walked for a Python file. It is a cheap assertion over ~50 files and it is the difference
  // between "no interpreter is reachable" and "nothing here wanted one".
  const acquired = walkFiles(speechDir);
  const pythonFiles = acquired.filter((path) => path.endsWith(".py") || path.endsWith(".pyc"));
  say(`  the speech component is ${acquired.length} files under ${speechDir}`);
  check(
    pythonFiles.length === 0,
    `not one of them is Python${pythonFiles.length === 0 ? "" : `: ${pythonFiles.join(", ")}`}`,
  );

  // Remotion's **browser cache**, and nothing else, is borrowed from the checkout — the same loan
  // `render.mjs` takes and for the same reason: Remotion resolves it from the render worker's cwd,
  // and a freshly resolved workspace has none, so without this the still job pays for a second copy
  // of the same headless shell inside the measurement. Where there is none to borrow the link is
  // skipped and Remotion fetches its own.
  const remotionCache = join(REPO, "node_modules", ".remotion");
  if (existsSync(remotionCache)) {
    symlinkSync(remotionCache, join(workspace, "node_modules", ".remotion"), "dir");
    say(`  browser cache borrowed from ${remotionCache}`);
  } else {
    say(`  no browser cache at ${remotionCache}; Remotion will fetch its own inside the still job`);
  }

  section("daemon");
  // NO COORDINATE IS SUPPLIED. `env` is the composed environment and nothing else: no
  // `XPLAINER_ONNX_*`, no `XPLAINER_TTS_*`, and `XPLAINER_STATE_DIR` naming the directory `setup`
  // has just written its marker into. Everything the narration worker needs to find the engine it
  // is about to speak with, it reads out of that marker — which is claim 5, and which is asserted
  // on the worker's own provenance line rather than on this script's arithmetic.
  const daemonEnv = env;
  const daemon = startDaemon(daemonEnv);
  const announcement = await daemon.ready;
  say(`  ready line:  ${JSON.stringify(announcement)}`);
  check(typeof announcement.socket === "string", "the ready line names an IPC socket to attach to");
  check(existsSync(announcement.socket), `the socket exists at ${announcement.socket}`);

  section("mcp --attach");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp", "--attach"],
    cwd: REPO,
    env: daemonEnv,
    stderr: "pipe",
  });
  const client = new Client({ name: "xplainer-e2e-speech", version: "1.0.0" });
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
  const narrated = await runJob(client, "explainer_narrate", { slug: SLUG, narration: NARRATION });
  const narrationLines = narrated.job.output.lines;
  say(`  the narration job took ${narrated.seconds.toFixed(2)}s for 4 segments`);
  check(
    narrationLines.some((line) => line.includes("kokoro in this process")),
    "the worker's own provenance line says the speech came from kokoro in this process — not " +
      "from a server, a container or a fixture",
  );
  check(
    narrationLines.some((line) => line.includes(`voice ${NARRATION.voice}`)),
    `…in the voice the acquisition pinned (${NARRATION.voice})`,
  );
  // CLAIM 5. The route was selected by the product out of its own record: this script exports no
  // `XPLAINER_ONNX_*` variable, so the only way the worker can have found the engine is the marker,
  // and the line says which. Before plan S5 this assertion could not exist — the origin would have
  // named the three variables this proof was setting itself.
  check(
    narrationLines.some((line) => line.includes(`route recorded by setup in ${markerPath}`)),
    `…and that it found it in ${markerPath}, which is the record setup wrote: the product selected ` +
      "the route, with no XPLAINER_ONNX_* variable anywhere in this run (plan S5)",
  );

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

  const wav = readWav(audio);
  const drift = Math.abs(wav.durationMs - timings.totalMs);
  say(
    `  narration.wav is ${wav.durationMs.toFixed(3)} ms; timings.json says ${timings.totalMs.toFixed(3)} ms (drift ${drift.toFixed(3)} ms)`,
  );
  check(
    drift < 1,
    `timings.json total equals the WAV duration within 1 ms (drift ${drift.toFixed(3)} ms, P1-2)`,
  );

  section("every word in the script is audible (AC 2, plan D5)");
  const expected = tally(NARRATION.segments.flatMap((segment) => scriptWords(segment.text)));
  const spoken = tally(captions.map((caption) => caption.text.trim()));
  const expectedTotal = [...expected.values()].reduce((sum, count) => sum + count, 0);
  const spokenTotal = [...spoken.values()].reduce((sum, count) => sum + count, 0);
  say(`  the script has ${expectedTotal} words; captions.json carries ${spokenTotal} spans`);
  const missing = missingFrom(expected, spoken);
  const extra = missingFrom(spoken, expected);
  check(
    missing.length === 0,
    `every occurrence of every word in the script appears in captions.json${missing.length === 0 ? "" : `; missing ${missing.join(", ")}`}` +
      " — which is the assertion the whole plan turns on, because upstream Kokoro deletes an " +
      "out-of-dictionary word rather than mispronouncing it",
  );
  check(
    extra.length === 0,
    `and captions.json invents nothing the script did not say${extra.length === 0 ? "" : `; extra ${extra.join(", ")}`}`,
  );
  // Named rather than left to the multiset, so the transcript says out loud that the hostile terms
  // were in it: a script that had quietly lost its lexicon words would still pass a comparison
  // against itself.
  for (const term of [
    "Kubernetes",
    "nginx",
    "PostgreSQL",
    "gRPC",
    "systemd",
    "webhook",
    "idempotent",
    MUST_BE_DERIVED,
  ]) {
    check(
      (spoken.get(term) ?? 0) > 0,
      `"${term}" is one of them — a word only the curated lexicon or the letter-to-sound ruleset ` +
        "can pronounce, and CMUdict carries none of them",
    );
  }

  const derivedLines = narrationLines.filter((line) =>
    line.includes("speech derived a pronunciation for"),
  );
  for (const line of derivedLines) {
    say(`    | ${line}`);
  }
  check(
    derivedLines.length > 0,
    `the job's log tail carries ${derivedLines.length} derived pronunciation(s), which is how D5 ` +
      "holds for the long tail: a guess that announces itself rather than a word that vanishes",
  );
  check(
    derivedLines.some((line) => line.includes(`"${MUST_BE_DERIVED}"`)),
    `and ${JSON.stringify(MUST_BE_DERIVED)} — the word no dictionary carries — is one of them, by ` +
      "name, so this is an assertion about layer 3 and not about what CMUdict happens to hold",
  );

  section("the timings are the model's own");
  let previousEnd = 0;
  const disordered = [];
  for (const caption of captions) {
    if (
      caption.startMs < previousEnd ||
      caption.endMs <= caption.startMs ||
      caption.endMs > wav.durationMs + 1
    ) {
      disordered.push(
        `${JSON.stringify(caption.text.trim())} ${caption.startMs}–${caption.endMs} ms after ${previousEnd} ms`,
      );
    }
    previousEnd = Math.max(previousEnd, caption.endMs);
  }
  check(
    disordered.length === 0,
    `all ${captions.length} word spans run forward, never overlap and end inside the ` +
      `${wav.durationMs.toFixed(0)} ms of audio${disordered.length === 0 ? "" : `; ${disordered.join("; ")}`}`,
  );

  const onset = audibleOnset(wav);
  check(
    onset.ms !== null,
    `the track has audio above ${AUDIBLE_LEVEL} of full scale (peak ${onset.peak.toFixed(4)}) — a ` +
      "silent render looks like a successful one from inside Node",
  );
  const first = captions[0];
  const onsetDelta = first.startMs - onset.ms;
  say(
    `  the voice starts at ${onset.ms.toFixed(1)} ms (sample ${onset.sample}); the first word ` +
      `${JSON.stringify(first.text.trim())} is recorded at ${first.startMs} ms (delta ${onsetDelta.toFixed(1)} ms)`,
  );
  check(
    Math.abs(onsetDelta) < FIRST_WORD_ONSET_MS,
    `the first word's recorded start is within ${FIRST_WORD_ONSET_MS} ms of the audible onset ` +
      `(${onsetDelta.toFixed(1)} ms), so the duration units were converted against this run's own ` +
      "sample count rather than a constant (plan D6)",
  );

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
  await runJob(client, "explainer_render", { slug: SLUG });
  const mp4 = join(workspace, "out", SLUG, "explainer.mp4");
  check(existsSync(mp4), `explainer_render wrote ${mp4}`);

  const listed = await callTool(client, "explainer_list", {});
  const summary = listed.videos.find((video) => video.slug === SLUG);
  say(`  explainer_list: ${JSON.stringify(summary)}`);
  check(summary?.rendered === true, "explainer_list reports the video as rendered");
  check(summary?.has_narration === true, "explainer_list reports the video as narrated");
  check(
    summary?.mp4 === mp4,
    "explainer_list returns the MP4's path, and it is the file probed below",
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
  // component replaced by one that draws nothing. Rendered by the pinned Remotion CLI directly,
  // because the daemon restores an engine-owned file before every render. It runs under the same
  // composed environment as everything else, so the render half of this proof needs no more of a
  // machine than the narration half did.
  //
  // **The CLI is spawned as a script under `process.execPath`, never through `node_modules/.bin`.**
  // Neither file in `.bin` can be spawned on Windows — the extensionless one is a `#!/bin/sh`
  // script `CreateProcess` refuses, and the `.cmd` is what libuv refuses without `shell: true` —
  // and `shell: true` would hand this argv, which carries absolute paths under
  // `C:\Users\RUNNER~1\…`, to `cmd.exe` to re-parse. `toolchain.mjs` and `runtime.mjs` both already
  // spawn the manifest's `remotion_entry` under an explicit interpreter for exactly this reason, so
  // the three proofs now agree. The interpreter is this process's own because this proof runs from a
  // checkout and there is no payload to take one from.
  const controlSource = join(workspace, "videos", CONTROL_SLUG);
  const controlPublic = join(workspace, "public", CONTROL_SLUG);
  cpSync(join(workspace, "videos", SLUG), controlSource, { recursive: true });
  cpSync(publicDir, controlPublic, { recursive: true });
  writeFileSync(join(controlSource, "Captions.tsx"), CAPTIONS_DISABLED, "utf8");
  const controlPng = join(workspace, "out", `${CONTROL_SLUG}.png`);
  runLogged(
    "control",
    process.execPath,
    [
      remotionEntry,
      "still",
      `videos/${CONTROL_SLUG}/index.ts`,
      "Explainer",
      controlPng,
      `--frame=${captionFrame}`,
      "--scale=1",
      `--public-dir=${controlPublic}`,
    ],
    { cwd: workspace, env: daemonEnv },
  );
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
      `pixels, at least ${percent(CAPTION_BAND_MIN_CHANGE)} required): the captions are burned in, ` +
      "at a time the model's own duration predictor decided",
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
  copyFileSync(mp4, join(ARTIFACTS, "e2e-speech.mp4"));
  copyFileSync(audio, join(ARTIFACTS, "e2e-speech-narration.wav"));
  copyFileSync(stillPath, join(ARTIFACTS, "e2e-speech-still.png"));
  copyFileSync(controlPng, join(ARTIFACTS, "e2e-speech-frame-nocaptions.png"));
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
    join(ARTIFACTS, "e2e-speech-frame-captioned.png"),
  ]);
  const megabytes = statSync(mp4).size / 1_048_576;
  say(
    `  e2e-speech.mp4 (${megabytes.toFixed(2)} MB), e2e-speech-narration.wav, e2e-speech-still.png, e2e-speech-frame-captioned.png, e2e-speech-frame-nocaptions.png`,
  );
  say(`  transcript:  ${LOG_PATH}`);

  section("shutdown");
  await client.close();
  const stopped = new Promise((resolve) => {
    daemon.child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
  const asked = await beginPlannedShutdown(daemon.child, announcement.socket);
  const exited = await stopped;
  say(
    `  the daemon exited ${exited.code === null ? `on ${exited.signal}` : `with code ${exited.code}`}`,
  );
  // The message names the mechanism that was actually used. It used to say `SIGTERM` on a platform
  // where no SIGTERM had been delivered, which is the same species of unhelpfulness as the empty
  // `control exited null:` above: a failure that describes something that did not happen.
  check(exited.code === 0, `${asked} shut the daemon down cleanly (exit 0)`);
  check(
    !existsSync(join(stateDir, "runtime.json")),
    "runtime.json is gone after the clean shutdown",
  );

  say("");
  say(`observed job states, in order: ${observed.join(", ")}`);
  say(`  setup:       ${setupSeconds.toFixed(1)}s`);
  say(`  narration:   ${narrated.seconds.toFixed(2)}s for ${timings.segments.length} segments`);
  say(`  wall clock:  ${((Date.now() - wallClockStarted) / 1000).toFixed(1)}s`);
  say(`SPEECH END-TO-END PASSED — ${stamp()}`);
}

main().then(
  () => {
    if (scratch !== null) {
      // The borrowed Remotion browser cache, unlinked by hand before the tree it sits in goes.
      // `rmSync` unlinks a symlink rather than following it, so this is belt and braces — and the
      // braces are worth having when what is on the other end of it is inside the checkout.
      const link = join(scratch, "workspace", "node_modules", ".remotion");
      if (existsSync(link) && lstatSync(link).isSymbolicLink()) {
        unlinkSync(link);
      }
      rmSync(scratch, { recursive: true, force: true });
    }
    process.exit(0);
  },
  (error) => {
    const message = error instanceof Error ? error.message : String(error);
    try {
      say("");
      say(`SPEECH END-TO-END FAILED: ${message}`);
      if (scratch !== null) {
        say(`  the scratch directory is left at ${scratch} for inspection`);
      }
    } catch {
      process.stderr.write(`SPEECH END-TO-END FAILED: ${message}\n`);
    }
    process.exit(1);
  },
);
