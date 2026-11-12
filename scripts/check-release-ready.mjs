#!/usr/bin/env node
/**
 * The release check: the hard condition as a gate (ADR 0031's note of 2026-11-12, D8).
 *
 * ADR 0031 made a rule of it — nothing is released from a tree that still carries the previous
 * renderer's workspace or cannot acquire what a render needs — and Follow-up 8 asked for that rule
 * to be "a gate and not a sentence". This file is the gate. It is **offline**: it reads the
 * working tree and nothing else, so it can run as every published member's `prepublishOnly` and
 * answer the same thing for each of them.
 *
 *   (a) `template-has-no-package-json`        `packages/render-core/template/` holds no
 *       `template-names-no-previous-renderer`  `package.json`, and no file under it names the
 *                                              previous renderer or one of its packages.
 *   (b) `render-rows-recorded`                 every render platform's `browser` and `ffmpeg` row
 *                                              in `apps/cli/src/setup/toolchain.manifest.json` is
 *                                              `recorded` — a digest somebody reviewed, never an
 *                                              `unavailable` placeholder or a missing row.
 *   (d) `release-blockers-closed`              every entry of `docs/release-blockers.json` is
 *                                              closed, with evidence: a run id, a dated ADR note
 *                                              that exists, a commit this repository has, or an
 *                                              owner ask id. An open entry is listed with what
 *                                              closes it. An entry ADR 0031 names may be closed and
 *                                              may never be deleted.
 *
 * Rule (c) — the manifest the CDN serves is byte-identical to the committed copy — needs the
 * network, so it is not here: `scripts/release-publish.mjs` runs it once, after this check and
 * before `pnpm publish -r`, because pnpm publishes one package at a time and a CDN failing
 * between two of them must not leave a release half on the registry.
 *
 * TWO WAYS TO RUN IT.
 *
 *   node scripts/check-release-ready.mjs              the self-tests, then every rule. Red until
 *                                                     every blocker is closed, which is the point.
 *                                                     What `prepublishOnly` and `pnpm
 *                                                     release:publish` run.
 *   node scripts/check-release-ready.mjs --self-test  the self-tests and nothing else. What
 *                                                     `pnpm verify` and CI run, because the rules
 *                                                     themselves have to fire on every commit while
 *                                                     the release they judge is still refused.
 *
 * EVERY RULE CARRIES ITS OWN NEGATIVE TEST, and they run first, on every invocation, for the reason
 * `check-publish-contract.mjs` gives: a gate whose rules cannot be shown to fire is
 * indistinguishable from one that passes vacuously, and this one guards a publish that cannot be
 * taken back. A rule with no self-test is a failure. Samples that name the previous renderer build
 * the word from two halves, so `check-no-remotion.mjs` has nothing to say about this file.
 *
 * Exit codes:
 *   0  ready to publish (or, with `--self-test`, every rule fired and held silent as it should)
 *   1  not ready — at least one rule found a problem — or a rule failed its own test
 *   2  the checker could not run (an argument it does not take, no workspace root, an input file
 *      missing or unparseable)
 *  70  internal error
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_FILE = "pnpm-workspace.yaml";

const TEMPLATE_DIR = "packages/render-core/template";
const TOOLCHAIN_MANIFEST = "apps/cli/src/setup/toolchain.manifest.json";
const BLOCKERS_FILE = "docs/release-blockers.json";
const ADR_DIR = "docs/adr";

/** The previous renderer's name, from two halves, and the pattern `check-no-remotion.mjs` uses. */
const PREVIOUS_RENDERER = ["re", "motion"].join("");
const NAMES_PREVIOUS_RENDERER = new RegExp(
  `@${PREVIOUS_RENDERER}/|\\b${PREVIOUS_RENDERER}\\b`,
  "i",
);

/** The five platforms a render can run on: each needs a browser row and an ffmpeg row. */
const RENDER_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"];

/** The manifest blocks a render reads, by key. `speech` has routes that need no row. */
const RENDER_BLOCKS = ["browser", "ffmpeg"];

