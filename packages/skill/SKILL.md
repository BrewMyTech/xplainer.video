---
name: xplainer
description: Turn any problem — a bug, a root cause, an architecture decision, a new subsystem — into a short narrated explainer video with captions, rendered to a single MP4. Use when asked to "explain this as a video", "make an explainer", "turn this into a video", or when a fix is subtle enough that the team will understand it faster from ninety seconds of animation than from a diff.
---

# xplainer

Build an explainer video: animated scenes, a synthesised voiceover, and
word-level captions, rendered together into one MP4.

The bar is comprehension. Someone who watches the output should be able to say
what broke, why it broke, and what the fix does — without opening the diff.
That bar is met by **showing the mechanism**, not by narrating a slide deck.

## One tool set, and it runs on this machine

The eight tools are served by a runtime on the user's own machine. Nothing is
uploaded and nothing renders anywhere else: the workspace, the speech service
and every frame stay where this session already is. The one exception is the
user's to make: with ElevenLabs chosen for speech, the narration text is sent
there (see *Which voice is speaking*).

**Prefer the local tools when they are present.** If this session has an
xplainer server registered, call it: it renders on the machine the user is
already sitting at, it has no quota, and the finished MP4 lands somewhere they
can open. If none is registered, say so and stop — there is no second route to
reach for.

## Nothing to install

The renderer brings React, Tailwind and `@xplainer/motion` with it. There is
nothing to install: you never run `npm install`, never scaffold a project, and
never touch `node_modules`. Everything goes through the tools:

| Tool | Does |
|---|---|
| `explainer_create(slug)` | Makes the video and scaffolds its files |
| `explainer_put_source(slug, files)` | Writes your scene source files (React, `@xplainer/motion`) into the video |
| `explainer_put_media(slug, name, base64)` | Uploads one image, audio or video asset |
| `explainer_narrate(slug, narration)` | Voiceover + captions + timings |
| `explainer_still(slug, frame)` | One frame, for a layout check |
| `explainer_render(slug)` | Renders the MP4 |
| `explainer_job(job_id)` | Progress of any of the queued three |
| `explainer_list()` | What videos exist and their state |

Narration, stills and renders are queued, so those three tools return a `job_id`
immediately — poll `explainer_job` rather than waiting.

`explainer_create` scaffolds six files. **Five belong to the engine and you
cannot write them:** `index.ts`, `types.ts`, `Root.tsx`, `Captions.tsx` and
`Video.tsx`. `Video.tsx` is the composition shell — it mounts the voiceover,
mounts the caption track, and lays out one `<Sequence>` per narration segment at
the measured position and length.

This is enforced, not requested. A write naming any of those five is **refused**,
the whole call fails, and nothing at all is written — not even the files in the
same call that were fine. A render restores an engine file that was altered by
any other route. The reason is blunt: two of the lines in that shell are the
soundtrack and the captions, and a video that lost them still renders, still
exits clean, and ships silent.

**The sixth file, `Scenes.tsx`, is yours**, together with every component it
imports — by convention under `scenes/` — and any helper, hook or data file you
want beside them. Nothing about what a scene may contain is constrained: a scene
is ordinary React and you can draw anything. `Scenes.tsx` is scaffolded once, as
an empty map, and never overwritten, so `explainer_create` stays safe to re-run.

Your files reach the runtime through `explainer_put_source`, one call carrying
every file you changed. Paths are relative to the video, so a scene component
goes to `scenes/Symptom.tsx` and the map naming it goes to `Scenes.tsx`. Only
those five exact top-level names are reserved — `scenes/Root.tsx` is yours.
`explainer_create` also returns a `write_source_to` path, and you may write the
files there directly instead; the same five names are off limits there too.

## The one mechanic that isn't negotiable

`explainer_narrate` synthesises the voiceover and gets back **the timestamp of
every spoken word**. Every scene length, and every caption, comes from those
measurements, written to `timings.json`.

Guess durations instead and the picture drifts from the voice a few scenes in.
So: **write the narration, narrate it, then build the picture against
`timings.json`.** Never hand-write a scene duration.

