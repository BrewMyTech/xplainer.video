/**
 * Fetching one toolchain artefact: resumable, verified against a reviewed digest, and committed
 * whole or not at all.
 *
 * [ADR 0005](../../../../docs/adr/0005-download-on-first-run-chrome-headless-shell-and-tts.md)
 * fixes both halves of what this module owes a user. The acquisition is "an explicit, resumable,
 * user-visible `xplainer setup` step", and "the download path has to verify the checksum **before**
 * extracting" — and its Consequences add the sentence that is really the acceptance condition
 * here: **"a download that fails behind a corporate proxy must say so, not produce a render that
 * fails later with a missing-binary error."** So every failure below has a name, and none of them
 * is "something went wrong".
 *
 * **The four transport conditions, and why each is a separate name.**
 *
 * - A **short body** is a connection that ended before the length the server itself declared. It is
 *   resumable, and saying so is the difference between "run setup again" and "your network is
 *   broken".
 * - A **checksum mismatch** is bytes that arrived whole and are not the reviewed artefact. The
 *   partial file is deleted rather than kept, because resuming onto bytes that are already wrong
 *   would re-download the same mismatch for ever.
 * - A **resume that was not honoured** is a server that answered a `Range` request with something
 *   other than that range. Appending the body of such a response to a partial file produces a file
 *   of exactly the right length made of the wrong bytes — which the digest would catch, but only
 *   after another hundred megabytes, and the honest report is that the resume failed.
 * - A **proxy interception** is something between here and the origin answering instead of it: a
 *   `407`, a captive-portal or filter page served with `200 text/html`, or a TLS handshake that
 *   never reached a real server. This is the failure ADR 0005 names, and it is reported as itself.
 *
 * **Why this speaks `node:http` rather than `fetch`.** Measured on Node 24: a `407 Proxy
 * Authentication Required` never reaches a `fetch` caller at all — undici turns it into a network
 * error whose `cause` is an empty `Error` with no `code`, so the one status a corporate proxy is
 * most likely to answer with would arrive indistinguishable from a dropped connection, and the
 * branch naming it would be dead code. The artefact URLs also **redirect**: the arm64 Linux build
 * the pinned Remotion line selects is a `307` to another host. Holding the status line, the headers
 * and the redirect chain is what makes both of those sayable.
 *
 * **What "atomic commit" means here.** The archive is verified, unpacked into a **staging
 * directory beside the destination**, and only then `rename`d onto it — the same argument
 * `install/stage.ts` makes for a payload and `daemon/durable-write.ts` makes for a single file:
 * `rename(2)` is atomic within one filesystem, so a half-unpacked toolchain is never visible under
 * the name a later `setup`, an install preflight or a render will look for. Staging beside the
 * destination rather than in the system temp directory is what keeps the rename a rename when a
 * user has relocated their state directory to another volume.
 *
 * **Two committers, because two of the components are not archives.**
 * {@link acquireArtefact} is the archive one, and its reader is now a **parameter**
 * ({@link ArchiveFormat}) rather than "the zip reader": the ONNX speech runtime exists only inside
 * an npm tarball, and the selector that keeps one platform out of the five it carries belongs at
 * that provider's call site rather than in here. {@link acquireFile} is the other, for an artefact
 * that arrives as itself — the Kokoro model graph and its voice tensor — where there is no staging
 * tree because there is nothing to unpack, and the commit is the same one `rename`.
 */

