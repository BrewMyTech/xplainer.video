/**
 * The CLI's three side effects, behind one injectable seam.
 *
 * Writing to stdout, writing to stderr and terminating the process are the only
 * things this package does that a test cannot observe by inspecting a return
 * value — and they are exactly what AC-14a, AC-14b and S2.4b's fifth test have
 * to assert. Routing them through `CliIo` lets `apps/cli/src/program.test.ts`
 * drive the real commander program, with the real command registrations and the
 * real exit codes, and still record what a user would have seen instead of
 * killing the Vitest worker.
 *
 * {@link processIo} is the production implementation and is what
 * `createProgram()` uses when no other is supplied, so the tested path and the
 * shipped path differ only in where the bytes and the exit code land.
 */

import process from "node:process";

/** Where a command's output and its exit code go. */
export type CliIo = {
  /** Write to standard output. The caller supplies its own newline. */
  writeOut(text: string): void;
  /** Write to standard error. The caller supplies its own newline. */
  writeErr(text: string): void;
  /** Terminate with `code`. Never returns. */
  exit(code: number): never;
};

/** The real streams and a real `process.exit`. */
export const processIo: CliIo = {
  writeOut(text: string): void {
    process.stdout.write(text);
  },
  writeErr(text: string): void {
    process.stderr.write(text);
  },
  exit(code: number): never {
    process.exit(code);
  },
};
