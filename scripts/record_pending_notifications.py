#!/usr/bin/env python3
"""
Runs immediately before promote_pending.py, over the same
data/pending/*.json files, to capture what promote_pending.py has no
reason to know and won't be able to recover afterward: which PR each
entry came from, and who submitted it.

The correlation is the submission branch name — api/submit.js always
names it submit/<slug>, where <slug> is also the pending file's own
basename, so the originating PR can be found by branch name alone, no
extra storage needed at submission time. The submitter's handle (if any)
is pulled from the PR body's "**Submitted by**: @handle" line — see
api/submit.js, which writes that exact label.

Appends one record per pending entry to data/pending_notifications.json,
a queue that notify_live.py drains once each entry is confirmed actually
live (see build-pages.yml). Never touches data/pending or data/entries.json
itself.

Usage: GITHUB_TOKEN=... python3 scripts/record_pending_notifications.py
       GITHUB_REPOSITORY=owner/repo is read from the environment, same as
       the rest of these scripts running in Actions.
"""
import glob
import json
import os
import re
import sys
import urllib.parse
import urllib.request

QUEUE_PATH = "data/pending_notifications.json"
SUBMITTER_RE = re.compile(r"\*\*Submitted by\*\*:\s*@([a-zA-Z0-9-]+)")


def _headers(token):
    return {
        "User-Agent": "sfwa-directory-bot",
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
    }


def find_pr(repo_full_name, slug, token):
    owner = repo_full_name.split("/")[0]
    q = urllib.parse.urlencode({"state": "all", "head": f"{owner}:submit/{slug}"})
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo_full_name}/pulls?{q}", headers=_headers(token)
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            prs = json.loads(resp.read())
    except Exception as e:
        print(f"warning: could not look up PR for slug {slug}: {e}", file=sys.stderr)
        return None
    return prs[0] if prs else None


def main():
    token = os.environ.get("GITHUB_TOKEN")
    repo_full_name = os.environ.get("GITHUB_REPOSITORY")
    if not token or not repo_full_name:
        print("GITHUB_TOKEN and GITHUB_REPOSITORY are required", file=sys.stderr)
        sys.exit(1)

    pending_paths = sorted(glob.glob("data/pending/*.json"))
    if not pending_paths:
        print("No pending entries to record.")
        return

    try:
        with open(QUEUE_PATH) as f:
            queue = json.load(f)
    except FileNotFoundError:
        queue = []

    for path in pending_paths:
        slug = os.path.splitext(os.path.basename(path))[0]
        with open(path) as f:
            entry = json.load(f)

        pr = find_pr(repo_full_name, slug, token)
        if not pr:
            print(f"warning: no PR found for slug {slug}, notification will be skipped", file=sys.stderr)
            continue

        handle_match = SUBMITTER_RE.search(pr.get("body") or "")
        queue.append({
            "url": entry["url"],
            "name": entry["name"],
            "pr_number": pr["number"],
            "handle": handle_match.group(1) if handle_match else None,
        })

    with open(QUEUE_PATH, "w") as f:
        json.dump(queue, f, indent=2)
        f.write("\n")

    print(f"Recorded {len(pending_paths)} pending notification(s), {len(queue)} total queued.")


if __name__ == "__main__":
    main()