import { createHash, type Hash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { flushDirectory } from "../daemon/durable-write.js";
import { PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import { extractZip } from "./archive.js";

/** Why a download was refused. One value per distinguishable condition, never a catch-all. */
export type DownloadRefusalReason =
  | "not-available"
  | "short-body"
  | "checksum-mismatch"
  | "resume-not-honoured"
  | "proxy-interception"
  | "insecure-redirect"
  | "too-many-redirects"
  | "unreachable"
  | "unsupported-archive"
  | "destination-occupied";

/**
 * The artefact was not acquired, and nothing has been committed.
 *
 * The exit code is [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md)
 * §Degraded paths' `3`: `setup` refuses having written nothing where a user can see it, and the
 * partial file it may leave behind under its own work directory is the *resume point*, not a
 * result.
 */
export class DownloadRefusal extends Error {
  readonly reason: DownloadRefusalReason;
  readonly url: string;
  readonly exitCode: number = PRECONDITION_UNMET_EXIT_CODE;

  constructor(reason: DownloadRefusalReason, url: string, message: string) {
    super(message);
    this.name = "DownloadRefusal";
    this.reason = reason;
    this.url = url;
  }
}

/** What to fetch and what it must hash to. Both come from the toolchain manifest. */
export type ArtefactRequest = {
  url: string;
  /** The expected SHA-256, lowercase hex — a reviewed value, never one recorded from the bytes. */
  sha256: string;
  /** The expected length, cross-checked against the server's own `Content-Length`. */
  size: number;
};

/** How a body reached the disk, for a report a user or a test can read. */
export type TransferKind = "fresh" | "resumed" | "restarted";

/** What {@link downloadArtefact} did. */
export type DownloadOutcome = {
  /** The verified archive. */
  path: string;
  /** Its length, which equals the request's `size` by the time this is returned. */
  bytes: number;
  /** Its digest, which equals the request's `sha256` by the time this is returned. */
  sha256: string;
  /** Whether it was fetched whole, resumed from a partial, or restarted over one. */
  transfer: TransferKind;
  /** How many bytes this call moved, which is less than `bytes` when a resume was honoured. */
  transferred: number;
};

/** Where the partial lives, and the two knobs a caller may turn. */
export type DownloadOptions = {
  request: ArtefactRequest;
  /** The `.part` file. It survives a failure on purpose: it is the resume point. */
  partFile: string;
  signal?: AbortSignal;
  /** How long a socket may go silent before the attempt is abandoned. Defaults to 60 s. */
  idleTimeoutMs?: number;
  /** Called as bytes land, for a progress line. Never for control flow. */
  onProgress?: (received: number, total: number) => void;
};

/** How much of an intercepting page is quoted back to the user. */
const INTERCEPTION_SNIPPET = 400;

/** How long a socket may deliver nothing before the attempt is abandoned. */
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/** How many redirects one artefact may travel through. */
const MAX_REDIRECTS = 5;

/** The statuses that mean "the artefact is somewhere else". */
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Error codes that mean the TLS connection did not reach the origin.
 *
 * A corporate proxy that re-signs traffic presents a certificate no public root vouches for, and a
 * middlebox that hijacks port 443 does not speak TLS at all. Both land here, and both are the
 * interception ADR 0005 requires to be named. Codes that merely mean "the network dropped" —
 * `ECONNRESET`, `ETIMEDOUT` — are deliberately absent: they are `unreachable` or, mid-body, a
 * resumable short body.
 */
const INTERCEPTION_CODES: ReadonlySet<string> = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "EPROTO",
  "ERR_SSL_PACKET_LENGTH_TOO_LONG",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/** Local write failures, which are the machine's problem and not the download's. */
const LOCAL_WRITE_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EDQUOT",
  "EIO",
  "ENOSPC",
  "EPERM",
  "EROFS",
]);

/** One response, after redirects. */
type ArtefactResponse = {
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  /** The body. Always consumed or destroyed — a response left open holds its socket. */
  body: IncomingMessage;
  /** The URL that finally answered, which is not the one asked for when a redirect intervened. */
  url: string;
};

/**
 * Fetch one artefact to `partFile`, resuming a previous attempt where the server allows it.
 *
 * The digest is computed **as the bytes land**, including the bytes a resume kept, so nothing is
 * hashed twice and no complete copy is ever held in memory.
 */