/**
 * The blockers ADR 0031's note of 2026-11-12 names under D8, and the ones its plan added. Each
 * must stay in `docs/release-blockers.json` until a release has shipped past it: an entry is
 * closed with evidence, never deleted, because deleting an open one would pass this gate.
 */
const REQUIRED_BLOCKERS = [
  "linux-12fps-run",
  "windows-remote-debugging-pipe",
  "page-network-decision",
  "macos-default-encoder-patent",
  "checklist-a7-pin-snapshot",
  "v2-manifest-upload",
  "cdn-cache-rule-applied",
  "linux-windows-setup-proof",
  "chrome-157-throughput",
];

const BLOCKER_STATUSES = new Set(["open", "closed"]);
const BLOCKER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What a closing piece of evidence may be. `adr-note` is checked against the record itself. */
const EVIDENCE_IDS = {
  run: { pattern: /^\d{6,}$/, describe: "a GitHub Actions run id" },
  commit: { pattern: /^[0-9a-f]{7,40}$/, describe: "a commit hash" },
  "owner-ask": { pattern: /^[0-9a-f]{8}$/, describe: "an owner ask id" },
};

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// The rules. Each is pure over the input its loader builds, so the self-tests can drive it.

function checkTemplateManifest(files) {
  return files.some((file) => file.path === "package.json")
    ? [
        `${TEMPLATE_DIR}/package.json exists. The template is two source files since payload 2 ` +
          "left (ADR 0031 D7); a manifest there is a workspace somebody means to install, and " +
          "nothing installs the workspace any more.",
      ]
    : [];
}

function checkTemplateNames(files) {
  return files
    .filter((file) => NAMES_PREVIOUS_RENDERER.test(file.text))
    .map(
      (file) =>
        `${TEMPLATE_DIR}/${file.path} names the previous renderer or one of its packages. The ` +
        "template is copied onto every user's machine, and the renderer bundles against " +
        "@xplainer/motion alone.",
    );
}

function checkRenderRows(manifest) {
  const problems = [];
  for (const block of RENDER_BLOCKS) {
    const rows = manifest?.[block]?.expected;
    if (rows === null || typeof rows !== "object") {
      problems.push(`${TOOLCHAIN_MANIFEST} has no "${block}.expected" block.`);
      continue;
    }
    for (const platform of RENDER_PLATFORMS) {
      const row = rows[platform];
      if (row === undefined || row === null) {
        problems.push(`${block} has no row for ${platform}, so \`setup\` cannot acquire it there.`);
      } else if (row.status !== "recorded") {
        const reason = typeof row.reason === "string" ? ` (${row.reason})` : "";
        problems.push(
          `${block}.expected.${platform} is ${JSON.stringify(row.status)}, not "recorded"` +
            `${reason}. A release ships the digest somebody reviewed, never a placeholder.`,
        );
      }
    }
  }
  return problems;
}

