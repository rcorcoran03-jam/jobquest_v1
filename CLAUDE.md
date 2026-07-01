# CLAUDE.md — JobQuest

Standing context for every Claude Code session. Read this before touching anything.

**This is the canonical, deployed repo.** `index.html` here is what Cloudflare Pages actually serves. If you were pointed at a different folder (e.g. `~/Documents/jobquest-dev`) for this project, stop and work here instead — that folder is a stale, disconnected copy that has previously caused a real regression (see "Why this file exists" below).

---

## What this project is

JobQuest is a single-file HTML job-search OS deployed on Cloudflare Pages. The entire application — UI, state, AI feature calls, and data models — lives in `index.html`. A companion Cloudflare Pages Function handles all Anthropic API calls server-side so the API key never reaches the browser.

Repo layout:

```
index.html              ← the entire app — the ONLY file you edit for features
functions/api/claude.js ← server-side proxy; Cloudflare turns this into the /api/claude endpoint
README.md               ← public setup guide (Starter Edition framing)
CLAUDE.md               ← this file
```

---

## Workflow — git is the safety net, not manual file copies

This repo has full commit history back to the project's start. Use it as the versioning mechanism — do not create `index_v1_3_X.html`-style backup copies before editing. That pattern was used in a disconnected local folder and directly caused a shipped feature (the Pipeline Narrative generator) to be silently overwritten twice by later commits that didn't know about it.

- **Pull before you start.** Always `git pull` (or at minimum `git log --oneline -5` / `git status`) at the start of a session, before making the first edit. Confirm you're not about to build on top of a stale snapshot.
- **Commit in small, real increments** that reflect actual units of work — matches the existing commit history's style (short, lowercase, descriptive: `"job board launches"`, `"focus tab and profile"`).
- **Pushing to `main`** — this repo has both direct-push commits and one PR-merged commit in its history; there's no single settled convention yet. Follow whatever push/review process the user asks for in each session rather than assuming one.
- **Never do a wholesale file replacement** of `index.html` from an external copy (another folder, a downloaded export, etc.) without first diffing it against the current `git log` to check what's landed since that copy was taken. If you're unsure, diff first, don't overwrite.

---

## Architecture — key constraints

- **Proxy-only AI calls.** Every AI feature POSTs to `/api/claude`. The constant is `const CLAUDE_URL = '/api/claude';` near the top of the script block. The Anthropic API key lives exclusively as the `ANTHROPIC_API_KEY` environment variable on the Cloudflare deployment. It is never sent to or stored in the browser. Do not introduce any client-side key handling.
- **Cloudflare Pages Function path.** `functions/api/claude.js` must be at that exact path in the repo. Cloudflare maps it to `/api/claude` automatically.
- **Single file.** All HTML, CSS, and JS live in `index.html`. No bundler, no build step, no external JS imports except the XLSX library loaded from cdnjs.
- **localStorage for state.** User profile is stored as `USER_PROFILE` in localStorage. Applications, contacts, and tasks have their own keys. GitHub Gist is the optional cloud backup layer (Sync tab).
- **Model.** Check the current `CLAUDE_MODEL` constant before assuming a value — don't hardcode a model name from memory. Don't change it without checking the proxy's allowed model list.

---

## Inline manifest

The top of `index.html` has an ASCII-box comment block. Keep it current on every meaningful edit. It tracks:

- Current version (`jq-version` meta tag and the box header)
- Changelog entries (recent changes, newest first)
- Pending / wishlist items

The `<meta name="jq-version">`, `<meta name="jq-base">`, and `<meta name="jq-date">` tags immediately follow and must stay in sync with the box. Bump the version on meaningful feature work; a git commit alone is enough provenance for small fixes — use judgment rather than bumping on every single edit.

---

## Validation pattern — run after every JS edit

The script block is large (~5000+ lines). After any change to JS, validate before considering the edit done.

**Step 1 — extract the script block:**

```python
import re
html = open('index.html').read()
blocks = re.findall(r'<script>(.*?)</script>', html, re.DOTALL)
for i, b in enumerate(blocks):
    open(f'/tmp/jq_script_{i}.js', 'w').write(b)
    print(f'wrote block {i}: {len(b)} chars')
```

**Step 2 — syntax check:**

```bash
for f in /tmp/jq_script_*.js; do node --check "$f" && echo "OK: $f"; done
```

A clean run prints `OK:` for every block. Any syntax error prints the line number — fix before proceeding.

---

## Edit discipline

**Before any edit:**

1. `grep -n` the target string first to confirm it appears exactly once and to get the line number.
2. Anchor edits on surrounding unique context (at least one line above and one below the target) when the target string itself is short or generic.
3. After a successful edit, the earlier view of that file region is stale — re-view before a second edit to the same area.
4. `grep -n` for the insertion anchor before adding new JS functions or CSS rules. Never guess line numbers in a file this size.

---

## Key code landmarks (grep to locate)

| What | String to grep |
|---|---|
| Profile read/write | `getProfile` / `saveProfile` |
| AI prompt construction | `buildAnalyzeSystem` / `profileBackground()` / `profileLine(` |
| Setup wizard render | `renderSetupWizard` |
| Resume draft-from-paste | `wizardDraftFromResume` |
| Example profile data | `EXAMPLE_APPS` / `loadExampleData` |
| Proxy URL constant | `const CLAUDE_URL` |
| Streaming helper | `async function claudeStream` |
| Inline manifest box | `╔══` (top of file) |
| Version meta tags | `jq-version` |

---

## What not to do

- Do not add client-side API key handling in any form.
- Do not split the app into multiple files without explicit instruction.
- Do not rename `functions/api/claude.js` or move it out of `functions/api/`.
- Do not introduce a build step or package.json unless explicitly asked.
- Do not bump the version number without also updating the inline manifest box and meta tags.
- Do not push to `main` without the user's explicit go-ahead in that session — see Workflow section above.
- Do not treat any other local folder (e.g. `~/Documents/jobquest-dev`) as a working copy of this project. If one exists, its contents may be stale — diff before trusting it.

---

## Why this file exists (context, not action items)

On 2026-07-01, a feature ("Pipeline Narrative" generator, commit `d8aaf90`) was built and merged via PR, then silently lost twice — first by commit `5c28648` ("job board launches"), briefly restored by a merge commit, then lost again by `a16e730` ("HQ launchers"). Root cause: those commits were authored against a stale local snapshot of `index.html` (from a *different, non-git-tracked* working folder) and pushed as wholesale file replacements, which clobbered the PR's changes instead of reconciling with them. This file was added the same day specifically to prevent a repeat.

---

## Owner context

Ryan Corcoran — Senior PM, Minneapolis MN. Active job search targeting Senior PM / Sr. Manager / Associate Director roles in digital health (care navigation, behavioral health, analytics) and medtech. Personal instance lives at `jobquest.ryan-corcoran.com`. Public Starter Edition is distributed via this repo (`github.com/rcorcoran03-jam/jobquest_v1`). Portfolio at `ryan-corcoran.com`.

The demo persona in the public example data is **Dario Naharis** — a fictional Minneapolis medtech PM. Keep him in the example data unless explicitly told to replace him.
