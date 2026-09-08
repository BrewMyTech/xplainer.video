/**
 * The packaged application's payload, checked on the machine that packed it.
 *
 * This is the check T22 CREATES; nothing in this repository asserted the shape of a packaged
 * desktop build before it. Round 1 described it three times as "extending" an existing check and
 * there was none, so the five assertions below are written out rather than implied:
 *
 *   1. **The dependency shape.** `@xplainer/cli` must resolve to a real directory carrying a built
 *      `dist/`, never to a symlink: electron-builder walks real directories and does not follow
 *      pnpm's links, so a symlinked workspace dependency is packed as a broken one. NOTE the path
 *      this asserts is the path Node resolves, not a hard-coded `apps/desktop/node_modules/…` —
 *      `pnpm-workspace.yaml` sets `nodeLinker: hoisted`, and a hoisted linker puts the injected
 *      copy in the WORKSPACE ROOT's `node_modules`, leaving `apps/desktop/node_modules` without an
 *      `@xplainer` directory at all (measured, pnpm 11.25.0).
 *   2. **The payload is in the packaged tree**, at `<resources>/xplainer-runtime/`, with its
 *      manifest — which is what `extraResources` in `electron-builder.yml` is for.
 *   3. **The architectures match, compared by this process** — the runner's own Node, which is
 *      already running on this machine's architecture. A payload built for another architecture
 *      cannot perform this comparison on itself: it cannot start. This is the check that turns
 *      `Bad CPU type in executable` into a sentence naming both architectures (plan §1.3d B).
 *   4. **`runtime verify` re-hashes the payload as it was packed.** The comparison above reads two
 *      fields; this reads every byte, from the checkout's own CLI, and it is what catches a
 *      packaging step that rewrote, truncated or dereferenced part of the payload on the way into
 *      `Resources`.
 *   5. **The production call path runs.** `<payload>/bin/node[.exe] <payload>/…/dist/bin.js
 *      --version` — the payload's own interpreter running the payload's own entry, which is exactly
 *      what the app spawns under decision D10. Nothing here uses `ELECTRON_RUN_AS_NODE`, and no
 *      flag exists that only this check would pass.
 *
 * Run it after `electron-builder` — `--dir` is enough — from anywhere:
 *
 *     node apps/desktop/scripts/check-packaged-payload.mjs
 *
 * It needs no display, which is why `.github/workflows/desktop.yml` runs it on all three runners.
 * The graphical half is `check-packaged-launch.mjs`, and it does.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** `apps/desktop`, derived from this file rather than from the working directory. */
const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The workspace root. */
const REPO_DIR = resolve(DESKTOP_DIR, "..", "..");

/** Where electron-builder writes, per `directories.output`. */
const RELEASE_DIR = join(DESKTOP_DIR, "release");

/** The `extraResources` destination, and `PACKAGED_PAYLOAD_DIRECTORY` in `src/main/paths.ts`. */
const PAYLOAD_DIRECTORY = "xplainer-runtime";

/** Payload 1's manifest, and `RUNTIME_MANIFEST_FILE` in `apps/cli/src/runtime/manifest.ts`. */
const RUNTIME_MANIFEST_FILE = "runtime.manifest.json";

/** The CLI entry inside the payload, payload-relative. */
const PAYLOAD_CLI_ENTRY = ["lib", "node_modules", "@xplainer", "cli", "dist", "bin.js"];

/** The checkout's own CLI, which runs `runtime verify` from a process that is already compatible. */
const CHECKOUT_CLI = join(REPO_DIR, "apps", "cli", "dist", "bin.js");

let failures = 0;

/** Record one passing assertion. */
function ok(what, detail) {
  process.stdout.write(`ok    ${what}${detail === undefined ? "" : ` — ${detail}`}\n`);
}

/** Record one failing assertion and keep going, so one run reports every problem it can see. */
function fail(what, detail) {
  failures += 1;
  process.stdout.write(`FAIL  ${what}\n      ${detail}\n`);
}

/**
 * The `Resources` directory of the packaged application for this platform.
 *
 * macOS is globbed rather than hard-coded because electron-builder names the directory after the
 * architectures it packed — `mac-arm64` for the arm64-only target this app ships (§1.3d B) and
 * `mac` when it packs the host default — and a check that guessed would fail for a reason that has
 * nothing to do with the payload.
 */
function packagedResources() {
  if (process.platform === "darwin") {
    const macDirs = existsSync(RELEASE_DIR)
      ? readdirSync(RELEASE_DIR).filter((name) => name === "mac" || name.startsWith("mac-"))
      : [];
    for (const dir of macDirs) {
      const parent = join(RELEASE_DIR, dir);
      const bundle = readdirSync(parent).find((name) => name.endsWith(".app"));
      if (bundle !== undefined) {
        return join(parent, bundle, "Contents", "Resources");
      }
    }
    return null;
  }
  const unpacked = process.platform === "win32" ? "win-unpacked" : "linux-unpacked";
  const resources = join(RELEASE_DIR, unpacked, "resources");
  return existsSync(resources) ? resources : null;
}

/**
 * The directory Node resolves `@xplainer/cli` to when asked from `apps/desktop`, or `null`.
 *
 * Node's own algorithm, walked explicitly: `apps/desktop/node_modules`, then each parent's. It is
 * written out rather than delegated to `require.resolve` because the package's `exports` map does
 * not expose `./package.json`, so `require.resolve` cannot answer with the directory itself.
 */