/** Why one evidence item does not close anything, or `null` when it does. */
function evidenceProblem(evidence, { adrText, commitExists }) {
  if (evidence === null || typeof evidence !== "object") {
    return "an evidence item is not an object";
  }
  if (typeof evidence.what !== "string" || evidence.what.trim() === "") {
    return `the ${String(evidence.kind)} evidence does not say what it shows ("what")`;
  }
  if (evidence.kind === "adr-note") {
    if (typeof evidence.adr !== "string" || !/^\d{4}$/.test(evidence.adr)) {
      return `adr-note evidence names ADR ${JSON.stringify(evidence.adr)}, not a four-digit number`;
    }
    if (typeof evidence.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(evidence.date)) {
      return `adr-note evidence is dated ${JSON.stringify(evidence.date)}, not YYYY-MM-DD`;
    }
    const text = adrText(evidence.adr);
    if (text === null) {
      return `ADR ${evidence.adr} does not exist under ${ADR_DIR}/`;
    }
    const lines = text.split(/\r?\n/);
    const note = lines.findIndex((line) => line.startsWith(`## Note, ${evidence.date}`));
    if (note === -1) {
      return `ADR ${evidence.adr} has no note dated ${evidence.date}`;
    }
    if (evidence.section !== undefined) {
      const end = lines.findIndex((line, index) => index > note && line.startsWith("## "));
      const body = lines.slice(note + 1, end === -1 ? undefined : end);
      if (!body.includes(`### ${evidence.section}`)) {
        return (
          `ADR ${evidence.adr}'s note of ${evidence.date} has no section ` +
          `"### ${String(evidence.section)}"`
        );
      }
    }
    return null;
  }
  const kind = EVIDENCE_IDS[evidence.kind];
  if (kind === undefined) {
    return (
      `evidence of kind ${JSON.stringify(evidence.kind)} is not one of run, commit, owner-ask ` +
      "or adr-note"
    );
  }
  if (typeof evidence.id !== "string" || !kind.pattern.test(evidence.id)) {
    return `${JSON.stringify(evidence.id)} is not ${kind.describe}`;
  }
  if (evidence.kind === "commit" && !commitExists(evidence.id)) {
    return `commit ${evidence.id} is not in this repository`;
  }
  return null;
}

function checkBlockers({ document, adrText, commitExists }) {
  if (document === null || typeof document !== "object" || !Array.isArray(document.blockers)) {
    return [`${BLOCKERS_FILE} has no "blockers" array.`];
  }
  const problems = [];
  const seen = new Set();
  for (const [index, blocker] of document.blockers.entries()) {
    const id = typeof blocker?.id === "string" ? blocker.id : null;
    const label = id ?? `entry ${String(index)}`;
    if (id === null || !BLOCKER_ID.test(id)) {
      problems.push(`${label} has no kebab-case "id".`);
    } else if (seen.has(id)) {
      problems.push(`${id} appears twice.`);
    }
    if (id !== null) {
      seen.add(id);
    }
    if (typeof blocker?.title !== "string" || blocker.title.trim() === "") {
      problems.push(`${label} has no "title".`);
    }
    if (typeof blocker?.closes_when !== "string" || blocker.closes_when.trim() === "") {
      problems.push(`${label} does not say what closes it ("closes_when").`);
    }
    if (!Array.isArray(blocker?.evidence)) {
      problems.push(`${label} has no "evidence" array.`);
    }
    if (!BLOCKER_STATUSES.has(blocker?.status)) {
      problems.push(`${label} has status ${JSON.stringify(blocker?.status)}, not open or closed.`);
      continue;
    }
    if (blocker.status === "open") {
      problems.push(
        `${label} is open: ${String(blocker.title)}\n      closes when: ` +
          `${String(blocker.closes_when)}`,
      );
      continue;
    }
    const evidence = Array.isArray(blocker.evidence) ? blocker.evidence : [];
    if (evidence.length === 0) {
      problems.push(`${label} is closed with no evidence. Closing takes a run, a note or an ask.`);
    }
    for (const item of evidence) {
      const problem = evidenceProblem(item, { adrText, commitExists });
      if (problem !== null) {
        problems.push(`${label} is closed, and ${problem}.`);
      }
    }
  }
  for (const id of REQUIRED_BLOCKERS) {
    if (!seen.has(id)) {
      problems.push(
        `${id} is missing from ${BLOCKERS_FILE}. ADR 0031 names it as a release blocker: close ` +
          "it with evidence, never delete it.",
      );
    }
  }
  return problems;
}

/** The rules, in the order they are reported. `input` names the loader that feeds each one. */
const RULES = [
  {
    id: "template-has-no-package-json",
    clause: "a",
    input: "template",
    check: checkTemplateManifest,
  },
  {
    id: "template-names-no-previous-renderer",
    clause: "a",
    input: "template",
    check: checkTemplateNames,
  },
  { id: "render-rows-recorded", clause: "b", input: "manifest", check: checkRenderRows },
  { id: "release-blockers-closed", clause: "d", input: "blockers", check: checkBlockers },
];

