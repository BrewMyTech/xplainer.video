/**
 * The whole of the placeholder window: the application name and its version.
 *
 * The spec's Non-Goals put every real screen in a later roadmap phase, so this
 * component takes the one value it shows as a prop and owns no state.
 */

type AppProps = {
  /** The version the main process reported, via the preload bridge. */
  readonly version: string;
};

export function App({ version }: AppProps) {
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        margin: 0,
        fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
        color: "#e8e8ea",
        backgroundColor: "#111114",
      }}
    >
      <h1 style={{ margin: 0, fontSize: "2.5rem", letterSpacing: "-0.02em" }}>Xplainer</h1>
      <p style={{ margin: "0.75rem 0 0", opacity: 0.7 }}>Version {version}</p>
    </main>
  );
}
