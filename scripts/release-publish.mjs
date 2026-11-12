#!/usr/bin/env node
/**
 * `pnpm release:publish` — the one command that publishes a release (ADR 0031's note of
 * 2026-11-12, D8).
 *
 * **It never builds or packs in the clone it is run from.** It publishes HEAD from a throwaway
 * `git worktree` of that commit, so nothing on disk in the clone — a stale `dist/`, an uncommitted
 * edit, an ignored file, an injected copy made by an earlier install — can reach a tarball, and
 * nothing in the clone is deleted or relinked. Steps, each run only when the one before it passed:
 *
 *   1. HEAD is on `origin/main` (`git merge-base --is-ancestor`, local refs only): a release is a
 *      commit `main` already records (AGENTS.md, §Publishing a release). Uncommitted changes in
 *      the clone are reported and left alone; they are not in HEAD, so they are not published.
 *   2. `git worktree add --detach <tmp>/tree HEAD`.
 *   3. `node scripts/check-release-ready.mjs`, from the worktree — the offline release check: the
 *      template carries no package manifest and no trace of the previous renderer, every render
 *      platform's browser and ffmpeg row is recorded, and every entry of
 *      `docs/release-blockers.json` is closed with its evidence. It needs only Node, so it runs
 *      before the slow steps.
 *   4. `pnpm install --frozen-lockfile --config.nodeLinker=isolated`, in the worktree. Isolated
 *      because pnpm can rewrite `workspace:` ranges only through per-consumer links, which the
 *      committed `hoisted` layout does not have (AGENTS.md); frozen so the release is built from the
 *      committed lockfile or not at all. With `CI=1`, so lefthook's postinstall does not repoint the
 *      clone's shared git hooks at a worktree about to be deleted. Every pnpm call in the worktree
 *      also carries `pnpm_config_verify_deps_before_run=false`: pnpm otherwise checks the install
 *      before `pnpm turbo` runs, sees the isolated layout disagree with the committed `hoisted`, and
 *      re-installs hoisted in the middle of the release — measured on pnpm 11.25.0, a second install,
 *      a mixed layout and lefthook repointing the clone's hooks, even with the `--config` flag on
 *      that call. The `--config` flag is still what makes the install isolated:
 *      `pnpm_config_node_linker` loses to the workspace file there.
 *   5. `pnpm turbo build --cache=local:,remote:`, forced (`TURBO_FORCE=true`), in the worktree. A
 *      linked worktree shares turbo's cache with the clone it came from — measured: its writes land
 *      in the clone's `.turbo/cache` — so a cache hit could restore a `dist/` the clone built, orphans
 *      and all. The flag turns both caches off for this run, and `TURBO_FORCE` is the second lock.
 *   6. `node scripts/check-publish-contract.mjs`, in the worktree — the tarball gate, on that
 *      build: what `npm pack` would put in each tarball, including every file the manifest's
 *      `exports`, `main`, `types` and `bin` name, and a `dist/` in every package that declares one.
 *   7. Rule (c): the toolchain manifest the CDN serves at
 *      `https://cdn.xplainer.video/toolchain/v2/manifest.json` is byte-identical to the worktree's
 *      `apps/cli/src/setup/toolchain.manifest.json`, compared by SHA-256. A release whose `setup`
 *      would read a different document than the one reviewed here is refused.
 *   8. The worktree is still exactly HEAD plus ignored build output (`git status` in it is empty),
 *      and then `pnpm publish -r --no-git-checks --access public`, in it, with every argument given
 *      to this script appended — `pnpm release:publish --otp 123456`. A leading `--` is dropped. It
 *      runs with `XPLAINER_RELEASE_PUBLISH=1`, which every member's `prepublishOnly` requires of a
 *      publish, so a bare `pnpm publish` is refused per package. That stops an accident, not a
 *      determined publisher: `--ignore-scripts` skips every hook.
 *
 * The worktree is made with the clone's git hooks switched off, and removed afterwards whatever
 * happened — a refusal, a failure, or a throw. Ctrl-C, SIGHUP and SIGTERM stop the run at the next
 * step, before the publish included, and abort the manifest fetch; a Ctrl-C also reaches the running
 * step, which fails like any other. Only a hard kill leaves a worktree behind, in the temporary
 * directory, where `git worktree prune` forgets it once the directory is gone.
 *
 * WHY A FRESH WORKTREE. Two releases went wrong in place on 2026-11-12. 0.1.0 was published from a
 * clone whose `dist/` was stale or absent, because `pnpm publish` packs whatever is on disk and
 * nothing built: `@xplainer/cli` carried 0.0.11's build and `@xplainer/motion` no `dist/` at all.
 * The first fix built in place after deleting every published `dist/` — `tsc` never removes what it
 * emitted for a deleted source, so a build alone left orphans that shipped — and that broke 0.1.1's
 * first attempt instead. This workspace injects its members (`injectWorkspacePackages`), and an
 * injected copy is made at install time and follows a rebuild only through the hardlinks it shares
 * with the source: `syncInjectedDepsAfterScripts` never adds a new file (`.npmrc`). The owner's
 * isolated install ran over a 0.0.11-era `dist/`, the delete broke every hardlink, and the CLI's
 * build resolved `@xplainer/protocol` through a copy that still held the old types: 22 errors, and
 * nothing published. A build that had compiled against stale types would have published silently.
 * In a fresh checkout no `dist/` exists when the install runs, so every copy is materialised from
 * this build, the path CI has always taken; nothing stale exists anywhere to be found, and a
 * defect there is a missing file that fails loudly rather than an old one that passes.
 *
 * WHY THE NETWORK RULE IS HERE AND NOT IN THE HOOK. Step 3 is also every published member's
 * `prepublishOnly`; pnpm runs that hook per package, before packing it, and stops the whole run
 * at the first refusal. Step 7 cannot go there: a CDN that answered for the third package and
 * failed for the fourth would leave a release half on the registry. Here it runs once, before
 * the first package is touched.
 *
 * DO NOT RUN THIS BEFORE THE VERSION-2 MANIFEST IS UPLOADED. Step 7 requests its URL, and until the
 * cache rule in `infra/terraform` is applied an error answer can be kept at the edge for 30 days
 * (`docs/release-blockers.json`, `v2-manifest-upload` and `cdn-cache-rule-applied`). Step 3
 * refuses while either is open, so the request is not made by accident.
 *
 * `--self-test` drives every step with an injected `fetch` and injected effects — the manifest
 * compare on identical, different, missing and unreachable answers, and the order: no worktree is
 * made for a HEAD off `origin/main`, nothing is installed when the check refuses, nothing is built
 * after a failed install, nothing is checked after a failed build, nothing is fetched after a
 * refused tarball, nothing is published when the compare refuses, the publish gets the fixed
 * arguments and then the caller's, an interruption stops the run before the next step, and the
 * worktree is removed on every path that made one, including a step that throws. It also builds the
 * real steps over a recording `spawnSync` and checks what each would run, and where: every pnpm and
 * node step inside the worktree, the build with both caches off and forced, the publish with the
 * variable set. It requests nothing, spawns nothing and writes nothing, and it is what
 * `pnpm verify` and CI run.
 *
 * Exit codes:
 *   0  published (or every self-test passed)
 *   1  HEAD is not on origin/main or git could not say, the worktree could not be made, the
 *      install or the build failed, the published manifest differs or could not be read, the
 *      worktree changed, a self-test failed, or a step was killed by a signal
 * 130  interrupted (Ctrl-C, SIGHUP or SIGTERM) between steps
 *   2  an argument this script cannot take, or no workspace root
 *  70  internal error
 *   *  any other code is a step's own, passed through: the release check's, the install's, the
 *      build's, the publish contract's (whose own `2` means it could not run) or `pnpm publish`'s
 */
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_FILE = "pnpm-workspace.yaml";
const RELEASE_CHECK = "scripts/check-release-ready.mjs";
const PUBLISH_CONTRACT = "scripts/check-publish-contract.mjs";
const INSTALL_ARGS = ["install", "--frozen-lockfile", "--config.nodeLinker=isolated"];
const BUILD_ARGS = ["turbo", "build", "--cache=local:,remote:"];
/** On every pnpm call in the worktree: no implicit re-install that would undo the isolated layout. */
const WORKTREE_PNPM_ENV = { pnpm_config_verify_deps_before_run: "false" };
/** How many uncommitted paths the report names before it says how many more. */
const DIRTY_SHOWN = 10;
const INTERRUPTED = 130;
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

