#!/usr/bin/env python3
"""
Fetch GitHub repo stats (stars, forks, creation date, contributor count,
language breakdown) for every entry's `repo` field and write a static
data/stars.json snapshot, so the site doesn't make live, unauthenticated
(60 req/hr, shared across every visitor behind the same IP/NAT) GitHub API
calls per visitor per repo. Meant to run on a schedule via
.github/workflows/snapshot-stars.yml, not per-request.

Usage: GITHUB_TOKEN=... python3 scripts/snapshot_stars.py > data/stars.json
       (GITHUB_TOKEN is optional but raises the rate limit from 60/hr to
       5000/hr — worth setting when run from Actions, where it's free. Each
       repo now costs 3 API calls instead of 1, so this matters more than
       it used to.)

Schema: {repo: {"stars": N, "created": "YYYY-MM-DD", "forks": N,
                 "contributors": N, "languages": [{"name": str, "pct": float}, ...]}}
"""
import json
import os
import re
import sys
import urllib.request
import urllib.error


def _headers(token):
    headers = {"User-Agent": "sfwa-directory-bot", "Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def fetch_repo_info(repo, token=None):
    req = urllib.request.Request(f"https://api.github.com/repos/{repo}", headers=_headers(token))
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
        stars = data.get("stargazers_count")
        created = data.get("created_at")
        forks = data.get("forks_count")
        if stars is None or created is None:
            return None
        return {"stars": stars, "created": created[:10], "forks": forks}
    except Exception as e:
        print(f"warning: could not fetch info for {repo}: {e}", file=sys.stderr)
        return None


def fetch_contributor_count(repo, token=None):
    # per_page=1 + the Link header's "last" page number is the standard trick
    # for a total count without paginating through the whole contributor list.
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/contributors?per_page=1&anon=true",
        headers=_headers(token),
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            link = resp.headers.get("Link")
            data = json.loads(resp.read())
        if link:
            m = re.search(r'[?&]page=(\d+)>;\s*rel="last"', link)
            if m:
                return int(m.group(1))
        return len(data)
    except Exception as e:
        print(f"warning: could not fetch contributor count for {repo}: {e}", file=sys.stderr)
        return None


def fetch_languages(repo, token=None):
    req = urllib.request.Request(f"https://api.github.com/repos/{repo}/languages", headers=_headers(token))
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
        total = sum(data.values())
        if not total:
            return []
        ranked = sorted(data.items(), key=lambda kv: kv[1], reverse=True)[:5]
        return [{"name": name, "pct": round(n / total * 100, 1)} for name, n in ranked]
    except Exception as e:
        print(f"warning: could not fetch languages for {repo}: {e}", file=sys.stderr)
        return []


def main():
    with open("data/entries.json") as f:
        entries = json.load(f)

    token = os.environ.get("GITHUB_TOKEN")
    repos = sorted({e["repo"] for e in entries if e.get("repo")})

    snapshot = {}
    for repo in repos:
        info = fetch_repo_info(repo, token)
        if info is None:
            continue
        info["contributors"] = fetch_contributor_count(repo, token)
        info["languages"] = fetch_languages(repo, token)
        snapshot[repo] = info

    print(json.dumps(snapshot, indent=2))


if __name__ == "__main__":
    main()
