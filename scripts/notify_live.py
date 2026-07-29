#!/usr/bin/env python3
"""
Runs at the end of build-pages.yml — the last step in the promote → snapshot
→ build chain — draining data/pending_notifications.json (written by
record_pending_notifications.py) by posting a comment back on each
entry's original submission PR once it's confirmed actually live: entry
present in data/entries.json with its checks already attached.

Content is a plain readback of entry.checks, which already holds both
security_scan.py's and check_sfwa.py's results by the time an entry
reaches data/entries.json (see review-submission.yml's merge step) — no
separate score computation, no drift between what the PR was told before
merge and what's reported after.

An entry not yet found in data/entries.json (build ran before its
promotion, or promotion is still in flight) is left in the queue for the
next run rather than dropped — see main().

Usage: python3 scripts/notify_live.py
       Requires GITHUB_TOKEN and GITHUB_REPOSITORY in the environment.
"""
import json
import os
import sys
import urllib.request

QUEUE_PATH = "data/pending_notifications.json"
SITE_URL = "https://iamsingle.app"


def slugify(s):
    # Kept in sync by hand with the identical function in build_pages.mjs,
    # index.html, and api/submit.js — no shared module between them.
    import re
    out = re.sub(r"[^a-z0-9]+", "-", s.lower())
    out = re.sub(r"(^-|-$)", "", out)
    return (out or "entry")[:40]


def _headers(token):
    return {
        "User-Agent": "sfwa-directory-bot",
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
    }


def post_comment(repo_full_name, pr_number, body, token):
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo_full_name}/issues/{pr_number}/comments",
        data=json.dumps({"body": body}).encode(),
        headers={**_headers(token), "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.status


def build_comment(entry, slug, handle):
    checks = entry.get("checks", [])
    applicable = [c for c in checks if c["status"] != "skip"]
    passed = sum(1 for c in applicable if c["status"] == "pass")

    sfwa_checks = [c for c in checks if c["id"].startswith("sfwa-")]
    sfwa_failed = [c for c in sfwa_checks if c["status"] == "fail"]

    lines = []
    if handle:
        lines.append(f"@{handle} — your submission is live: {SITE_URL}/entry/{slug}")
    else:
        lines.append(f"Your submission is live: {SITE_URL}/entry/{slug}")
    lines.append("")
    lines.append(f"**Score**: {passed}/{len(applicable)} automated checks passed.")

    if sfwa_checks:
        if sfwa_failed:
            lines.append("")
            lines.append("**SFWA check**: this repo tripped one or more heuristics for "
                          "\"single file, no build, no backend\" — worth a look even though it's already live:")
            for c in sfwa_failed:
                lines.append(f"- {c['label']}: {c['detail']}")
        else:
            lines.append("")
            lines.append("**SFWA check**: passed — looks like a genuine single-file app.")

    lines.append("")
    lines.append("_Automated message. Full per-check detail is on the entry's page._")
    return "\n".join(lines)


def main():
    token = os.environ.get("GITHUB_TOKEN")
    repo_full_name = os.environ.get("GITHUB_REPOSITORY")
    if not token or not repo_full_name:
        print("GITHUB_TOKEN and GITHUB_REPOSITORY are required", file=sys.stderr)
        sys.exit(1)

    try:
        with open(QUEUE_PATH) as f:
            queue = json.load(f)
    except FileNotFoundError:
        return
    if not queue:
        return

    with open("data/entries.json") as f:
        entries_by_url = {e["url"]: e for e in json.load(f)}

    remaining = []
    notified = 0
    for item in queue:
        entry = entries_by_url.get(item["url"])
        if not entry or "checks" not in entry:
            remaining.append(item)  # not live yet — try again next build
            continue

        slug = slugify(entry["name"])
        body = build_comment(entry, slug, item.get("handle"))
        try:
            post_comment(repo_full_name, item["pr_number"], body, token)
            notified += 1
        except Exception as e:
            print(f"warning: could not comment on PR #{item['pr_number']}: {e}", file=sys.stderr)
            remaining.append(item)  # retry next build rather than lose it

    with open(QUEUE_PATH, "w") as f:
        json.dump(remaining, f, indent=2)
        f.write("\n")

    print(f"Notified {notified}, {len(remaining)} still queued.")


if __name__ == "__main__":
    main()
