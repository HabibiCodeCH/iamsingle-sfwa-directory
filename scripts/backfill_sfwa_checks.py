#!/usr/bin/env python3
"""
One-time backfill: check_sfwa.py was added after 21 entries were already
in the catalog, so they sat on the old 9-check scale while every entry
reviewed afterward showed 13 — the same catalog showing two different
totals depending on when an entry happened to be added, which reads as
inconsistent even though every number is individually honest.

Runs check_sfwa.py's own check_repo() directly against every entry in
data/entries.json that doesn't already have an sfwa-* check, and appends
the results to that entry's existing checks array (never replaces it —
security_scan.py's results stay exactly as they were).

Not part of the regular pipeline and not meant to run again — new
entries already get this at submission time via review-submission.yml.
Kept as a script rather than a one-off shell command for the same reason
every other data mutation in this repo is one: it's auditable in the
commit history that added it, and rerunnable if the same situation
comes up again (a new check added after entries already exist).

Usage: python3 scripts/backfill_sfwa_checks.py
       (rewrites data/entries.json in place; GITHUB_TOKEN optional but
       recommended — 21 entries x 2 GitHub API calls each adds up)
"""
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from check_sfwa import check_repo  # noqa: E402

ENTRIES_PATH = "data/entries.json"


def main():
    token = os.environ.get("GITHUB_TOKEN")

    with open(ENTRIES_PATH) as f:
        entries = json.load(f)

    updated = 0
    for entry in entries:
        checks = entry.get("checks", [])
        if any(c["id"].startswith("sfwa-") for c in checks):
            continue  # already on the new scale

        if entry.get("repo"):
            new_checks = check_repo(entry["repo"], entry["url"], token)
        else:
            new_checks = [{
                "id": "sfwa-fetch",
                "label": "SFWA structure check",
                "status": "skip",
                "detail": "no repo set — nothing to inspect",
            }]

        entry["checks"] = checks + new_checks
        updated += 1
        print(f"  {entry['name']}: {[c['status'] for c in new_checks]}", file=sys.stderr)
        time.sleep(1)  # light courtesy delay, not strictly required for 21 entries

    with open(ENTRIES_PATH, "w") as f:
        json.dump(entries, f, indent=2)
        f.write("\n")

    print(f"Backfilled {updated} entries.", file=sys.stderr)


if __name__ == "__main__":
    main()