You never write a scene's position or its length, because you never write the
`<Sequence>`. `Scenes.tsx` maps each narration segment id to the component that
draws it, and the engine reads `from` and `durationInFrames` straight off the
measured segment:

```tsx
import type { SceneMap } from "./Video";
import { SymptomScene } from "./scenes/Symptom";
import { CauseScene } from "./scenes/Cause";

export const scenes: SceneMap = {
  symptom: SymptomScene,
  cause: CauseScene,
};
```

Keep `import type` on that first line. As a value import it creates a real module
cycle at runtime and your scenes can come back `undefined`.

Each scene is handed `{ segment, timings, captions }`. Mismatches are loud in
both directions: a key naming no narration segment fails the render and lists the
valid ids, and a segment with no key draws a visible "no scene" placeholder — so
building one scene at a time works, and reordering the narration reshuffles the
picture correctly on its own.

Two optional exports draw across the whole video if you want them: `Backdrop`,
behind every scene, and `Overlay`, above the scenes and below the captions.

Inside a scene, `useCurrentFrame()` restarts at zero, so scene animations are
written relative to the scene. To land a beat on a specific spoken word, read
`captions.json` — every word carries real `startMs`/`endMs`.

Every authoring API comes from one package, `@xplainer/motion`:
`useCurrentFrame`, `useVideoConfig`, `interpolate`, `Easing`, `spring`,
`random`, `Sequence`, `Series`, `Loop`, `Freeze`, `AbsoluteFill`, `Img`,
`staticFile`, `delayRender` and `continueRender`. React is plain `react`.

```tsx
import { AbsoluteFill, interpolate, useCurrentFrame } from "@xplainer/motion";
```

## Workflow

1. **Get the explanation right.** Read the code, the diff, the logs. You need
   the real root cause; an explainer built on a guess is worse than none,
   because it is confidently wrong and now memorable. Land on: the symptom
   someone noticed, what actually caused it, why it was non-obvious, what the
   fix changes. If there were three causes, that *is* the story.
2. **Decide the visual direction** before writing components (below).
3. **Storyboard as motion** — what moves, and what that movement means.
4. `explainer_create`, then write the narration and `explainer_narrate`. Read
   the job's output for words the voice had to guess at (below).
5. **Design your scenes** against `timings.json` — one entry in `Scenes.tsx`
   per narration segment id, plus the components it imports — and send them all
   with `explainer_put_source`.
6. `explainer_still` and look at it, then `explainer_render`.

If the caller handed you screenshots, recordings, or diagrams, use them — real
footage of the bug beats any abstraction you can draw. Lead with it. Send each
file with `explainer_put_media` and reference it as `staticFile("media/name.png")`;
`explainer_create` returns the matching `put_media_in` path, so you may also
drop the files there yourself.

## Show the mechanism, don't list it

The default failure mode is a deck: heading, three bullets, cut to next heading.
That transfers words, not understanding. People understand a bug when they watch
the wrong thing happen.

Before writing any scene, ask: *what would this look like if it were moving?*

| When the point is… | Show |
|---|---|
| a sequence of events | a timeline that plays — events landing one by one, the late one arriving after the boundary that was supposed to close things out |
| state that got stuck | the state machine itself, a token moving through it, and stalling where it stalled |
| a race or an ordering bug | two lanes against one clock, drifting out of order |
| data taking the wrong path | the payload travelling between boxes and visibly branching wrong |
| a value that should have changed | the value on screen, changing — or conspicuously not |
| specific code | the excerpt held still, with emphasis moving to the line under discussion |
| before and after | one diagram transforming in place, not two static cards side by side |
| scale, cost, or volume | quantity as quantity: bars growing, a counter running, a queue filling |

Working rules:

- **One mechanism per scene.** If a scene needs "and also", it is two scenes.
- **Hold after motion settles.** Give each state about a second of stillness to
  be read. Animation that never rests is harder to follow than a static card.