/**
 * Steps 3 to 8, inside the worktree `tree`. Returns the exit status; the caller removes the tree.
 */
async function publishFromTree(tree, extra, steps) {
  const stopped = (before) => {
    steps.log(`release:publish: interrupted before ${before}; nothing was published.`);
    return INTERRUPTED;
  };
  if (steps.interrupted()) {
    return stopped("the release check");
  }
  const check = steps.runCheck(tree);
  if (check !== 0) {
    steps.log(
      `release:publish: the release check refused (exit ${String(check)}); nothing was installed, ` +
        "built, fetched or published.",
    );
    return check ?? 1;
  }
  if (steps.interrupted()) {
    return stopped("the install");
  }
  const install = steps.runInstall(tree);
  if (install !== 0) {
    steps.log(
      `release:publish: the isolated install failed (exit ${String(install)}); nothing was built, ` +
        "fetched or published.",
    );
    return install ?? 1;
  }
  if (steps.interrupted()) {
    return stopped("the build");
  }
  const build = steps.runBuild(tree);
  if (build !== 0) {
    steps.log(
      `release:publish: the build failed (exit ${String(build)}); nothing was fetched or ` +
        "published.",
    );
    return build ?? 1;
  }
  if (steps.interrupted()) {
    return stopped("the publish contract");
  }
  const contract = steps.runContract(tree);
  if (contract !== 0) {
    steps.log(
      `release:publish: a tarball breaks the publish contract (exit ${String(contract)}); ` +
        "nothing was fetched and nothing was published.",
    );
    return contract ?? 1;
  }
  if (steps.interrupted()) {
    return stopped("the manifest compare");
  }
  const problems = await checkPublishedManifest(steps.fetch, steps.readCommitted(tree));
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
  const changes = steps.treeChanges(tree);
  if (changes.length > 0) {
    steps.log(
      "release:publish: the worktree is no longer HEAD plus build output, so its tarballs are not " +
        "the commit; nothing was published.",
    );
    for (const line of changes) {
      steps.log(`  ${line}`);
    }
    return 1;
  }
  if (steps.interrupted()) {
    return stopped("the publish");
  }
  return steps.runPublish(tree, [...PUBLISH_ARGS, ...extra]) ?? 1;
}

