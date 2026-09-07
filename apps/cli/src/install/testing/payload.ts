/**
 * A real payload-1 artefact, small enough to build in a test and runnable enough to prove a launch.
 *
 * The three properties T8 exists to establish are properties of a **process**: a launch spec that
 * starts a daemon out of a staged directory, a launcher that reaches the same daemon, and a
 * rewritten launcher that runs out of a different one. None of them can be observed from inside the
 * Vitest worker, so the tests spawn the payload — which means the payload has to be a payload:
 * `bin/node` is a copy of this process's own interpreter, `lib/node_modules/@xplainer/cli/` carries
 * a `package.json` whose `bin` field names a file that exists, and `runtime.manifest.json` is
 * produced by the **shipped** scanner, so `verifyRuntimePayload()` really re-hashes it.
 *
 * **Why not `assembleRuntime()` against a fixture checkout.** That is `runtime/assemble.test.ts`'s
 * subject and it copies npm as well, which is 17 MB the stager has no opinion about. What is under
 * test here is what happens to a payload *after* it exists, so the cheapest artefact that is
 * genuinely one — a real interpreter, a real entry, a real manifest — is the right fixture. It is
 * built once per suite and cloned for the second runtime.
 *
 * **The entry is a miniature daemon on purpose.** It serves its own identity over a loopback
 * listener and records where it is listening, so a second process started through the launcher can
 * ask "which daemon is up" and answer it over a socket rather than by comparing paths. That is the
 * difference between asserting that two strings match and asserting that the launcher **reaches**
 * the daemon the launch spec started.
 */

