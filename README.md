# iamsingle.app — directory of single-file web apps

A curated, community-submittable catalog of apps that ship as one HTML file:
no install, no build step, no server required to run. Sparked by
[Show HN: Bento](https://news.ycombinator.com/item?id=49008211) and the
broader "single-file web app" (SFWA) niche (TiddlyWiki, Hyperclay, Decker,
and a growing list of GitHub projects tagged `single-file`).

Name: **iamsingle.app** (pun on "single-file app" / "I am single").

## What's here

```
index.html                          the site itself (fetches data/entries.json + data/stars.json at runtime)
api/submit.js                       serverless function: POST here to open a submission PR directly
data/entries.json                   the directory's data — this is what PRs edit
data/stars.json                     GitHub star snapshot, refreshed daily — not hand-edited
assets/favicon.svg, logo.svg         vector source (edit these, not the PNGs)
assets/favicon-16/32/180/512.png     rendered favicon sizes
assets/logo.png                      rendered logo, 720×160
scripts/diff_entries.py             finds entries added/changed in a PR vs its base branch
scripts/security_scan.py            heuristic security checks (see below)
scripts/ai_check.py                 Haiku "does the description match reality" check (batch, via Actions)
scripts/merge_checks.py             writes both results into data/entries.json as a `checks` array
scripts/snapshot_stars.py           fetches star counts, writes data/stars.json
.github/workflows/review-submission.yml   wires the review scripts into a manual PR-review flow
.github/workflows/snapshot-stars.yml      runs snapshot_stars.py on a daily schedule
package.json                        marks this a Node/Vercel project (api/submit.js needs it)
```

## How the site works

- Static, three files at runtime: `index.html` + `data/entries.json` +
  `data/stars.json`. No backend.
- **Star ranking**: for entries with a `repo` field, stars come from
  `data/stars.json`, a snapshot refreshed daily by the scheduled
  `snapshot-stars.yml` workflow (`scripts/snapshot_stars.py`, authenticated
  with the default `GITHUB_TOKEN` for a 5000/hr rate limit). The site does
  not call the GitHub API live per visitor — that was the original design
  and it doesn't scale past a handful of concurrent visitors sharing an IP.
- **Submission form**: POSTs directly to `api/submit.js`, which opens the PR
  itself via the GitHub API — see "Submission backend" below. A manual
  "file it as an issue" link is kept as a fallback if the API is down.
- **Check badges**: each card shows `passed/total` from the entry's `checks`
  array, if present. Click the badge to expand the itemized pass/fail/skip
  list. Entries with no `checks` (hand-curated, never gone through a PR)
  show no badge — that's intentional, not a bug.

## Submission backend (`api/submit.js`)

A Vercel serverless function. Validates the form POST, runs the AI
"description matches README" check inline, then opens a PR against
`data/entries.json` directly via the GitHub API — no GitHub account needed
on the submitter's end, and no manual issue→PR conversion by a maintainer.

Needs two env vars set on the Vercel project (not committed anywhere):

- **`GITHUB_BOT_TOKEN`** — a fine-grained PAT scoped to *only* this repo,
  with **Contents: write** and **Pull requests: write** permissions. Don't
  reuse a broad personal token here — this one lives in Vercel, not a CI
  job gated by manual review, so it should carry the least privilege that
  still works.
- **`ANTHROPIC_API_KEY`** — same key the batch `ai_check.py` uses. If unset,
  the inline check is skipped (not the whole submission — the PR still
  opens, just without that one check filled in).

The heavier checks (`security_scan.py`: repo clone, `detect-secrets`,
`semgrep`) are *not* run here — too slow for a synchronous request. Those
still require a maintainer to manually run "Review submission" from the
Actions tab before merging. A honeypot field (`hp`) provides basic bot
resistance; there's no persistent rate limiting (would need Vercel KV or
similar) — GitHub's own abuse detection and manual PR review are the
backstop for now.

## How the review pipeline works

**Manually triggered** by a maintainer (Actions tab → "Review submission" →
Run workflow, entering the PR number) — not automatic on every incoming PR.
This is deliberate: the scripts below run with `contents: write` /
`pull-requests: write` and (once set) `ANTHROPIC_API_KEY`. Automatically
checking out an untrusted PR's own branch and running its scripts with that
access is a classic GitHub Actions "pwn request" — a submission PR could
modify `scripts/*.py` itself and exfiltrate the secret. Instead the workflow
always runs the scripts from the base branch, and pulls only the PR's
`data/entries.json` as plain data via `git show` — the PR's own code is
never checked out or executed.

