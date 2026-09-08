/**
 * R-SEC-9's three remaining preconditions, one refusal at a time.
 *
 * The bind address and the acknowledgement are `binding.test.ts`'s; this file is the other three —
 * the certificate, the operator allowlist, and a token this daemon did not mint — plus the one rule
 * that follows from the rest of the machine rather than from the ADR: TLS on a *loopback* bind is
 * refused, because `status`, `daemon restart` and the desktop all reach a loopback daemon over
 * `http` and none of them would say why they had stopped working.
 *
 * Every assertion here is on the sentence as well as the verdict. These are the only messages an
 * operator ever sees about a bind that did not happen, and "all of the missing preconditions in one
 * message" is a property of the text: a refusal that named one flag at a time would make somebody
 * run the command three times to learn a list this function already had.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSelfSignedCertificate } from "./testing/self-signed.js";
import {
  ALLOW_HOST_FLAG,
  loadTlsMaterial,
  mintedTokenRefusal,
  remoteExposureRefusal,
  TLS_CERT_FLAG,
  TLS_KEY_FLAG,
} from "./tls.js";

const scratch: string[] = [];

function directory(): string {
  const made = mkdtempSync(join(tmpdir(), "xplainer-tls-"));
  scratch.push(made);
  return made;
}

afterEach(() => {
  for (const path of scratch.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const REMOTE = { loopback: false, hostname: "192.0.2.10" };

describe("remoteExposureRefusal, on a non-loopback bind", () => {
  it("names every missing precondition in one sentence", () => {
    const refusal = remoteExposureRefusal({ ...REMOTE, allowHosts: [] });

    expect(refusal).toContain(TLS_CERT_FLAG);
    expect(refusal).toContain(TLS_KEY_FLAG);
    expect(refusal).toContain(ALLOW_HOST_FLAG);
    expect(refusal).toContain("192.0.2.10");
    expect(refusal).toContain("Nothing has been bound.");
  });

  it.each([
    ["only the certificate", { certPath: "/c" }, TLS_KEY_FLAG],
    ["only the key", { keyPath: "/k" }, TLS_CERT_FLAG],
  ])("refuses %s and names the half that is missing", (_case, half, expected) => {
    const refusal = remoteExposureRefusal({
      ...REMOTE,
      ...half,
      allowHosts: ["daemon.internal"],
    });

    expect(refusal).toContain(expected);
  });

  it("refuses a complete TLS pair with no --allow-host", () => {
    const refusal = remoteExposureRefusal({
      ...REMOTE,
      certPath: "/c",
      keyPath: "/k",
      allowHosts: [],
    });

    expect(refusal).toContain(ALLOW_HOST_FLAG);
    expect(refusal).not.toContain(TLS_CERT_FLAG);
  });

  it("permits a bind that brings all three", () => {
    expect(
      remoteExposureRefusal({
        ...REMOTE,
        certPath: "/c",
        keyPath: "/k",
        allowHosts: ["daemon.internal"],
      }),
    ).toBeNull();
  });
});

describe("remoteExposureRefusal, on a loopback bind", () => {
  it("asks for nothing at all", () => {
    expect(
      remoteExposureRefusal({ loopback: true, hostname: "127.0.0.1", allowHosts: [] }),
    ).toBeNull();
  });

  /** `--allow-host` is unconditional: the guard's list is the operator's whatever the bind is. */
  it("permits an operator allowlist without a widened bind", () => {
    expect(
      remoteExposureRefusal({
        loopback: true,
        hostname: "127.0.0.1",
        allowHosts: ["daemon.internal"],
      }),
    ).toBeNull();
  });

  it("refuses TLS, and says which callers it would have broken", () => {
    const refusal = remoteExposureRefusal({
      loopback: true,
      hostname: "127.0.0.1",
      certPath: "/c",
      keyPath: "/k",
      allowHosts: [],
    });

    expect(refusal).toContain("xplainer status");
    expect(refusal).toContain("127.0.0.1");
  });
});

