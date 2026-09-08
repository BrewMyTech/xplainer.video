#!/usr/bin/env node
/**
 * The P2-5 gate: what a daemon exposed beyond this machine actually answers.
 *
 * [ADR 0020](../../docs/adr/0020-always-running-local-daemon.md) §Security R-SEC-9 does not make
 * remote exposure a flag. It makes it a list, and the list is `all` rather than `any`: an explicit
 * `--bind`, an explicit `--i-understand-remote-exposure`, TLS, at least one `--allow-host`, and a
 * token this daemon did not mint — with `0.0.0.0` and `::` refused outright however hard the caller
 * insists. T25 built that as behaviour and `apps/cli`'s suites assert every branch of it in
 * process. This script is the half those cannot be: **a real listener on an address that is not
 * loopback**, reached over a real TLS handshake from a client that pins the operator's own
 * certificate, so that the `401`, the `200` and the `403` are what a machine on the other end of a
 * network card would receive.
 *
 * **Two phases, and the first one is the one that matters.**
 *
 * 1. **Refused before anything is bound.** Five commands, each missing exactly one of R-SEC-9's
 *    requirements, and each spawned **while this script itself holds the port they were told to
 *    bind**. That is what turns "it printed a refusal" into evidence about *ordering*: a `serve`
 *    that reached `listen()` on a held port exits `10` naming the address as already in use, so an
 *    exit `1` carrying the refusal sentence proves the precondition was decided first. A **sixth**
 *    command with every precondition supplied is run onto the same held port and is required to
 *    exit `10`, because without it "exit 1 rather than 10" would be an assertion about a port
 *    nothing was ever holding. The state directory is then read back for each refusal: no
 *    `runtime.json`, which `markReady()` is the only writer of, and no recorded port in
 *    `daemon.json`.
 * 2. **The four outcomes over TLS.** One daemon on the chosen address with a self-signed
 *    certificate and an operator token, then: an unauthenticated request is `401` with the
 *    `WWW-Authenticate` challenge; the operator's token is `200`; a valid token carrying
 *    `Host: evil.com` is `403`; and the guard's loopback authorities are still on the allowlist
 *    while the **bound address itself** is not, because `--allow-host` is where that decision is
 *    made and an authority nobody asked for is an authority nobody decided about. That pair is
 *    CVE-2026-65105 written as an assertion: widening the bind added the operator's name and
 *    removed nothing.
 *
 * **Which address it binds.** The first non-internal IPv4 this machine has that will accept a
 * listener — a LAN address, which is genuinely reachable from another host — and, only if there is
 * none, the loopback alias `127.0.0.2`, which is not routed anywhere but is not in
 * `daemon/binding.ts`'s `LOOPBACK_BINDS` either and therefore exercises the same code path. Which
 * one was used is printed rather than assumed, and `XPLAINER_REMOTE_BIND` overrides the choice.
 * The listener is up for the length of one phase, on a port the kernel picks, behind TLS, an
 * operator token and a `Host` allowlist — which is the whole configuration this gate exists to
 * prove.
 *
 * ```bash
 * pnpm e2e:remote
 * XPLAINER_REMOTE_BIND=192.168.1.20 pnpm e2e:remote   # name the interface yourself
 * ```
 *
 * It is **not** part of `pnpm verify` and must not become part of it: it binds a real address on
 * whatever network this machine is attached to. `.github/workflows/daemon-remote.yml` runs it on
 * `ubuntu-latest` and `macos-latest`, where the address is the runner's own private one.
 *
 * **Windows is not in this gate, and the reason is not that it was skipped.** The guard, the
 * refusals and the TLS listener are the same portable code on all three platforms and are asserted
 * on all three by `apps/cli`'s suites; what is genuinely different there is the *filesystem* half
 * of R-SEC-5 — the token file's ACL and the named pipe's security descriptor — and that has its own
 * two-account proof in `.github/workflows/daemon-windows.yml`, which is T26's.
 *
 * Environment it reads: `XPLAINER_REMOTE_BIND` (the address to bind) and `COLLIE_ARTIFACTS_DIR`
 * (default `<repo>/.session/artifacts`). Everything it prints is also written to
 * `<artifacts>/e2e-remote.log`, line by line, so a run that dies halfway still leaves its
 * transcript behind.
 *
 * Exit codes: `0` every assertion held; `1` one did not, and the last line names it.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { get as httpGet } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { writeSelfSignedCertificate } from "../../apps/cli/src/daemon/testing/self-signed.ts";

/** The repository root, two levels up from this file. */
const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** The built CLI this gate drives. `pnpm turbo build` below makes it this commit's. */
const CLI = join(REPO, "apps", "cli", "dist", "bin.js");