// ---------------------------------------------------------------------------
// Self-tests: a violating sample each rule must fire on, and a clean one it must not.

const recordedRow = { status: "recorded", sha256: "0".repeat(64) };

function sampleManifest(overrides = {}) {
  const block = () => Object.fromEntries(RENDER_PLATFORMS.map((key) => [key, recordedRow]));
  const manifest = {
    format_version: 2,
    browser: { expected: block() },
    ffmpeg: { expected: block() },
  };
  for (const [path, row] of Object.entries(overrides)) {
    const [name, platform] = path.split(" ");
    if (row === undefined) {
      delete manifest[name].expected[platform];
    } else {
      manifest[name].expected[platform] = row;
    }
  }
  return manifest;
}

const SAMPLE_ADR = [
  "# 0031. A record",
  "",
  "## Note, 2026-11-12: decisions",
  "",
  "### The page's network: allowed by default",
  "",
  "## Note, 2026-11-13: a later one",
].join("\n");

const sampleEnvironment = {
  adrText: (number) => (number === "0031" ? SAMPLE_ADR : null),
  commitExists: (hash) => hash === "6802d60",
};

function closedBlocker(id, evidence) {
  return {
    id,
    title: `the blocker ${id}`,
    status: "closed",
    closes_when: "it is done",
    evidence: evidence ?? [{ kind: "run", id: "43133391215", what: "the run that did it" }],
  };
}

/** A document closing every required blocker, with one of `replace`'s entries swapped in. */
function sampleBlockers(replace = {}, extra = []) {
  const blockers = REQUIRED_BLOCKERS.filter((id) => replace[id] !== null).map(
    (id) => replace[id] ?? closedBlocker(id),
  );
  return { document: { blockers: [...blockers, ...extra] }, ...sampleEnvironment };
}