export async function downloadArtefact(options: DownloadOptions): Promise<DownloadOutcome> {
  const { request, partFile } = options;
  mkdirSync(dirname(partFile), { recursive: true });

  const probe = await headArtefact(options);
  let present = sizeOf(partFile);
  if (present > probe.length) {
    // Longer than the artefact: whatever it is, it is not a prefix of what we want.
    rmSync(partFile, { force: true });
    present = 0;
  }
  if (present === probe.length) {
    const digest = await digestOfFile(partFile);
    if (digest === request.sha256) {
      return {
        path: partFile,
        bytes: present,
        sha256: digest,
        transfer: "resumed",
        transferred: 0,
      };
    }
    rmSync(partFile, { force: true });
    present = 0;
  }

  const wantsResume = present > 0 && probe.acceptsRanges;
  const response = await perform(options, request.url, "GET", wantsResume ? present : 0);
  await assertServedByOrigin(request.url, response);
  const transfer = classifyTransfer(request, response, present, probe.length, wantsResume);
  const hash = createHash("sha256");
  let received = 0;
  if (transfer === "resumed") {
    await hashInto(hash, partFile);
    received = present;
  }
  const sink = createWriteStream(partFile, { flags: transfer === "resumed" ? "a" : "w" });
  try {
    await pipeline(
      response.body,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          received += chunk.length;
          options.onProgress?.(received, probe.length);
          yield chunk;
        }
      },
      sink,
    );
  } catch (error) {
    throw classifyTransferFailure(request, error, received);
  }

  if (received !== request.size) {
    throw new DownloadRefusal(
      "short-body",
      request.url,
      `${request.url} delivered ${received} bytes of the ${request.size} the manifest records. ` +
        "The partial download is kept, so running setup again resumes it.",
    );
  }
  const digest = hash.digest("hex");
  if (digest !== request.sha256) {
    rmSync(partFile, { force: true });
    throw new DownloadRefusal(
      "checksum-mismatch",
      request.url,
      `${request.url} hashed to ${digest} and the toolchain manifest expects ${request.sha256}. ` +
        "The download has been discarded and nothing was unpacked.",
    );
  }
  return {
    path: partFile,
    bytes: received,
    sha256: digest,
    transfer,
    transferred: received - (transfer === "resumed" ? present : 0),
  };
}

/** What the artefact's own `HEAD` says. */
type ArtefactProbe = { length: number; acceptsRanges: boolean };

/**
 * `HEAD` for the length, and for whether a resume is even worth asking for.
 *
 * A server that answers without a `Content-Length`, or that refuses `HEAD` outright, is not an
 * error: the manifest already records the size, so the recorded one stands and the resume is simply
 * not attempted. What the probe must not do is let a **disagreement** through — a server offering a
 * different length than the manifest records is serving a different artefact, and that is worth
 * saying before a hundred megabytes rather than after.
 */
async function headArtefact(options: DownloadOptions): Promise<ArtefactProbe> {
  const { request } = options;
  const response = await perform(options, request.url, "HEAD", 0);
  response.body.resume();
  if (response.status === 405 || response.status === 501) {
    return { length: request.size, acceptsRanges: false };
  }
  await assertServedByOrigin(request.url, response);
  const declared = response.headers["content-length"];
  if (declared === undefined) {
    return { length: request.size, acceptsRanges: false };
  }
  const length = Number(declared);
  if (!Number.isInteger(length) || length !== request.size) {
    throw new DownloadRefusal(
      "checksum-mismatch",
      request.url,
      `${request.url} is ${declared} bytes and the toolchain manifest records ${request.size}. ` +
        "That is a different artefact from the one whose digest was reviewed.",
    );
  }
  return { length, acceptsRanges: response.headers["accept-ranges"] === "bytes" };
}

/**
 * Decide what this response is, and refuse the two shapes that would corrupt the file.
 *
 * A `206` is appended **only** when its `Content-Range` says exactly the range that was asked for
 * and the total it names is the artefact's; anything else claiming partial content is a mis-resume
 * and is refused rather than appended. A `200` where a range was asked for is a server that ignored
 * the header, and RFC 9110 says its body is the **whole** representation, so the partial file is
 * truncated and the transfer **restarts** — which is why the outcome distinguishes `restarted`
 * from `fresh`: a caller that measured the transfer would otherwise report a resume that did not
 * happen. A `200` whose length is not the whole artefact is neither, and is refused.
 */
