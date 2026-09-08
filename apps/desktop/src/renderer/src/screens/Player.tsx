/**
 * The player: the finished film, and the layout checks beside it.
 *
 * **The `<video>` element never talks to the daemon.** Its `src` is an `xplainer-media://` URL —
 * the artefact path the library answered, carried whole — and the main process is what adds the
 * `Authorization` and streams the bytes back with the `Range` intact. A page that fetched the
 * daemon itself would need the bearer token in it, and a token in a page needs a browser origin
 * allowed on the daemon, which R-SEC-7 forbids for any value.
 *
 * The URL builder arrives as a prop rather than being read off `window.xplainer`, so this component
 * renders under a plain test runner with no preload bridge in the world.
 */

import { filmOf, type LibraryArtefact, type LibraryVideo, stillsOf } from "../library";
import { CARD, CODE, COLORS, HEADING, MUTED, SCREEN } from "../theme";

/** What the player is given: one video, and the scheme its bytes come over. */
export type PlayerProps = {
  video: LibraryVideo | null;
  /** `window.xplainer.mediaUrl` — a daemon path in, a URL the main process serves out. */
  mediaUrl(apiPath: string): string;
};

export function Player(props: PlayerProps) {
  const { video, mediaUrl } = props;
  if (video === null) {
    return (
      <section style={SCREEN} aria-label="Player">
        <h2 style={HEADING}>Player</h2>
        <p style={{ ...CARD, ...MUTED }}>Choose a video in the library to play it.</p>
      </section>
    );
  }

  const film = filmOf(video);
  const stills = stillsOf(video);
  return (
    <section style={SCREEN} aria-label="Player">
      <header>
        <h2 style={HEADING}>{video.slug}</h2>
        <p style={MUTED}>
          {film === null
            ? "no render yet — queue one from the library"
            : `${film.name} · ${megabytes(film.bytes)}`}
        </p>
      </header>

      {film === null ? null : (
        <video
          data-artefact={film.url}
          controls
          preload="metadata"
          src={mediaUrl(film.url)}
          style={{
            width: "100%",
            borderRadius: "0.5rem",
            background: "#000",
            border: `1px solid ${COLORS.border}`,
          }}
        >
          {/* No caption track is shipped as a sidecar: the captions are burnt into the frame by the
              composition, so an empty `<track>` here would advertise one that does not exist. */}
        </video>
      )}

      {stills.length === 0 ? null : (
        <div>
          <h3 style={{ ...HEADING, fontSize: "0.95rem" }}>Layout checks</h3>
          <ul
            style={{
              listStyle: "none",
              margin: "0.5rem 0 0",
              padding: 0,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gap: "0.6rem",
            }}
          >
            {stills.map((still) => (
              <li key={still.name} style={{ ...CARD, padding: "0.5rem" }}>
                <img
                  data-artefact={still.url}
                  alt={`${video.slug} ${still.name}`}
                  src={mediaUrl(still.url)}
                  style={{ width: "100%", borderRadius: "0.25rem", display: "block" }}
                />
                <p style={{ ...CODE, marginTop: "0.4rem" }}>{still.name}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.25rem" }}>
        {video.artefacts.map((artefact) => (
          <li key={artefact.name} style={CODE}>
            {describeArtefact(artefact)}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One artefact as a line: what it is, what it is called, and how big it is. */
function describeArtefact(artefact: LibraryArtefact): string {
  return `${artefact.kind.padEnd(9)} ${artefact.name} · ${megabytes(artefact.bytes)}`;
}

/** A byte count a person can read. */
function megabytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} kB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