/**
 * Every step, in order, each behind the last. `steps` supplies every effect: `head()` returns
 * `{ commit, problems, dirty }` — why HEAD may not be published (`[]` when it may) and what the
 * clone holds uncommitted; `createTree(commit)` makes the worktree and returns its path, or throws;
 * `removeTree(tree)` removes it and returns whether it could, never throwing; `treeChanges(tree)`
 * what `git status` reports in it; `interrupted()` whether a signal asked the run to stop;
 * `runCheck`, `runInstall`,
 * `runBuild`, `runContract` and `runPublish(tree, args)` return an exit status (`null` for a
 * signal or a spawn failure); `readCommitted(tree)` the committed manifest's bytes; `fetch` the
 * network; and `log(line)` where the refusals go.
 */
async function releasePublish(argv, steps) {
  const extra = argv[0] === "--" ? argv.slice(1) : argv;
  const head = steps.head();
  if (head.problems.length > 0) {
    steps.log("release:publish: HEAD may not be published; no worktree was made.");
    for (const problem of head.problems) {
      steps.log(`  ${problem}`);
    }
    return 1;
  }
  const reportDirty = () => {
    if (head.dirty.length === 0) {
      return;
    }
    steps.log(
      `release:publish: ${String(head.dirty.length)} uncommitted path(s) in this clone are not ` +
        `published: the release is built from ${head.commit} alone, in a fresh worktree.`,
    );
    for (const line of head.dirty.slice(0, DIRTY_SHOWN)) {
      steps.log(`  ${line}`);
    }
    if (head.dirty.length > DIRTY_SHOWN) {
      steps.log(`  … and ${String(head.dirty.length - DIRTY_SHOWN)} more`);
    }
  };
  reportDirty();
  let tree;
  try {
    tree = steps.createTree(head.commit);
  } catch (error) {
    steps.log(
      `release:publish: could not make a worktree of ${head.commit} ` +
        `(${error instanceof Error ? error.message : String(error)}); nothing was built.`,
    );
    return 1;
  }
  steps.log(`release:publish: publishing ${head.commit} from ${tree}.`);
  try {
    return await publishFromTree(tree, extra, steps);
  } finally {
    if (!steps.removeTree(tree)) {
      steps.log(
        `release:publish: could not remove ${tree}; run \`git worktree remove --force ${tree}\`.`,
      );
    }
    // Said again at the end, where it is read: an uncommitted version bump publishes nothing.
    reportDirty();
  }
}

