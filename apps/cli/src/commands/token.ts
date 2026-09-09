/**
 * `xplainer token` — one verb, `rotate`, and the grace window that makes it usable.
 *
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §Security R-SEC-8 asks for
 * exactly this: "`xplainer token rotate` writes a new token with a grace window for the old one".
 * The window is the whole difference between a rotation and an outage. An agent holds the token in
 * its environment — Claude Code's `${VAR}` expansion, Codex's `bearer_token_env_var` — and nothing
 * updates that environment at the instant this command writes a file, so a rotation with no window
 * is a rotation that breaks every configured client until each one is restarted. For the length of
 * the window the daemon accepts **both** values (`daemon/token.ts` §createTokenRing), and the
 * running daemon needs no restart to notice: the ring re-reads the two files when either changes.
 *
 * **`daemon uninstall` does not call this, and that is deliberate.** Round 2 of the phase-2 plan
 * said uninstall "rotates the token automatically so a copy left in a shell history is dead", and a
 * rotated token is still a live credential — which is precisely what roadmap P2-9 says must not be
 * left behind. So `install/uninstall.ts` **deletes** the file instead, and this command is what a
 * daemon that **stays installed** uses.
 *
 * **What it prints, and what it will not.** The path, the two instants, and what protects each
 * file. Never the value: R-SEC-6 keeps the secret in the file it lives in, the file is `0600` (and,
 * on Windows, carries the explicit entry R-SEC-5 names), and a command that echoed it would put it
 * in a scrollback and a shell history — the exact place the rule exists to keep it out of.
 *
 * The exit codes are the table's (`docs/ARCHITECTURE.md` §6) and none is invented here: `1` for
 * commander's own usage errors and for a `--grace` outside its range, `3` for a token file that is
 * not there — a precondition unmet, with nothing written — `12` for one that is there and cannot be
 * read, and `70` for anything else.
 */

import { Command, InvalidArgumentError } from "commander";
import { type TokenRotation, updateDaemonState } from "../daemon/daemon-state.js";
import { DAEMON_INTERNAL_EXIT_CODE, USAGE_EXIT_CODE } from "../daemon/exit-codes.js";
import { resolveStateDirSetting } from "../daemon/state-dir.js";
import {
  DEFAULT_TOKEN_GRACE_MS,
  MAX_TOKEN_GRACE_MS,
  type RotatedToken,
  resolveTokenPathSetting,
  rotateToken,
  TokenMissingError,
  TokenUnreadableError,
  tokenProtection,
} from "../daemon/token.js";
import type { CliIo } from "../io.js";

/** What `xplainer token rotate` parses. */
type RotateOptions = {
  stateDir?: string;
  tokenFile?: string;
  grace?: number;
};

/**
 * Build the `token` command group.
 *
 * The group **and** its verb carry their own output routing, for the reason `commands/runtime.ts`
 * gives for doing the same: commander's `addCommand()` copies neither `configureOutput()` nor
 * `exitOverride()` from the parent, so a group that configures only itself leaves its verbs writing
 * to the process streams — and this verb has a usage error a caller has to be able to observe.
 */
export function createTokenCommand(io: CliIo): Command {
  const token = route(
    new Command("token").description("Manage this machine's bearer token").helpCommand(false),
    io,
  );
  token.addCommand(createRotateCommand(io));
  return token;
}

/** Send this command's output and its exits through `io` rather than through the process. */
function route(command: Command, io: CliIo): Command {
  return command
    .configureOutput({
      writeOut: (text) => {
        io.writeOut(text);
      },
      writeErr: (text) => {
        io.writeErr(text);
      },
    })
    .exitOverride((error) => io.exit(error.exitCode));
}

