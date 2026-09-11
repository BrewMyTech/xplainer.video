#!/usr/bin/env node
/**
 * The unscoped `xplainer` command (`packages/alias/dist/bin.js`).
 *
 * `npm i -g xplainer` and `npx xplainer` install this package, and this file is
 * the whole of it: it locates `@xplainer/cli`'s own binary — the exact version
 * pinned in `package.json` — and hands the process over to it.
 *
 * ============================================================================
 * WHY IT IMPORTS THE REAL BINARY RATHER THAN SPAWNING IT
 * ============================================================================
 *
 * A forwarder can hand over two ways, and this is the process a user's shell
 * waits on, so the difference is not stylistic:
 *
 *   * `await import(...)` runs the CLI **in this process**. The exit code is
 *     whatever the CLI set, because there is only one process to set it. A
 *     `SIGTERM` is delivered to the handlers the CLI installed, so the daemon's
 *     six-step drain ends in its own exit `0` rather than in a parent's guess
 *     about what its child's death meant. `stdin`, `stdout` and `stderr` are
 *     the **same three file descriptors** the shell opened: nothing is piped,
 *     nothing is re-encoded, and nothing can interleave.
 *
 *   * `spawnSync(process.execPath, [bin, ...])` would have to re-implement all
 *     three. Exit codes have to be copied *and* signal deaths turned back into
 *     a signal death (`128 + n` is not the same thing as dying of `SIGTERM`);
 *     every signal has to be forwarded; and the stdio has to be inherited
 *     exactly, with a second process sitting in the pipeline for the life of
 *     the command.
 *
 * The stdio half is the one that matters most. `xplainer mcp` is configured
 * into an agent as a **stdio MCP server**, so this command's stdout *is* a
 * JSON-RPC stream: `apps/cli/AGENTS.md`'s rule is that "a shim's stdout is the
 * JSON-RPC stream" and "one stray line on stdout is a parse error inside the
 * agent, with no message anyone will see". The safest forwarder is therefore
 * the one that never touches the stream at all, and an in-process import is the
 * only hand-over that cannot: this file writes to stdout on no path, not even
 * to refuse.
 *
 * ============================================================================
 * WHY `process.argv[1]` IS REWRITTEN
 * ============================================================================
 *
 * One thing an import does not get for free, and a spawn would: `argv[1]`. Node
 * sets it to the file it started, which here is this forwarder, and
 * `apps/cli/src/daemon/start.ts` reads `process.argv[1]` as "the entry file,
 * which is where the payload is looked for" when it freezes the daemon's
 * **responding** identity — the row `install/supervisors/identity.ts` compares
 * against the launch spec the supervisor actually holds. Left pointing at this
 * file, a `serve` reached through the alias would report identity drift against
 * a perfectly correct install, and the digest would be computed from the wrong
 * directory.
 *
 * So the entry is rewritten to the file being imported, which is precisely what
 * `argv[1]` would have been had npm's own shim for `@xplainer/cli` run. Nothing
 * else about the argv changes: `argv[0]` is the interpreter, and `argv.slice(2)`
 * — every flag and subcommand the user typed — is untouched, because
 * `apps/cli/src/bin.ts` parses `process.argv` itself. `commander` is given the
 * program name `xplainer` explicitly in `program.ts`, so the help output does
 * not depend on this value either way.
 */

import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REFUSAL_EXIT_CODE, resolveCliBin } from "./forward.ts";

let target: string;
try {
  target = resolveCliBin({
    // `import.meta.resolve` is the only resolver that answers the question npm
    // answers when it links a command, and it returns a URL; every path below
    // this line is a filesystem path.
    resolve: (specifier) => fileURLToPath(import.meta.resolve(specifier)),
    exists: existsSync,
    readFile: (path) => readFileSync(path, "utf8"),
  });
} catch (error) {
  // stderr, never stdout: see the docblock. A refusal reaching an agent's MCP
  // stream would be a parse error rather than a message.
  process.stderr.write(`xplainer: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(REFUSAL_EXIT_CODE);
}

process.argv[1] = target;
await import(pathToFileURL(target).href);
