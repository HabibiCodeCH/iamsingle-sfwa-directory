#!/usr/bin/env python3
"""
Fold every entry in data/pending/*.json into data/entries.json, then
delete the consumed pending files. Runs server-side against whatever
data/entries.json currently looks like on main — never as part of a PR's
own diff — which is what lets concurrent submissions merge without
conflicting with each other. See .github/workflows/promote-pending.yml.

Usage: python3 scripts/promote_pending.py
(rewrites data/entries.json and removes consumed data/pending/*.json files)
"""
import glob
import json
import os


def main():
    pending_paths = sorted(glob.glob("data/pending/*.json"))
    if not pending_paths:
        print("No pending entries to promote.")
        return

    with open("data/entries.json") as f:
        entries = json.load(f)
    existing_urls = {e["url"] for e in entries}

    promoted = []
    for path in pending_paths:
        with open(path) as f:
            entry = json.load(f)
        if entry["url"] in existing_urls:
            # Already present — e.g. the same app submitted twice and
            # both PRs merged. Drop the pending file, don't add a
            # duplicate entry.
            print(f"skip (duplicate url): {path}")
        else:
            entries.append(entry)
            existing_urls.add(entry["url"])
            promoted.append(entry["name"])
        os.remove(path)

    with open("data/entries.json", "w") as f:
        json.dump(entries, f, indent=2)
        f.write("\n")

    if promoted:
        print("Promoted:", ", ".join(promoted))


if __name__ == "__main__":
    main()
