/**
 * What one identity probe costs on the machine this is run on.
 *
 * A **measurement, not a gate**: it prints and exits `0` whatever the numbers are. The number it
 * exists for is the Windows one. ADR 0024's note of 2026-09-06 §Process identity priced the macOS
 * probe at about 4.5 ms and built the whole store's cost discipline on it — "once per acquisition
 * and once per worker at reconciliation, never per write" — and when the Windows half of the tuple
 * was implemented on 2026-09-09 that probe became a `powershell.exe` start, which is a different
 * order of number. A discipline written around 4.5 ms and paid at some unmeasured multiple of it is
 * not a discipline, so this is the reading the note quotes.
 *
 * Three things are timed, because they are the three the daemon actually pays:
 *
 * 1. **`selfIdentity()` cold** — the one every process pays exactly once, at start-up. On Windows
 *    it is a single `powershell.exe` answering *both* halves, which is the whole reason it is a
 *    special case rather than two calls.
 * 2. **`processStartToken()` on a live pid** — what `classifyWorker` pays for one recorded worker
 *    whose number is still in use, and what `startIsProvablyGone` pays per unfinished start. It is
 *    timed several times so that a first reading inflated by a cold WMI service is visible as a
 *    first reading rather than averaged into the rest.
 * 3. **`machineBootId()` warm** — which must be free, because it is memoised, and a number here
 *    that is not ~0 would mean the memo is not working.
 *
 * ```
 * node --import ./apps/cli/src/daemon/testing/ts-source-hook.ts \
 *   apps/cli/src/daemon/testing/identity-cost.ts
 * ```
 */

import process from "node:process";
import { machineBootId, processStartToken, selfIdentity } from "../worker-identity.js";

/** How many times the per-worker probe is timed. */
const SAMPLES = 5;

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Milliseconds for one call, to one decimal, so a 0.02 ms memo hit does not read as `0`. */
function timed(call: () => unknown): number {
  const started = process.hrtime.bigint();
  call();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function main(): void {
  say(`platform: ${process.platform}  node: ${process.version}  pid: ${String(process.pid)}`);

  const cold = timed(() => selfIdentity());
  const self = selfIdentity();
  say(`selfIdentity() cold:      ${cold.toFixed(1)} ms`);
  say(`  pid:        ${String(self.pid)}`);
  say(`  start_time: ${self.start_time ?? "<none>"}`);
  say(`  boot_id:    ${self.boot_id ?? "<none>"}`);
  say(`selfIdentity() memoised:  ${timed(() => selfIdentity()).toFixed(3)} ms`);
  say(`machineBootId() memoised: ${timed(() => machineBootId()).toFixed(3)} ms`);

  const samples: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    samples.push(timed(() => processStartToken(process.pid)));
  }
  say(`processStartToken(live pid), ${String(SAMPLES)} readings:`);
  for (const [index, ms] of samples.entries()) {
    say(`  ${String(index + 1)}: ${ms.toFixed(1)} ms`);
  }
  const total = samples.reduce((sum, ms) => sum + ms, 0);
  say(`  mean: ${(total / samples.length).toFixed(1)} ms`);
  say(`  min:  ${Math.min(...samples).toFixed(1)} ms`);
  say(`  max:  ${Math.max(...samples).toFixed(1)} ms`);

  // The token has to be the same string every time or the whole comparison is worthless, so the
  // measurement says whether it was rather than leaving that to the suite alone.
  const tokens = new Set([...Array(SAMPLES).keys()].map(() => processStartToken(process.pid)));
  say(`distinct tokens across ${String(SAMPLES)} further readings: ${String(tokens.size)}`);
}

main();
