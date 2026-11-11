/**
 * How a page failure is named: `<CODE>: <detail>`, always with the code first.
 *
 * The renderer reads only the message (CDP's `Runtime.evaluate` reports a rejection's `message`),
 * so the code has to be in the text. The harness produces four of them itself; anything else the
 * page throws — a component's `throw`, an error in a timer, a rejected promise nobody caught — is a
 * `PAGE_ERROR`. One exception: an error whose message **already** starts with one of the codes
 * below keeps it. That is how `<Video>`'s render-time refusal reaches the renderer as
 * `NOT_SUPPORTED_IN_V1: …` rather than `PAGE_ERROR: NOT_SUPPORTED_IN_V1: …` — the code a caller
 * branches on is the first token either way, and only one of the two spellings needs documenting.
 */

export const FAILURE_CODES: readonly [
  "PAGE_ERROR",
  "DELAY_RENDER_TIMEOUT",
  "IMAGE_BROKEN",
  "IMAGE_TIMEOUT",
  "NOT_SUPPORTED_IN_V1",
] = ["PAGE_ERROR", "DELAY_RENDER_TIMEOUT", "IMAGE_BROKEN", "IMAGE_TIMEOUT", "NOT_SUPPORTED_IN_V1"];

export type FailureCode = (typeof FAILURE_CODES)[number];

/** `<code>: <detail>`. */
export function failure(code: FailureCode, detail: string): string {
  return `${code}: ${detail}`;
}

/** The message of anything thrown: an `Error`'s message, a string as itself, else its `String()`. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const message: unknown = Reflect.get(error, "message");
    if (typeof message === "string") {
      return message;
    }
  }
  return String(error);
}

/** The failure line for anything thrown: its own code if it carries one, else `PAGE_ERROR`. */
export function describeFailure(error: unknown): string {
  const message = messageOf(error);
  if (FAILURE_CODES.some((code) => message.startsWith(`${code}: `))) {
    return message;
  }
  return failure("PAGE_ERROR", message);
}