function classifyTransfer(
  request: ArtefactRequest,
  response: ArtefactResponse,
  present: number,
  total: number,
  wantsResume: boolean,
): TransferKind {
  if (response.status === 206) {
    if (!wantsResume) {
      throw new DownloadRefusal(
        "resume-not-honoured",
        request.url,
        `${request.url} answered 206 Partial Content to a request that asked for none.`,
      );
    }
    const range = response.headers["content-range"];
    const parsed = parseContentRange(range);
    if (parsed === null || parsed.start !== present || parsed.total !== total) {
      throw new DownloadRefusal(
        "resume-not-honoured",
        request.url,
        `${request.url} was asked for bytes ${present}- of ${total} and answered 206 with ` +
          `Content-Range ${JSON.stringify(range)}. Appending that to the partial download would ` +
          "produce a file of the right length and the wrong contents, so nothing was appended.",
      );
    }
    return "resumed";
  }
  if (response.status === 200) {
    const declared = response.headers["content-length"];
    if (declared !== undefined && Number(declared) !== total) {
      throw new DownloadRefusal(
        "resume-not-honoured",
        request.url,
        `${request.url} answered 200 with ${declared} of ${total} bytes. A 200 carries the whole ` +
          "artefact, so a short one is neither a resume nor a fresh download.",
      );
    }
    return present > 0 ? "restarted" : "fresh";
  }
  if (response.status === 416) {
    // The partial is longer than the resource; `downloadArtefact` has already discarded that case,
    // so reaching here means the artefact at that URL has changed under us.
    throw new DownloadRefusal(
      "resume-not-honoured",
      request.url,
      `${request.url} answered 416 Range Not Satisfiable for bytes ${present}- of ${total}, so ` +
        "the artefact at that URL has changed since the partial download was started.",
    );
  }
  throw new DownloadRefusal(
    "unreachable",
    request.url,
    `${request.url} answered ${response.status} ${response.statusText}.`,
  );
}

type ContentRange = { start: number; end: number; total: number };

function parseContentRange(header: string | string[] | undefined): ContentRange | null {
  if (typeof header !== "string") {
    return null;
  }
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header.trim());
  if (match === null) {
    return null;
  }
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

/**
 * Refuse a response that did not come from the artefact's own origin.
 *
 * Three signals, and each one was chosen because it is what a real middlebox does rather than what
 * a threat model imagines: `407` is a proxy asking for credentials, a filter or captive portal
 * answers `200` with an HTML page, and a `404` is an artefact that is simply not there. The page's
 * text is quoted back where there is one, because "your organisation has blocked this category" is
 * the message that tells a user what to do next.
 */
async function assertServedByOrigin(url: string, response: ArtefactResponse): Promise<void> {
  if (response.status === 407) {
    response.body.resume();
    throw new DownloadRefusal(
      "proxy-interception",
      url,
      `A proxy answered 407 Proxy Authentication Required for ${url}. The artefact was not ` +
        "fetched, and setup cannot supply proxy credentials for you.",
    );
  }
  if (response.status === 404 || response.status === 403 || response.status === 410) {
    response.body.resume();
    throw new DownloadRefusal(
      "not-available",
      url,
      `${url} answered ${response.status} ${response.statusText}. The artefact the toolchain ` +
        "manifest names is not at that address.",
    );
  }
  const type = response.headers["content-type"] ?? "";
  if (typeof type === "string" && /^text\/html\b/i.test(type)) {
    const page = await readSnippet(response.body);
    const quoted = page === "" ? "(the response carried no body)" : page;
    throw new DownloadRefusal(
      "proxy-interception",
      url,
      `${url} answered ${response.status} with an HTML page rather than the artefact, which is ` +
        `what a proxy or a captive portal does. The page begins: ${quoted}`,
    );
  }
}

/** The first few hundred characters of a body, whitespace collapsed, for a message. */
async function readSnippet(body: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of body) {
    text += (chunk as Buffer).toString("utf8");
    if (text.length >= INTERCEPTION_SNIPPET) {
      body.destroy();
      break;
    }
  }
  return text.slice(0, INTERCEPTION_SNIPPET).replace(/\s+/g, " ").trim();
}

/**
 * One request, following redirects, with every transport failure classified rather than raw.
 *
 * A redirect that leaves `https:` is refused rather than followed: the artefacts are public, so a
 * downgrade buys nothing and is what an interception looks like when it cannot present a
 * certificate. The `Range` header travels with the redirect, because the artefact is at the far end
 * of it and a resume that silently became a fresh download would move a hundred megabytes twice.
 */
async function perform(
  options: DownloadOptions,
  url: string,
  method: "GET" | "HEAD",
  from: number,
): Promise<ArtefactResponse> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await exchange(options, current, method, from);
    const location = response.headers.location;
    if (!REDIRECTS.has(response.status) || typeof location !== "string") {
      return response;
    }
    response.body.resume();
    current = redirectTarget(current, location);
  }
  throw new DownloadRefusal(
    "too-many-redirects",
    url,
    `${url} redirected more than ${MAX_REDIRECTS} times without answering with an artefact.`,
  );
}

