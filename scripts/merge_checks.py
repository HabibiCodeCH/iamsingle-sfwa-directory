#!/usr/bin/env python3
"""
Combine one or more result files (security_scan.py, check_sfwa.py, ...)
into a single "checks" array on each matching entry, so the static site
can render a "X/Y passed" badge with per-test detail.

Takes every result file in one call rather than being run once per file —
each call *sets* entry["checks"] from scratch, so a second run would
silently overwrite the first result set instead of adding to it.

Writes results into each data/pending/*.json file in place, matched by
url — not into data/entries.json, since a submission PR never touches
that shared file directly (see promote-pending.yml, which folds a
pending file's final content, checks included, into data/entries.json
after its PR merges).

Usage: python3 scripts/merge_checks.py scan_results.json sfwa_results.json ...
(rewrites matching data/pending/*.json files in place)
"""
import glob
import json
import sys


def main():
    if len(sys.argv) < 2:
        print("usage: merge_checks.py <result-file.json> [more-result-files.json ...]", file=sys.stderr)
        sys.exit(1)

    # Keyed by url, not name: names aren't unique or validated, and matching
    # on a mutable/attacker-controlled field risks one entry's checks getting
    # applied to a different entry that happens to share its display name.
    checks_by_url = {}
    for result_path in sys.argv[1:]:
        with open(result_path) as f:
            results = json.load(f)
        for r in results:
            checks_by_url.setdefault(r["url"], []).extend(r["checks"])

    for path in glob.glob("data/pending/*.json"):
        with open(path) as f:
            entry = json.load(f)
        if entry["url"] not in checks_by_url:
            continue
        entry["checks"] = checks_by_url[entry["url"]]
        with open(path, "w") as f:
            json.dump(entry, f, indent=2)
            f.write("\n")


if __name__ == "__main__":
    main()
