/**
 * The whole `xplainer` command tree, in a child process, with argv passed straight through.
 *
 * `child-serve.ts` fixes the verb because every one of its callers wants `serve`; this one does
 * not, because `commands/mcp.test.ts` spawns `mcp` and `mcp --attach` from the same harness and an
 * MCP client that spawns the shim has to be handed one command line. Running the program here
 * rather than `node dist/bin.js` keeps the assertions on the sources being edited — see
 * `ts-source-hook.ts` for why a built binary is the wrong dependency for these suites.
 */

import process from "node:process";
import { createProgram } from "../../program.js";

await createProgram().parseAsync(process.argv.slice(2), { from: "user" });