/** Where the transcript is left for a human to look at. */
const ARTIFACTS =
  (process.env.COLLIE_ARTIFACTS_DIR ?? "").trim() || join(REPO, ".session/artifacts");

/** Where the transcript is written, line by line. */
const LOG_PATH = join(ARTIFACTS, "e2e-remote.log");

/**
 * The name the certificate carries and the one `--allow-host` this daemon is given.
 *
 * A name rather than the bound address, because `--allow-host` takes "a hostname clients will send
 * in `Host`" and because a name is what makes the two halves separable below: the client reaches
 * the daemon at an IP address it was never told to trust, and the authority it is admitted under is
 * the operator's name.
 */
const ALLOW_HOST = "xplainer-remote.test";

/** The loopback alias, used only when this machine has no external IPv4 at all. */
const LOOPBACK_ALIAS = "127.0.0.2";

/** How long the daemon has to print its ready line. */
const READY_TIMEOUT_MS = 60_000;

/** How long one request may take. */
const REQUEST_TIMEOUT_MS = 15_000;

/** How long `SIGTERM` to exit may take. The shipped drain budget is 20 s. */
const SHUTDOWN_TIMEOUT_MS = 40_000;

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

/**
 * How pnpm is spawned, in the form `spawnSync` takes it.
 *
 * On POSIX it is pnpm's own name and its arguments. On Windows pnpm is a `pnpm.cmd` shim, which is
 * not an image the kernel can execute, and since CVE-2024-27980 Node refuses to hand one to
 * `CreateProcess` without `shell` — and passing arguments *and* `shell: true` is a Node 24 runtime
 * deprecation (DEP0190), so that branch passes one command string and no argument array.
 */
function pnpm(...args) {
  return process.platform === "win32"
    ? { command: `pnpm.cmd ${args.join(" ")}`, args: [], shell: true }
    : { command: "pnpm", args, shell: false };
}

/** Run a command with both streams captured into the transcript, and return the whole result. */
function spawnLogged(label, spec, options = {}) {
  say(`${stamp()} ${label}`);
  const result = spawnSync(spec.command, spec.args, {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: spec.shell === true,
    ...options,
  });
  for (const [stream, text] of [
    ["out", result.stdout ?? ""],
    ["err", result.stderr ?? ""],
  ]) {
    for (const line of text.split("\n")) {
      if (line.trim() !== "") {
        say(`  [${stream}] ${line}`);
      }
    }
  }
  if (result.error !== undefined) {
    say(`  [error] ${result.error.message}`);
  }
  say(`${stamp()} ${label}: exit ${String(result.status ?? result.signal)}`);
  return result;
}

/** Every address this gate is willing to bind, in the order it will try them. */
function candidateAddresses() {
  const configured = (process.env.XPLAINER_REMOTE_BIND ?? "").trim();
  if (configured !== "") {
    return [{ address: configured, where: "XPLAINER_REMOTE_BIND" }];
  }
  const candidates = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        candidates.push({ address: entry.address, where: name });
      }
    }
  }
  // Last, and only as a fallback: an alias inside 127.0.0.0/8 is not reachable from another host,
  // so it proves less about exposure — but it is not one of `LOOPBACK_BINDS`'s four literals
  // either, so every R-SEC-9 branch under test runs exactly as it would on a LAN address. Linux
  // binds it with no setup; macOS needs `sudo ifconfig lo0 alias 127.0.0.2` first.
  candidates.push({ address: LOOPBACK_ALIAS, where: "loopback alias" });
  return candidates;
}

