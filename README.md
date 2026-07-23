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
vercel.json                         rewrites /entry/:slug to index.html for the client-side detail-page router
api/submit.js                       serverless function: POST here to open a submission PR directly
data/entries.json                   the directory's data — this is what PRs edit
data/stars.json                     GitHub star count + repo creation date snapshot, refreshed daily — not hand-edited
assets/favicon.svg, logo.svg         vector source (edit these, not the PNGs)
assets/favicon-16/32/180/512.png     rendered favicon sizes
assets/logo.png                      rendered logo, 720×160
scripts/diff_entries.py             finds entries added/changed in a PR vs its base branch
scripts/security_scan.py            heuristic security checks (see below)
scripts/merge_checks.py             writes the results into data/entries.json as a `checks` array
scripts/snapshot_stars.py           fetches star counts, writes data/stars.json
scripts/check_hn_featured.py        heuristic Hacker News coverage lookup (see below) — leads only, never auto-applied
.github/workflows/review-submission.yml   wires the review scripts into a manual PR-review flow
.github/workflows/snapshot-stars.yml      runs snapshot_stars.py daily, plus on every push to main that touches data/entries.json
package.json                        marks this a Node/Vercel project (api/submit.js needs it)
```

## How the site works

- Static, three files at runtime: `index.html` + `data/entries.json` +
  `data/stars.json`. No backend.
- **Star ranking + GitHub pill**: for entries with a `repo` field, star
  count and repo creation date come from `data/stars.json`
  (`{repo: {"stars": N, "created": "YYYY-MM-DD"}}`), a snapshot refreshed
  daily (and right after any merged submission) by the `snapshot-stars.yml` workflow
  (`scripts/snapshot_stars.py`, authenticated with the default
  `GITHUB_TOKEN` for a 5000/hr rate limit). The site does not call the
  GitHub API live per visitor — that was the original design and it
  doesn't scale past a handful of concurrent visitors sharing an IP. Each
  card shows a small pill with a GitHub icon (links to the repo), the
  star count, and the repo's creation month/year.
- **Sort options**: stars, "date created" (the repo's own GitHub creation
  date, from `data/stars.json`), "date added" (when the entry was added to
  *this* catalog, from each entry's `added` field), or name. `added` is
  stamped automatically by `api/submit.js` at submission time; entries from
  before this field existed keep whatever date was backfilled from git
  history when it was introduced.
- **Submission form**: POSTs directly to `api/submit.js`, which opens the PR
  itself via the GitHub API — see "Submission backend" below. A manual
  "file it as an issue" link is kept as a fallback if the API is down.
- **Featured badge**: an entry with a `featured` field
  (`[{"platform", "url", "title", "points"}]`) shows a badge next to its
  category tags. For `"platform": "Hacker News"` this renders as an
  orange HN-branded pill (Y mark, ▲ point count) linking to the thread;
  `points` is a static snapshot from when the entry was added, not
  live-refreshed — HN scores are effectively frozen once a story ages off
  the front page, so there's no daily-refresh job for this the way there
  is for stars. Other platform values fall back to a plain text badge.
  Nothing sets `featured` automatically — see `scripts/check_hn_featured.py`
  below for how a maintainer finds candidates to confirm.
- **Check badges**: each card shows `passed/total` from the entry's `checks`
  array, if present. Click the badge to expand the itemized pass/fail/skip
  list. Entries with no `checks` (hand-curated, never gone through a PR)
  show no badge — that's intentional, not a bug.
- **Detail pages**: clicking an entry's name goes to `/entry/{slug}` (a
  slugified version of its name) instead of straight to the live demo — a
  client-side view, still rendered by `index.html`, with a bigger header,
  Share/Visit buttons, stat cards (GitHub stars, created date, repo, security
  audit score), and the full checks list. `vercel.json` rewrites any
  `/entry/:slug` request to `index.html` so a hard refresh or a shared link
  works, not just in-app navigation. There's no server-side rendering, so a
  shared link's social-preview card falls back to the generic site-wide
  `og:image`/description, not per-entry content — the page itself renders
  correctly once loaded, this only affects unfurled link previews.

## Submission backend (`api/submit.js`)

A Vercel serverless function. Validates the form POST, then opens a PR
against `data/entries.json` directly via the GitHub API — no GitHub account
needed on the submitter's end, and no manual issue→PR conversion by a
maintainer.

Needs one env var set on the Vercel project (not committed anywhere):

- **`GITHUB_BOT_TOKEN`** — a fine-grained PAT scoped to *only* this repo,
  with **Contents: write** and **Pull requests: write** permissions. Don't
  reuse a broad personal token here — this one lives in Vercel, not a CI
  job gated by manual review, so it should carry the least privilege that
  still works.

Also enforces a 100/day submission cap (`DAILY_SUBMISSION_CAP` in
`api/submit.js`), counted via GitHub's own PR history — no extra
infrastructure needed. Caps PR/branch spam from a public, unauthenticated
endpoint.

The heavier checks (`security_scan.py`: repo clone, `detect-secrets`,
`semgrep`) are *not* run here — too slow for a synchronous request. Those
still require a maintainer to manually run "Review submission" from the
Actions tab before merging. A honeypot field (`hp`) provides basic bot
resistance on top of the daily cap.

## How the review pipeline works

**Manually triggered** by a maintainer (Actions tab → "Review submission" →
Run workflow, entering the PR number) — not automatic on every incoming PR.
This is deliberate: the script below runs with `contents: write` /
`pull-requests: write`. Automatically checking out an untrusted PR's own
branch and running its scripts with that access is a classic GitHub Actions
"pwn request" — a submission PR could modify `scripts/*.py` itself and
exfiltrate the token. Instead the workflow always runs the scripts from the
base branch, and pulls only the PR's `data/entries.json` as plain data via
`git show` — the PR's own code is never checked out or executed.

Per changed/new entry:

1. **`security_scan.py`** — heuristic only, not a guarantee:
   - if `repo` is set: shallow-clones it, runs `detect-secrets` (leaked
     credentials) and `semgrep` (`p/security-audit`, `p/javascript` rulesets)
   - always: fetches the live `url` (http/https only, internal/private
     hosts refused) and regex-tests the raw HTML/JS for the literal
     presence of `eval(`, `new Function(`, decode→eval chains, decoded
     content written into the DOM, `sendBeacon` calls — these are presence
     checks on fetched text, not argument/taint analysis, so a `fail`
     means "found, needs a human look," not "confirmed dangerous"
   - each test reports `pass` / `fail` / `skip` individually — no prose summary
2. **`merge_checks.py`** — writes the results into a `checks` array on the
   matching entry (matched by `url`, the same stable key `diff_entries.py`
   uses — not by `name`, which isn't unique) and rewrites `data/entries.json`.
3. **`check_hn_featured.py`** — searches HN's free Algolia API
   (`hn.algolia.com/api`, no auth) for stories matching the entry's
   repo/URL/name. Common project names produce false positives (e.g.
   searching "Bento" also surfaces an unrelated Steam Deck keyboard), so
   results are only ever *candidates* in the PR comment — nothing writes
   to the entry's `featured` field automatically. A maintainer confirms a
   real match and adds it by hand.
4. The workflow commits and tries to push that change back to the PR branch
   — this only works for PRs from branches in this repo; `GITHUB_TOKEN` can't
   push to a fork's branch, so fork PRs rely on the PR comment instead.
5. A PR comment posts the same pass/fail list per entry, plus any HN
   candidates, for reviewers who don't want to open the diff.

### Known limitations worth reviewing

- `security_scan.py`'s pattern tests are regex-based and will miss anything
  even lightly obfuscated. Treat every `pass` as "nothing obvious found,"
  not "verified safe." `semgrep`/`detect-secrets` versions aren't pinned in
  the workflow — consider pinning once this is stable, so results don't
  shift silently on a tool update.
- GitHub's unauthenticated API rate limit (60/hr/IP) applies to the live
  star-ranking calls from visitors' browsers. Fine at current scale.
- The site now depends on `fetch()` for `data/entries.json`, so opening
  `index.html` directly via `file://` will fail on CORS. It only works
  served over http(s) — Vercel, GitHub Pages, etc.
- The SSRF guard on the submitted `url` blocks private/loopback/link-local
  addresses at DNS-resolution time, not on every redirect hop — a submitted
  URL that redirects to an internal address after the initial check could
  still slip through. Not exploited in testing, but worth hardening
  (e.g. disabling redirects and re-checking each hop) before this sees
  real traffic.

## If you rename the site

Update in one pass:
- `<title>` and `.kicker` / `<h1>` text in `index.html`
- the wordmark text in `assets/logo.svg` (re-render `logo.png` after editing)
- `OWNER`/`REPO` constants at the top of `api/submit.js`, and the fallback
  issue link in `index.html`'s submit-section, if the repo name changes too

## Deploying

Needs Vercel (or another host that runs `api/*.js` as serverless functions)
— `api/submit.js` means this is no longer a pure static site. Set
`GITHUB_BOT_TOKEN` as a project env var (see "Submission backend" above)
before the submission form will work; the catalog itself renders fine
without it.
