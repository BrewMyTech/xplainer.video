/**
 * The window's visual vocabulary, in one place.
 *
 * Inline style objects rather than a stylesheet: the renderer's Content-Security-Policy allows
 * `style-src 'self' 'unsafe-inline'` and nothing else, and a single module of tokens keeps every
 * screen agreeing about a colour without a build step that would have to be trusted with one.
 *
 * The palette is dark because the app is a viewer for video and stills, and a bright chrome around
 * a dark frame is the one thing a player must not do.
 */

import type { CSSProperties } from "react";

/** Every colour the window uses. */
export const COLORS = {
  page: "#111114",
  panel: "#17171c",
  raised: "#1e1e25",
  border: "#2a2a33",
  text: "#e8e8ea",
  muted: "#9a9aa6",
  accent: "#7aa2f7",
  good: "#7bd88f",
  bad: "#f78c8c",
  warn: "#e0af68",
} as const;

/** The one font stack, so nothing has to choose a second. */
export const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/** The monospace stack, for anything that is a path, an argument vector or a job's output. */
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/** A screen's outermost box: a heading, then its content, with room to breathe. */
export const SCREEN: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  padding: "1.5rem",
  overflowY: "auto",
  flex: 1,
  minHeight: 0,
};

/** A card: the unit every list item, every control and every panel is made of. */
export const CARD: CSSProperties = {
  background: COLORS.panel,
  border: `1px solid ${COLORS.border}`,
  borderRadius: "0.5rem",
  padding: "0.9rem 1rem",
};

/** A button. Quiet by default, because the loud one is the render. */
export const BUTTON: CSSProperties = {
  font: "inherit",
  fontSize: "0.85rem",
  color: COLORS.text,
  background: COLORS.raised,
  border: `1px solid ${COLORS.border}`,
  borderRadius: "0.375rem",
  padding: "0.4rem 0.75rem",
  cursor: "pointer",
};

/** The one button on a screen that starts work. */
export const PRIMARY_BUTTON: CSSProperties = {
  ...BUTTON,
  background: COLORS.accent,
  borderColor: COLORS.accent,
  color: "#0d1017",
  fontWeight: 600,
};

/** A heading over a screen. */
export const HEADING: CSSProperties = {
  margin: 0,
  fontSize: "1.15rem",
  letterSpacing: "-0.01em",
};

/** The quiet line under a heading, or under a row. */
export const MUTED: CSSProperties = {
  margin: 0,
  color: COLORS.muted,
  fontSize: "0.82rem",
};

/** Anything that is a path, an argv or a line of a job's output. */
export const CODE: CSSProperties = {
  fontFamily: MONO,
  fontSize: "0.75rem",
  color: COLORS.muted,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  margin: 0,
};
