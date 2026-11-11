/**
 * A worker ended by `process.exit()` while its browser is still starting.
 *
 * That is what a `SIGTERM` during Chrome's handshake does to the render worker: its handler exits
 * the process before `launchChrome` has returned anything the worker could clean up. `cdp.test.ts`
 * spawns this with a stand-in browser that never answers and reports where it is by writing the
 * file named in argv[3]; once that file exists, this exits with {@link EXIT_CODE}, and the test then
 * asks whether the browser and its profile went with it.
 *
 * `tsconfig.build.json` excludes `src/**\/testing/**`; none of this ships.
 */

import { existsSync } from "node:fs";
import process from "node:process";
import { launchChrome } from "../cdp.js";

/** The code this exits with, so a test can tell this exit from a crash. */
const EXIT_CODE = 7;

const [executable, report] = process.argv.slice(2);
if (executable === undefined || report === undefined) {
  process.stderr.write("usage: child-launch <browser> <report-file>\n");
  process.exit(2);
}

// Never settles: the stand-in browser does not answer the handshake.
void launchChrome({ executable, log: () => {}, extraFlags: ["--no-sandbox"] });

const poll = setInterval(() => {
  if (existsSync(report)) {
    clearInterval(poll);
    process.exit(EXIT_CODE);
  }
}, 20);
