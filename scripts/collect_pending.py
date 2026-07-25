#!/usr/bin/env python3
"""
Collect every entry from data/pending/*.json in the current checkout and
print them as a JSON array.

Replaces the old diff_entries.py, which diffed data/entries.json against
a PR's base branch to find new/changed entries. That approach is gone
along with the shared-array submission model: a submission PR now adds
exactly one new file under data/pending/ (written by api/submit.js) and
never touches data/entries.json, so there's nothing left to diff — any
file present under data/pending/ in a PR simply *is* a new entry.

Usage: python3 scripts/collect_pending.py
Prints a JSON array to stdout.
"""
import glob
import json


def main():
    entries = []
    for path in sorted(glob.glob("data/pending/*.json")):
        with open(path) as f:
            entries.append(json.load(f))
    print(json.dumps(entries, indent=2))


if __name__ == "__main__":
    main()