// ---------------------------------------------------------------------------
// Self-tests

const COMMITTED_SAMPLE = Buffer.from('{ "format_version": 2 }\n');
const COMMIT = "6395f022efda43ba1b5c5111705403c2d2edafaf";
const TREE = "/tmp/xplainer-release-test/tree";

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

/**
 * One `releasePublish` run against fakes; returns what it did. A step given `"throw"` throws, so
 * the worktree's removal can be checked on that path too.
 */
async function rehearse({
  argv = [],
  problems = [],
  dirty = [],
  createTree = TREE,
  check = 0,
  install = 0,
  build = 0,
  contract = 0,
  answer,
  changes = [],
  interruptAfter,
  publish = 0,
}) {
  const calls = [];
  const { fetchImpl, urls } = fakeFetch(answer ?? { status: 200, body: COMMITTED_SAMPLE });
  const step = (name, result) => (tree) => {
    calls.push(tree === TREE ? name : `${name} outside the tree`);
    if (result === "throw") {
      throw new Error(`${name} threw`);
    }
    return result;
  };
  let status;
  try {
    status = await releasePublish(argv, {
      head: () => {
        calls.push("head");
        return { commit: COMMIT, problems, dirty };
      },
      createTree: (commit) => {
        calls.push(commit === COMMIT ? "tree" : "tree of the wrong commit");
        if (createTree instanceof Error) {
          throw createTree;
        }
        return createTree;
      },
      removeTree: (tree) => {
        calls.push(tree === TREE ? "remove" : "remove the wrong tree");
        return true;
      },
      treeChanges: (tree) => {
        calls.push(tree === TREE ? "changes" : "changes outside the tree");
        return changes;
      },
      interrupted: () =>
        interruptAfter === "fetch" ? urls.length > 0 : calls.includes(interruptAfter),
      runCheck: step("check", check),
      runInstall: step("install", install),
      runBuild: step("build", build),
      runContract: step("contract", contract),
      readCommitted: () => COMMITTED_SAMPLE,
      fetch: fetchImpl,
      runPublish: (tree, args) => {
        calls.push(tree === TREE ? ["publish", ...args] : ["publish outside the tree", ...args]);
        return publish;
      },
      log: () => {},
    });
  } catch (error) {
    status = `threw: ${error instanceof Error ? error.message : String(error)}`;
  }
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

const UP_TO_CHECK = ["head", "tree", "check"];
const RAN_GATES = ["head", "tree", "check", "install", "build", "contract"];
const PUBLISHED = (...extra) => [
  ...RAN_GATES,
  "changes",
  ["publish", ...PUBLISH_ARGS, ...extra],
  "remove",
];

const SEQUENCE_TESTS = [
  {
    name: "a HEAD off origin/main makes no worktree and builds nothing",
    run: { problems: ["HEAD is not on origin/main"] },
    expect: { status: 1, calls: ["head"], fetched: 0 },
  },
  {
    name: "uncommitted changes in the clone are reported, not refused, and not published",
    run: { dirty: ["?? apps/cli/src/scratch.ts"] },
    expect: { status: 0, calls: PUBLISHED(), fetched: 1 },
  },
  {
    name: "a worktree that could not be made builds nothing and removes nothing",
    run: { createTree: new Error("git worktree add failed") },
    expect: { status: 1, calls: ["head", "tree"], fetched: 0 },
  },
  {
    name: "a refused check installs nothing, and the worktree is removed",
    run: { check: 1 },
    expect: { status: 1, calls: [...UP_TO_CHECK, "remove"], fetched: 0 },
  },
  {
    name: "a check that could not run passes its own code through",
    run: { check: 2 },
    expect: { status: 2, calls: [...UP_TO_CHECK, "remove"], fetched: 0 },
  },
  {
    name: "a check killed by a signal is a refusal",
    run: { check: null },
    expect: { status: 1, calls: [...UP_TO_CHECK, "remove"], fetched: 0 },
  },
  {
    name: "a failed install builds nothing",
    run: { install: 1 },
    expect: { status: 1, calls: [...UP_TO_CHECK, "install", "remove"], fetched: 0 },
  },
  {
    name: "a failed build runs no contract, fetches nothing and publishes nothing",
    run: { build: 1 },
    expect: { status: 1, calls: [...UP_TO_CHECK, "install", "build", "remove"], fetched: 0 },
  },
  {
    name: "a build killed by a signal is a failure",
    run: { build: null },
    expect: { status: 1, calls: [...UP_TO_CHECK, "install", "build", "remove"], fetched: 0 },
  },
  {
    name: "a build that throws still removes the worktree, and the throw is not swallowed",
    run: { build: "throw" },
    expect: {
      status: "threw: build threw",
      calls: [...UP_TO_CHECK, "install", "build", "remove"],
      fetched: 0,
    },
  },
  {
    name: "a tarball that breaks the contract fetches nothing and publishes nothing",
    run: { contract: 1 },
    expect: { status: 1, calls: [...RAN_GATES, "remove"], fetched: 0 },
  },
  {
    name: "a contract gate that could not run passes its own code through",
    run: { contract: 2 },
    expect: { status: 2, calls: [...RAN_GATES, "remove"], fetched: 0 },
  },
  {
    name: "a Ctrl-C during the manifest fetch publishes nothing",
    run: { interruptAfter: "fetch" },
    expect: { status: INTERRUPTED, calls: [...RAN_GATES, "changes", "remove"], fetched: 1 },
  },
  {
    name: "a signal between two steps stops the run before the next one",
    run: { interruptAfter: "install" },
    expect: { status: INTERRUPTED, calls: [...UP_TO_CHECK, "install", "remove"], fetched: 0 },
  },
  {
    name: "a worktree the build or the pack changed publishes nothing",
    run: { changes: [" M packages/motion/LICENSE"] },
    expect: { status: 1, calls: [...RAN_GATES, "changes", "remove"], fetched: 1 },
  },
  {
    name: "a differing manifest publishes nothing",
    run: { answer: { status: 200, body: different } },
    expect: { status: 1, calls: [...RAN_GATES, "remove"], fetched: 1 },
  },
  {
    name: "a passing release checks, installs, builds, then publishes once, the caller's arguments last",
    run: { argv: ["--otp", "123456"] },
    expect: { status: 0, calls: PUBLISHED("--otp", "123456"), fetched: 1 },
  },
  {
    name: "a leading -- is not passed to pnpm",
    run: { argv: ["--", "--otp", "123456"] },
    expect: { status: 0, calls: PUBLISHED("--otp", "123456"), fetched: 1 },
  },
  {
    name: "a failed publish is a failed release, and the worktree is still removed",
    run: { publish: 1 },
    expect: { status: 1, calls: PUBLISHED(), fetched: 1 },
  },
];

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
  problems.push(...(await realStepsSelfTest()));
  return { problems, cases: MANIFEST_TESTS.length + SEQUENCE_TESTS.length + 1 };
}