const SELF_TESTS = [
  {
    rule: "template-has-no-package-json",
    violating: [
      { path: "package.json", text: "{}" },
      { path: "tsconfig.json", text: "{}" },
    ],
    clean: [
      { path: "tailwind.css", text: '@import "tailwindcss";' },
      { path: "tsconfig.json", text: "{}" },
    ],
  },
  {
    rule: "template-names-no-previous-renderer",
    violating: [{ path: "tsconfig.json", text: `{ "types": ["@${PREVIOUS_RENDERER}/media"] }` }],
    clean: [{ path: "tsconfig.json", text: '{ "compilerOptions": { "jsx": "react-jsx" } }' }],
  },
  {
    rule: "template-names-no-previous-renderer",
    // Prose, in any case: the template is copied verbatim, comments and all.
    violating: [{ path: "tailwind.css", text: `/* styles for R${PREVIOUS_RENDERER.slice(1)} */` }],
    clean: [{ path: "tailwind.css", text: "/* styles for @xplainer/motion, and promotions */" }],
  },
  {
    rule: "render-rows-recorded",
    violating: sampleManifest({
      "ffmpeg darwin-arm64": { status: "unavailable", reason: "PLACEHOLDER — not built" },
    }),
    clean: sampleManifest(),
  },
  {
    rule: "render-rows-recorded",
    // A row simply missing is as unacquirable as a placeholder.
    violating: sampleManifest({ "browser linux-arm64": undefined }),
    clean: sampleManifest({ "browser linux-arm64": recordedRow }),
  },
  {
    rule: "release-blockers-closed",
    // Open is open, whatever evidence it has gathered so far.
    violating: sampleBlockers({
      "linux-12fps-run": { ...closedBlocker("linux-12fps-run"), status: "open" },
    }),
    clean: sampleBlockers(),
  },
  {
    rule: "release-blockers-closed",
    // Closed is a claim; the evidence is what makes it one.
    violating: sampleBlockers({ "v2-manifest-upload": closedBlocker("v2-manifest-upload", []) }),
    clean: sampleBlockers({
      "v2-manifest-upload": closedBlocker("v2-manifest-upload", [
        { kind: "owner-ask", id: "1be7850f", what: "the owner's upload" },
      ]),
    }),
  },
  {
    rule: "release-blockers-closed",
    violating: sampleBlockers({
      "linux-12fps-run": closedBlocker("linux-12fps-run", [
        { kind: "run", id: "last-tuesday", what: "a run" },
      ]),
    }),
    clean: sampleBlockers(),
  },
  {
    rule: "release-blockers-closed",
    // An ADR note is evidence only if the record carries it, section and all.
    violating: sampleBlockers({
      "page-network-decision": closedBlocker("page-network-decision", [
        { kind: "adr-note", adr: "0031", date: "2026-11-12", section: "Signing", what: "a note" },
      ]),
    }),
    clean: sampleBlockers({
      "page-network-decision": closedBlocker("page-network-decision", [
        {
          kind: "adr-note",
          adr: "0031",
          date: "2026-11-12",
          section: "The page's network: allowed by default",
          what: "the decision",
        },
      ]),
    }),
  },
  {
    rule: "release-blockers-closed",
    violating: sampleBlockers({
      "cdn-cache-rule-applied": closedBlocker("cdn-cache-rule-applied", [
        { kind: "commit", id: "deadbee", what: "a commit nobody made" },
      ]),
    }),
    clean: sampleBlockers({
      "cdn-cache-rule-applied": closedBlocker("cdn-cache-rule-applied", [
        { kind: "commit", id: "6802d60", what: "the rule as declared" },
      ]),
    }),
  },
  {
    rule: "release-blockers-closed",
    // Deleting an open blocker must not be a way to pass.
    violating: sampleBlockers({ "checklist-a7-pin-snapshot": null }),
    clean: sampleBlockers(),
  },
  {
    rule: "release-blockers-closed",
    violating: sampleBlockers({}, [closedBlocker("linux-12fps-run")]),
    clean: sampleBlockers({}, [closedBlocker("a-later-blocker")]),
  },
  {
    rule: "release-blockers-closed",
    violating: sampleBlockers({
      "chrome-157-throughput": { ...closedBlocker("chrome-157-throughput"), status: "done" },
    }),
    clean: sampleBlockers(),
  },
];

const describeSample = (sample) => {
  const text = JSON.stringify(sample);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
};

function runSelfTests() {
  const problems = [];
  const rules = new Map(RULES.map((rule) => [rule.id, rule]));
  const covered = new Set();
  for (const test of SELF_TESTS) {
    const rule = rules.get(test.rule);
    if (rule === undefined) {
      problems.push(`self-test names unknown rule "${test.rule}".`);
      continue;
    }
    covered.add(rule.id);
    if (rule.check(test.violating).length === 0) {
      problems.push(
        `rule "${rule.id}" did NOT fire on ${describeSample(test.violating)}, which violates ` +
          "it. The rule can no longer fail, so it would wave a release through.",
      );
    }
    const clean = rule.check(test.clean);
    if (clean.length > 0) {
      problems.push(
        `rule "${rule.id}" fired on ${describeSample(test.clean)}, which does not violate it: ` +
          `${clean[0]}`,
      );
    }
  }
  for (const id of rules.keys()) {
    if (!covered.has(id)) {
      problems.push(`rule "${id}" has no self-test. Add a violating and a clean sample.`);
    }
  }
  return { problems, verified: [...covered].sort(), samples: SELF_TESTS.length };
}

// ---------------------------------------------------------------------------
// The tree

/** Walk up for `pnpm-workspace.yaml`, from the working directory and then from this file. */
function findWorkspaceRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const start of [process.cwd(), resolve(here, "..")]) {
    let dir = resolve(start);
    for (;;) {
      if (existsSync(join(dir, WORKSPACE_FILE))) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  return null;
}

function readJson(root, path) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) {
    throw new UsageError(`${path} is missing, so the release cannot be judged.`);
  }
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new UsageError(`${path} is not valid JSON: ${error.message}`);
  }
}

