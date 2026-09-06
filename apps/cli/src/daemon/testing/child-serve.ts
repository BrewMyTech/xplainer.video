/**
 * `xplainer serve`, in a child process, through the real command tree.
 *
 * The second-`serve` refusal is a property of the **binary**, not of a module: it has to go through
 * `createProgram()`'s registration, the real `processIo`, and a real `process.exit`, or the test
 * proves something narrower than the criterion. Running the program here rather than
 * `node dist/bin.js` keeps the assertion on the sources being edited — see `ts-source-hook.ts` for
 * why a built binary is the wrong dependency for this suite.
 *
 * Arguments after the entry are passed straight to `serve`, so a caller can ask for `--port 0`.
 */

import process from "node:process";
import { createProgram } from "../../program.js";

await createProgram().parseAsync(["serve", ...process.argv.slice(2)], { from: "user" });