Per changed/new entry:

1. **`security_scan.py`** — heuristic only, not a guarantee:
   - if `repo` is set: shallow-clones it, runs `detect-secrets` (leaked
     credentials) and `semgrep` (`p/security-audit`, `p/javascript` rulesets)
   - always: fetches the live `url` (http/https only, internal/private
     hosts refused) and pattern-tests the raw HTML/JS for `eval()` on
     dynamic content, `new Function()`, decode→eval chains, decoded content
     written into the DOM, `sendBeacon` calls
   - each test reports `pass` / `fail` / `skip` individually — no prose summary
2. **`ai_check.py`** — asks `claude-haiku-4-5-20251001` whether the submitted
   description matches the repo's own README (fetched via the GitHub API).
   Entries with no `repo` are skipped — there's nothing to check against.
   Never checks the live app page itself — those are often a canvas or a
   compressed JS blob with no readable text to check against. The fetched
   README is passed to the model as explicitly delimited, untrusted data,
   not instructions, to reduce (not eliminate) prompt-injection risk from a
   submitter-controlled README.
3. **`merge_checks.py`** — combines both into a `checks` array on the
   matching entry (matched by `url`, the same stable key `diff_entries.py`
   uses — not by `name`, which isn't unique) and rewrites `data/entries.json`.
4. The workflow commits and tries to push that change back to the PR branch
   — this only works for PRs from branches in this repo; `GITHUB_TOKEN` can't
   push to a fork's branch, so fork PRs rely on the PR comment instead.
5. A PR comment posts the same pass/fail list per entry, for reviewers who
   don't want to open the diff.

### Not wired yet

- **`ANTHROPIC_API_KEY`** — add it under *Settings → Secrets and variables →
  Actions → New repository secret* on `HabibiCodeCH/iamsingle-sfwa-directory`.
  Until it's set, `ai_check.py` fails closed (marks the check `skip` with a
  note), it does not silently pass.

### Known limitations worth reviewing

- `security_scan.py`'s pattern tests are regex-based and will miss anything
  even lightly obfuscated. Treat every `pass` as "nothing obvious found,"
  not "verified safe." `semgrep`/`detect-secrets` versions aren't pinned in
  the workflow — consider pinning once this is stable, so results don't
  shift silently on a tool update.
- GitHub's unauthenticated API rate limit (60/hr/IP) applies both to the
  live star-ranking calls from visitors' browsers and to any repo/README
  fetches the Action makes during a review run. Fine at current scale.
- The site now depends on `fetch()` for `data/entries.json`, so opening
  `index.html` directly via `file://` will fail on CORS. It only works
  served over http(s) — Vercel, GitHub Pages, etc.
- The SSRF guard on `url`/README fetches blocks private/loopback/link-local
  addresses at DNS-resolution time, not on every redirect hop — a submitted
  URL that redirects to an internal address after the initial check could
  still slip through. Not exploited in testing, but worth hardening
  (e.g. disabling redirects and re-checking each hop) before this sees
  real traffic.
- The AI check's prompt-injection mitigation (delimiting the README as
  untrusted data) reduces but doesn't eliminate the risk of a crafted
  README manipulating the model's verdict — treat `ai-match` the same as
  every other check here: a heuristic signal for a human, not a guarantee.

## If you rename the site

Update in one pass:
- `<title>` and `.kicker` / `<h1>` text in `index.html`
- the wordmark text in `assets/logo.svg` (re-render `logo.png` after editing)
- `OWNER`/`REPO` constants at the top of `api/submit.js`, and the fallback
  issue link in `index.html`'s submit-section, if the repo name changes too

## Deploying

Needs Vercel (or another host that runs `api/*.js` as serverless functions)
— `api/submit.js` means this is no longer a pure static site. Set
`GITHUB_BOT_TOKEN` and `ANTHROPIC_API_KEY` as project env vars (see
"Submission backend" above) before the submission form will work; the
catalog itself renders fine without them.