- **Movement must mean something.** If an element moves, the movement is the
  point. Ambient drift, floating particles, and things sliding in for no reason
  read as generated filler.
- **Reserve a slot for every element.** Lay scenes out with flex or grid and
  fade elements in where they already sit. Never let a late arrival shove an
  earlier one sideways.
- **Voice and picture do different jobs.** The animation shows *what happens*;
  the narration explains *why it happens*. If the voice is reading the words on
  screen, delete one of them.
- **Text is the fallback, not the default.** A text card is right for a hard
  claim you want to land — a takeaway, a name, a number. It is wrong as the
  representation of a process.

## Visual direction

Design it for this subject, the way a studio would. Do not reach for a generic
"tech explainer" look.

Fix the direction before building. Write down, in a few lines:

- **Palette** — 4–6 named hex values. Derive them from the subject's own world
  where there is one: the product's real UI, the terminal it runs in, the
  colours the logs already use for pass and fail.
- **Type** — a display face with personality used with restraint, plus a body
  face that stays readable in motion, plus a mono face if code appears. Set a
  real scale; do not let one weight do every job.
- **Motion signature** — the one movement idea repeated throughout. Everything
  easing on the same curve, a single accent that travels between scenes, a
  consistent way new information arrives.
- **Signature element** — the one thing this video is remembered by. Spend your
  boldness here and keep everything around it quiet.

Then check the plan against the brief: if any part of it is what you would have
produced for *any* engineering explainer, change that part.

Currently over-used and worth avoiding unless the brief actually asks: cream
background with a high-contrast serif and a terracotta accent; near-black with
one acid-green accent; glassmorphic cards floating on a gradient mesh; and
`01 / 02 / 03` numbering on content that is not genuinely a sequence.

Sizing for a 1920×1080 frame: headline 90–120px, body 48–56px, labels 32px
minimum. Anything smaller is decoration — if it must be read, make it bigger.
Keep one focal point per frame, hold a generous margin, and keep scene content
out of the band reserved for captions.

## Styling: Tailwind is allowed

Tailwind v4 is built into the renderer: every utility class your files mention
is compiled into the page. Use utility classes or inline styles — whichever suits
the video. Both are fine; don't mix them arbitrarily within one video.

The engine's `index.ts` imports the stylesheet already, so the utilities are live
whether or not you reach for them — there is nothing to wire up, and nothing to
remove if you style purely inline.

**One rule:** motion is `interpolate()` on `useCurrentFrame()`, not
Tailwind's `animate-*`, `transition-*` and `duration-*` utilities or CSS
keyframes. The renderer does seek CSS animations and transitions to the frame
being drawn, and `explainer_still` steps through every earlier frame first, so a
still shows what the render will — but CSS timing runs from the moment an
element first appears, ignores `<Sequence>`, `<Loop>` and `<Freeze>`, and cannot
be timed to the narration. `interpolate()` is a pure function of the frame, so
it does all three. Tailwind is for layout, colour, spacing and type.

Note also that arbitrary Tailwind text sizes are usually easier to read at video
scale than the default scale — `text-[96px]` beats `text-6xl` when you want a
specific size.

## Motion craft

- Animate with `useCurrentFrame()` and `interpolate()`. **CSS transitions and
  CSS/Tailwind animations ignore the timing components and the narration**
  (above).
- Reach for `interpolate()` with `Easing.bezier()` first; `spring()` when the
  motion should overshoot.
- Prefer the `scale`, `translate` and `rotate` CSS properties over `transform`
  strings — they stay readable and editable.
- Stagger related elements by a few frames rather than moving them as a block.
- Images go through `<Img src={staticFile("media/name.png")} />`, both from
  `@xplainer/motion`; the renderer waits for every `<img>` to load before it
  draws a frame. A CSS `background-image` is not waited for, so a picture that
  must be there uses `<Img>`.
- **No video assets.** `<Video>` and `<OffthreadVideo>` fail the render with
  `NOT_SUPPORTED_IN_V1`; show stills instead.
