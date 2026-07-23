#!/usr/bin/env python3
"""
Heuristic check: has a submitted entry already had a Hacker News story
about it? Uses HN's free, unauthenticated Algolia search API
(https://hn.algolia.com/api) — no API key or auth needed.

This is a lead for a human reviewer, not an automatic grant of the
`featured` field: a text-search match can be a false positive (a
different project that happens to share a name), so results are printed
for the maintainer to confirm and add to the entry by hand — same trust
model as security_scan.py's pattern tests.

Usage: python3 scripts/check_hn_featured.py <entries.json subset, e.g. new_entries.json>
"""
import json
import sys
import urllib.parse
import urllib.request


def search_hn(query):
    url = "https://hn.algolia.com/api/v1/search?" + urllib.parse.urlencode({
        "query": query,
        "tags": "story",
        "hitsPerPage": 5,
    })
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "sfwa-directory-bot"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read()).get("hits", [])
    except Exception as e:
        print(f"warning: HN search failed for {query!r}: {e}", file=sys.stderr)
        return []


def find_candidates(entry):
    # Crude relevance filter: require the entry's repo/name to actually
    # show up in the matched story's url or title, since a bare keyword
    # search can otherwise surface unrelated stories.
    needle = (entry.get("repo") or entry.get("name") or "").lower().split("/")[-1]
    if not needle:
        return []

    seen = {}
    for query in filter(None, [entry.get("repo"), entry.get("url"), entry.get("name")]):
        for hit in search_hn(query):
            hn_id = hit.get("objectID")
            if not hn_id or hn_id in seen:
                continue
            haystack = ((hit.get("url") or "") + " " + (hit.get("title") or "")).lower()
            if needle not in haystack:
                continue
            seen[hn_id] = {
                "title": hit.get("title") or "",
                "url": f"https://news.ycombinator.com/item?id={hn_id}",
                "story_url": hit.get("url") or "",
                "points": hit.get("points"),
            }
    return list(seen.values())


def main():
    if len(sys.argv) != 2:
        print("usage: check_hn_featured.py <entries.json>", file=sys.stderr)
        sys.exit(1)

    with open(sys.argv[1]) as f:
        entries = json.load(f)

    results = []
    for entry in entries:
        candidates = find_candidates(entry)
        if candidates:
            results.append({"name": entry["name"], "url": entry["url"], "candidates": candidates})

    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
