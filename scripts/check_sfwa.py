#!/usr/bin/env python3
"""
Heuristic check for whether a submission is actually what this catalog
claims to be: one file, no build step, no backend to keep alive. Nothing
in the existing pipeline checked this before — security_scan.py audits
code that's already been accepted as a genuine entry, it never asked
whether the repo is single-file to begin with. That gap is what let a
Vue source project (needs `npm run build`, ships no artifact) and a
PHP-backed app (needs a server) both look like normal submissions.

Same trust model as security_scan.py and check_hn_featured.py: a heuristic
lead for a human reviewer, not a verdict. A repo that fails every check
here might still be a fine catalog entry if a maintainer looks and
disagrees — these are reasons to look closer, not an auto-reject.

Output shape matches security_scan.py exactly ([{name, url, checks}]) so
merge_checks.py can fold both into the same entry.checks array.

Usage: python3 scripts/check_sfwa.py new_entries.json > sfwa_results.json
       (GITHUB_TOKEN optional, raises the rate limit — see snapshot_stars.py)
"""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

# Reused rather than reimplemented — the SSRF guard (reject internal/private
# addresses, re-checked on every redirect hop) is exactly as load-bearing
# here as it is there; this script fetches the same kind of submitter-
# controlled URL.
sys.path.insert(0, str(Path(__file__).parent))
from security_scan import is_safe_url, SafeRedirectHandler  # noqa: E402

TIMEOUT = 20
MAX_URL_FETCH_BYTES = 5_000_000

# Byte size a build tool's presence is trusted over — a big committed HTML
# file sitting next to package.json usually means the artifact is checked
# in even though the source needs a build too (this repo's own demo pages
# do exactly that). Small enough that a stub index.html doesn't count.
BUILT_ARTIFACT_MIN_BYTES = 3000

# How much smaller the live URL can be than the repo's largest HTML file
# before it looks like a different page entirely — a landing/marketing
# page linking to the real app rather than the app itself. Caught exactly
# this on a real submission: a repo whose real app was an 8 MB single
# file, submitted with a URL pointing at an unrelated few-KB landing page
# in the same repo. Deliberately generous — plenty of genuine SFWAs are
# legitimately smaller than the biggest file in their own repo (docs,
# alternate builds, etc.), so this only fires on an order-of-magnitude gap.
URL_VS_REPO_RATIO = 5

# Primary GitHub-reported language implying a required server process.
# Deliberately short and conservative — long enough to flag the clear
# cases (a PHP backend, a Python/Flask app), short enough that a repo
# using e.g. Rust only to compile to wasm isn't wrongly caught.
BACKEND_LANGUAGES = {"PHP", "Python", "Ruby", "Java", "C#"}


def _headers(token):
    headers = {"User-Agent": "sfwa-directory-bot", "Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _get(url, token):
    req = urllib.request.Request(url, headers=_headers(token))
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read())


def fetch_url_size(url):
    """Bytes actually downloaded from the submitted URL, capped, or None if
    it couldn't be fetched safely at all. A HEAD request would be cheaper
    but plenty of hosts either don't implement it or answer it differently
    from GET, and this only runs once per submission — GET-and-cap is
    simpler and more honest about what the visitor's browser would see."""
    ok, why = is_safe_url(url)
    if not ok:
        return None
    opener = urllib.request.build_opener(SafeRedirectHandler())
    req = urllib.request.Request(url, headers={"User-Agent": "sfwa-directory-bot"})
    try:
        with opener.open(req, timeout=TIMEOUT) as resp:
            return len(resp.read(MAX_URL_FETCH_BYTES))
    except Exception:
        return None


def check_repo(repo, url, token=None):
    try:
        info = _get(f"https://api.github.com/repos/{repo}", token)
        branch = info.get("default_branch", "main")
        tree = _get(f"https://api.github.com/repos/{repo}/git/trees/{branch}?recursive=1", token)
    except Exception as e:
        return [{
            "id": "sfwa-fetch",
            "label": "SFWA structure check",
            "status": "skip",
            "detail": f"could not fetch repo: {e}",
        }]

    blobs = [t for t in tree.get("tree", []) if t.get("type") == "blob"]
    html_files = [b for b in blobs if b["path"].lower().endswith((".html", ".htm"))]
    has_package_json = any(b["path"] == "package.json" for b in blobs)
    largest = max(html_files, key=lambda b: b.get("size", 0), default=None)
    largest_html = largest.get("size", 0) if largest else 0

    checks = []

    if not html_files:
        checks.append({
            "id": "sfwa-html-artifact",
            "label": "Ships an HTML file",
            "status": "fail",
            "detail": "no .html/.htm file found in the repo — nothing here is directly usable in a browser",
        })
    else:
        checks.append({
            "id": "sfwa-html-artifact",
            "label": "Ships an HTML file",
            "status": "pass",
            "detail": "",
        })

    if has_package_json and largest_html < BUILT_ARTIFACT_MIN_BYTES:
        checks.append({
            "id": "sfwa-no-build-step",
            "label": "No build step required",
            "status": "fail",
            "detail": "package.json is present and no HTML file over 3 KB is committed — this looks like it needs `npm run build` before it's usable; consider committing the built output directly",
        })
    else:
        checks.append({
            "id": "sfwa-no-build-step",
            "label": "No build step required",
            "status": "pass",
            "detail": "",
        })

    language = info.get("language")
    if language in BACKEND_LANGUAGES:
        checks.append({
            "id": "sfwa-client-side-only",
            "label": "No backend required",
            "status": "fail",
            "detail": f"primary language is {language} — this catalog is for apps with no server to keep alive; confirm this genuinely runs client-side only before merging",
        })
    else:
        checks.append({
            "id": "sfwa-client-side-only",
            "label": "No backend required",
            "status": "pass",
            "detail": "",
        })

    fetched_size = fetch_url_size(url)
    if fetched_size is None:
        checks.append({
            "id": "sfwa-url-is-app",
            "label": "Submitted URL looks like the app itself",
            "status": "skip",
            "detail": "could not fetch the submitted url",
        })
    elif fetched_size < 300_000 and largest_html > fetched_size * URL_VS_REPO_RATIO:
        checks.append({
            "id": "sfwa-url-is-app",
            "label": "Submitted URL looks like the app itself",
            "status": "fail",
            "detail": (
                f"the submitted url is {fetched_size:,} bytes, but the repo's largest HTML file "
                f"({largest['path']}) is {largest_html:,} bytes — this may be a landing/marketing "
                f"page rather than the app; double check the url points at the actual tool"
            ),
        })
    else:
        checks.append({
            "id": "sfwa-url-is-app",
            "label": "Submitted URL looks like the app itself",
            "status": "pass",
            "detail": "",
        })

    return checks


def main():
    if len(sys.argv) != 2:
        print("usage: check_sfwa.py <entries.json>", file=sys.stderr)
        sys.exit(1)

    with open(sys.argv[1]) as f:
        entries = json.load(f)

    token = os.environ.get("GITHUB_TOKEN")
    report = []
    for entry in entries:
        if entry.get("repo"):
            checks = check_repo(entry["repo"], entry["url"], token)
        else:
            checks = [{
                "id": "sfwa-fetch",
                "label": "SFWA structure check",
                "status": "skip",
                "detail": "no repo set — nothing to inspect",
            }]
        report.append({"name": entry["name"], "url": entry["url"], "checks": checks})

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