/**
 * Where a redirect leads, refusing a downgrade off `https`.
 *
 * A pure function over the two URLs, because that is the one part of the redirect chain worth
 * asserting on its own: the artefacts are public, so leaving `https` buys nothing, and a plain-http
 * hop is exactly where a middlebox would substitute an artefact. The digest would still catch the
 * substitution — this refuses it a hundred megabytes earlier, and by name.
 */
export function redirectTarget(from: string, location: string): string {
  const next = new URL(location, from);
  if (new URL(from).protocol === "https:" && next.protocol !== "https:") {
    throw new DownloadRefusal(
      "insecure-redirect",
      from,
      `${from} redirected to ${next.protocol}//${next.host}, which is not https. setup does not ` +
        "follow a downgrade: the artefact is verified by digest, but a plain-http hop is where a " +
        "middlebox would substitute one.",
    );
  }
  return next.toString();
}

/** One HTTP exchange, with no redirect handling and no interpretation of the status. */
function exchange(
  options: DownloadOptions,
  url: string,
  method: "GET" | "HEAD",
  from: number,
): Promise<ArtefactResponse> {
  return new Promise<ArtefactResponse>((resolve, reject) => {
    const parsed = new URL(url);
    const send =
      parsed.protocol === "https:"
        ? httpsRequest
        : parsed.protocol === "http:"
          ? httpRequest
          : null;
    if (send === null) {
      reject(
        new DownloadRefusal(
          "unreachable",
          url,
          `${parsed.protocol}// is not a scheme setup downloads over.`,
        ),
      );
      return;
    }
    let delivered: IncomingMessage | null = null;
    const request = send(
      url,
      {
        method,
        headers: from > 0 ? { range: `bytes=${from}-` } : {},
        signal: options.signal,
      },
      (message) => {
        delivered = message;
        resolve({
          status: message.statusCode ?? 0,
          statusText: message.statusMessage ?? "",
          headers: message.headers,
          body: message,
          url,
        });
      },
    );
    const idle = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    request.setTimeout(idle, () => {
      // Destroying the *response* once one exists is what puts this message in front of the user:
      // destroying the request instead aborts the body with Node's own bare "aborted", and a
      // download that hung for a minute would be reported as one that stopped for no reason.
      const stalled = Object.assign(new Error(`no data for ${idle} ms`), { code: "ETIMEDOUT" });
      const message: IncomingMessage | null = delivered;
      if (message === null) {
        request.destroy(stalled);
        return;
      }
      message.destroy(stalled);
    });
    request.on("error", (error) => reject(transportRefusal(url, error)));
    request.end();
  });
}

/** A connection that never produced a response, named by what stopped it. */
function transportRefusal(url: string, error: unknown): DownloadRefusal {
  const code = errorCode(error);
  const detail = error instanceof Error ? error.message : String(error);
  if (code !== null && INTERCEPTION_CODES.has(code)) {
    return new DownloadRefusal(
      "proxy-interception",
      url,
      `The TLS connection to ${url} did not reach the origin (${code}). That is what a proxy ` +
        "re-signing traffic, or a middlebox answering on port 443, looks like from here — the " +
        "artefact was not fetched, and setup will not fall back to an unverified connection.",
    );
  }
  return new DownloadRefusal(
    "unreachable",
    url,
    `${url} could not be reached${code === null ? "" : ` (${code})`}: ${detail}`,
  );
}

/**
 * A body that stopped mid-transfer, told apart from a disk that would not take it.
 *
 * A connection dropped part way is the ordinary flaky-network case and is **resumable**, so it is
 * reported as a short body with the partial kept — the same name and the same remedy as a server
 * that ended the body early on purpose. A local write failure is not a download problem at all and
 * is re-thrown as itself: `ENOSPC` reported as "the download was short" would send a user to their
 * network for a full disk.
 */
