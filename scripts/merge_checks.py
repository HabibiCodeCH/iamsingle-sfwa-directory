#!/usr/bin/env python3
"""
Combine scan_results.json (security_scan.py) into a single "checks" array
on each matching entry in data/entries.json, so the static site can render
a "X/Y passed" badge with per-test detail.

Usage: python3 scripts/merge_checks.py scan_results.json
(rewrites data/entries.json in place)
"""
import json
import sys


def main():
    if len(sys.argv) != 2:
        print("usage: merge_checks.py <scan_results.json>", file=sys.stderr)
        sys.exit(1)

    with open(sys.argv[1]) as f:
        scan_results = json.load(f)
    with open("data/entries.json") as f:
        entries = json.load(f)

    # Keyed by url, not name: names aren't unique or validated, and matching
    # on a mutable/attacker-controlled field risks one entry's checks getting
    # applied to a different entry that happens to share its display name.
    checks_by_url = {}
    for r in scan_results:
        checks_by_url.setdefault(r["url"], []).extend(r["checks"])

    for entry in entries:
        if entry["url"] in checks_by_url:
            entry["checks"] = checks_by_url[entry["url"]]

    with open("data/entries.json", "w") as f:
        json.dump(entries, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