/** Hold `address` on a port the kernel picks, or reject if this machine will not have it. */
function holdPort(address) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: address, port: 0, exclusive: true }, () => {
      const bound = server.address();
      if (bound === null || typeof bound === "string") {
        server.close();
        reject(new Error(`${address} bound something without a port`));
        return;
      }
      resolve({ port: bound.port, release: () => new Promise((done) => server.close(done)) });
    });
  });
}

/** The first candidate this machine will actually let a listener onto, with the port held. */
async function seizeAddress() {
  const tried = [];
  for (const candidate of candidateAddresses()) {
    const held = await holdPort(candidate.address).then(
      (value) => value,
      (error) => {
        tried.push(`${candidate.address} (${candidate.where}): ${error.message}`);
        return null;
      },
    );
    if (held !== null) {
      return { ...candidate, ...held };
    }
  }
  throw new Error(
    `no address on this machine accepted a listener, so there is nothing to expose: ${tried.join("; ")}. ` +
      "Set XPLAINER_REMOTE_BIND to an address this host holds, or add the loopback alias " +
      `(macOS: sudo ifconfig lo0 alias ${LOOPBACK_ALIAS}).`,
  );
}

/** The environment the daemon is spawned with: this shell's, minus anything that would steer it. */
function daemonEnvironment(paths) {
  const env = { ...process.env, XPLAINER_VIDEOS_DIR: paths.videos };
  // Both have flag equivalents this gate passes explicitly, and a value inherited from the
  // operator's shell would silently answer for a different daemon than the one under test.
  delete env.XPLAINER_STATE_DIR;
  delete env.XPLAINER_TOKEN_FILE;
  delete env.XPLAINER_SOCKET;
  return env;
}

/** `xplainer serve <args>`, run to completion, for the refusals that never reach a listener. */
function serveRefused(label, args, paths) {
  return spawnLogged(
    label,
    { command: process.execPath, args: [CLI, "serve", ...args] },
    {
      env: daemonEnvironment(paths),
    },
  );
}

