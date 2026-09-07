/**
 * The one error type `connect`'s writers raise, carrying the exit code the table already gives it.
 *
 * Both writers can fail in ways that are a *user's* problem rather than a bug — a `~/.claude.json`
 * that is not JSON, a `config.toml` that already declares this server in a shape a line-oriented
 * edit cannot safely replace — and every one of them must end the same way ADR 0020 §Degraded paths
 * words the rule: "probe before writing; on refusal, write nothing, exit with the documented code,
 * and print the one command that fixes it." Raising a typed refusal is what lets each writer state
 * its own sentence while `commands/connect.ts` keeps one place that turns a sentence into an exit.
 *
 * The codes are read from `daemon/exit-codes.ts`; nothing here invents one.
 */

/** A refusal a user can act on, with the documented exit code for its condition. */
export class ConnectRefusal extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, message: string) {
    super(message);
    this.name = "ConnectRefusal";
    this.exitCode = exitCode;
  }
}
