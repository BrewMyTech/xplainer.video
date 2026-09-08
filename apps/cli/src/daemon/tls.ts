/**
 * What a non-loopback bind costs, and the certificate the operator has to bring to pay it.
 *
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §Security R-SEC-9 does not
 * make remote exposure a flag. It makes it a list, and the list is `all` rather than `any`:
 *
 * > A non-loopback socket requires **all** of: an explicit `--bind`; an explicit
 * > `--i-understand-remote-exposure` …; a non-default token; TLS; and a Host/Origin allowlist that
 * > still applies, now against the operator's hostnames. `0.0.0.0` and `::` are refused outright.
 *
 * `daemon/binding.ts` owns the first two and the wildcards, because those are decidable from the
 * address alone. This file owns the other three, and it owns them as **refusals computed before
 * anything is bound**: `remoteExposureRefusal()` is what `serve` asks before it takes the state
 * directory, and `mintedTokenRefusal()` is what it asks in the one place the token's provenance is
 * known. A daemon that discovered a missing certificate after binding would already have been
 * reachable, unencrypted, on the address the operator was trying to protect.
 *
 * **The operator supplies the certificate; this product never generates one.** There is no
 * `--tls-self-signed`, no key written into the state directory and no certificate authority here.
 * A daemon that minted its own certificate would be handing every client the choice between
 * trusting it blindly and not connecting, which is the same non-decision an unencrypted socket
 * offers with one more step. {@link loadTlsMaterial} reads two paths, checks that they are a
 * certificate and a private key and that the key is *that certificate's* key, and stops there:
 * `apps/desktop`'s bridge already takes a caller-supplied trust store (`CertificateTrust`), so
 * pinning a self-signed certificate the operator made is the supported arrangement and making one
 * is `openssl`'s job, not ours.
 *
 * **TLS is refused on a loopback bind**, which is the one rule here that R-SEC-9 does not state and
 * that follows from everything else on the machine: `xplainer status` probes `http://127.0.0.1`
 * over `daemon/health.ts`'s unpooled client, `resolveDaemonEndpoint()` builds an `http:` origin
 * from `daemon.json`'s recorded port, and `apps/desktop` resolves the same. A loopback listener
 * speaking TLS would answer none of them, and it would answer none of them *silently* — so the
 * refusal names the reason rather than letting a working machine become a broken one.
 */

import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import type { TokenOrigin } from "./daemon-state.js";

/** The operator's certificate chain, in PEM. */
export const TLS_CERT_FLAG = "--tls-cert";

/** The private key for {@link TLS_CERT_FLAG}, in PEM. */
export const TLS_KEY_FLAG = "--tls-key";

/**
 * One authority the guard's `Host` allowlist gains, repeatable.
 *
 * A hostname rather than a URL, because the guard compares authorities and appends the bound port
 * itself — the same shape `127.0.0.1`, `localhost` and `[::1]` already have there.
 */
export const ALLOW_HOST_FLAG = "--allow-host";

/** A certificate and its key, read and checked, in the form `node:https` takes them. */
export type TlsMaterial = {
  /** The PEM chain, as read. */
  cert: string;
  /** The PEM private key, as read. */
  key: string;
  /** Where the chain came from, for the line `serve` prints. */
  certPath: string;
  /** Where the key came from. Never its contents, anywhere. */
  keyPath: string;
};

/** Either the material, or the sentence explaining why this daemon will not bind. */
export type TlsDecision = { ok: true; material: TlsMaterial } | { ok: false; message: string };

/** What {@link remoteExposureRefusal} weighs. */
export type RemoteExposureRequest = {
  /** `daemon/binding.ts`'s verdict: `false` only for an acknowledged, deliberately remote bind. */
  loopback: boolean;
  /** The interface about to be bound, so the refusal names the address the operator asked for. */
  hostname: string;
  /** `--tls-cert`, if it was given. */
  certPath?: string | undefined;
  /** `--tls-key`, if it was given. */
  keyPath?: string | undefined;
  /** Every `--allow-host`, in the order they were given. */
  allowHosts: readonly string[];
};

/**
 * The R-SEC-9 preconditions that argv alone decides, as one sentence naming **every** one that is
 * missing.
 *
 * All of them at once rather than the first: an operator who is told about the certificate, fixes
 * that, and is then told about the allowlist has been made to run the command three times to learn
 * a list this function already had. The token is not here — its provenance is a fact about the
 * state directory, which is not readable until ownership is held — and it is
 * {@link mintedTokenRefusal}'s.
 *
 * @returns the refusal, or `null` when this bind may proceed.
 */
