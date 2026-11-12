#!/usr/bin/env node
/**
 * `pnpm release:publish` — the one command that publishes a release (ADR 0031's note of
 * 2026-11-12, D8).
 *
 * Seven steps, each run only when the one before it passed:
 *
 *   1. The tree is the commit. `--no-git-checks` (step 7) turns pnpm's own checks off, and every
 *      member's build compiles whatever is under its `src/`, tracked or not, so this refuses:
 *      anything `git status` reports under `apps/`, `packages/`, `services/`, the root `LICENSE`
 *      and `NOTICE` (every tarball's `prepack` copies them in) or `pnpm-workspace.yaml` (its
 *      catalog is written into the published ranges); any gitignored file under a published
 *      member's `src/` or its other non-`dist` `files` roots, which `git status` never shows and
 *      the build and `npm pack` both take (`out/`, `release/` and `dist/` are ignored at any
 *      depth); and a HEAD that is not on `origin/main`. It runs again just before step 7, so a
 *      build or a pack that changed the tree publishes nothing.
 *   2. `node scripts/check-release-ready.mjs` — the offline release check: the template carries
 *      no package manifest and no trace of the previous renderer, every render platform's browser
 *      and ffmpeg row is recorded, and every entry of `docs/release-blockers.json` is closed with
 *      its evidence. It reads no build output, so it runs before the slow steps.
 *   3. Every published member's `dist/` is deleted: each member that is not `private` and whose
 *      `files` names `dist`. A roster that comes out empty is refused. Do not run this beside a
 *      `pnpm verify` in the same tree: that run reads the `dist/` this deletes.
 *   4. `pnpm turbo build`, forced (`TURBO_FORCE=true`): every member is built from the tree that is
 *      about to be published, never taken from a cache.
 *   5. `node scripts/check-publish-contract.mjs` — the tarball gate, on that fresh build: what
 *      `npm pack` would put in each tarball, including every file the manifest's `exports`,
 *      `main`, `types` and `bin` name, and a `dist/` in every package that declares one.
 *   6. Rule (c), here: the toolchain manifest the CDN serves at
 *      `https://cdn.xplainer.video/toolchain/v2/manifest.json` is byte-identical to the committed
 *      `apps/cli/src/setup/toolchain.manifest.json`, compared by SHA-256. A release whose
 *      `setup` would read a different document than the one reviewed here is refused.
 *   7. `pnpm publish -r --no-git-checks --access public`, with every argument given to this
 *      script appended — `pnpm release:publish --otp 123456`. A leading `--` is dropped. It runs
 *      with `XPLAINER_RELEASE_PUBLISH=1`, which every member's `prepublishOnly` requires of a
 *      publish, so a bare `pnpm publish` that skipped steps 3 to 5 is refused per package. That
 *      stops an accident, not a determined publisher: `--ignore-scripts` skips every hook.
 *
 * WHY IT BUILDS, AND DELETES FIRST. 0.1.0 was published on 2026-11-12 from a clone whose `dist/`
 * directories were stale or absent, and every gate passed, because none of them built anything.
 * The registry received `@xplainer/cli` 0.1.0 byte-identical in `dist/` to 0.0.11, an
 * `@xplainer/motion` with no `dist/` at all, and pre-Phase-1 builds of render-core, skill,
 * protocol and mcp-server. A build alone is not enough either: `tsc` never removes what it emitted
 * for a source that has since been deleted, and `xplainer-minify-dist` rewrites those leftovers
 * with the rest, so they ship looking fresh. On 2026-11-12 a forced build of the release commit
 * still left four such files in the CLI's `dist/` (`runtime/template.*`,
 * `setup/providers/workspace.*`), and a clone's render-core still held the `dist/render/args.js`
 * that 0.1.0 shipped. Only a build into an empty `dist/` makes the tarballs describe the commit.
 *
 * WHY THE NETWORK RULE IS HERE AND NOT IN THE HOOK. Step 2 is also every published member's
 * `prepublishOnly`; pnpm runs that hook per package, before packing it, and stops the whole run
 * at the first refusal. Step 6 cannot go there: a CDN that answered for the third package and
 * failed for the fourth would leave a release half on the registry. Here it runs once, before
 * the first package is touched.
 *
 * DO NOT RUN THIS BEFORE THE VERSION-2 MANIFEST IS UPLOADED. Step 6 requests its URL, and until the
 * cache rule in `infra/terraform` is applied an error answer can be kept at the edge for 30 days
 * (`docs/release-blockers.json`, `v2-manifest-upload` and `cdn-cache-rule-applied`). Step 2
 * refuses while either is open, so the request is not made by accident.
 *
 * `--self-test` drives all seven steps with an injected `fetch` and injected effects — the
 * manifest compare on identical, different, missing and unreachable answers, and the order:
 * nothing runs on a tree that is not the commit, nothing is deleted or built when the check
 * refuses, nothing is checked after a failed build, nothing is fetched after a refused tarball,
 * nothing is published when the compare refuses or the tree changed, and the publish gets the
 * fixed arguments and then the caller's. It also runs the roster and the ignored-file filter
 * against fixtures, the roster in a temporary directory it removes. It requests nothing, spawns
 * nothing and touches nothing outside that directory, and it is what `pnpm verify` and CI run.
 *
 * Exit codes:
 *   0  published (or every self-test passed)
 *   1  the tree is not the commit or git could not read it, the delete roster is empty, the build
 *      failed, the published manifest differs or could not be read, a self-test failed, or a step
 *      was killed by a signal
 *   2  an argument this script cannot take, or no workspace root
 *  70  internal error
 *   *  any other code is a step's own, passed through: the release check's, the build's, the
 *      publish contract's (whose own `2` means it could not run) or `pnpm publish`'s
 */
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_FILE = "pnpm-workspace.yaml";
const RELEASE_CHECK = "scripts/check-release-ready.mjs";
const PUBLISH_CONTRACT = "scripts/check-publish-contract.mjs";
const BUILD_ARGS = ["turbo", "build"];
/** Where workspace members live: `check-publish-contract.mjs`'s `MEMBER_ROOTS`. */
const MEMBER_PARENTS = ["apps", "packages", "services"];
/** What a release may not carry uncommitted: the members, and the root files a publish reads. */
const TREE_PATHS = [...MEMBER_PARENTS, "LICENSE", "NOTICE", "pnpm-workspace.yaml"];
/** The ref a published commit must already be on (AGENTS.md: publish, then tag, from `main`). */
const RELEASE_BRANCH = "origin/main";
/** Read by every member's `prepublishOnly` (`check-release-ready.mjs --prepublish`). */
const RELEASE_PUBLISH_ENV = "XPLAINER_RELEASE_PUBLISH";
const COMMITTED_MANIFEST = "apps/cli/src/setup/toolchain.manifest.json";
const PUBLISHED_MANIFEST_URL = "https://cdn.xplainer.video/toolchain/v2/manifest.json";
const PUBLISH_ARGS = ["publish", "-r", "--no-git-checks", "--access", "public"];
const FETCH_TIMEOUT_MS = 30_000;