// ---------------------------------------------------------------------------

/**
 * The steps `releasePublish` takes, over real effects. Every effect comes in through `io`, so the
 * self-test can build these same functions over a recording `spawnSync` and check what each would
 * run, and where — the part of this script that decides whether the release is built in the
 * worktree or in the clone.
 */
function realSteps(root, io) {
  // On Windows `pnpm` is a .cmd shim, which child_process refuses to spawn without a shell. The
  // fixed arguments are literals and the caller's are the caller's own command line; the worktree
  // path goes in `cwd`, never on the command line.
  const isWindows = io.platform === "win32";
  const statusOf = (what, result) => {
    if (result.error !== undefined) {
      io.log(`release:publish: could not run ${what}: ${result.error.message}`);
    }
    return result.status;
  };
  const pnpm = (tree, args, env) =>
    statusOf(
      "pnpm",
      io.spawnSync(isWindows ? "pnpm.cmd" : "pnpm", args, {
        cwd: tree,
        stdio: "inherit",
        shell: isWindows,
        env: { ...io.env, ...WORKTREE_PNPM_ENV, ...env },
      }),
    );
  const node = (tree, script) =>
    statusOf(
      script,
      io.spawnSync(io.execPath, [join(tree, script)], { cwd: tree, stdio: "inherit" }),
    );
  const git = (args, cwd = root) =>
    io.spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const why = (result) =>
    (result.error?.message ?? result.stderr?.trim() ?? "") || `exit ${String(result.status)}`;
  const lines = (text) => (text ?? "").split("\n").filter((line) => line !== "");
  return {
    head: () => {
      const rev = git(["rev-parse", "--verify", "HEAD"]);
      if (rev.error !== undefined || rev.status !== 0) {
        return { commit: "HEAD", problems: [`git could not read HEAD: ${why(rev)}`], dirty: [] };
      }
      const commit = rev.stdout.trim();
      const problems = [];
      const onBranch = git(["merge-base", "--is-ancestor", "HEAD", RELEASE_BRANCH]);
      if (onBranch.status === 1) {
        problems.push(
          `${commit} is not on ${RELEASE_BRANCH}: merge it, pull, and publish a commit main ` +
            "already records.",
        );
      } else if (onBranch.error !== undefined || onBranch.status !== 0) {
        problems.push(`could not tell whether ${commit} is on ${RELEASE_BRANCH}: ${why(onBranch)}`);
      }
      const status = git(["status", "--porcelain", "--untracked-files=normal"]);
      return { commit, problems, dirty: status.status === 0 ? lines(status.stdout) : [] };
    },
    createTree: (commit) => {
      // The real path: macOS hands out `/var/…` for what pnpm reports as `/private/var/…`, and
      // Windows can hand out an 8.3 short name; one spelling throughout.
      const base = io.realpathSync(io.mkdtempSync(join(io.tmp, "xplainer-release-")));
      const tree = join(base, "tree");
      // `core.hooksPath` at a directory that does not exist: no hook of the clone's runs in the
      // worktree before a single gate has.
      const added = git([
        "-c",
        `core.hooksPath=${join(base, "no-hooks")}`,
        "worktree",
        "add",
        "--detach",
        tree,
        commit,
      ]);
      if (added.error !== undefined || added.status !== 0) {
        io.rmSync(base, { recursive: true, force: true });
        throw new Error(why(added));
      }
      return tree;
    },
    removeTree: (tree) => {
      try {
        const removed = git(["worktree", "remove", "--force", tree]);
        io.rmSync(dirname(tree), { recursive: true, force: true, maxRetries: 3 });
        if (removed.status !== 0) {
          git(["worktree", "prune"]);
        }
        return !io.existsSync(tree);
      } catch {
        // Never throw from here: it runs in a `finally`, after a publish that cannot be undone.
        return false;
      }
    },
    treeChanges: (tree) => {
      const status = git(["status", "--porcelain", "--untracked-files=all"], tree);
      if (status.error !== undefined || status.status !== 0) {
        return [`git status could not read the worktree: ${why(status)}`];
      }
      return lines(status.stdout);
    },
    interrupted: () => io.signal.aborted,
    runCheck: (tree) => node(tree, RELEASE_CHECK),
    runInstall: (tree) => pnpm(tree, INSTALL_ARGS, { CI: "1" }),
    runBuild: (tree) => pnpm(tree, BUILD_ARGS, { TURBO_FORCE: "true" }),
    runContract: (tree) => node(tree, PUBLISH_CONTRACT),
    readCommitted: (tree) => io.readFileSync(join(tree, COMMITTED_MANIFEST)),
    fetch: (url, init) =>
      io.fetch(url, { ...init, signal: AbortSignal.any([init.signal, io.signal]) }),
    runPublish: (tree, args) => pnpm(tree, args, { [RELEASE_PUBLISH_ENV]: "1" }),
    log: io.log,
  };
}

