---
"@xplainer/cli": minor
---

**Renders take about half as long, and the switch that does it changes no byte of the MP4.** The capture browser no longer waits on a 60 Hz frame clock (`--disable-frame-rate-limit --disable-gpu-vsync`): a headless page has no display to keep pace with, and every screenshot draws its own frame, so that wait added at least 16.7 ms to every frame and changed no pixel. On a 57-second, 1723-frame benchmark video on an M5 Pro, the median render went from 71.7 s on 0.1.1 to 28.8 s, against 27.2 s for 0.0.11 measured in the same session, and the MP4 is byte-identical to 0.1.1's.

**A still now shows the animation and transition events the render shows on that frame.** `explainer_still` steps through every earlier frame without capturing it, and a frame nobody captures got none of the rendering update a screenshot brings, which is where `animationend`, `transitionend` and the other animation events are dispatched. So an `onAnimationEnd` recorded the frame after the one it belongs to, or nothing. The pre-roll now asks the page for a rendering update on each frame where a CSS animation or transition changes phase. A still of a scene that reacts to those events can differ from the same still on 0.1.1, by design; a scene that animates with `interpolate()` is unaffected.

**A scene that runs timers or a frame loop beside a `delayRender` hold can render differently, and now renders the same way every time.** The page harness this CLI bundles runs a hold's timers in film order rather than on the wall clock; `@xplainer/motion`'s changelog has the detail.
