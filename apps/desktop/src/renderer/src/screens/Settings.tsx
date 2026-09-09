/**
 * Settings: where the daemon is, and the two things this window can ask the CLI to do about it.
 *
 * Both controls are shell-outs and neither writes anything itself. "Add to Claude Code / Codex"
 * runs `xplainer connect claude|codex`; "Start xplainer at login" runs `xplainer daemon install`,
 * which is the only thing in this project allowed to write a `plist`, a systemd unit or a scheduled
 * task.
 *
 * **Which program runs is decision D10 and this screen shows it**, because it is the difference
 * between a control that works on a machine with nothing installed and one that does not: before an
 * install both run the packaged payload's own interpreter, and afterwards the stable launcher
 * `daemon install` wrote. The stage and the executable come back with the result, so a user reading
 * this screen can see which of the two ran.
 */

import {
  CONNECT_LABELS,
  CONNECT_VENDORS,
  type ConnectVendor,
  type ControlMessage,
  type DiscoveryMessage,
} from "../../../shared/ipc";
import { BUTTON, CARD, CODE, COLORS, HEADING, MUTED, PRIMARY_BUTTON, SCREEN } from "../theme";

/** What the settings screen is given. */
export type SettingsProps = {
  discovery: DiscoveryMessage | null;
  /** The vendor whose `connect` is running, or `null`. */
  connecting: ConnectVendor | null;
  /** What the last `connect` answered, or `null` before the first one. */
  connectResult: ControlMessage | null;
  /** Whether `daemon install` is running. */
  installing: boolean;
  /** What the last `daemon install` answered. */
  installResult: ControlMessage | null;
  onConnect(vendor: ConnectVendor): void;
  onStartAtLogin(): void;
};

export function Settings(props: SettingsProps) {
  const {
    discovery,
    connecting,
    connectResult,
    installing,
    installResult,
    onConnect,
    onStartAtLogin,
  } = props;

  return (
    <section style={SCREEN} aria-label="Settings">
      <h2 style={HEADING}>Settings</h2>

      <div style={CARD}>
        <h3 style={{ ...HEADING, fontSize: "0.95rem" }}>This machine's daemon</h3>
        {discovery === null ? (
          <p style={MUTED}>Asking the CLI where the daemon is…</p>
        ) : (
          <>
            <p style={MUTED}>
              {discovery.outcome} · {discovery.url}
            </p>
            <p style={MUTED}>{discovery.action}</p>
            {discovery.sentences.map((sentence) => (
              <p key={sentence} style={CODE}>
                {sentence}
              </p>
            ))}
            <p style={CODE}>state directory: {discovery.stateDir}</p>
          </>
        )}
      </div>

      <div style={CARD}>
        <h3 style={{ ...HEADING, fontSize: "0.95rem" }}>Add to an agent</h3>
        <p style={MUTED}>
          Registers this daemon's stdio entry by running <code>xplainer connect</code>. The entry
          carries no URL, no port and no token.
        </p>
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
          {CONNECT_VENDORS.map((vendor) => (
            <button
              key={vendor}
              type="button"
              data-vendor={vendor}
              disabled={connecting !== null}
              style={BUTTON}
              onClick={() => {
                onConnect(vendor);
              }}
            >
              {connecting === vendor ? "Registering…" : `Add to ${CONNECT_LABELS[vendor]}`}
            </button>
          ))}
        </div>
        <ControlReport result={connectResult} />
      </div>

      <div style={CARD}>
        <h3 style={{ ...HEADING, fontSize: "0.95rem" }}>Start xplainer at login</h3>
        <p style={MUTED}>
          Runs <code>xplainer daemon install</code>, which stages the runtime this app is carrying
          and registers it with this platform's own service manager.
        </p>
        <div style={{ marginTop: "0.75rem" }}>
          <button
            type="button"
            data-control="start-at-login"
            disabled={installing}
            style={PRIMARY_BUTTON}
            onClick={onStartAtLogin}
          >
            {installing ? "Installing…" : "Start at login"}
          </button>
        </div>
        <ControlReport result={installResult} />
      </div>
    </section>
  );
}

/** What one control answered: the stage it ran through, the program, and the CLI's own words. */
function ControlReport({ result }: { result: ControlMessage | null }) {
  if (result === null) {
    return null;
  }
  if (result.event === "control_unavailable") {
    return (
      <div style={{ marginTop: "0.75rem" }}>
        <p style={{ ...MUTED, color: COLORS.bad }}>{result.reason}</p>
        <p style={CODE}>{result.detail}</p>
      </div>
    );
  }
  return (
    <div style={{ marginTop: "0.75rem" }} data-stage={result.stage}>
      <p style={{ ...MUTED, color: result.ok ? COLORS.good : COLORS.bad }}>
        {result.ok ? "done" : `exit ${String(result.exitCode)}`} · ran the{" "}
        {result.stage === "payload" ? "packaged runtime" : "installed launcher"}
      </p>
      <p style={CODE}>
        {result.executable} {result.argv.join(" ")}
      </p>
      {result.detail === "" ? null : <p style={CODE}>{result.detail}</p>}
    </div>
  );
}
