/**
 * Progress: every job this window queued, as the daemon's own stream describes it.
 *
 * Each row is one `ExplainerJobOutput` — the exact document `explainer_job` answers an agent with —
 * so what a person sees here and what an agent polling the same render sees are the same facts.
 * There is no percentage, because the contract carries none: a state, the time it has been in it,
 * and the tail of what the job wrote are what the daemon actually knows.
 */

import { describeWatch, type JobWatch } from "../progress";
import { CARD, CODE, COLORS, HEADING, MUTED, SCREEN } from "../theme";

/** What the progress screen is given. `now` is a prop so a rendered row is a pure function. */
export type ProgressProps = {
  watches: readonly JobWatch[];
  /** `Date.now()` at render time — passed in, so the elapsed second is not read from a clock here. */
  now: number;
};

export function Progress(props: ProgressProps) {
  const { watches, now } = props;
  return (
    <section style={SCREEN} aria-label="Progress">
      <h2 style={HEADING}>Progress</h2>
      {watches.length === 0 ? (
        <p style={{ ...CARD, ...MUTED }}>
          Nothing queued from this window yet. A still or a render from the library appears here as
          soon as the daemon accepts it.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.6rem" }}>
          {watches.map((watch) => (
            <li
              key={watch.subscription}
              data-slug={watch.slug}
              data-status={watch.snapshot?.status ?? "queued"}
              style={{ ...CARD, borderColor: colourFor(watch) }}
            >
              <p style={{ margin: 0, fontWeight: 600 }}>
                {watch.verb} · {watch.slug}
              </p>
              <p style={MUTED}>{describeWatch(watch, now)}</p>
              {watch.snapshot === null || watch.snapshot.lines.length === 0 ? null : (
                <pre style={{ ...CODE, marginTop: "0.5rem", maxHeight: "9rem", overflow: "auto" }}>
                  {watch.snapshot.lines.join("\n")}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The border colour a row gets: the job's own outcome, and nothing inferred. */
function colourFor(watch: JobWatch): string {
  if (watch.streamError !== null) {
    return COLORS.bad;
  }
  const status = watch.snapshot?.status;
  if (status === undefined) {
    return COLORS.border;
  }
  if (status === "error" || status === "cancelled") {
    return COLORS.bad;
  }
  // `done` is the last of the three terminal states; what is left is `queued` or `running`.
  return status === "done" ? COLORS.good : COLORS.accent;
}
