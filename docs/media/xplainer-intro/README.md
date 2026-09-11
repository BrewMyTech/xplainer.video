# The README's hero video, and how to make it again

`docs/media/xplainer-intro.mp4` is the eighty-second tour at the top of the repository's
[`README.md`](../../../README.md). It was produced by driving this project's own MCP tools — the
same five an agent gets — so the video is also the largest worked example of what a scene file is
supposed to look like.

**The two files beside this one are the tool calls, not a description of them.** `narration.json`
is the argument object `explainer_narrate` takes and `source.json` is the one
`explainer_put_source` takes, both verbatim, so a regeneration is a replay rather than a rewrite.
That is the whole reason they are here: a 4.5 MB MP4 with no source is a file nobody can update,
and the next release would either ship a stale video or drop it.

## Replaying it

Any MCP client attached to a running daemon can make these four calls. The sequence is fixed and
the order is not negotiable — `still` and `render` both refuse a video that has not been narrated,
because a composition with no `timings.json` has no scene lengths to lay out:

```
explainer_create      { "slug": "xplainer-intro" }
explainer_put_source  <- docs/media/xplainer-intro/source.json
explainer_narrate     <- docs/media/xplainer-intro/narration.json
explainer_render      { "slug": "xplainer-intro" }
```

`explainer_create` is safe to call on a slug that already exists — it never overwrites — and
`explainer_put_source` deliberately refuses the five engine-owned files, so neither call can damage
an existing video. Poll `explainer_job` between the queued ones.

Two things about the output are worth knowing before comparing a fresh render against the committed
one:

- **The duration comes from the speech, so it moves.** Two runs of the same narration through the
  same voice can differ by a few frames, and every scene boundary shifts with it. The committed MP4
  is 2409 frames at 30 fps; a replay landing on 2400 or 2420 is correct, not a regression.
- **The committed MP4 is not the render's own output.** `explainer_render` wrote 9.9 MB; what is in
  `docs/media/` is 4.5 MB, because a repository is the wrong place for a 10 MB file that could be
  half that. Re-run this on any replacement — `+faststart` is the half that matters for a README,
  since it moves the index to the front so the video starts playing before it has finished
  downloading:

  ```bash
  ffmpeg -i "<state>/workspace/out/xplainer-intro/explainer.mp4" \
    -c:v libx264 -crf 26 -preset slow -pix_fmt yuv420p -profile:v high -level 4.0 \
    -c:a aac -b:a 96k -movflags +faststart \
    docs/media/xplainer-intro.mp4
  ```

## The poster

`docs/media/xplainer-intro-poster.png` is **frame 70**, scaled to 1600px: inside the title card,
part way through its sheen, and in a gap between two caption pages. The gap is the reason for that
exact frame rather than a rounder one — a poster taken mid-page carries a burnt-in caption frozen
mid-sentence, which reads as a broken screenshot rather than as a still of a narrated video. The
README links it to the MP4 rather than embedding a `<video>`:
GitHub serves a repository `.mp4` with `nosniff`, so a `<video src="...raw...">` renders a dead
player, while the `blob` page it does link to has a working one.

For **inline** playback in the README, the video has to be uploaded through GitHub's own web UI —
drag it into an issue or PR comment, which returns a `github.com/user-attachments/assets/...` URL
that `<video>` will accept. That URL cannot be produced from a checkout, which is why the committed
form is a linked poster.

## Why frame 0 is blank

Worth recording, because it looks like a bug and is not: the narration begins with about
0.4 s of silence, so the first measured segment starts at frame 12 and frames 0–11 are behind every
`Sequence`. A still at frame 0 shows the backdrop and nothing else. Any poster has to come from
inside a segment.
