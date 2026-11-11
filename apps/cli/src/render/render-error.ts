/**
 * The one failure shape the render worker prints: `<CODE>: <sentence>`.
 *
 * Every stage of a render — the bundle, the browser, the page, the encoder — fails with a code an
 * agent can branch on and a sentence a person can act on, and the worker's last act is to print
 * `message` to stderr, where it becomes the tail of the job's log. The code is carried separately
 * as well, so a test asserts which failure happened rather than how it happened to be worded.
 */

/** A render stage failed, by name. `message` is always `<code>: <sentence>`. */
export class RenderError extends Error {
  /** The failure's name: `BUNDLE_FAILED`, `CHROME_LAUNCH_FAILED`, `PAGE_ERROR`, … */
  readonly code: string;

  constructor(code: string, sentence: string) {
    super(`${code}: ${sentence}`);
    this.name = "RenderError";
    this.code = code;
  }
}

/** The leading `CODE:` of a message, when it has one in the shape every stage uses. */
export function leadingCode(message: string): string | null {
  const match = /^([A-Z][A-Z0-9_]*[A-Z0-9]):/.exec(message);
  return match?.[1] ?? null;
}