class UsageError extends Error {}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Rule (c). The problems with what `fetchImpl` returns for the published URL, or `[]` when it is
 * byte-identical to `committed`.
 */
async function checkPublishedManifest(fetchImpl, committed) {
  let response;
  try {
    response = await fetchImpl(PUBLISHED_MANIFEST_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return [
      `${PUBLISHED_MANIFEST_URL} could not be fetched (${error instanceof Error ? error.message : String(error)}).`,
    ];
  }
  if (response.status !== 200) {
    return [
      `${PUBLISHED_MANIFEST_URL} answered ${String(response.status)}. Upload ${COMMITTED_MANIFEST} ` +
        "there and purge the URL before publishing; a CLI that cannot read it cannot run setup.",
    ];
  }
  const served = Buffer.from(await response.arrayBuffer());
  const servedDigest = sha256(served);
  const committedDigest = sha256(committed);
  if (servedDigest !== committedDigest) {
    return [
      `${PUBLISHED_MANIFEST_URL} is not the committed ${COMMITTED_MANIFEST}: served sha256 ` +
        `${servedDigest} (${String(served.length)} B), committed ${committedDigest} ` +
        `(${String(committed.length)} B). Upload the committed copy and purge the URL, or wait ` +
        "out the edge's five minutes, and run this again.",
    ];
  }
  return [];
}

/** Whether a manifest's `files` ships a `dist/`: `dist`, `./dist`, or anything under either. */
function filesDeclareDist(files) {
  return (
    Array.isArray(files) &&
    files.some((entry) => typeof entry === "string" && /^(\.\/)?dist(\/|$)/.test(entry))
  );
}

/**
 * Every member that is not `private` and whose `files` ships `dist/`: `{ dir, roots }`, where
 * `roots` are the paths besides `dist/` that reach its tarball — `src/`, which the build compiles,
 * and each other `files` entry up to its first glob segment.
 */
function publishedMembers(root) {
  const members = [];
  for (const parent of MEMBER_PARENTS) {
    const base = join(root, parent);
    if (!existsSync(base)) {
      continue;
    }
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const manifestPath = join(base, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(manifestPath)) {
        continue;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.private !== true && filesDeclareDist(manifest.files)) {
        const dir = `${parent}/${entry.name}`;
        const roots = [`${dir}/src`];
        for (const file of manifest.files) {
          if (typeof file !== "string" || filesDeclareDist([file])) {
            continue;
          }
          const plain = file.replace(/^\.\//, "").split("/");
          const cut = plain.findIndex((segment) => segment.includes("*"));
          const path = (cut === -1 ? plain : plain.slice(0, cut)).join("/");
          if (path !== "") {
            roots.push(`${dir}/${path}`);
          }
        }
        members.push({ dir, roots });
      }
    }
  }
  return members.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Which of `git ls-files --others --ignored` under the shipped roots would reach a tarball. Not a
 * dot-segment under `src/` (tsc's `include` skips those, and agent tooling keeps state there), and
 * never `node_modules`, `__pycache__` or `.pyc`, which neither the build nor the contract admits.
 */
function ignoredThatShip(paths) {
  return paths.filter((path) => {
    const segments = path.split("/");
    if (
      segments.some((s) => s === "node_modules" || s === "__pycache__") ||
      path.endsWith(".pyc")
    ) {
      return false;
    }
    const src = segments.indexOf("src");
    return !(src !== -1 && segments.slice(src + 1).some((s) => s.startsWith(".")));
  });
}

/**
 * The seven steps, in order, each behind the last. `steps` supplies every effect:
 * `treeProblems()` returns why the tree is not the commit (`[]` when it is), `cleanDist()`
 * deletes every published `dist/` and returns `{ declared, deleted }`,
 * `runCheck()`, `runBuild()`, `runContract()` and `runPublish(args)` return an exit status
 * (`null` for a signal or a spawn failure), `readCommitted()` the committed manifest's bytes,
 * `fetch` the network, and `log(line)` where the refusals go.
 */
async function releasePublish(argv, steps) {
  const extra = argv[0] === "--" ? argv.slice(1) : argv;
  const before = steps.treeProblems();
  if (before.length > 0) {
    steps.log(
      "release:publish: the tree is not the commit it would publish, and the build would ship " +
        "the difference; nothing was checked, built or published.",
    );
    for (const line of before) {
      steps.log(`  ${line}`);
    }
    return 1;
  }
  const check = steps.runCheck();
  if (check !== 0) {
    steps.log(
      `release:publish: the release check refused (exit ${String(check)}); nothing was built, ` +
        "fetched or published.",
    );
    return check ?? 1;
  }
  const { declared, deleted } = steps.cleanDist();
  if (declared.length === 0) {
    steps.log(
      "release:publish: no published member declares dist/, so the roster is wrong; nothing " +
        "was deleted, built or published.",
    );
    return 1;
  }
  steps.log(
    `release:publish: deleted ${deleted.length === 0 ? "no dist/ (none existed)" : deleted.join(", ")} before building.`,
  );
  const build = steps.runBuild();
  if (build !== 0) {
    steps.log(
      `release:publish: the build failed (exit ${String(build)}); nothing was fetched or ` +
        "published, and the published members' dist/ may be missing: run `pnpm build`.",
    );
    return build ?? 1;
  }
  const contract = steps.runContract();
  if (contract !== 0) {
    steps.log(
      `release:publish: a tarball breaks the publish contract (exit ${String(contract)}); ` +
        "nothing was fetched and nothing was published.",
    );
    return contract ?? 1;
  }
  const problems = await checkPublishedManifest(steps.fetch, steps.readCommitted());
  if (problems.length > 0) {
    for (const problem of problems) {
      steps.log(`release:publish: (c) ${problem}`);
    }
    steps.log("release:publish: nothing was published.");
    return 1;
  }
  steps.log(
    `release:publish: (c) the published manifest is byte-identical to ${COMMITTED_MANIFEST}.`,
  );
  const after = steps.treeProblems();
  if (after.length > 0) {
    steps.log(
      "release:publish: building or packing changed the tree, so the tarballs are not the " +
        "commit; nothing was published.",
    );
    for (const line of after) {
      steps.log(`  ${line}`);
    }
    return 1;
  }
  return steps.runPublish([...PUBLISH_ARGS, ...extra]) ?? 1;
}

// ---------------------------------------------------------------------------
// Self-tests

const COMMITTED_SAMPLE = Buffer.from('{ "format_version": 2 }\n');

/** A fake `fetch` answering every request with `answer`, recording the URLs it was asked for. */
function fakeFetch(answer) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (answer instanceof Error) {
      throw answer;
    }
    return new Response(answer.body, { status: answer.status });
  };
  return { fetchImpl, urls };
}

/** One `releasePublish` run against fakes; returns what it did. */
async function rehearse({
  argv = [],
  dirty = [],
  dirtyAfter = [],
  declared = ["packages/motion/dist"],
  check = 0,
  build = 0,
  contract = 0,
  answer,
  publish = 0,
}) {
  const calls = [];
  const { fetchImpl, urls } = fakeFetch(answer ?? { status: 200, body: COMMITTED_SAMPLE });
  const status = await releasePublish(argv, {
    treeProblems: () => {
      const first = !calls.includes("tree");
      calls.push(first ? "tree" : "tree again");
      return first ? dirty : dirtyAfter;
    },
    cleanDist: () => {
      calls.push("clean");
      return { declared, deleted: declared };
    },
    runBuild: () => {
      calls.push("build");
      return build;
    },
    runContract: () => {
      calls.push("contract");
      return contract;
    },
    runCheck: () => {
      calls.push("check");
      return check;
    },
    readCommitted: () => COMMITTED_SAMPLE,
    fetch: fetchImpl,
    runPublish: (args) => {
      calls.push(["publish", ...args]);
      return publish;
    },
    log: () => {},
  });
  return { status, calls, urls };
}

const different = Buffer.from(COMMITTED_SAMPLE);
different[different.length - 2] ^= 1;

const MANIFEST_TESTS = [
  {
    name: "an identical document passes",
    answer: { status: 200, body: COMMITTED_SAMPLE },
    fires: false,
  },
  { name: "one changed byte is refused", answer: { status: 200, body: different }, fires: true },
  { name: "a 404 is refused", answer: { status: 404, body: "not found" }, fires: true },
  { name: "a 200 with nothing in it is refused", answer: { status: 200, body: "" }, fires: true },
  { name: "an unreachable CDN is refused", answer: new TypeError("fetch failed"), fires: true },
];

const RAN_GATES = ["tree", "check", "clean", "build", "contract"];

const SEQUENCE_TESTS = [
  {
    name: "a dirty tree checks nothing, deletes nothing and builds nothing",
    run: { dirty: ["uncommitted: ?? apps/cli/src/scratch.ts"] },
    expect: { status: 1, calls: ["tree"], fetched: 0 },
  },
  {
    name: "an empty delete roster builds nothing",
    run: { declared: [] },
    expect: { status: 1, calls: ["tree", "check", "clean"], fetched: 0 },
  },
  {
    name: "a tree the build or the pack changed publishes nothing",
    run: { dirtyAfter: ["uncommitted:  M packages/motion/LICENSE"] },
    expect: { status: 1, calls: [...RAN_GATES, "tree again"], fetched: 1 },
  },
  {
    name: "a refused check deletes nothing, builds nothing and fetches nothing",
    run: { check: 1 },
    expect: { status: 1, calls: ["tree", "check"], fetched: 0 },
  },
  {
    name: "a check that could not run passes its own code through",
    run: { check: 2 },
    expect: { status: 2, calls: ["tree", "check"], fetched: 0 },
  },
  {
    name: "a check killed by a signal is a refusal",
    run: { check: null },
    expect: { status: 1, calls: ["tree", "check"], fetched: 0 },
  },
  {
    name: "a failed build runs no contract, fetches nothing and publishes nothing",
    run: { build: 1 },
    expect: { status: 1, calls: ["tree", "check", "clean", "build"], fetched: 0 },
  },
  {
    name: "a build killed by a signal is a failure",
    run: { build: null },
    expect: { status: 1, calls: ["tree", "check", "clean", "build"], fetched: 0 },
  },
  {
    name: "a tarball that breaks the contract fetches nothing and publishes nothing",
    run: { contract: 1 },
    expect: { status: 1, calls: RAN_GATES, fetched: 0 },
  },
  {
    name: "a contract gate that could not run passes its own code through",
    run: { contract: 2 },
    expect: { status: 2, calls: RAN_GATES, fetched: 0 },
  },
  {
    name: "a differing manifest publishes nothing",
    run: { answer: { status: 200, body: different } },
    expect: { status: 1, calls: RAN_GATES, fetched: 1 },
  },
  {
    name: "a passing release deletes, builds, checks, then publishes once, the caller's arguments last",
    run: { argv: ["--otp", "123456"] },
    expect: {
      status: 0,
      calls: [...RAN_GATES, "tree again", ["publish", ...PUBLISH_ARGS, "--otp", "123456"]],
      fetched: 1,
    },
  },
  {
    name: "a leading -- is not passed to pnpm",
    run: { argv: ["--", "--otp", "123456"] },
    expect: {
      status: 0,
      calls: [...RAN_GATES, "tree again", ["publish", ...PUBLISH_ARGS, "--otp", "123456"]],
      fetched: 1,
    },
  },
  {
    name: "a failed publish is a failed release",
    run: { publish: 1 },
    expect: {
      status: 1,
      calls: [...RAN_GATES, "tree again", ["publish", ...PUBLISH_ARGS]],
      fetched: 1,
    },
  },
];

/** `publishedDistDirs`'s predicate against the `files` shapes it has to tell apart. */
const DIST_DECLARATION_TESTS = [
  [["dist/**/*.js", "LICENSE"], true],
  [["dist", "SKILL.md"], true],
  [["./dist"], true],
  [["distribution", "LICENSE"], false],
  [["SKILL.md", { not: "a string" }], false],
  [undefined, false],
];

/** `ignoredThatShip` against the paths it has to tell apart. */
const IGNORED_TESTS = [
  ["apps/cli/src/release/notes.ts", true],
  ["packages/render-core/template/out/probe.txt", true],
  ["packages/render-core/template/.env", true],
  ["apps/cli/src/.omc/state/session.json", false],
  ["packages/protocol/python/xplainer_protocol/__pycache__/m.cpython-312.pyc", false],
  ["packages/render-core/template/node_modules/x/index.js", false],
];

/** `publishedMembers` over a fixture workspace in a temporary directory, removed afterwards. */
function rosterSelfTest() {
  const fixture = mkdtempSync(join(tmpdir(), "release-publish-roster-"));
  const member = (dir, manifest) => {
    mkdirSync(join(fixture, dir), { recursive: true });
    if (manifest !== undefined) {
      writeFileSync(join(fixture, dir, "package.json"), JSON.stringify(manifest));
    }
  };
  try {
    member("apps/cli", { files: ["dist/**/*.js", "LICENSE"] });
    member("packages/core", {
      files: ["dist/**/*.js", "template", "python/**/*.py", "./SKILL.md"],
    });
    member("packages/config", { private: true, files: ["dist"] });
    member("packages/data", { files: ["distribution"] });
    member("packages/empty");
    writeFileSync(join(fixture, "packages", "README.md"), "not a member\n");
    const got = JSON.stringify(publishedMembers(fixture));
    const want = JSON.stringify([
      { dir: "apps/cli", roots: ["apps/cli/src", "apps/cli/LICENSE"] },
      {
        dir: "packages/core",
        roots: [
          "packages/core/src",
          "packages/core/template",
          "packages/core/python",
          "packages/core/SKILL.md",
        ],
      },
    ]);
    return got === want
      ? []
      : [
          `publishedMembers over the fixture: expected ${want}, got ${got}: step 3 would delete the wrong dist/.`,
        ];
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

async function runSelfTests() {
  const problems = [];
  for (const test of MANIFEST_TESTS) {
    const { fetchImpl, urls } = fakeFetch(test.answer);
    const found = await checkPublishedManifest(fetchImpl, COMMITTED_SAMPLE);
    if (found.length > 0 !== test.fires) {
      problems.push(`${test.name}: rule (c) ${test.fires ? "did not fire" : `fired: ${found[0]}`}`);
    }
    if (urls.length !== 1 || urls[0] !== PUBLISHED_MANIFEST_URL) {
      problems.push(`${test.name}: requested ${JSON.stringify(urls)}, not the one published URL.`);
    }
  }
  for (const test of SEQUENCE_TESTS) {
    const { status, calls, urls } = await rehearse(test.run);
    const got = JSON.stringify({ status, calls, fetched: urls.length });
    const want = JSON.stringify(test.expect);
    if (got !== want) {
      problems.push(`${test.name}: expected ${want}, got ${got}.`);
    }
  }
  for (const [files, expected] of DIST_DECLARATION_TESTS) {
    if (filesDeclareDist(files) !== expected) {
      problems.push(
        `filesDeclareDist(${JSON.stringify(files)}) is not ${String(expected)}: step 3 would ` +
          (expected ? "leave a stale dist/ to be published." : "delete a directory nothing ships."),
      );
    }
  }
  for (const [path, ships] of IGNORED_TESTS) {
    if ((ignoredThatShip([path]).length === 1) !== ships) {
      problems.push(
        `ignoredThatShip(${JSON.stringify(path)}) is not ${String(ships)}: step 1 would ` +
          (ships ? "publish an ignored file." : "refuse a tree over a file nothing ships."),
      );
    }
  }
  problems.push(...rosterSelfTest());
  return {
    problems,
    cases:
      MANIFEST_TESTS.length +
      SEQUENCE_TESTS.length +
      DIST_DECLARATION_TESTS.length +
      IGNORED_TESTS.length +
      1,
  };
}

// ---------------------------------------------------------------------------

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

async function main(argv) {
  if (argv.includes("--self-test")) {
    if (argv.length !== 1) {
      throw new UsageError("--self-test takes no other argument, and publishes nothing.");
    }
    const { problems, cases } = await runSelfTests();
    if (problems.length > 0) {
      process.stderr.write("release:publish: the wrapper failed its own tests.\n");
      for (const problem of problems) {
        process.stderr.write(`  x ${problem}\n`);
      }
      return 1;
    }
    process.stdout.write(
      `release:publish: ${String(cases)} self-test case(s) passed with injected effects: rule (c) ` +
        "passes only an identical document, nothing runs on a tree that is not the commit, " +
        "the roster and the ignored-file filter match their fixtures, nothing is deleted or " +
        "built after a refused check, nothing is fetched after a failed build or a refused " +
        "tarball, and nothing is published after a refused compare.\n",
    );
    return 0;
  }

  const root = findWorkspaceRoot();
  if (root === null) {
    throw new UsageError(`no ${WORKSPACE_FILE} found above the working directory.`);
  }
  // On Windows `pnpm` is a .cmd shim, which child_process refuses to spawn without a shell. The
  // fixed arguments are literals and the caller's are the caller's own command line.
  const isWindows = process.platform === "win32";
  const statusOf = (what, result) => {
    if (result.error !== undefined) {
      process.stderr.write(`release:publish: could not run ${what}: ${result.error.message}\n`);
    }
    return result.status;
  };
  const pnpm = (args, env) =>
    statusOf(
      "pnpm",
      spawnSync(isWindows ? "pnpm.cmd" : "pnpm", args, {
        cwd: root,
        stdio: "inherit",
        shell: isWindows,
        env: { ...process.env, ...env },
      }),
    );
  const node = (script) =>
    statusOf(
      script,
      spawnSync(process.execPath, [join(root, script)], { cwd: root, stdio: "inherit" }),
    );
  return releasePublish(argv, {
    treeProblems: () => {
      const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
      const why = (result) =>
        (result.error?.message ?? result.stderr?.trim() ?? "") || `exit ${String(result.status)}`;
      const lines = (text) => text.split("\n").filter((line) => line !== "");
      const problems = [];
      const status = git(["status", "--porcelain", "--untracked-files=all", "--", ...TREE_PATHS]);
      if (status.error !== undefined || status.status !== 0) {
        return [`git status could not read the tree: ${why(status)}`];
      }
      problems.push(...lines(status.stdout).map((line) => `uncommitted: ${line}`));
      const roots = publishedMembers(root).flatMap((member) => member.roots);
      const ignored = git([
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--",
        ...roots,
      ]);
      if (ignored.error !== undefined || ignored.status !== 0) {
        problems.push(`git ls-files could not list ignored files: ${why(ignored)}`);
      } else {
        problems.push(
          ...ignoredThatShip(lines(ignored.stdout)).map((p) => `ignored but shipped: ${p}`),
        );
      }
      const onBranch = git(["merge-base", "--is-ancestor", "HEAD", RELEASE_BRANCH]);
      if (onBranch.status === 1) {
        problems.push(`HEAD is not on ${RELEASE_BRANCH}: publish a commit main already records.`);
      } else if (onBranch.error !== undefined || onBranch.status !== 0) {
        problems.push(`could not tell whether HEAD is on ${RELEASE_BRANCH}: ${why(onBranch)}`);
      }
      return problems;
    },
    cleanDist: () => {
      const declared = publishedMembers(root).map((member) => `${member.dir}/dist`);
      const deleted = [];
      for (const dir of declared) {
        // `<parent>/<member>/dist` under the root and nothing else, whatever the roster says.
        const target = resolve(root, dir);
        const parts = relative(root, target).split(sep);
        if (parts.length !== 3 || !MEMBER_PARENTS.includes(parts[0]) || parts[2] !== "dist") {
          throw new Error(`refusing to delete ${target}: not a member's dist/ inside ${root}`);
        }
        if (existsSync(target)) {
          rmSync(target, { recursive: true, force: true, maxRetries: 3 });
          deleted.push(dir);
        }
      }
      return { declared, deleted };
    },
    runBuild: () => pnpm(BUILD_ARGS, { TURBO_FORCE: "true" }),
    runContract: () => node(PUBLISH_CONTRACT),
    runCheck: () => node(RELEASE_CHECK),
    readCommitted: () => readFileSync(join(root, COMMITTED_MANIFEST)),
    fetch: globalThis.fetch,
    runPublish: (args) => pnpm(args, { [RELEASE_PUBLISH_ENV]: "1" }),
    log: (line) => process.stderr.write(`${line}\n`),
  });
}

process.exitCode = await main(process.argv.slice(2)).catch((error) => {
  if (error instanceof UsageError) {
    process.stderr.write(`release:publish: ${error.message}\n`);
    return 2;
  }
  process.stderr.write(
    `release:publish: internal error\n${error instanceof Error ? error.stack : String(error)}\n`,
  );
  return 70;
});
