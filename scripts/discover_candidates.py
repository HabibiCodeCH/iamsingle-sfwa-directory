#!/usr/bin/env python3
"""
Poll GitHub's search API for repos tagged with topics that correlate with
"single-file web app," and append any not already in the catalog or
already surfaced to data/candidates.json — a lead list for a human to
look at, same trust model as check_hn_featured.py: a topic tag is not a
grant of inclusion, it's a reason to go look.

Topic choice matters here. `single-file-app` (~107 repos) and
`single-file-web-app` (~9) and `single-html-file` (~13) are specific
enough to be signal. The generic `single-file` topic (~1400+ repos) is
not used — it's dominated by C++ single-header libraries and unrelated
to web apps, and would bury every real candidate under noise.

Meant to run on a schedule via .github/workflows/discover-candidates.yml,
same shape as snapshot_stars.py. Never touches data/entries.json — adding
a candidate to the real catalog stays a human decision, made the normal
way (a submission, or a maintainer editing entries.json directly).

Usage: GITHUB_TOKEN=... python3 scripts/discover_candidates.py
       (GITHUB_TOKEN is optional but raises the rate limit; the search
       API has its own, stricter limit than the core API — 30 req/min
       authenticated, 10/min not — worth setting from Actions, where
       it's free.)
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

TOPICS = ["single-file-app", "single-file-web-app", "single-html-file"]
CANDIDATES_PATH = "data/candidates.json"
ENTRIES_PATH = "data/entries.json"


def _headers(token):
    headers = {"User-Agent": "sfwa-directory-bot", "Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def search_topic(topic, token=None):
    """All repos for one topic, paginated. The search API caps at 1000
    results total (10 pages of 100); nothing here gets close to that."""
    repos = []
    page = 1
    while True:
        url = "https://api.github.com/search/repositories?" + urllib.parse.urlencode({
            "q": f"topic:{topic}",
            "per_page": 100,
            "page": page,
        })
        req = urllib.request.Request(url, headers=_headers(token))
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read())
        except Exception as e:
            print(f"warning: search failed for topic:{topic} page {page}: {e}", file=sys.stderr)
            break

        items = data.get("items", [])
        repos.extend(items)
        if len(items) < 100:
            break
        page += 1
        time.sleep(2)  # stay well under the search API's per-minute limit

    return repos


def main():
    token = os.environ.get("GITHUB_TOKEN")

    with open(ENTRIES_PATH) as f:
        known_repos = {e["repo"] for e in json.load(f) if e.get("repo")}

    try:
        with open(CANDIDATES_PATH) as f:
            candidates = json.load(f)
    except FileNotFoundError:
        candidates = []
    seen_repos = known_repos | {c["repo"] for c in candidates}

    found = []
    for topic in TOPICS:
        for item in search_topic(topic, token):
            full_name = item.get("full_name")
            if not full_name or full_name in seen_repos:
                continue
            seen_repos.add(full_name)  # a repo can carry more than one of our topics
            found.append({
                "repo": full_name,
                "name": item.get("name"),
                "url": item.get("homepage") or item.get("html_url"),
                "description": item.get("description") or "",
                "stars": item.get("stargazers_count", 0),
                "topic": topic,
                "discovered": time.strftime("%Y-%m-%d"),
            })

    candidates.extend(found)
    with open(CANDIDATES_PATH, "w") as f:
        json.dump(candidates, f, indent=2)
        f.write("\n")

    print(f"{len(found)} new candidate(s), {len(candidates)} total pending review.", file=sys.stderr)


if __name__ == "__main__":
    main()