function createRotateCommand(io: CliIo): Command {
  return (
    route(new Command("rotate"), io)
      .description("Write a new bearer token, keeping the old one working for a grace window")
      // The same two spellings `serve` takes, because the file this command rewrites is the file that
      // daemon reads: a rotation aimed at a different path by a different precedence would report
      // success against a token nothing is using.
      .option("--state-dir <path>", "the state directory whose token is rotated")
      .option("--token-file <path>", "the token file itself — a path, never a token value")
      .option(
        "--grace <seconds>",
        "how long the retired token keeps working; 0 locks every holder of it out at once",
        parseGraceSeconds,
      )
      .action((options: RotateOptions) => {
        const stateDir = resolveStateDirSetting({ flag: options.stateDir }).path;
        const tokenSetting = resolveTokenPathSetting(stateDir, { flag: options.tokenFile });
        const graceMs =
          options.grace === undefined ? DEFAULT_TOKEN_GRACE_MS : Math.round(options.grace * 1000);

        let rotated: RotatedToken;
        try {
          rotated = rotateToken({ path: tokenSetting.path, graceMs });
        } catch (error) {
          if (error instanceof TokenMissingError || error instanceof TokenUnreadableError) {
            io.writeErr(`${error.message}\n`);
            return io.exit(error.exitCode);
          }
          if (error instanceof RangeError) {
            io.writeErr(`xplainer token rotate: ${error.message}\n`);
            return io.exit(USAGE_EXIT_CODE);
          }
          io.writeErr(
            `xplainer token rotate: ${tokenSetting.path} could not be rotated ` +
              `(${error instanceof Error ? error.message : String(error)}).\n`,
          );
          return io.exit(DAEMON_INTERNAL_EXIT_CODE);
        }

        // Recorded after the files are on disk, never before: a `daemon.json` announcing a window
        // that no file backs would have `daemon status` reporting a credential nothing accepts.
        //
        // `token_origin` is deliberately left alone. That field answers "who decides this daemon's
        // credential" — which R-SEC-9 requires to be the operator before a non-loopback bind — and a
        // rotation replaces the *value* without changing the answer: an operator's daemon stays the
        // operator's, and a daemon running on its own mint does not become non-default by having
        // minted twice. Writing `operator` here would turn one command into a way past R-SEC-9's
        // fifth precondition; writing `minted` would break a remote daemon for rotating its token.
        const record: TokenRotation = {
          rotated_at: rotated.rotatedAt.toISOString(),
          grace_until: rotated.graceUntil.toISOString(),
          previous_token_file: rotated.previousPath,
        };
        updateDaemonState(stateDir, { token_rotation: record });

        io.writeOut(describeRotation(rotated, stateDir));
      })
  );
}

/**
 * `--grace` in seconds, as commander hands it over.
 *
 * A rejected value is commander's own `InvalidArgumentError`, which exits `1` through the same
 * `exitOverride` every other usage error takes — one parser, one code.
 */
function parseGraceSeconds(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds * 1000 > MAX_TOKEN_GRACE_MS) {
    throw new InvalidArgumentError(
      `a grace window is between 0 and ${String(MAX_TOKEN_GRACE_MS / 1000)} seconds`,
    );
  }
  return seconds;
}

/**
 * What the operator is told, in the order the next question comes in.
 *
 * The last paragraph is the one that earns its place: a rotation is finished when every client is
 * carrying the new value, and the command that just made the old one temporary is the right place
 * to say so and to name the deadline.
 */
function describeRotation(rotated: RotatedToken, stateDir: string): string {
  const lines = [
    `xplainer token rotate: wrote a new bearer token to ${rotated.path} ` +
      `(${tokenProtection(rotated.acl)}).`,
  ];
  if (rotated.previousPath === null) {
    lines.push(
      "  grace:    none — the previous token stopped working the moment this file was written, " +
        "and every client still carrying it is locked out now.",
    );
  } else {
    lines.push(
      `  grace:    the previous token keeps working until ${rotated.graceUntil.toISOString()}, ` +
        `from ${rotated.previousPath} (${tokenProtection(rotated.previousAcl)}).`,
      "  daemon:   a running daemon picks both values up on its next request; nothing needs " +
        "restarting, and no token value was printed here or written to daemon.json.",
      `  next:     give every configured client the value in ${rotated.path} before that instant. ` +
        `\`xplainer daemon status\` in ${stateDir} reports the window while it is open.`,
    );
  }
  return `${lines.join("\n")}\n`;
}
