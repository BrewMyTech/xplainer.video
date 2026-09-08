/**
 * The names the renderer and the main process address each other by, written once.
 *
 * Context isolation is on and Node integration is off, so the renderer reaches the daemon **only**
 * through these channels: the main process holds the bearer token, opens every connection and
 * proxies (T23). A renderer that could build an authenticated request itself would be a renderer
 * that has the token, and a page that has the token is a page that can be persuaded to give it
 * away — which is why the preload exposes verbs and never a secret.
 *
 * This module is `src/shared/` for the reason `version-argument.ts` is: the preload bundle is
 * loaded into a context with no Node built-ins available to it, so anything it imports must be
 * strings and types and nothing else. Nothing here reads a file, opens a socket or touches
 * `electron`.
 */

import type { DiscoveryOutcome, DiscoveryRefusalReason } from "../main/discovery";
import type { EnqueueVerb } from "./daemon-api";

/** Every channel the renderer may invoke, and what each one is for. */
export const IPC_CHANNELS = {
  /** Where this machine's daemon is, as one of the seven discovery outcomes. */
  discover: "xplainer:discover",
  /** One authenticated `/api/*` request, answered as a JSON document. */
  request: "xplainer:api-request",
  /** Start streaming one job's progress. Answers a subscription id. */
  subscribe: "xplainer:job-subscribe",
  /** Stop a stream started by {@link IPC_CHANNELS.subscribe}. */
  unsubscribe: "xplainer:job-unsubscribe",
  /** Queue one of the three long-running tools for a video. Answers the daemon's `202`. */
  enqueue: "xplainer:job-enqueue",
  /** Run `connect claude|codex` through whichever of D10's two stages resolved. */
  connect: "xplainer:connect-agent",
  /** Run `daemon install` through the same two stages. */
  install: "xplainer:install-supervisor",
} as const;

/** The one channel the main process pushes on: a job event, addressed to a live subscription. */
export const JOB_EVENT_CHANNEL = "xplainer:job-event";

/**
 * What discovery answered, as the renderer receives it.
 *
 * The outcome and the sentence a user is shown, plus the origin and the state directory the CLI
 * reported. **A path, never a secret**: `tokenFile` is where the token lives, as it is everywhere
 * else in this project (R-SEC-6), and the value itself never crosses this boundary.
 *
 * `DiscoveryOutcome` is imported **as a type** and must stay that way: `src/main/discovery.ts`
 * reaches the filesystem, and this module is loaded by the preload, which has no Node built-ins.
 */
export type DiscoveryMessage = {
  outcome: DiscoveryOutcome;
  /** The one thing a user can do about it. */
  action: string;
  /** Why this outcome, in the CLI's own words. */
  detail: string;
  /** The origin the app talks to. */
  url: string;
  /** The state directory the CLI reported. */
  stateDir: string;
  /** Where the bearer token lives. A path. */
  tokenFile: string | null;
  /** The CLI's own condition code, for a screen that wants to show the exact wording. */
  condition: string;
  /** The sentences the CLI is entitled to say about this machine. */
  sentences: readonly string[];
};

/** What the renderer asks for when it wants an `/api/*` document. */
export type ApiRequestMessage = {
  /** A path under the daemon's origin, always starting with `/api/`. Built by `@xplainer/cli`. */
  path: string;
  /** `GET` by default. */
  method?: string | undefined;
  /** A JSON body, already serialised. Only for `POST`. */
  body?: string | undefined;
};

/**
 * What one proxied request answered.
 *
 * The status travels with the document because every `/api/*` refusal is a JSON body with a code in
 * it, and a renderer that only saw the body could not tell a `404` from a video that has no
 * artefacts. No header is forwarded: the only one that mattered on the way out was `authorization`,
 * and it is the one thing that must not come back.
 */
export type ApiResponseMessage = {
  status: number;
  /** The parsed JSON body, or `null` for a response that carried none. */
  body: unknown;
};

/** A live job stream, as the renderer holds it. */
export type JobSubscription = {
  /** The id the main process answered with. Every event for this stream carries it. */
  subscription: number;
  /** Stop following. Removes the listener and tells the main process to abort the stream. */
  stop(): Promise<void>;
};

/** One job event pushed to the renderer, tagged with the subscription that asked for it. */
export type JobEventMessage = {
  /** The id {@link IPC_CHANNELS.subscribe} answered with. */
  subscription: number;
  /** `job` while it runs, `end` once, and `error` when the stream itself failed. */
  kind: "job" | "end" | "error";
  /** The event's `data`, parsed, or the failure's sentence for `error`. */
  data: unknown;
};

/** The two agents `xplainer connect` has a verb for. A closed set, so a window cannot invent a third. */
export const CONNECT_VENDORS = ["claude", "codex"] as const;

/** One of {@link CONNECT_VENDORS}. */
export type ConnectVendor = (typeof CONNECT_VENDORS)[number];

/** The name a user sees for each vendor, which is not the verb the CLI takes. */
export const CONNECT_LABELS: Readonly<Record<ConnectVendor, string>> = {
  claude: "Claude Code",
  codex: "Codex CLI",
};

/** Whether an unvalidated value off the IPC boundary is a vendor this app will run a verb for. */
export function isConnectVendor(value: unknown): value is ConnectVendor {
  return typeof value === "string" && (CONNECT_VENDORS as readonly string[]).includes(value);
}

/** Which of decision D10's two stages a control ran through. */
export type ControlStage = "payload" | "launcher";

/** What the renderer asks for when it wants a job queued. */
export type EnqueueMessage = {
  slug: string;
  verb: EnqueueVerb;
};

/**
 * What one of the two one-click controls did.
 *
 * `control_ran` carries the **executable** because that is the whole of what decision D10 asserts:
 * a control that ran the packaged payload before an install and the stable launcher after it is
 * the difference between a button that works on a clean machine and one that does not. A non-zero
 * `exitCode` is a run, not a failure to report: `connect` refusing because no daemon has ever bound
 * on this machine is a sentence to show, and `detail` is the command's own words for it.
 */
export type ControlMessage =
  | {
      event: "control_ran";
      stage: ControlStage;
      /** The program that was spawned. Absolute, and never a `PATH` lookup. */
      executable: string;
      /**
       * Everything after the executable — the payload's entry included, at the payload stage.
       *
       * The window prints `executable` and this, so together they are the command line that was
       * spawned and not a summary of it.
       */
      argv: readonly string[];
      /** Whether the command exited `0`. */
      ok: boolean;
      exitCode: number | null;
      /** What the command wrote — its refusal if it refused, its report if it did not. */
      detail: string;
    }
  | {
      event: "control_unavailable";
      /** Why there was no program to run at all. */
      reason: DiscoveryRefusalReason;
      detail: string;
    };