- **The narration is the only audio track.** The engine adds it; a second
  `<Audio>` — music, a sound effect — fails the render with
  `NOT_SUPPORTED_IN_V1` rather than vanishing from the MP4.
- `staticFile()` names a file inside the video's own public directory:
  `staticFile("media/name.png")`, never a leading `/` or a `..`, which it
  refuses. A scene's imports stay inside the workspace too; one that reaches
  elsewhere on the machine fails the bundle with `BUNDLE_FAILED`.
- Scatter things with `random(seed)`, never `Math.random()` — a seeded value is
  the same on every frame, while `Math.random()` (reproducible from run to run)
  returns a new number on every render, so whatever it places jumps each frame. `Date.now()` and timers run on the video's clock, not
  the wall clock.
- If a scene has to wait for something asynchronous before a frame is drawn, take
  `const handle = delayRender("label")` and release it with
  `continueRender(handle)`. Timers you start while a hold is out run while the
  frame waits — in order, one at a time, stopping at the one that releases the
  hold — so `setTimeout(() => continueRender(handle), 100)` works, and a timer
  started beside it for later fires on the frame its delay reaches, the same on
  every render; every other timer runs on the video's clock. A hold not released
  within 30 seconds fails the render with `DELAY_RENDER_TIMEOUT` and names its
  label.

**Videos written for the previous renderer.** Imports from `remotion`,
`@remotion/media` and `@remotion/captions` still compile for one more release —
they are mapped onto `@xplainer/motion`, and the job log prints a deprecation
line naming each file that used one; switch the import when you next touch the
file. What does not carry over: video assets and a second `<Audio>` (above); any
other `@remotion/*` package, which fails the render with `BUNDLE_FAILED` naming
it; Remotion Studio, whose job `explainer_still` now does; `remotion.config.ts`,
which no longer exists; and WebGL, which is not supported (a 2D `<canvas>`
works). `spring()` and the `Easing` curves follow their documented formulas, so
an old overshoot can land a hair differently.

## Narration

- **Short sentences.** Each becomes its own caption window; long clauses smear
  the timing.
- **Spell out symbols.** "the agent underscore id field", not `agent_id`.
  "line twenty-eight sixty", not `:2860`. The model reads literally.
- **Open on the symptom**, in the words someone would actually use to complain
  about it. Architecture comes after the viewer cares.
- **Don't narrate the visuals.** No "as you can see here".
- **60–150 seconds**, roughly 8–14 segments. Longer than that, ship two videos.
- Use `holdSeconds` on a segment when the animation needs to finish after the
  voice stops.

The narration spec passed to `explainer_narrate`:

```json
{
  "voice": "af_heart",
  "speed": 1.0,
  "fps": 30,
  "segments": [
    { "id": "symptom", "text": "The session sat there saying it was working." },
    { "id": "cause", "text": "A subagent outlived the stop event.", "holdSeconds": 6 }
  ]
}
```

Leave `voice` out unless the user named one; the default, `af_heart`, means the
same thing. Which voice speaks is the machine's choice, not yours — see *Which
voice is speaking* below. On the built-in Kokoro voice, ids are
`<language><gender>_<name>` — `af_` American female, `am_` American male,
`bf_`/`bm_` British — and blend by weight: `"af_bella(2)+af_sky(1)"`. `speed`
runs 0.25–4.0 on Kokoro and 0.7–1.2 under ElevenLabs.

Pass `dry_run: true` to skip synthesis and get silence of estimated length — the
fast way to check pacing and layout before committing to real audio.

## Words the voice has to guess at

The voice knows ordinary English. For anything else — a tool name, an
initialism, a product, a surname — it derives a pronunciation and **says so**.
Read `explainer_job`'s output after every `explainer_narrate` and look for:

```
[xplainer] speech derived a pronunciation for "kubectl": /kjˈubɛktəl/ (letter-to-sound).
```

One line per word it had to guess, naming the word, the phonemes it chose, the
file to correct them in, and a line you can paste straight into that file. That
warning is the signal. **Do not go looking for hard words yourself before
narrating** — you cannot hear the audio, most technical English is already
correct, and an override you invent for a word that was fine is how a working
pronunciation gets broken.

