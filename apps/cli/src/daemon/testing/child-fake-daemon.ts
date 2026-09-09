/**
 * A daemon on the real socket whose `/healthz` says whatever the test needs it to say.
 *
 * P1-13 asks for the shim's skew check to be proved "with an injected daemon version", and the
 * version the daemon advertises comes from `MCP_CONTRACT_VERSION` — one constant, generated from
 * `packages/protocol/schemas/manifest.json`. There is no honest way to move it from outside, and
 * adding a `--contract-version` flag to `serve` would put a seam in the shipped daemon whose only
 * caller is a test, which is exactly what `apps/cli/AGENTS.md` means by "never stub what a test is
 * about".
 *
 * So the *other* side is substituted instead: this is a real listener on the real IPC path, built
 * from the real `createServer()` over the real local backend, with `/healthz` — and only
 * `/healthz` — answered from `XPLAINER_TEST_HEALTHZ`. `/mcp` is the shipped route, so a shim that
 * decides it may attach then attaches to a server that serves the eight tools for real, and the
 * test can tell "it attached" from "it attached to nothing".
 *
 * It is not `serve`: no ownership, no reconciliation, no token, no drain. Those are asserted
 * against the real command in `commands/serve.test.ts`, and none of them is what this file is for.
 */

import process from "node:process";
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import { createLocalBackend } from "../../backend.js";
import { createServer } from "../../server.js";
import { resolveWorkspaceRoot } from "../../workspace-root.js";
import { prepareIpcSocket } from "../ipc.js";
import { createJobStore } from "../job-store.js";
import { createJobRunner } from "../runner.js";
import { resolveStateDir } from "../state-dir.js";
import { selfIdentity } from "../worker-identity.js";

/** What `/healthz` answers with, verbatim. */
type InjectedHealth = {
  status?: string;
  version?: string;
  contract_version?: string;
};

const injected = JSON.parse(process.env.XPLAINER_TEST_HEALTHZ ?? "{}") as InjectedHealth;
const stateDir = resolveStateDir();
const workspaceRoot = resolveWorkspaceRoot(stateDir);
const runner = createJobRunner({
  store: createJobStore(stateDir),
  owner: { ...selfIdentity(), run_id: "fake-daemon" },
});
const shipped = createServer(createLocalBackend({ runner, root: workspaceRoot }));

const app = new Hono();
app.get("/healthz", (c) =>
  c.json({
    status: injected.status ?? "ok",
    version: injected.version ?? "0.0.0",
    contract_version: injected.contract_version ?? "0",
  }),
);
// Everything else is the shipped application, unchanged — `/mcp` included.
app.all("*", (c) => shipped.fetch(c.req.raw));

const ipc = prepareIpcSocket({ stateDir });
const server = createAdaptorServer({ fetch: app.fetch, hostname: "xplainer.ipc" });
server.listen(ipc.path, () => {
  process.stdout.write(`${JSON.stringify({ event: "fake-daemon", socket: ipc.path })}\n`);
});
