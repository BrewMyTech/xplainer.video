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
 *
 * **It is faithful about the four things an install verifies, and about nothing else.** T11's
 * verify step polls an **authenticated** `GET /healthz` and finds the daemon through the files the
 * real one writes, so this entry does the same four things the real `serve` does and in the same
 * order: it mints the bearer token at `--token-file` if the file is absent (`0600`, `O_EXCL`), it
 * binds `--port`, it writes `runtime.json` and merges the port, the token path and the socket into
 * `daemon.json` — merges, so the installer's own fields survive — and only then prints its ready
 * line. `/healthz` answers `401` without that token. What it deliberately does **not** have is the
 * job store, the ownership lock, the reconciler, the MCP endpoint or the real guard's `Host` and
 * `Origin` layers: those are `daemon/`'s and are proved in `daemon/`'s own suites against the real
 * `serve`. The end-to-end case — the real `serve`, out of a real `runtime build` payload, under a
 * real `launchctl` or `systemctl` — is `install.supervisor.test.ts`, which is why this fixture can
 * stay small enough to build in a `beforeAll`.
 */

import { constants, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import {
  MANIFEST_VERSION,
  type ManifestPackage,
  PAYLOAD_BIN_DIR,
  PAYLOAD_LIB_DIR,
  PAYLOAD_NPM_CLI,
  RUNTIME_MANIFEST_FILE,
  type RuntimeManifest,
  scanTree,
} from "../../runtime/manifest.js";

/** The package a payload's launch contract names, and the directory it lives in. */
export const FIXTURE_PACKAGE = "@xplainer/cli";

/** The package whose `template/package.json` declares the workspace pins a runtime resolves. */
export const TEMPLATE_FIXTURE_PACKAGE = "@xplainer/render-core";

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
  /**
   * Extra names in `bin/` that are copies of the interpreter.
   *
   * `runtime/verify.ts` refuses a payload whose manifest names another platform — the interpreter
   * is a native binary — so a macOS machine cannot stage a Windows payload at all, and the
   * Windows registration path would be untestable anywhere but Windows. What *is* testable
   * everywhere is the artefact, the argv and the command sequence, and those need only a file at
   * the name the launch contract picks. So a caller that is going to build a `win32` launch spec
   * asks for `node.exe` here: it is a real file, it is in the manifest with a real hash, and the
   * preflight's `X_OK` probe answers about the same bytes it would on Windows.
   */
  extraInterpreters?: readonly string[] | undefined;
  /**
   * The workspace pins a `@xplainer/render-core` inside the payload declares, or none.
   *
   * A real payload always carries one — `render-core`'s `files` allowlist ships `template/`, so
   * every runtime states which Remotion line its workspace resolves — and T15's pre-drain check
   * compares exactly that document between two payloads. It is an option rather than the default
   * because most suites here are about staging, naming and launching, and a payload with one more
   * package in it is a payload with a different content digest and therefore a different slot name.
   */
  templatePins?: Readonly<Record<string, string>> | undefined;
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

  for (const name of options.extraInterpreters ?? []) {
    copyFileSync(
      interpreter,
      join(options.outDir, PAYLOAD_BIN_DIR, name),
      constants.COPYFILE_FICLONE,
    );
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

  const templatePackages: ManifestPackage[] = [];
  if (options.templatePins !== undefined) {
    const templateDir = join(
      options.outDir,
      ...PAYLOAD_LIB_DIR.split("/"),
      ...TEMPLATE_FIXTURE_PACKAGE.split("/"),
    );
    mkdirSync(join(templateDir, "template"), { recursive: true });
    writeFileSync(
      join(templateDir, "package.json"),
      `${JSON.stringify({ name: TEMPLATE_FIXTURE_PACKAGE, version: options.version }, null, 2)}\n`,
    );
    // The same two fields `runtime/verify.ts` reads out of the real template, and in the same
    // document: `dependencies` is what a workspace resolves and `devDependencies` travels with it.
    writeFileSync(
      join(templateDir, "template", "package.json"),
      `${JSON.stringify(
        {
          name: "@xplainer/render-workspace",
          version: "1.0.0",
          private: true,
          dependencies: { ...options.templatePins },
        },
        null,
        2,
      )}\n`,
    );
    templatePackages.push({
      path: `${PAYLOAD_LIB_DIR}/${TEMPLATE_FIXTURE_PACKAGE}`,
      name: TEMPLATE_FIXTURE_PACKAGE,
      version: options.version,
      workspace: true,
    });
  }

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
      ...templatePackages,
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
 * `serve` is what a launch spec starts: it mints the token, binds loopback, writes the two state
 * files, and prints one line of JSON — the same shape the real daemon's ready line has, for the
 * same reason, so a test waits for the daemon rather than sleeping. `whoami` is what a *launcher*
 * runs: it reads that record and fetches the daemon's identity over the socket, then prints both
 * identities and the arguments it was forwarded. Everything it reports about itself — the runtime
 * it is running out of, and the marker built into it — is derived from its own location, so no test
 * has to trust a path it composed itself.
 *
 * The order is the real one and it matters: the token exists before the listener does, because a
 * poller that reached `/healthz` before the file was written would get a `401` it could not tell
 * from a wrong token; and `runtime.json` is written after the bind, because its whole job is to
 * record the port that was really taken.
 */
function entrySource(marker: string): string {
  return `import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Merge into a JSON file, keeping every key already in it. */
const mergeJson = (path, changes) => {
  let held = {};
  if (existsSync(path)) {
    held = JSON.parse(readFileSync(path, "utf8"));
  }
  writeFileSync(path, JSON.stringify({ ...held, ...changes }, null, 2) + "\\n");
};

if (verb === "serve") {
  // The token first, and only when it is absent: the real daemon owns this file, and a poller that
  // reached the port before the file existed could not tell "not ready" from "wrong token".
  const tokenFile = flag("--token-file") ?? join(stateDir, "token");
  mkdirSync(dirname(tokenFile), { recursive: true });
  if (!existsSync(tokenFile)) {
    writeFileSync(tokenFile, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
  }
  const token = readFileSync(tokenFile, "utf8").trim();
  const socket = flag("--socket") ?? null;

  // Shutting down is one function, because two callers reach it: the drain route below and
  // SIGTERM. Both end the way the real daemon's step 6 ends — runtime.json removed, exit 0 —
  // which is what \`awaitStopped()\` is watching for.
  let shuttingDown = false;
  const shutDown = () => {
    const already = shuttingDown;
    shuttingDown = true;
    if (!already) {
      setTimeout(() => {
        rmSync(join(stateDir, "runtime.json"), { force: true });
        if (socket !== null) {
          rmSync(socket, { force: true });
        }
        process.exit(0);
      }, 50);
    }
    return already;
  };

  const handler = (request, response) => {
    response.setHeader("content-type", "application/json");
    if ((request.url ?? "").startsWith("/api/daemon/drain") && request.method === "POST") {
      const already = shutDown();
      response.statusCode = 202;
      response.end(
        JSON.stringify({
          event: "draining",
          timeout_ms: 5000,
          pid: process.pid,
          already_draining: already,
        }),
      );
      return;
    }
    if ((request.url ?? "").startsWith("/healthz")) {
      if (request.headers.authorization !== "Bearer " + token) {
        response.statusCode = 401;
        response.setHeader("www-authenticate", "Bearer");
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      response.end(
        JSON.stringify({ status: "ok", version: MARKER, contract_version: "1" }),
      );
      return;
    }
    response.end(JSON.stringify(identity));
  };

  const server = createServer(handler);
  // The IPC listener is the one ADR 0024's drain arrives on, and it is the same application: one
  // handler, two listeners, exactly as \`startServer({ ipc })\` binds them. A path this platform
  // cannot listen on is reported and skipped rather than fatal — a fixture that refused to start
  // because a named pipe could not be bound on macOS would fail every case that never drains.
  if (socket !== null) {
    try {
      mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
      rmSync(socket, { force: true });
      const ipc = createServer(handler);
      ipc.on("error", (error) => {
        process.stderr.write("ipc listen failed: " + String(error) + "\\n");
      });
      ipc.listen(socket);
    } catch (error) {
      process.stderr.write("ipc listen failed: " + String(error) + "\\n");
    }
  }
  const requested = Number(flag("--port") ?? "0");
  server.listen(requested, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    // After the bind, because the point of this file is the port that was really taken.
    writeFileSync(
      join(stateDir, "runtime.json"),
      JSON.stringify(
        {
          format_version: 1,
          pid: process.pid,
          run_id: MARKER + "-" + String(process.pid),
          boot_id: null,
          port,
          addresses: ["http://127.0.0.1:" + String(port)],
          socket,
          started_at: new Date().toISOString(),
        },
        null,
        2,
      ) + "\\n",
    );
    // Merged, not replaced: an installer wrote this file a moment ago and its fields are what
    // the uninstall reads.
    mergeJson(join(stateDir, "daemon.json"), {
      port,
      token_file: tokenFile,
      socket_path: socket,
      contract_version: "1",
    });
    writeFileSync(record, JSON.stringify({ ...identity, port, argv }));
    process.stdout.write(JSON.stringify({ event: "ready", ...identity, port }) + "\\n");
  });
  server.on("error", (error) => {
    process.stderr.write("listen failed: " + String(error) + "\\n");
    process.exit(1);
  });
  process.on("SIGTERM", () => {
    rmSync(join(stateDir, "runtime.json"), { force: true });
    if (socket !== null) {
      rmSync(socket, { force: true });
    }
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