describe("mintedTokenRefusal", () => {
  it("refuses the value this daemon minted for itself, and names token_origin", () => {
    const refusal = mintedTokenRefusal({ origin: "minted", path: "/state/token" });

    expect(refusal).toContain("/state/token");
    expect(refusal).toContain("token_origin");
    expect(refusal).toContain("--token-file");
    expect(refusal).toContain("Nothing has been bound.");
  });

  it("permits a token the operator supplied", () => {
    expect(mintedTokenRefusal({ origin: "operator", path: "/state/token" })).toBeNull();
  });
});

describe("loadTlsMaterial", () => {
  it("reads a real pair and hands back what it read", () => {
    const dir = directory();
    const written = writeSelfSignedCertificate(dir, { names: ["127.0.0.1", "daemon.internal"] });

    const decision = loadTlsMaterial({ certPath: written.certPath, keyPath: written.keyPath });

    expect(decision.ok).toBe(true);
    if (!decision.ok) {
      return;
    }
    expect(decision.material.cert).toBe(written.cert);
    expect(decision.material.key).toBe(written.key);
    expect(decision.material.certPath).toBe(written.certPath);
  });

  it.each([
    ["certificate", (paths: { certPath: string; keyPath: string }) => paths.certPath],
    ["private key", (paths: { certPath: string; keyPath: string }) => paths.keyPath],
  ])("refuses when the %s is not there, naming the path", (what, pick) => {
    const dir = directory();
    const written = writeSelfSignedCertificate(dir, { names: ["127.0.0.1"] });
    const missing = join(dir, "absent.pem");
    const paths = { certPath: written.certPath, keyPath: written.keyPath };
    const broken =
      what === "certificate" ? { ...paths, certPath: missing } : { ...paths, keyPath: missing };

    const decision = loadTlsMaterial(broken);

    expect(decision.ok).toBe(false);
    if (decision.ok) {
      return;
    }
    expect(decision.message).toContain(what);
    expect(decision.message).toContain(pick(broken));
    expect(decision.message).toContain("Nothing has been bound.");
  });

  it("refuses a certificate file that is not a certificate", () => {
    const dir = directory();
    const written = writeSelfSignedCertificate(dir, { names: ["127.0.0.1"] });
    const notACert = join(dir, "notes.txt");
    writeFileSync(notACert, "this is where I keep my certificate\n");

    const decision = loadTlsMaterial({ certPath: notACert, keyPath: written.keyPath });

    expect(decision.ok).toBe(false);
    if (decision.ok) {
      return;
    }
    expect(decision.message).toContain("is not a PEM certificate");
  });

  it("refuses a key file that is not a key, without quoting a byte of it", () => {
    const dir = directory();
    const written = writeSelfSignedCertificate(dir, { names: ["127.0.0.1"] });
    const notAKey = join(dir, "notes.txt");
    writeFileSync(notAKey, "-----BEGIN PRIVATE KEY-----\nnot base64 at all\n");

    const decision = loadTlsMaterial({ certPath: written.certPath, keyPath: notAKey });

    expect(decision.ok).toBe(false);
    if (decision.ok) {
      return;
    }
    expect(decision.message).toContain("is not a PEM private key");
    expect(decision.message).not.toContain("not base64 at all");
  });

  /**
   * Two `openssl` runs and one path copied from the wrong one. Both files are valid, so nothing
   * before the handshake notices — which is why this is checked here rather than left to a client.
   */
  it("refuses a valid key that belongs to a different certificate", () => {
    const dir = directory();
    const mine = writeSelfSignedCertificate(dir, { names: ["127.0.0.1"] });
    const other = writeSelfSignedCertificate(directory(), { names: ["127.0.0.1"] });

    const decision = loadTlsMaterial({ certPath: mine.certPath, keyPath: other.keyPath });

    expect(decision.ok).toBe(false);
    if (decision.ok) {
      return;
    }
    expect(decision.message).toContain("not the key of the certificate");
  });
});