function resolvePackedCli() {
  let directory = DESKTOP_DIR;
  for (;;) {
    const candidate = join(directory, "node_modules", "@xplainer", "cli");
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

/** Assertion 1: the dependency electron-builder packs is a real directory with a built `dist/`. */
function checkDependencyShape() {
  const packed = resolvePackedCli();
  if (packed === null) {
    fail(
      "@xplainer/cli resolves from apps/desktop",
      "no node_modules/@xplainer/cli at or above apps/desktop. Run `pnpm install`.",
    );
    return;
  }
  const stats = lstatSync(packed);
  if (stats.isSymbolicLink()) {
    fail(
      "@xplainer/cli is a real directory, not a symlink",
      `${packed} is a symlink. electron-builder does not follow one, so the packed app would ` +
        `carry a dangling dependency. pnpm-workspace.yaml's injectWorkspacePackages and ` +
        `dedupeInjectedDeps: false are what keep it a directory.`,
    );
    return;
  }
  if (!stats.isDirectory()) {
    fail("@xplainer/cli is a real directory, not a symlink", `${packed} is not a directory.`);
    return;
  }
  ok("@xplainer/cli is a real directory, not a symlink", packed);

  const entry = join(packed, "dist", "bin.js");
  if (existsSync(entry)) {
    ok("the packed @xplainer/cli carries its built entry", entry);
  } else {
    fail(
      "the packed @xplainer/cli carries its built entry",
      `${entry} is absent. Build it: pnpm --filter @xplainer/cli build.`,
    );
  }
}

/** Assertion 3: the payload's architecture against this process's, before anything is spawned. */
function checkArchitecture(manifestFile) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch (error) {
    fail("the payload manifest is readable JSON", `${manifestFile}: ${error.message}`);
    return false;
  }
  if (manifest.platform !== process.platform) {
    fail(
      "the payload was built for this platform",
      `payload platform ${manifest.platform} != host ${process.platform}`,
    );
    return false;
  }
  if (manifest.arch !== process.arch) {
    fail(
      "the payload was built for this architecture",
      `payload arch ${manifest.arch} != host ${process.arch}`,
    );
    return false;
  }
  ok(
    "the payload was built for this platform and architecture",
    `${manifest.platform}/${manifest.arch}, compared by this process before any spawn`,
  );
  return true;
}

/** Assertion 4: every byte of the payload, re-hashed by the checkout's CLI. */
function checkRuntimeVerify(payloadRoot) {
  if (!existsSync(CHECKOUT_CLI)) {
    fail(
      "`runtime verify` re-hashes the packaged payload",
      `${CHECKOUT_CLI} is absent. Build it: pnpm --filter @xplainer/cli build.`,
    );
    return;
  }
  const verify = spawnSync(process.execPath, [CHECKOUT_CLI, "runtime", "verify", payloadRoot], {
    encoding: "utf8",
  });
  if (verify.status === 0) {
    ok("`runtime verify` re-hashes the packaged payload", verify.stdout.trim());
  } else {
    fail(
      "`runtime verify` re-hashes the packaged payload",
      `${(verify.stderr || verify.stdout || "").trim()} (exit ${verify.status})`,
    );
  }
}

/** Assertion 5: the production call path — the payload's interpreter running the payload's entry. */
function checkProductionCallPath(payloadRoot) {
  const interpreter = join(payloadRoot, "bin", process.platform === "win32" ? "node.exe" : "node");
  const entry = join(payloadRoot, ...PAYLOAD_CLI_ENTRY);
  for (const file of [interpreter, entry]) {
    if (!existsSync(file)) {
      fail("the payload carries the launch contract's files", `${file} is absent.`);
      return;
    }
  }
  const run = spawnSync(interpreter, [entry, "--version"], { encoding: "utf8" });
  if (run.error !== undefined) {
    fail(
      "the payload's own interpreter runs the payload's own entry",
      `${interpreter} would not start: ${run.error.message}`,
    );
    return;
  }
  const printed = run.stdout.trim();
  if (run.status === 0 && /^\d+\.\d+\.\d+/.test(printed)) {
    ok(
      "the payload's own interpreter runs the payload's own entry",
      `${interpreter} ${entry} --version -> ${printed}`,
    );
  } else {
    fail(
      "the payload's own interpreter runs the payload's own entry",
      `exit ${run.status}, stdout ${JSON.stringify(printed)}, stderr ` +
        `${JSON.stringify(run.stderr.trim())}`,
    );
  }
}

process.stdout.write(
  `packaged payload check — ${process.platform}/${process.arch}, node ${process.version}\n`,
);

checkDependencyShape();

const resources = packagedResources();
if (resources === null) {
  fail(
    "a packaged application exists for this platform",
    `nothing under ${RELEASE_DIR}. Pack one first: pnpm --filter @xplainer/desktop exec ` +
      `electron-builder --dir --publish never`,
  );
} else {
  ok("a packaged application exists for this platform", resources);
  const payloadRoot = join(resources, PAYLOAD_DIRECTORY);
  const manifestFile = join(payloadRoot, RUNTIME_MANIFEST_FILE);
  if (!existsSync(manifestFile)) {
    fail(
      "the packaged application ships the runtime payload",
      `${manifestFile} is absent. electron-builder.yml's extraResources copies ` +
        `.artefacts/xplainer-runtime, which \`xplainer runtime build --out\` produces.`,
    );
  } else {
    ok("the packaged application ships the runtime payload", manifestFile);
    if (checkArchitecture(manifestFile)) {
      checkRuntimeVerify(payloadRoot);
      checkProductionCallPath(payloadRoot);
    }
  }
}

if (failures === 0) {
  process.stdout.write("PACKAGED PAYLOAD CHECK PASSED\n");
} else {
  process.stdout.write(`PACKAGED PAYLOAD CHECK FAILED — ${failures} assertion(s)\n`);
  process.exitCode = 1;
}
