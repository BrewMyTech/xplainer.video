#!/usr/bin/env node
/**
 * The `xplainer` binary (`apps/cli/dist/bin.js`).
 *
 * Everything worth testing lives in `program.ts`; this file exists to be the
 * shebang and the argv. `tsc` preserves the shebang into `dist/bin.js`, which is
 * what `package.json`'s `bin` field points at.
 */

import process from "node:process";
import { createProgram } from "./program.js";

await createProgram().parseAsync(process.argv);