/** Every file under the template, as `{ path, text }`. `node_modules` is never shipped. */
function loadTemplate(root) {
  const base = join(root, TEMPLATE_DIR);
  if (!existsSync(base)) {
    throw new UsageError(`${TEMPLATE_DIR}/ is missing, so this is not the tree to judge.`);
  }
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") {
          walk(full);
        }
      } else if (entry.isFile()) {
        files.push({
          path: relative(base, full).split(sep).join("/"),
          text: readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(base);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function loadBlockers(root) {
  const adrs = existsSync(join(root, ADR_DIR)) ? readdirSync(join(root, ADR_DIR)) : [];
  return {
    document: readJson(root, BLOCKERS_FILE),
    adrText: (number) => {
      const file = adrs.find((name) => name.startsWith(`${number}-`) && name.endsWith(".md"));
      return file === undefined ? null : readFileSync(join(root, ADR_DIR, file), "utf8");
    },
    commitExists: (hash) =>
      spawnSync("git", ["cat-file", "-e", `${hash}^{commit}`], { cwd: root, stdio: "ignore" })
        .status === 0,
  };
}

const LOADERS = {
  template: loadTemplate,
  manifest: (root) => readJson(root, TOOLCHAIN_MANIFEST),
  blockers: loadBlockers,
};

function main(argv) {
  const selfTestOnly = argv.length === 1 && argv[0] === "--self-test";
  if (argv.length > 0 && !selfTestOnly) {
    throw new UsageError(
      `unexpected argument(s): ${argv.join(" ")}. The one this checker takes is --self-test; ` +
        "rule (c), which needs the network, is `pnpm release:publish`'s.",
    );
  }

  const selfTest = runSelfTests();
  if (selfTest.problems.length > 0) {
    process.stderr.write(
      "check-release-ready: the gate failed its own tests, so it was not run against the tree.\n",
    );
    for (const problem of selfTest.problems) {
      process.stderr.write(`  x ${problem}\n`);
    }
    return 1;
  }
  process.stdout.write(
    `check-release-ready: ${String(selfTest.verified.length)} rule(s) self-tested from ` +
      `${String(selfTest.samples)} sample(s), each fired on a violating value and silent on a ` +
      `clean one: ${selfTest.verified.join(", ")}.\n`,
  );
  if (selfTestOnly) {
    return 0;
  }

  const root = findWorkspaceRoot();
  if (root === null) {
    throw new UsageError(`no ${WORKSPACE_FILE} found above the working directory.`);
  }
  const inputs = new Map();
  let total = 0;
  for (const rule of RULES) {
    if (!inputs.has(rule.input)) {
      inputs.set(rule.input, LOADERS[rule.input](root));
    }
    const problems = rule.check(inputs.get(rule.input));
    total += problems.length;
    const verdict = problems.length === 0 ? "ok" : `${String(problems.length)} problem(s)`;
    const stream = problems.length === 0 ? process.stdout : process.stderr;
    stream.write(`check-release-ready: (${rule.clause}) ${rule.id}: ${verdict}\n`);
    for (const problem of problems) {
      stream.write(`  x ${problem}\n`);
    }
  }

  if (total > 0) {
    process.stderr.write(
      `\ncheck-release-ready: NOT READY — ${String(total)} problem(s). Nothing is published ` +
        `until each is fixed, or closed with its evidence in ${BLOCKERS_FILE}.\n`,
    );
    return 1;
  }
  process.stdout.write(
    "check-release-ready: ready. Rule (c), the published toolchain manifest against the " +
      "committed one, is the next thing `pnpm release:publish` runs.\n",
  );
  return 0;
}

let exitCode;
try {
  exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`check-release-ready: ${error.message}\n`);
    exitCode = 2;
  } else {
    process.stderr.write(
      `check-release-ready: internal error\n${error instanceof Error ? error.stack : String(error)}\n`,
    );
    exitCode = 70;
  }
}
process.exitCode = exitCode;