So the loop is: narrate, read the warnings, decide which ones are actually
wrong, fix those, narrate again. Re-narrating is cheap on the built-in voice.

To fix one, add a line to the `lexicon.txt` the warning names — spelling,
spaces, then the phonemes:

```text
kubectl        kjˈubkˌʌtəl               # koob-CUT-ul
```

Start from the IPA in the warning and change only what sounds wrong. A rough
key: `A` is "ay", `I` is "eye", `i` is "ee", `O` is "oh", `ɛ` is "eh", and `ˈ`
marks the stressed syllable.

Three things to know before you write to it:

- **It is the user's file, not the video's.** One lexicon serves every video on
  that machine, so an entry you add outlives this job. That is right for
  `kubectl` and wrong for a one-off you are unsure about.
- **Case decides matching.** A lower-case spelling matches any case, so `api`
  catches `API`. A spelling with a capital matches exactly, which is what keeps
  an entry for `ID` from also changing the word "id".
- **Spelling it out in the narration is often the better fix.** `k8s` reads
  fine as "kubernetes"; `psql` reads fine as "postgres shell". Reach for the
  lexicon when the word itself has to be spoken.

You may add an entry before narrating for a word you genuinely know is
non-standard and whose pronunciation you are sure of. That is the exception,
not the routine.

## Which voice is speaking

The machine's owner chooses the speech provider, not you. The first line of the
narration job's output names it — `from kokoro …` is the built-in voice,
`from elevenlabs …` is ElevenLabs — and the closing `mode` line repeats it.

Under `elevenlabs`:

- **Every narration is billed per character to the user's account.** Iterate
  with `dry_run: true`, and narrate for real once the script is settled.
- `voice` is left out (or the default `af_heart`, which means the voice the
  owner configured) or is a 20-character ElevenLabs voice id the user gave you.
  Anything else is refused before a word is spoken.
- `speed` must be 0.7–1.2.
- `lexicon.txt` applies to the built-in Kokoro voice only, so no pronunciation
  warnings appear. To fix a word, respell it in the narration text.

Never ask for, read, print or write the API key, and never change the provider:
both are the user's. If narration fails because the key is missing or refused,
tell the user to run `xplainer config set tts.elevenlabs.api_key` themselves.
Switching provider is theirs too, with `xplainer config set tts.provider …`.

## Before you render

`explainer_still(slug, frame)` and actually look at the image:

- Is the main message readable in about a second?
- Is there one obvious focal point, or is the frame competing with itself?
- Does anything overlap, or collide with the captions?
- Would this frame still make sense if it were on screen for half a second?

Remember a still can catch a scene mid-reveal — if it looks sparse, check
whether later elements simply haven't arrived yet. There is no Studio and no dev
server: the still is the preview. A still steps through every earlier frame
before it draws its own, so it shows what the render will, and a failure on any
earlier frame fails the still too, naming that frame.

Then render, and report the output path or URL and the duration.

## Notes

- **Narration needs a speech service.** It runs on the user's machine, and a
  failed `explainer_narrate` usually means it is not running yet — the runtime's
  own setup command installs and starts it. Read the failure out of
  `explainer_job` before retrying.
- **A render needs ffmpeg on the user's machine.** A render that fails with
  `FFMPEG_NOT_FOUND` or `FFMPEG_NO_LIBX264` names the fix in its message; pass it
  on to the user rather than retrying.
- **Re-running is cheap on the built-in voice.** Change the narration and
  re-narrate, or change the components and re-render. There is no state to
  clean up. Under ElevenLabs, every real narration is billed.
- **Frames are reproducible on the same machine, not across machines.** The
  same video renders to the same frames every time here; on another operating
  system the picture is the same design but not the same pixels — text, shadows
  and SVG strokes differ most. Don't promise a pixel-identical render elsewhere.
- **The workspace is a build area, not a repository.** Treat the MP4 as the
  deliverable and hand it over directly, rather than expecting the sources to
  still be sitting there later.
