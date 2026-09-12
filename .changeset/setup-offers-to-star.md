---
"@xplainer/cli": patch
---

`xplainer setup` offers to star the repository on GitHub, once, and only to a person.

On a yes it uses whatever can act without asking for a secret: the GitHub CLI first (`gh api -X PUT
/user/starred/...`, using the account it is already signed in as), then `GITHUB_TOKEN`/`GH_TOKEN` if
one is in the environment, and failing both it opens the repository in a browser so the question
lands somewhere the person can answer it.

Three rules keep it from becoming the prompt this CLI has always avoided — `connect/vendor-cli.ts`
closes stdin precisely because "a CLI that decided to prompt would otherwise hang `connect` for
ever". It asks only when **both** streams are a TTY and `CI` is unset, so `xplainer update` (which
spawns `setup` as a child) and every `scripts/e2e/*.mjs` never see it. It records the answer — yes
*or* no — so it is asked at most once per machine. And it can never fail the command: a GitHub
outage, a revoked token or a machine with no browser costs one line of output.

**It also gives up after ten seconds.** A TTY on both ends says a terminal is attached, not that a
person is reading it — an agent-driven session, a `tmux` pane nobody has open, a laptop that got
closed. Without a deadline the install just stops, with a question as the last thing printed. A
timeout is recorded as nothing at all rather than as a no, because somebody who walked away has not
declined and should be asked next time.

`--no-star` skips it outright, for a scripted install that has a terminal but no one at it. The
answer is kept in `<state>/star.json` rather than in `toolchain.json`, because that marker is a
generated protocol type shared with the Python side and a starring preference is not part of the
tool contract.
