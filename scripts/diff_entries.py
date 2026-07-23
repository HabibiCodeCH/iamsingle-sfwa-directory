#!/usr/bin/env python3
"""
Diff data/entries.json between the PR's base ref and the current checkout,
and print the entries that are new or changed (matched by "url").

Usage: python3 scripts/diff_entries.py <base_ref>
Prints a JSON array to stdout.
"""
import json
import subprocess
import sys


def load_base_entries(base_ref: str):
    try:
        raw = subprocess.check_output(
            ["git", "show", f"{base_ref}:data/entries.json"],
            stderr=subprocess.DEVNULL,
        )
        return json.loads(raw)
    except subprocess.CalledProcessError:
        # file didn't exist on base (e.g. first-ever entries.json) -> nothing to compare against
        return []
    except json.JSONDecodeError:
        return []


def load_current_entries():
    with open("data/entries.json") as f:
        return json.load(f)


def main():
    if len(sys.argv) != 2:
        print("usage: diff_entries.py <base_ref>", file=sys.stderr)
        sys.exit(1)

    base_ref = sys.argv[1]
    base_entries = {e["url"]: e for e in load_base_entries(base_ref)}
    current_entries = load_current_entries()

    changed = []
    for entry in current_entries:
        prior = base_entries.get(entry["url"])
        if prior is None or prior != entry:
            changed.append(entry)

    print(json.dumps(changed, indent=2))


if __name__ == "__main__":
    main()