/** What `daemon.json` says about a start, or `null` when the state directory was never made. */
function recordedState(stateDir) {
  const path = join(stateDir, "daemon.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

/** Start the daemon and resolve when its ready line arrives. */
function startDaemon(args, paths) {
  const child = spawn(process.execPath, [CLI, "serve", ...args], {
    env: daemonEnvironment(paths),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  const stderr = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the daemon printed no ready line inside ${READY_TIMEOUT_MS} ms`));
    }, READY_TIMEOUT_MS);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      for (const line of String(chunk).trim().split("\n")) {
        if (line.trim() !== "") {
          stderr.push(line);
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
      clearTimeout(timer);
      try {
        resolve({ child, ready: JSON.parse(line), stderr });
      } catch (error) {
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

/**
 * One `GET /healthz` over TLS, with the `Host` header and the token the case is about.
 *
 * `node:https`'s client, not `fetch`: undici drops a `Host` override, which is a phase-1
 * measurement and is exactly the header four of these cases turn on. `servername` is pinned to the
 * certificate's name so that the `Host` header cannot steer certificate verification — Node derives
 * the SNI name and the identity check from `Host` when nothing else says otherwise, and the
 * `evil.com` case would then fail in the handshake rather than reaching the guard it is about.
 */
function ask(endpoint, { host, authorization }) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    if (authorization !== undefined) {
      headers.Authorization = authorization;
    }
    if (endpoint.origin !== undefined) {
      headers.Origin = endpoint.origin;
    }
    const request = httpsRequest(
      {
        host: endpoint.address,
        port: endpoint.port,
        path: "/healthz",
        method: "GET",
        headers,
        ca: endpoint.ca,
        servername: ALLOW_HOST,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            challenge: response.headers["www-authenticate"],
            protocol: request.socket.getProtocol(),
            subject: request.socket.getPeerCertificate().subject?.CN,
            body,
          });
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`the request did not answer inside ${REQUEST_TIMEOUT_MS} ms`));
    });
    request.end();
  });
}

/** The same request in plaintext, which a TLS listener must not answer. */
function askInPlaintext(endpoint, headers) {
  return new Promise((resolve) => {
    const request = httpGet(
      { host: endpoint.address, port: endpoint.port, path: "/healthz", headers },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ answered: true, status: response.statusCode ?? 0, body }),
        );
      },
    );
    request.on("error", (error) => resolve({ answered: false, reason: `${error.message}` }));
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`no answer inside ${REQUEST_TIMEOUT_MS} ms`));
    });
  });
}

/**
 * Wait until the daemon's stderr carries `fragment`, or give up and let the assertion fail.
 *
 * The ready line is the *last* thing `serve` writes, but it goes to a different pipe than the four
 * sentences before it — and two pipes have no shared arrival order at the reader. Polling the lines
 * that have arrived is what keeps a loaded machine from failing an assertion about what was said
 * rather than about what is true.
 */
function awaitStderr(lines, fragment, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const text = lines.join("\n");
      if (text.includes(fragment) || Date.now() >= deadline) {
        resolve(text);
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

/** `SIGTERM`, and the exit code it produced. */
function stopDaemon(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the daemon did not exit inside ${SHUTDOWN_TIMEOUT_MS} ms`));
    }, SHUTDOWN_TIMEOUT_MS);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.kill("SIGTERM");
  });
}

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true });
  say(`${stamp()} pnpm e2e:remote — R-SEC-9, on an address that is not loopback`);
  say(`repository: ${REPO}`);
  say(`transcript: ${LOG_PATH}`);

  section("the build, so the daemon under test is this commit's");
  const built = spawnLogged("pnpm turbo build", pnpm("turbo", "build"));
  check(built.status === 0, "every member built");
  check(existsSync(CLI), `the CLI this gate drives exists at ${CLI}`);

  scratch = mkdtempSync(join(tmpdir(), "xplainer-remote-"));
  const paths = { videos: join(scratch, "videos") };
  const certificate = join(scratch, "tls");
  mkdirSync(certificate, { recursive: true });

  section("the address, the certificate and the operator's token");
  const seized = await seizeAddress();
  say(
    `  ..  binding ${seized.address} (${seized.where}), which is none of daemon/binding.ts's four ` +
      `loopback literals; port ${seized.port} is held by this script for the refusals below`,
  );
  // The certificate carries the operator's name *and* the address, so a client may verify either
  // one; this gate verifies the name, which is the authority the daemon was told to admit.
  const material = writeSelfSignedCertificate(certificate, {
    names: [ALLOW_HOST, seized.address],
  });
  check(
    existsSync(material.certPath) && existsSync(material.keyPath),
    `a self-signed certificate for ${ALLOW_HOST} and ${seized.address}, and its key`,
  );
  const operatorToken = "e2e-remote-operator-token-not-a-minted-one";
  const tokenPath = join(scratch, "operator.token");
  writeFileSync(tokenPath, `${operatorToken}\n`, { mode: 0o600 });
  check(existsSync(tokenPath), `an operator token in ${tokenPath}, which this daemon did not mint`);

  section("phase 1 — every missing precondition is refused before anything is bound");
  const remote = [
    "--bind",
    seized.address,
    "--i-understand-remote-exposure",
    "--tls-cert",
    material.certPath,
    "--tls-key",
    material.keyPath,
    "--allow-host",
    ALLOW_HOST,
    "--token-file",
    tokenPath,
  ];
  /**
   * One refusal case: the flags to drop, and every fragment the refusal has to carry.
   *
   * The three `daemon/tls.ts` owns end in "Nothing has been bound.", because they are refusals of a
   * bind this daemon *would otherwise have made*. `daemon/binding.ts`'s two never get that far —
   * the address alone decides them — and asserting a sentence they do not say would be asserting
   * the wrong module's wording, so each case names what it actually promises.
   */
  const refusals = [
    {
      name: "no TLS",
      drop: ["--tls-cert", "--tls-key"],
      says: [
        "Still missing: --tls-cert <path to a PEM certificate chain>",
        "Nothing has been bound.",
      ],
    },
    {
      name: "no --allow-host",
      drop: ["--allow-host"],
      says: [
        "Still missing: --allow-host <a hostname clients will send in Host>",
        "Nothing has been bound.",
      ],
    },
    {
      name: "the token this daemon minted for itself",
      drop: ["--token-file"],
      says: ["is the one this daemon minted for itself", "Nothing has been bound."],
    },
    {
      name: "no --i-understand-remote-exposure",
      drop: ["--i-understand-remote-exposure"],
      says: [
        "is not a loopback address, and this daemon serves loopback only",
        "Remote exposure is outside the supported configuration",
      ],
    },
    {
      name: "0.0.0.0, refused outright",
      replace: { "--bind": "0.0.0.0" },
      says: [
        "binds every interface, which is refused outright",
        "--i-understand-remote-exposure does not enable it",
      ],
    },
  ];

  for (const [index, refusal] of refusals.entries()) {
    const stateDir = join(scratch, `refused-${index}`);
    const args = ["--port", String(seized.port), "--state-dir", stateDir];
    for (let at = 0; at < remote.length; at += 1) {
      const flag = remote[at];
      const takesValue = flag !== "--i-understand-remote-exposure";
      if ((refusal.drop ?? []).includes(flag)) {
        at += takesValue ? 1 : 0;
        continue;
      }
      const replacement = refusal.replace?.[flag];
      args.push(flag);
      if (takesValue) {
        at += 1;
        args.push(replacement ?? remote[at]);
      }
    }
    const result = serveRefused(`serve, ${refusal.name}`, args, paths);
    check(
      result.status === 1,
      `${refusal.name}: exit 1 while this script holds ${seized.address}:${seized.port} — a serve ` +
        "that had reached listen() would have exited 10 naming that port as already in use, so " +
        "the refusal is decided before the bind rather than after it",
    );
    for (const fragment of refusal.says) {
      check(
        (result.stderr ?? "").includes(fragment),
        `${refusal.name}: the refusal says "${fragment}"`,
      );
    }
    check(
      !existsSync(join(stateDir, "runtime.json")),
      `${refusal.name}: no runtime.json, which markReady() is the only writer of`,
    );
    const recorded = recordedState(stateDir);
    check(
      recorded === null || recorded.port === undefined,
      `${refusal.name}: daemon.json records no port either (${recorded === null ? "the state directory was never made" : `token_origin ${recorded.token_origin}, ready_at ${recorded.recentStarts?.[0]?.ready_at ?? "<none>"}`})`,
    );
  }

  // The control that makes the five above mean what they say. Everything R-SEC-9 asks for is
  // supplied, so this one has no precondition left to fail on and gets as far as `listen()` — where
  // the held port is waiting. Its exit `10` is what proves the trap was armed: without it, "exit 1
  // rather than 10" would be an assertion about a port nothing was ever holding.
  const control = serveRefused(
    "serve, every precondition met, onto the held port",
    ["--port", String(seized.port), "--state-dir", join(scratch, "control"), ...remote],
    paths,
  );
  check(
    control.status === 10,
    "with all five preconditions met the same command reaches listen() and exits 10, so the held " +
      "port really was a trap and the five refusals really did stop short of it",
  );
  check(
    (control.stderr ?? "").includes(`${seized.address}:${seized.port} is already in use`),
    `and it says ${seized.address}:${seized.port} is already in use, which is the only sentence ` +
      "in this phase that could only have been printed after a bind was attempted",
  );

  await seized.release();
  say(`  ..  ${seized.address}:${seized.port} released; the daemon below picks its own port`);

  section("phase 2 — a real remote listener, and what it answers");
  const stateDir = join(scratch, "remote");
  const started = await startDaemon(["--port", "0", "--state-dir", stateDir, ...remote], paths);
  const endpoint = {
    address: seized.address,
    port: started.ready.port,
    ca: material.cert,
  };
  try {
    check(
      started.ready.event === "ready" && typeof started.ready.port === "number",
      `the ready line arrived: ${JSON.stringify(started.ready)}`,
    );
    const announcement = await awaitStderr(
      started.stderr,
      `listening on https://${seized.address}:${started.ready.port}`,
    );
    check(
      announcement.includes(`bound ${seized.address}, which is not loopback, over TLS from`) &&
        announcement.includes(material.certPath) &&
        announcement.includes(`Reachable as ${ALLOW_HOST}`),
      "serve said which address it exposed, which certificate it is using and which authority it " +
        "was told to admit",
    );
    check(
      announcement.includes(`listening on https://${seized.address}:${started.ready.port}`),
      `and the listener is https, not http, on ${seized.address}:${started.ready.port}`,
    );

    const authority = `${ALLOW_HOST}:${endpoint.port}`;
    const unauthenticated = await ask(endpoint, { host: authority });
    check(
      unauthenticated.status === 401 && unauthenticated.challenge === "Bearer",
      `unauthenticated: 401 with WWW-Authenticate: Bearer over ${unauthenticated.protocol}, from ` +
        `a certificate this client pinned itself (CN ${unauthenticated.subject}) — ${unauthenticated.body}`,
    );

    const authorized = await ask(endpoint, {
      host: authority,
      authorization: `Bearer ${operatorToken}`,
    });
    check(
      authorized.status === 200 && JSON.parse(authorized.body).contract_version === "1",
      `the operator's token: 200 — ${authorized.body}`,
    );

    const wrongToken = await ask(endpoint, {
      host: authority,
      authorization: `Bearer ${operatorToken.replace("operator", "impostor")}`,
    });
    check(wrongToken.status === 401, "a token of the same length that is not the operator's: 401");

    const disallowedHost = await ask(endpoint, {
      host: `evil.com:${endpoint.port}`,
      authorization: `Bearer ${operatorToken}`,
    });
    check(
      disallowedHost.status === 403 &&
        JSON.parse(disallowedHost.body).error.code === "FORBIDDEN_HOST",
      "the operator's token with Host: evil.com: 403 FORBIDDEN_HOST — the guard did not weaken " +
        "when the bind widened, which is CVE-2026-65105 as an assertion",
    );

    const disallowedOrigin = await ask(
      { ...endpoint, origin: "https://evil.com" },
      { host: authority, authorization: `Bearer ${operatorToken}` },
    );
    check(
      disallowedOrigin.status === 403 &&
        JSON.parse(disallowedOrigin.body).error.code === "FORBIDDEN_ORIGIN",
      "and an Origin the allowlist does not carry: 403 FORBIDDEN_ORIGIN",
    );

    const allowedOrigin = await ask(
      { ...endpoint, origin: `https://${authority}` },
      { host: authority, authorization: `Bearer ${operatorToken}` },
    );
    check(
      allowedOrigin.status === 200,
      `while the operator's own origin https://${authority} is admitted: 200`,
    );

    const loopbackHost = await ask(endpoint, {
      host: `127.0.0.1:${endpoint.port}`,
      authorization: `Bearer ${operatorToken}`,
    });
    check(
      loopbackHost.status === 200,
      "Host: 127.0.0.1 is still admitted on the widened bind: the operator's name was added to " +
        "the allowlist and nothing was taken off it",
    );

    const boundAddressHost = await ask(endpoint, {
      host: `${seized.address}:${endpoint.port}`,
      authorization: `Bearer ${operatorToken}`,
    });
    check(
      boundAddressHost.status === 403,
      `while Host: ${seized.address} — the address this daemon is bound to — is 403, because an ` +
        "authority nobody asked for with --allow-host is an authority nobody decided about",
    );

    const plaintext = await askInPlaintext(endpoint, {
      Host: authority,
      Authorization: `Bearer ${operatorToken}`,
    });
    check(
      !plaintext.answered,
      `the same request without TLS is not answered at all (${plaintext.reason}), so the ` +
        "encryption is the listener's rather than the client's politeness",
    );

    check(
      existsSync(join(stateDir, "runtime.json")),
      "and this one did bind: runtime.json is there, which none of phase 1's five was",
    );
  } finally {
    const stopped = await stopDaemon(started.child);
    say(`  ..  SIGTERM → exit ${stopped.code ?? stopped.signal}`);
  }

  say("");
  say("REMOTE GATE PASSED");
  rmSync(scratch, { recursive: true, force: true });
}

main().catch((error) => {
  say("");
  say(`REMOTE GATE FAILED: ${error.message}`);
  if (scratch !== null) {
    say(`the scratch directory is kept at ${scratch}`);
  }
  say(`the transcript is at ${LOG_PATH}`);
  process.exitCode = 1;
});
