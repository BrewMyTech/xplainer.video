/**
 * The library: every video this machine holds, and what each one has produced.
 *
 * The rows come from `GET /api/videos` — the same `explainer_list` an agent calls, plus the files
 * each video has on disk — so the window and the agent cannot disagree about a video's state.
 *
 * **Two verbs and not three.** A still and a render take no arguments; narration takes a document
 * whose segment ids have to be the scene ids in the video's own composition, and composing one is
 * the agent's work. A button that invented a script would be a button that renders somebody else's
 * words.
 */

import type { EnqueueVerb } from "../../../shared/daemon-api";
import { describeVideo, filmOf, type LibraryVideo } from "../library";
import { BUTTON, CARD, COLORS, HEADING, MUTED, PRIMARY_BUTTON, SCREEN } from "../theme";

/** What the library screen is given. Every decision it shows was made before it was rendered. */
export type LibraryProps = {
  videos: readonly LibraryVideo[];
  /** The slug the player and the detail line are about, or `null`. */
  selected: string | null;
  /** Whether a request is in flight, so a second click cannot queue a second render. */
  busy: boolean;
  onSelect(slug: string): void;
  onQueue(slug: string, verb: EnqueueVerb): void;
  onRefresh(): void;
};

export function Library(props: LibraryProps) {
  const { videos, selected, busy, onSelect, onQueue, onRefresh } = props;
  return (
    <section style={SCREEN} aria-label="Library">
      <header style={{ display: "flex", alignItems: "baseline", gap: "0.75rem" }}>
        <h2 style={HEADING}>Library</h2>
        <p style={MUTED}>
          {videos.length === 0
            ? "no videos yet"
            : `${videos.length} video${videos.length === 1 ? "" : "s"}`}
        </p>
        <button type="button" style={{ ...BUTTON, marginLeft: "auto" }} onClick={onRefresh}>
          Refresh
        </button>
      </header>

      {videos.length === 0 ? (
        <p style={{ ...CARD, ...MUTED }}>
          Nothing here yet. Videos are created by an agent — `explainer_create` — and appear as soon
          as this daemon can see them.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.6rem" }}>
          {videos.map((video) => (
            <li
              key={video.slug}
              data-slug={video.slug}
              style={{
                ...CARD,
                borderColor: video.slug === selected ? COLORS.accent : COLORS.border,
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <button
                  type="button"
                  data-action="open"
                  onClick={() => {
                    onSelect(video.slug);
                  }}
                  style={{
                    ...BUTTON,
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    fontSize: "0.98rem",
                    fontWeight: 600,
                  }}
                >
                  {video.slug}
                </button>
                <p style={MUTED}>{describeVideo(video)}</p>
              </div>
              <div style={{ marginLeft: "auto", display: "flex", gap: "0.5rem" }}>
                <button
                  type="button"
                  data-action="still"
                  disabled={busy}
                  style={BUTTON}
                  onClick={() => {
                    onQueue(video.slug, "still");
                  }}
                >
                  Still
                </button>
                <button
                  type="button"
                  data-action="render"
                  disabled={busy}
                  style={PRIMARY_BUTTON}
                  onClick={() => {
                    onQueue(video.slug, "render");
                  }}
                >
                  Render
                </button>
                <button
                  type="button"
                  data-action="play"
                  disabled={filmOf(video) === null}
                  style={BUTTON}
                  onClick={() => {
                    onSelect(video.slug);
                  }}
                >
                  Play
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