export function remoteExposureRefusal(request: RemoteExposureRequest): string | null {
  if (request.loopback) {
    if (request.certPath === undefined && request.keyPath === undefined) {
      return null;
    }
    return (
      `xplainer serve: ${TLS_CERT_FLAG} and ${TLS_KEY_FLAG} are for a non-loopback --bind, and ` +
      `this daemon is binding ${request.hostname}. A loopback listener speaking TLS answers ` +
      "neither `xplainer status`, nor `xplainer daemon restart`, nor the desktop app, all of " +
      "which reach it over http — so this is refused rather than left to be discovered " +
      "(ADR 0020 §Security R-SEC-9)."
    );
  }

  const missing: string[] = [];
  if (request.certPath === undefined) {
    missing.push(`${TLS_CERT_FLAG} <path to a PEM certificate chain>`);
  }
  if (request.keyPath === undefined) {
    missing.push(`${TLS_KEY_FLAG} <path to its PEM private key>`);
  }
  if (request.allowHosts.length === 0) {
    missing.push(`${ALLOW_HOST_FLAG} <a hostname clients will send in Host> (repeatable)`);
  }
  if (missing.length === 0) {
    return null;
  }
  return (
    `xplainer serve: --bind ${request.hostname} exposes this daemon beyond this machine, which ` +
    "ADR 0020 §Security R-SEC-9 allows only with all five of an explicit --bind, " +
    "--i-understand-remote-exposure, TLS, an operator Host allowlist and a token this daemon did " +
    `not mint. Still missing: ${missing.join("; ")}. Nothing has been bound.`
  );
}

/**
 * The fifth precondition, asked once the token has been read: R-SEC-9's "a non-default token".
 *
 * `minted` is the daemon's own default — the value it generated so that the guard would be
 * non-optional on a machine where nothing had arranged a token — and it is the one value a remote
 * listener must not be authenticated with, because it was never a decision anybody made. See
 * `daemon/token.ts`'s `resolveTokenOrigin()` for how the two are told apart, and
 * `daemon/daemon-state.ts`'s `token_origin` for where the answer is kept.
 *
 * @returns the refusal, or `null` when this token may guard a remote listener.
 */
export function mintedTokenRefusal(request: { origin: TokenOrigin; path: string }): string | null {
  if (request.origin === "operator") {
    return null;
  }
  return (
    `xplainer serve: the bearer token in ${request.path} is the one this daemon minted for ` +
    "itself, and ADR 0020 §Security R-SEC-9 requires a non-default token for a non-loopback " +
    "bind. Write a token of your own to a file and pass it with --token-file, or point " +
    "XPLAINER_TOKEN_FILE at it; daemon.json's token_origin is what records which of the two this " +
    "is. Nothing has been bound."
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function read(
  path: string,
  what: string,
): { ok: true; text: string } | { ok: false; message: string } {
  try {
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch (error) {
    return {
      ok: false,
      message: `xplainer serve: could not read the TLS ${what} ${path} (${describe(error)}). Nothing has been bound.`,
    };
  }
}

/**
 * Read the operator's certificate and key, and refuse anything that is not a working pair.
 *
 * The two files are parsed here rather than handed straight to `node:https`, because a
 * `serve({ serverOptions })` given a text file fails inside the TLS context with an OpenSSL error
 * that names neither the flag nor the path. `checkPrivateKey` is the assertion worth making: a
 * certificate and a key that are each valid and belong to different pairs is the mistake an
 * operator actually makes — two `openssl` runs, one path copied from the wrong one — and it
 * otherwise surfaces as a handshake failure on the client's side of the machine.
 */
export function loadTlsMaterial(request: { certPath: string; keyPath: string }): TlsDecision {
  const cert = read(request.certPath, "certificate");
  if (!cert.ok) {
    return { ok: false, message: cert.message };
  }
  const key = read(request.keyPath, "private key");
  if (!key.ok) {
    return { ok: false, message: key.message };
  }

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(cert.text);
  } catch (error) {
    return {
      ok: false,
      message:
        `xplainer serve: ${request.certPath} is not a PEM certificate (${describe(error)}). ` +
        "Nothing has been bound.",
    };
  }

  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey(key.text);
  } catch (error) {
    // The message is the only thing said about this file, ever: a parse failure that quoted the
    // input would put a private key in the daemon's log.
    return {
      ok: false,
      message:
        `xplainer serve: ${request.keyPath} is not a PEM private key (${describe(error)}). ` +
        "Nothing has been bound.",
    };
  }

  if (!certificate.checkPrivateKey(privateKey)) {
    return {
      ok: false,
      message:
        `xplainer serve: ${request.keyPath} is a private key, but not the key of the certificate ` +
        `in ${request.certPath}. Nothing has been bound.`,
    };
  }

  return {
    ok: true,
    material: {
      cert: cert.text,
      key: key.text,
      certPath: request.certPath,
      keyPath: request.keyPath,
    },
  };
}