/** `realSteps` over recording effects: every pnpm and node step in the tree, with what it needs. */
async function realStepsSelfTest() {
  const ROOT = "/clone";
  const spawned = [];
  const read = [];
  const steps = realSteps(ROOT, {
    spawnSync: (command, args, options) => {
      spawned.push({ command, args, cwd: options.cwd, env: options.env ?? {} });
      if (command === "git" && args[0] === "rev-parse") {
        return { status: 0, stdout: `${COMMIT}\n`, stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    mkdtempSync: (prefix) => `${prefix}TEST`,
    realpathSync: (path) => path,
    rmSync: () => {},
    existsSync: () => false,
    readFileSync: (path) => {
      read.push(path);
      return COMMITTED_SAMPLE;
    },
    fetch: async () => new Response(COMMITTED_SAMPLE, { status: 200 }),
    signal: new AbortController().signal,
    platform: "linux",
    env: { PATH: "/usr/bin" },
    execPath: "/usr/bin/node",
    tmp: "/tmp",
    log: () => {},
  });
  const problems = [];
  const expect = (what, ok) => {
    if (!ok) {
      problems.push(`realSteps: ${what}.`);
    }
  };
  const head = steps.head();
  expect("head() reads the clone's HEAD", head.commit === COMMIT && head.problems.length === 0);
  const tree = steps.createTree(COMMIT);
  const added = spawned.find((call) => call.args.includes("worktree") && call.args.includes("add"));
  expect(
    "createTree adds a detached worktree of the commit, from the clone, with hooks off",
    added !== undefined &&
      added.cwd === ROOT &&
      added.args.at(-2) === tree &&
      added.args.at(-1) === COMMIT &&
      added.args.includes("--detach") &&
      added.args[0] === "-c" &&
      added.args[1].startsWith("core.hooksPath="),
  );
  spawned.length = 0;
  steps.runCheck(tree);
  steps.runInstall(tree);
  steps.runBuild(tree);
  steps.runContract(tree);
  steps.treeChanges(tree);
  steps.runPublish(tree, [...PUBLISH_ARGS, "--otp", "123456"]);
  const [check, install, build, contract, status, publish] = spawned;
  expect(
    "every step runs inside the worktree",
    spawned.length === 6 && spawned.every((call) => call.cwd === tree),
  );
  expect("the release check is the worktree's", check?.args[0] === join(tree, RELEASE_CHECK));
  expect("the contract is the worktree's", contract?.args[0] === join(tree, PUBLISH_CONTRACT));
  expect(
    "no pnpm call in the worktree may re-install on its own",
    [install, build, publish].every(
      (call) => call?.env.pnpm_config_verify_deps_before_run === "false",
    ),
  );
  expect(
    "the install is frozen and isolated, with CI set",
    JSON.stringify(install?.args) === JSON.stringify(INSTALL_ARGS) && install?.env.CI === "1",
  );
  expect(
    "the build is forced with both caches off",
    build?.args.includes("--cache=local:,remote:") && build?.env.TURBO_FORCE === "true",
  );
  expect("the worktree's own status is read", status?.command === "git");
  expect(
    "the publish carries the variable and the caller's arguments",
    publish?.env[RELEASE_PUBLISH_ENV] === "1" && publish?.args.at(-1) === "123456",
  );
  steps.readCommitted(tree);
  expect("the manifest compared is the worktree's", read[0] === join(tree, COMMITTED_MANIFEST));
  expect("removeTree reports a tree that is gone", steps.removeTree(tree) === true);
  return problems;
}

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
        "passes only an identical document, no worktree is made for a HEAD off origin/main, each " +
        "step runs only after the one before it passed and only inside the worktree, an " +
        "interruption stops the run, and every worktree made is removed, a throw included.\n",
    );
    return 0;
  }

  const root = findWorkspaceRoot();
  if (root === null) {
    throw new UsageError(`no ${WORKSPACE_FILE} found above the working directory.`);
  }
  // Ctrl-C, SIGHUP and SIGTERM stop the run at the next step and abort the manifest fetch. The
  // terminal delivers Ctrl-C to the running step too, which ends it; caught here, this process
  // lives on to remove the worktree.
  const interrupt = new AbortController();
  for (const signal of ["SIGINT", "SIGHUP", "SIGTERM"]) {
    process.on(signal, () => interrupt.abort());
  }
  return releasePublish(
    argv,
    realSteps(root, {
      spawnSync,
      mkdtempSync,
      realpathSync,
      rmSync,
      existsSync,
      readFileSync,
      fetch: globalThis.fetch,
      signal: interrupt.signal,
      platform: process.platform,
      env: process.env,
      execPath: process.execPath,
      tmp: tmpdir(),
      log: (line) => process.stderr.write(`${line}\n`),
    }),
  );
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
