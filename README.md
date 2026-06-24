<!--
  JobQuest README — public starter edition
  Version: v1.3.1 (public)  |  internal: readme_v1_3_2
  Changelog:
    v1.3.1 — Added Credits & license footer (MIT, links to ryan-corcoran.com).
             Repo now ships a LICENSE file.
    v1.3 — Distribution rewrite. Step 1 now uses GitHub fork instead of the old
           "create empty repo and upload three files" flow. Considered a Cloudflare
           "Deploy to Cloudflare" button but cut it: button is Workers-oriented and
           auto-detects build settings, unverified against this Pages + Functions
           setup (no wrangler.toml). Fork + manual Connect-to-Git is the tested path.
    v1.2 — Initial public guide (manual repo creation + file upload).
  Pending / wishlist:
    - Confirm source repo is PUBLIC before distributing (required for Fork).
    - Add link from jobquest.ryan-corcoran.com landing page -> repo root.
    - Revisit Deploy button later if verified against a Pages-compatible config.
-->
# JobQuest — your personal job-search OS

A single-file web app that runs your whole job search in one place:

- **AI fit analyzer** — paste a job description, get a 1–10 fit score, red flags, comp check, and live company news, all judged against *your* profile.
- **Application tracker** — pipeline by stage, priority, fit, and notes.
- **Networking CRM** — contacts, champions, follow-up reminders, AI-drafted outreach.
- **Focus timer, daily tasks, job-board launcher, and XLSX/CSV export.**
- **Cloud backup** to your own private GitHub Gist — open it from any browser.

Everything is yours: it runs on your own free Cloudflare deployment, your data lives in your browser and your private Gist, and your Anthropic API key stays a server-side secret that never touches the browser.

This guide takes about 20 minutes end to end. You'll need free accounts at **GitHub**, **Cloudflare**, and the **Anthropic Console**.

---

## What's in this repo

```
index.html              ← the entire app (one file)
functions/api/claude.js ← the proxy that talks to the Anthropic API
README.md               ← this guide
```

---

## Step 1 — Get your own copy on GitHub

You don't download anything or copy files around by hand. You make your own copy of this repo, which GitHub calls a **fork** — one click and you get a complete copy, folder structure and all, under your own account.

1. Create a free account at [github.com](https://github.com) if you don't have one.
2. On this repo's page, click **Fork** in the top-right. GitHub copies all three files into `github.com/your-username/jobquest_v1`, keeping the folder structure exactly (`index.html` at the root, `claude.js` inside `functions/api/`).
3. That's it — you now own a full copy. Continue to Step 2, then connect it to Cloudflare in Step 3.

> The folder path matters: Cloudflare turns `functions/api/claude.js` into the live URL `/api/claude` automatically. Forking preserves it for you, which is why this is easier than uploading files by hand.

---

## Step 2 — Get an Anthropic API key

1. Sign in at [console.anthropic.com](https://console.anthropic.com).
2. Add a little credit under **Billing** (the analyzer costs a fraction of a cent per run).
3. Go to **API Keys → Create Key**, and copy it. It starts with `sk-ant-`.

Keep it handy for Step 3. You will **not** paste it into the app — it goes into Cloudflare as a secret.

---

## Step 3 — Deploy to Cloudflare Pages

Connect your fork to Cloudflare, then add your API key.

1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com) (free account).
2. Go to **Workers & Pages → Create → Pages → Connect to Git**, and pick your `jobquest_v1` fork.
3. Build settings: leave the framework preset as **None**, and leave the build command and output directory **blank** (this is a static site — no build step). Click **Save and Deploy**.
4. When it finishes, open **Settings → Environment variables → Add variable**:
   - **Name:** `ANTHROPIC_API_KEY`
   - **Value:** your `sk-ant-…` key
   - Add it to **Production** (and Preview if you want previews to work). Save.
5. Trigger one more deploy so the new variable is picked up: **Deployments → Retry/redeploy** (or push any small change to GitHub).

Your app is now live at `https://your-project.pages.dev`. Open it.

> **Custom domain (optional):** under **Custom domains**, add one you own.

---

## Step 4 — First run: build your profile

On first open, JobQuest shows a **setup wizard**. Everything the AI uses is built from these fields, so it's worth a few minutes:

- **Basics** — name, target titles, focus areas, target comp, location, work mode. The "Not relocation" field lists places the analyzer should never count as a move (e.g. your metro and its suburbs).
- **Background** — a few sentences on your experience, your specialties, and education.
- **Fit criteria** — what makes a role a strong fit, what's a red flag, and your honest gaps. The analyzer frames gaps fairly rather than as dealbreakers.

**Shortcut:** paste your résumé and hit **✨ Draft from résumé** — Claude fills the fields in for you to review and edit. (This needs your deployment live, since it runs through your proxy.)

Prefer to look around first? Click **Load example data** for a fully populated demo. You can edit your real profile any time from the **Sync tab → Edit profile**.

---

## Step 5 — Turn on cloud backup (recommended)

After saving your profile, JobQuest offers GitHub Gist backup so your data survives a cleared browser and follows you to other devices. You can also reach it later from the **Sync tab**.

1. Create a token at [github.com/settings/tokens/new](https://github.com/settings/tokens/new) with **only the `gist` scope**. Copy it.
2. Create a new **secret** Gist at [gist.github.com](https://gist.github.com): filename `jobquest.json`, content `{}`. Copy the long ID from its URL.
3. Paste both into JobQuest and click **Connect**.

To open JobQuest on another device: visit your URL, go to the Sync tab, and enter the same token + Gist ID. Your data loads right in.

> The token and Gist ID are stored in that browser only and are sent only to `api.github.com`. Your data always saves locally first, so a sync hiccup can never lose it.

---

## How the AI plumbing works

All AI features POST to `/api/claude` on your own domain. That Cloudflare function attaches your `ANTHROPIC_API_KEY` and forwards the request to Anthropic, streaming the answer back. The key is a server-side secret — it is never sent to, or stored in, the browser.

If an AI feature ever errors with a message about the proxy, check that:
- your latest deployment is live, and
- `ANTHROPIC_API_KEY` is set in the Pages environment variables (then redeploy).

---

## Making it yours

A few things you can edit directly in `index.html` (search for the name):

- **`QUICK_LAUNCHES`** and **`TARGET_CAREER_PAGES`** — the job-board launcher links. Swap in the boards and target-company career pages you actually use.
- **`EXAMPLE_APPS` / `EXAMPLE_CONTACTS`** — the sample data behind "Load example data."
- Day-to-day data (applications, contacts, tasks) is all managed inside the app — no code editing needed.

---

## Privacy & cost

- **Your data** lives in your browser's local storage and, if you connect it, your private GitHub Gist. Nobody else has access.
- **The AI** runs on your Anthropic account. You pay Anthropic directly for what you use (typically well under a cent per analysis). Cloudflare Pages and GitHub Gist are free at this scale.

Good luck out there.

---

## Credits & license

JobQuest was built by **Ryan Corcoran** — product manager, Minneapolis. More work and a live demo at **[ryan-corcoran.com](https://ryan-corcoran.com)**.

Released under the [MIT License](LICENSE): use it, fork it, modify it, deploy it, all free of charge. The one ask the license makes is that you keep the copyright notice (it's in the `LICENSE` file and the header comment at the top of `index.html`). If JobQuest helped your search, a link back or a note is always appreciated, never required.

If you build something on top of this, I'd love to see it.
