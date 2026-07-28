# iamsingle.app — directory of single-file web apps

A curated, community-submittable catalog of apps that ship as one HTML file:
no install, no build step, no server required to run. Sparked by
[Show HN: Bento](https://news.ycombinator.com/item?id=49008211) and the
broader "single-file web app" (SFWA) niche (TiddlyWiki, Hyperclay, Decker,
and a growing list of GitHub projects tagged `single-file`).

Name: **iamsingle.app** (pun on "single-file app" / "I am single").

## What's here

```
index.html                          the site itself — build_pages.mjs inlines entries.json/stars.json/sizes.json into
                                     every generated page, so it's self-contained (works over file://, no fetch needed);
                                     falls back to fetching data/*.json if that inline data is ever missing
vercel.json                         rewrites /entry/:slug to index.html for the client-side detail-page router
api/submit.js                       serverless function: POST here to open a submission PR directly
data/entries.json                   the directory's data — never touched directly by a submission PR, see below
data/pending/                       one file per open submission PR — see "How submissions merge without conflicting"
data/stars.json                     GitHub star count + repo creation date snapshot, refreshed daily — not hand-edited
data/sizes.json                     byte size of each entry's live URL response, from scripts/screenshot.mjs — not hand-edited
og/                                 generated per-entry share card (name, stars, size, score over the app's own screenshot),
                                     used as each entry page's og:image/twitter:image — from scripts/screenshot.mjs
assets/favicon.svg, logo.svg         vector source (edit these, not the PNGs)
assets/favicon-16/32/180/512.png     rendered favicon sizes
assets/logo.png                      rendered logo, 720×160
scripts/collect_pending.py          gathers data/pending/*.json into a list for the review scripts
scripts/security_scan.py            heuristic security checks (see below)
scripts/merge_checks.py             writes results into each matching data/pending/*.json as a `checks` array
scripts/promote_pending.py          folds a merged data/pending/*.json file into data/entries.json
scripts/snapshot_stars.py           fetches star counts, writes data/stars.json
scripts/check_hn_featured.py        heuristic Hacker News coverage lookup (see below) — leads only, never auto-applied
.github/workflows/review-submission.yml   wires the review scripts into a manual PR-review flow
.github/workflows/promote-pending.yml     runs promote_pending.py after a submission PR merges
.github/workflows/snapshot-stars.yml      runs snapshot_stars.py daily, plus on every push to main that touches data/entries.json
package.json                        marks this a Node/Vercel project (api/submit.js needs it)
```

## How submissions merge without conflicting

Early on, every submission PR contained a full rewritten copy of
`data/entries.json` (the new entry appended to the end). That meant two
PRs open around the same time would both edit the same lines of the same
file — a textbook git merge conflict, every time, requiring the same
manual fix (rebuild the entry on top of current `main`, force-push,
re-merge) by hand.

Now a submission PR only ever adds one new file, `data/pending/{slug}.json`,
holding just that one entry. Two PRs can never collide, because they're
never editing the same file. The actual fold into `data/entries.json`
happens after a PR merges, via `promote-pending.yml` — it always reads
`data/entries.json` fresh off current `main`, appends the entry, and
deletes the consumed pending file. If two merges land close together, the
workflow's `concurrency` group queues the second run to start only after
the first finishes, so there's no race on the shared file either.

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
adding one new file under `data/pending/` directly via the GitHub API —
no GitHub account needed on the submitter's end, and no manual
issue→PR conversion by a maintainer. It still reads `data/entries.json`
once, read-only, to reject an obvious duplicate URL before opening the PR.

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
base branch, and pulls only the PR's `data/pending/*.json` file(s) as plain
data via `git show` — the PR's own code is never checked out or executed.

Per pending entry:

1. **`collect_pending.py`** — gathers every `data/pending/*.json` file the
   PR added into a single list for the scripts below.
2. **`security_scan.py`** — heuristic only, not a guarantee:
   - if `repo` is set: shallow-clones it, runs `detect-secrets` (leaked
     credentials) and `semgrep` (`p/security-audit`, `p/javascript` rulesets).
     Only `ERROR`-severity semgrep findings that aren't explicitly
     low-confidence fail the check: `p/security-audit` is a high-recall audit
     ruleset meant to surface things for human review, so a raw finding count
     is noise rather than a verdict. Lower-severity hits are still counted in
     the check's detail text, so a noisy entry isn't presented as spotless.
   - always: fetches the live `url` (http/https only; internal/private hosts
     refused, and re-checked on every redirect hop) and regex-tests the raw
     HTML/JS for the literal presence of `eval(`, `new Function(`, decode→eval
     chains, decoded content written into the DOM, `sendBeacon` calls — these
     are presence checks on fetched text, not argument/taint analysis, so a
     `fail` means "found, needs a human look," not "confirmed dangerous"
   - a page over the 20 MB read cap is reported `skip`, never `pass` — a
     truncated body matches no patterns and would otherwise be
     indistinguishable from a clean result
   - each test reports `pass` / `fail` / `skip` individually — no prose summary
   - `scripts/test_security_scan.py` covers the above (`python3
     scripts/test_security_scan.py`, stdlib only)
3. **`merge_checks.py`** — writes the results into a `checks` array on the
   matching pending file (matched by `url`, not `name`, which isn't unique)
   and rewrites that `data/pending/*.json` file in place — never
   `data/entries.json` directly, see "How submissions merge without
   conflicting" above.
4. **`check_hn_featured.py`** — searches HN's free Algolia API
   (`hn.algolia.com/api`, no auth) for stories matching the entry's
   repo/URL/name. Common project names produce false positives (e.g.
   searching "Bento" also surfaces an unrelated Steam Deck keyboard), so
   results are only ever *candidates* in the PR comment — nothing writes
   to the entry's `featured` field automatically. A maintainer confirms a
   real match and adds it by hand.
5. The workflow commits and tries to push that change back to the PR branch
   — this only works for PRs from branches in this repo; `GITHUB_TOKEN` can't
   push to a fork's branch, so fork PRs rely on the PR comment instead.
6. A PR comment posts the same pass/fail list per entry, plus any HN
   candidates, for reviewers who don't want to open the diff.
7. Once the PR merges, `promote-pending.yml` folds the (now checks-annotated)
   pending file into `data/entries.json` and deletes it — see above.

### Known limitations worth reviewing

- `security_scan.py`'s pattern tests are regex-based and will miss anything
  even lightly obfuscated. Treat every `pass` as "nothing obvious found,"
  not "verified safe." `semgrep`/`detect-secrets` versions aren't pinned in
  the workflow — consider pinning once this is stable, so results don't
  shift silently on a tool update.
- GitHub's unauthenticated API rate limit (60/hr/IP) applies to the live
  star-ranking calls from visitors' browsers. Fine at current scale.
- The SSRF guard re-checks every redirect hop, but it validates a host by
  resolving it and then reconnects by name — so a DNS record that changes
  between those two steps (rebinding) could still slip through. Closing that
  means pinning the connection to the validated IP, which `urllib` can't
  express without reimplementing TLS hostname verification.
- Nothing re-scans an entry *automatically* after its PR merges. A live URL is
  checked once and never again, so a project that fixes its dependencies keeps
  its old verdict until someone asks for a re-check:

      node scripts/screenshot.mjs --refresh <slug>[,<slug>]   # re-measure some
      node scripts/screenshot.mjs --refresh-all               # re-measure everything

  That re-does the screenshot, size, QR eligibility and network profile for
  those entries, then `build_pages.mjs` regenerates their badges. A scheduled
  version still wants a guard against a network blip flipping a certified
  entry to failed — see the note on downgrades below.
- There's no check for whether an app phones home. `sendBeacon` is
  pattern-matched, but `fetch(`/`XMLHttpRequest`/WebSockets/remote
  `<script src>` are not, and regex is the wrong instrument for it anyway —
  intercepting requests in the headless browser that already loads every
  entry (`scripts/screenshot.mjs`) would be both more accurate and a more
  meaningful badge than anything in the current set.

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
