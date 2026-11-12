#!/usr/bin/env node
/**
 * `pnpm release:publish` — the one command that publishes a release (ADR 0031's note of
 * 2026-11-12, D8).
 *
 * Three steps, each run only when the one before it passed:
 *
 *   1. `node scripts/check-release-ready.mjs` — the offline release check: the template carries
 *      no package manifest and no trace of the previous renderer, every render platform's browser
 *      and ffmpeg row is recorded, and every entry of `docs/release-blockers.json` is closed with
 *      its evidence.
 *   2. Rule (c), here: the toolchain manifest the CDN serves at
 *      `https://cdn.xplainer.video/toolchain/v2/manifest.json` is byte-identical to the committed
 *      `apps/cli/src/setup/toolchain.manifest.json`, compared by SHA-256. A release whose
 *      `setup` would read a different document than the one reviewed here is refused.
 *   3. `pnpm publish -r --no-git-checks --access public`, with every argument given to this
 *      script appended — `pnpm release:publish --otp 123456`. A leading `--` is dropped.
 *
 * WHY THE NETWORK RULE IS HERE AND NOT IN THE HOOK. Step 1 is also every published member's
 * `prepublishOnly`, so a bare `pnpm publish -r` is refused by the same check; pnpm runs that hook
 * per package, before packing it, and stops the whole run at the first refusal. Step 2 cannot go
 * there: a CDN that answered for the third package and failed for the fourth would leave a release
 * half on the registry. Here it runs once, before the first package is touched.
 *
 * DO NOT RUN THIS BEFORE THE VERSION-2 MANIFEST IS UPLOADED. Step 2 requests its URL, and until the
 * cache rule in `infra/terraform` is applied an error answer can be kept at the edge for 30 days
 * (`docs/release-blockers.json`, `v2-manifest-upload` and `cdn-cache-rule-applied`). Step 1
 * refuses while either is open, so the request is not made by accident.
 *
 * `--self-test` drives all three steps with an injected `fetch` and an injected process runner —
 * the manifest compare on identical, different, missing and unreachable answers, and the order:
 * nothing is fetched when the check refuses, nothing is published when the compare refuses, and
 * the publish gets the fixed arguments and then the caller's. It requests nothing and spawns
 * nothing, and it is what `pnpm verify` and CI run.
 *
 * Exit codes:
 *   0  published (or every self-test passed)
 *   1  the published manifest differs or could not be read, a self-test failed, or the publish
 *      itself failed with no code of its own
 *   2  an argument this script cannot take, or no workspace root
 *  70  internal error
 *   *  any other code is the release check's or `pnpm publish`'s own, passed through
 */
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_FILE = "pnpm-workspace.yaml";
const RELEASE_CHECK = "scripts/check-release-ready.mjs";
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
 * The three steps, in order, each behind the last. `steps` supplies every effect: `runCheck()` and
 * `runPublish(args)` return an exit status (`null` for a signal), `readCommitted()` the committed
 * manifest's bytes, `fetch` the network, and `log(line)` where the refusals go.
 */
async function releasePublish(argv, steps) {
  const extra = argv[0] === "--" ? argv.slice(1) : argv;
  const check = steps.runCheck();
  if (check !== 0) {
    steps.log(
      `release:publish: the release check refused (exit ${String(check)}); nothing was fetched ` +
        "and nothing was published.",
    );
    return check ?? 1;
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
async function rehearse({ argv = [], check = 0, answer, publish = 0 }) {
  const calls = [];
  const { fetchImpl, urls } = fakeFetch(answer ?? { status: 200, body: COMMITTED_SAMPLE });
  const status = await releasePublish(argv, {
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

const SEQUENCE_TESTS = [
  {
    name: "a refused check fetches nothing and publishes nothing",
    run: { check: 1 },
    expect: { status: 1, calls: ["check"], fetched: 0 },
  },
  {
    name: "a check that could not run passes its own code through",
    run: { check: 2 },
    expect: { status: 2, calls: ["check"], fetched: 0 },
  },
  {
    name: "a check killed by a signal is a refusal",
    run: { check: null },
    expect: { status: 1, calls: ["check"], fetched: 0 },
  },
  {
    name: "a differing manifest publishes nothing",
    run: { answer: { status: 200, body: different } },
    expect: { status: 1, calls: ["check"], fetched: 1 },
  },
  {
    name: "a passing release publishes once, with the caller's arguments last",
    run: { argv: ["--otp", "123456"] },
    expect: {
      status: 0,
      calls: ["check", ["publish", ...PUBLISH_ARGS, "--otp", "123456"]],
      fetched: 1,
    },
  },
  {
    name: "a leading -- is not passed to pnpm",
    run: { argv: ["--", "--otp", "123456"] },
    expect: {
      status: 0,
      calls: ["check", ["publish", ...PUBLISH_ARGS, "--otp", "123456"]],
      fetched: 1,
    },
  },
  {
    name: "a failed publish is a failed release",
    run: { publish: 1 },
    expect: { status: 1, calls: ["check", ["publish", ...PUBLISH_ARGS]], fetched: 1 },
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
  return { problems, cases: MANIFEST_TESTS.length + SEQUENCE_TESTS.length };
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
      `release:publish: ${String(cases)} self-test case(s) passed with an injected fetch and ` +
        "runner: rule (c) passes only an identical document, and nothing is fetched after a " +
        "refused check or published after a refused compare.\n",
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
  return releasePublish(argv, {
    runCheck: () =>
      spawnSync(process.execPath, [join(root, RELEASE_CHECK)], { cwd: root, stdio: "inherit" })
        .status,
    readCommitted: () => readFileSync(join(root, COMMITTED_MANIFEST)),
    fetch: globalThis.fetch,
    runPublish: (args) =>
      spawnSync(isWindows ? "pnpm.cmd" : "pnpm", args, {
        cwd: root,
        stdio: "inherit",
        shell: isWindows,
      }).status,
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