function classifyTransferFailure(
  request: ArtefactRequest,
  error: unknown,
  received: number,
): unknown {
  const code = errorCode(error);
  if (code !== null && LOCAL_WRITE_CODES.has(code)) {
    return error;
  }
  if (code !== null && INTERCEPTION_CODES.has(code)) {
    return new DownloadRefusal(
      "proxy-interception",
      request.url,
      `The connection to ${request.url} was taken over mid-transfer (${code}).`,
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new DownloadRefusal(
    "short-body",
    request.url,
    `${request.url} stopped after ${received} of ${request.size} bytes: ${detail}. The partial ` +
      "download is kept, so running setup again resumes it.",
  );
}

function errorCode(error: unknown): string | null {
  const own = (error as { code?: unknown }).code;
  if (typeof own === "string") {
    return own;
  }
  const cause = (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof cause === "string" ? cause : null;
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** Feed a file through a hash without keeping any of it. */
async function hashInto(hash: Hash, file: string): Promise<void> {
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
}

async function digestOfFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await hashInto(hash, file);
  return hash.digest("hex");
}

/**
 * What every archive reader reports, which is the part the two of them agree on.
 *
 * `archive.ts` also counts symlinks and `tar.ts` also counts the members its selector walked past;
 * neither number means anything to this module, which reports the summary and never branches on it.
 * Both readers' own summaries are assignable to this, so nothing is lost at the call site that
 * knows which reader it asked for.
 */
export type ArchiveSummary = {
  files: number;
  directories: number;
  bytes: number;
};

/**
 * One archive format: what it refuses before a byte is fetched, and how it unpacks.
 *
 * A pair rather than one function, because the two halves happen at opposite ends of a hundred
 * megabytes. `assert` runs **before** the download so an artefact this build cannot unpack is a
 * sentence rather than a wasted transfer — that ordering is the one thing a caller supplying its own
 * format must not lose — and `extract` runs after the digest has been checked.
 *
 * It is a parameter because the ONNX speech route needs a **selective** tar reader: the runtime it
 * acquires arrives as an npm tarball carrying every platform, and the point of acquiring it at all
 * is that a machine keeps its own. A format built at that call site closes over the selector, so
 * this module still knows nothing about npm, tar or platforms.
 */
export type ArchiveFormat = {
  /** Refuse a URL this reader cannot unpack, by extension, before anything is fetched. */
  assert: (url: string) => void;
  extract: (archive: string, staging: string) => ArchiveSummary | Promise<ArchiveSummary>;
};

/** The format every artefact but the ONNX runtime arrives in, and the default. */
export const ZIP_ARCHIVE: ArchiveFormat = {
  assert: assertZipArtefact,
  extract: extractZip,
};

/** Where the work happens and where the result lands. */
export type AcquireOptions = {
  request: ArtefactRequest;
  /** The directory the unpacked artefact becomes, whole, in one `rename`. */
  destination: string;
  /**
   * Where the partial download and the staging tree live.
   *
   * It defaults to a sibling of the destination, which is what keeps the commit a `rename` on one
   * filesystem. Pointing it at another volume turns that rename into a copy.
   */
  workDir?: string;
  /** How the artefact is refused and unpacked. Defaults to {@link ZIP_ARCHIVE}. */
  archive?: ArchiveFormat;
  /**
   * A last write into the staging tree, after extraction and **before** the `rename`.
   *
   * It exists so a provider can put a file of its own inside the tree it is committing and have
   * that file be present exactly when the tree is. Writing it after the rename instead would leave
   * a window in which a correct tree carries no receipt, and a later run that refuses a tree with
   * no receipt would then refuse correct work.
   */
  stage?: (staging: string, download: DownloadOutcome) => void;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  onProgress?: (received: number, total: number) => void;
};

/** What {@link acquireArtefact} committed. */
export type AcquireOutcome = {
  destination: string;
  download: DownloadOutcome;
  extraction: ArchiveSummary;
  /** What `fsync` on the destination's parent reported, as `durable-write.ts` words it. */
  flush: string;
};

/** How a staging directory is named, so a half-written one is never mistaken for a result. */
export const ACQUIRE_STAGE_PREFIX = ".staging-";

/** The suffix of the resumable partial. */
export const PART_SUFFIX = ".part";

/** The work directory `acquireArtefact` uses when a caller names none. */
export const WORK_DIR_NAME = ".setup";

/**
 * Fetch, verify, unpack and commit one artefact — the whole of what `setup` does per component.
 *
 * The order is the one ADR 0005 requires and is not an implementation detail: **verify, then
 * extract, then commit.** A digest checked after unpacking would have already written a hundred
 * megabytes of somebody else's archive into the destination.
 */
export async function acquireArtefact(options: AcquireOptions): Promise<AcquireOutcome> {
  const { request, destination } = options;
  if (existsSync(destination)) {
    throw new DownloadRefusal(
      "destination-occupied",
      request.url,
      `${destination} already exists. setup commits an artefact by renaming a staging directory ` +
        "onto that name, so it never writes into one that is already there.",
    );
  }
  const archive = options.archive ?? ZIP_ARCHIVE;
  archive.assert(request.url);
  const parent = dirname(destination);
  const workDir = options.workDir ?? join(parent, WORK_DIR_NAME);
  mkdirSync(workDir, { recursive: true });
  const partFile = join(workDir, `${basename(destination)}${PART_SUFFIX}`);
  const download = await downloadArtefact({
    request,
    partFile,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  const staging = join(workDir, `${ACQUIRE_STAGE_PREFIX}${process.pid}-${Date.now()}`);
  try {
    const extraction = await archive.extract(download.path, staging);
    options.stage?.(staging, download);
    mkdirSync(parent, { recursive: true });
    renameSync(staging, destination);
    rmSync(download.path, { force: true });
    return { destination, download, extraction, flush: flushDirectory(parent) };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Where a plain, unarchived file is fetched to and what it becomes. */
export type AcquireFileOptions = {
  request: ArtefactRequest;
  /** The **file** the verified bytes become, in one `rename`. */
  destination: string;
  /** Where the partial download lives. Defaults to a `.setup` directory beside the destination. */
  workDir?: string;
  /** The mode the committed file is given. Defaults to `0644`. */
  mode?: number;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  onProgress?: (received: number, total: number) => void;
};

/** What {@link acquireFile} committed. */
export type AcquireFileOutcome = {
  destination: string;
  download: DownloadOutcome;
  /** What `fsync` on the destination's parent reported, as `durable-write.ts` words it. */
  flush: string;
};

/** The mode a committed artefact file gets, matching `archive.ts`'s default for a zip member. */
const ACQUIRED_FILE_MODE = 0o644;

/**
 * Fetch, verify and commit one artefact that is **not** an archive.
 *
 * The ONNX speech route's model and voice are plain files — a 92 MB `.onnx` graph and a 510 KB
 * style tensor, straight out of the HuggingFace repository they live in — so there is nothing to
 * unpack and {@link acquireArtefact}'s staging *directory* has nothing to stage. What must not
 * change is the rest of the order: verify the digest before the bytes are visible under the name
 * anything else will look for, and make them visible in one `rename`. `download.ts` already
 * verifies; this is the commit, and it is the same `rename`-onto-the-name argument
 * `install/stage.ts` and `daemon/durable-write.ts` make.
 *
 * A destination that already exists is **refused** rather than replaced, exactly as it is for an
 * archive: whether a warm copy may be trusted is a question about the *component*, and the provider
 * that pinned the digest is the only thing that can answer it.
 */
export async function acquireFile(options: AcquireFileOptions): Promise<AcquireFileOutcome> {
  const { request, destination } = options;
  if (existsSync(destination)) {
    throw new DownloadRefusal(
      "destination-occupied",
      request.url,
      `${destination} already exists. setup commits a file by renaming a verified download onto ` +
        "that name, so it never writes over one that is already there.",
    );
  }
  const parent = dirname(destination);
  const workDir = options.workDir ?? join(parent, WORK_DIR_NAME);
  mkdirSync(workDir, { recursive: true });
  const partFile = join(workDir, `${basename(destination)}${PART_SUFFIX}`);
  const download = await downloadArtefact({
    request,
    partFile,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  chmodSync(download.path, options.mode ?? ACQUIRED_FILE_MODE);
  mkdirSync(parent, { recursive: true });
  renameSync(download.path, destination);
  return { destination, download, flush: flushDirectory(parent) };
}

/**
 * Refuse an artefact this build cannot unpack, by extension and before it is fetched.
 *
 * The query string is ignored on purpose: `remotion.media`'s URLs end `…zip?clear`, and a check
 * against the whole URL would refuse the artefact the pinned Remotion line actually selects.
 */
export function assertZipArtefact(url: string): void {
  const pathname = new URL(url).pathname;
  if (!pathname.toLowerCase().endsWith(".zip")) {
    throw new DownloadRefusal(
      "unsupported-archive",
      url,
      `${url} is not a .zip, and zip is the only archive format setup unpacks. Every artefact ` +
        "the toolchain manifest names is one.",
    );
  }
}
