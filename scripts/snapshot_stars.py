#!/usr/bin/env python3
"""
Fetch GitHub star counts + repo creation dates for every entry's `repo`
field and write a static data/stars.json snapshot, so the site doesn't
make a live, unauthenticated (60 req/hr, shared across every visitor
behind the same IP/NAT) GitHub API call per visitor per repo. Meant to
run on a schedule via .github/workflows/snapshot-stars.yml, not per-request.

Usage: GITHUB_TOKEN=... python3 scripts/snapshot_stars.py > data/stars.json
       (GITHUB_TOKEN is optional but raises the rate limit from 60/hr to
       5000/hr — worth setting when run from Actions, where it's free.)

Schema: {repo: {"stars": N, "created": "YYYY-MM-DD"}}
"""
import json
import os
import sys
import urllib.request
import urllib.error


def fetch_repo_info(repo, token=None):
    headers = {"User-Agent": "sfwa-directory-bot", "Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"https://api.github.com/repos/{repo}", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
        stars = data.get("stargazers_count")
        created = data.get("created_at")
        if stars is None or created is None:
            return None
        return {"stars": stars, "created": created[:10]}
    except Exception as e:
        print(f"warning: could not fetch info for {repo}: {e}", file=sys.stderr)
        return None


def main():
    with open("data/entries.json") as f:
        entries = json.load(f)

    token = os.environ.get("GITHUB_TOKEN")
    repos = sorted({e["repo"] for e in entries if e.get("repo")})

    snapshot = {}
    for repo in repos:
        info = fetch_repo_info(repo, token)
        if info is not None:
            snapshot[repo] = info

    print(json.dumps(snapshot, indent=2))


if __name__ == "__main__":
    main()