import { constants, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import {
  MANIFEST_VERSION,
  PAYLOAD_BIN_DIR,
  PAYLOAD_LIB_DIR,
  PAYLOAD_NPM_CLI,
  RUNTIME_MANIFEST_FILE,
  type RuntimeManifest,
  scanTree,
} from "../../runtime/manifest.js";

/** The package a payload's launch contract names, and the directory it lives in. */
export const FIXTURE_PACKAGE = "@xplainer/cli";

/** What {@link buildFixturePayload} was asked for. */
export type FixturePayloadOptions = {
  /** Where the payload goes. Created; it must not already hold one. */
  outDir: string;
  /** The version the package declares, which is the first half of a staged directory's name. */
  version: string;
  /** A string the entry reports about itself, so two runtimes are told apart by what they say. */
  marker: string;
  /**
   * Copy this process's interpreter into `bin/node`. Defaults to `true`.
   *
   * A test that only stages, names or resolves a payload never spawns it, and copying 100 MB of
   * Node for each of those would buy nothing: with this off the interpreter is a placeholder file,
   * which is still a real file with a real hash in the manifest, and the payload is still one the
   * stager and the resolver treat exactly as they treat a runnable one.
   */
  runnable?: boolean | undefined;
};

/** One built fixture payload. */
export type FixturePayload = {
  /** The payload's root. */
  outDir: string;
  /** The manifest written into it. */
  manifest: RuntimeManifest;
  /** `<payload>/bin/node`, the interpreter a launch spec names. */
  interpreter: string;
  /** `<payload>/lib/node_modules/@xplainer/cli/dist/bin.js`. */
  entry: string;
};

/** Build a runnable payload-1 artefact at `outDir`. */
export function buildFixturePayload(options: FixturePayloadOptions): FixturePayload {
  const interpreterName = process.platform === "win32" ? "node.exe" : "node";
  const interpreter = join(options.outDir, PAYLOAD_BIN_DIR, interpreterName);
  mkdirSync(dirname(interpreter), { recursive: true });
  if (options.runnable === false) {
    writeFileSync(interpreter, `not an interpreter: ${options.marker}\n`, { mode: 0o755 });
  } else {
    copyFileSync(process.execPath, interpreter, constants.COPYFILE_FICLONE);
  }

  const packageDir = join(
    options.outDir,
    ...PAYLOAD_LIB_DIR.split("/"),
    ...FIXTURE_PACKAGE.split("/"),
  );
  const entry = join(packageDir, "dist", "bin.js");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify(
      {
        name: FIXTURE_PACKAGE,
        version: options.version,
        type: "module",
        bin: { xplainer: "dist/bin.js" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(entry, entrySource(options.marker));

  // The manifest names npm's entry, so the payload carries one: a manifest that describes a file
  // the artefact does not have is a manifest `verify` would call a payload with a hole in it.
  const npmCli = join(options.outDir, ...PAYLOAD_NPM_CLI.split("/"));
  mkdirSync(dirname(npmCli), { recursive: true });
  writeFileSync(npmCli, "process.exitCode = 0;\n");

  const relativeEntry = `${PAYLOAD_LIB_DIR}/${FIXTURE_PACKAGE}/dist/bin.js`;
  const relativeInterpreter = `${PAYLOAD_BIN_DIR}/${interpreterName}`;
  const scan = scanTree(options.outDir, { exclude: [RUNTIME_MANIFEST_FILE] });
  const manifest: RuntimeManifest = {
    kind: "runtime",
    manifest_version: MANIFEST_VERSION,
    created_at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node_version: process.version,
    npm_version: "0.0.0-fixture",
    host: "node",
    launch: {
      interpreter: relativeInterpreter,
      entry: relativeEntry,
      npm_cli: PAYLOAD_NPM_CLI,
      argv: [relativeInterpreter, relativeEntry],
    },
    packages: [
      {
        path: `${PAYLOAD_LIB_DIR}/${FIXTURE_PACKAGE}`,
        name: FIXTURE_PACKAGE,
        version: options.version,
        workspace: true,
      },
    ],
    files: scan.files,
    links: scan.links,
  };
  writeFileSync(
    join(options.outDir, RUNTIME_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { outDir: options.outDir, manifest, interpreter, entry };
}

/**
 * The miniature daemon the fixture payload ships as its CLI.
 *
 * `serve` is what a launch spec starts: it binds loopback, records where it is, and prints one line
 * of JSON — the same shape the real daemon's ready line has, for the same reason, so a test waits
 * for the daemon rather than sleeping. `whoami` is what a *launcher* runs: it reads that record and
 * fetches the daemon's identity over the socket, then prints both identities and the arguments it
 * was forwarded. Everything it reports about itself — the runtime it is running out of, and the
 * marker built into it — is derived from its own location, so no test has to trust a path it
 * composed itself.
 */
function entrySource(marker: string): string {
  return `import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// <payload>/lib/node_modules/@xplainer/cli/dist/bin.js -> <payload>
const RUNTIME = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const MARKER = ${JSON.stringify(marker)};

const argv = process.argv.slice(2);
const verb = argv[0];
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const stateDir = flag("--state-dir") ?? process.env.XPLAINER_STATE_DIR;
if (stateDir === undefined) {
  process.stderr.write("no --state-dir and no XPLAINER_STATE_DIR\\n");
  process.exit(1);
}
const record = join(stateDir, "fake-daemon.json");
const identity = { runtime: RUNTIME, marker: MARKER, pid: process.pid };

if (verb === "serve") {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(identity));
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    writeFileSync(record, JSON.stringify({ ...identity, port, argv }));
    process.stdout.write(JSON.stringify({ event: "ready", ...identity, port }) + "\\n");
  });
  process.on("SIGTERM", () => {
    server.close();
    process.exit(0);
  });
} else if (verb === "whoami") {
  const daemon = JSON.parse(readFileSync(record, "utf8"));
  const reached = await (await fetch("http://127.0.0.1:" + daemon.port + "/whoami")).json();
  process.stdout.write(
    JSON.stringify({
      launcher_runtime: RUNTIME,
      launcher_marker: MARKER,
      forwarded: argv.slice(1),
      daemon_record: daemon,
      reached,
    }) + "\\n",
  );
} else {
  process.stderr.write("unknown verb " + String(verb) + "\\n");
  process.exit(1);
}
`;
}
