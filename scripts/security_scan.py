#!/usr/bin/env python3
"""
Best-effort security pass over newly submitted directory entries.
This is a heuristic first filter for human reviewers, NOT a guarantee
that an entry is free of malicious code. It:

  1. Shallow-clones the entry's GitHub repo (if given) and runs:
       - detect-secrets  (leaked credentials / tokens)
       - semgrep p/security-audit + p/javascript  (dangerous patterns)
  2. Fetches the entry's live URL and runs it through a fixed set of
     regex presence tests (eval() calls, new Function() construction,
     decode-then-exec chains, decoded content written into the DOM, etc).
     These only detect the literal pattern's presence in the fetched
     text — they don't parse or evaluate arguments, so a hit means
     "found, needs a human look," not "confirmed dangerous." Every test
     is reported individually as pass/fail/skip so results can be shown
     per-test on the site, not as a prose summary.

Usage: python3 scripts/security_scan.py new_entries.json > scan_results.json
"""
import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

TIMEOUT = 60
# Live pages are read up to this cap. Anything larger is reported as an
# explicit skip rather than scanned partially: a truncated body matches no
# patterns and would otherwise be indistinguishable from a clean pass.
MAX_SCAN_BYTES = 20_000_000


def ci_run_url():
    """URL of the current GitHub Actions run, if we're running in one.
    This repo is public, so Actions run logs are publicly viewable — safe
    to link to directly. Returns None for a local/manual run, where no
    such log exists."""
    server = os.environ.get("GITHUB_SERVER_URL")
    repo = os.environ.get("GITHUB_REPOSITORY")
    run_id = os.environ.get("GITHUB_RUN_ID")
    if server and repo and run_id:
        return f"{server}/{repo}/actions/runs/{run_id}"
    return None


def is_safe_url(url: str):
    """Reject non-http(s) schemes and hosts that resolve to internal/private
    addresses, so a submitted url can't be used to probe the runner's local
    network or cloud metadata endpoints (SSRF)."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return False, f"unsupported scheme {parsed.scheme!r}"
    host = parsed.hostname
    if not host:
        return False, "no hostname"
    if host == "localhost" or host.endswith(".localhost"):
        return False, "localhost is not allowed"
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        return False, f"could not resolve host: {e}"
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return False, f"host resolves to a non-public address ({ip})"
    return True, ""


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-checks is_safe_url() on every redirect hop.

    urlopen() follows redirects by default, so validating only the submitted
    URL leaves the guard trivially bypassable: a public host can answer with
    a 302 to 169.254.169.254 (or any internal address) and the runner would
    follow it. Checking per-hop closes that.

    Residual risk, not closed here: this resolves the host to validate it and
    then reconnects by name, so a DNS record that changes between those two
    steps (rebinding) could still slip through. Closing that properly means
    pinning the connection to the validated IP, which urllib can't express
    without reimplementing TLS hostname verification.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        ok, why = is_safe_url(newurl)
        if not ok:
            raise urllib.error.URLError(f"blocked redirect to a disallowed address: {why}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def semgrep_counts(raw_json: str):
    """Splits semgrep findings into (blocking, informational).

    p/security-audit is explicitly a high-recall audit ruleset: it surfaces
    things for a human to look at, so a raw finding count is noise rather
    than a verdict (one entry in this catalog reports 502 of them). Only
    ERROR-severity findings that aren't explicitly low-confidence fail the
    check; the rest are reported alongside a passing result so they stay
    visible without sinking the score.
    """
    results = json.loads(raw_json).get("results", [])
    blocking = 0
    for r in results:
        extra = r.get("extra", {})
        severity = str(extra.get("severity", "")).upper()
        # Rules that don't declare a confidence are treated as MEDIUM, i.e.
        # counted — only an explicit LOW is discounted.
        confidence = str(extra.get("metadata", {}).get("confidence", "MEDIUM")).upper()
        if severity == "ERROR" and confidence != "LOW":
            blocking += 1
    return blocking, len(results) - blocking


def semgrep_check(check_id: str, label: str, raw_json: str, run_url):
    """Builds one semgrep check dict from that ruleset's raw JSON output."""
    try:
        blocking, informational = semgrep_counts(raw_json)
    except json.JSONDecodeError:
        return {"id": check_id, "label": label, "status": "skip", "detail": "scan did not complete"}

    link = f" — {run_url}" if run_url else ""
    if blocking:
        detail = f"{blocking} high-severity finding(s){link}"
    elif informational:
        detail = f"{informational} informational finding(s), none high-severity{link}"
    else:
        detail = ""
    return {
        "id": check_id,
        "label": label,
        "status": "fail" if blocking else "pass",
        "detail": detail,
    }


PATTERN_TESTS = [
    # (id, label, pattern, fail_detail)
    # Labels are neutral topic names, not pass/fail assertions \u2014 the icon
    # (pass/fail) plus fail_detail carry the verdict, so a failing row
    # reads as a plain statement ("eval() usage \u2014 eval() call found")
    # instead of a negated claim contradicting its own fail marker.
    ("pattern-eval", "eval() usage", r"\beval\s*\(",
     "eval() call found \u2014 needs manual review"),
    ("pattern-function", "Function() construction", r"new\s+Function\s*\(",
     "new Function() call found \u2014 needs manual review"),
    ("pattern-decode-exec", "decode\u2192eval chain", r"atob\s*\([^)]*\)\s*\)?\s*;?\s*eval",
     "atob()-to-eval() chain found \u2014 needs manual review"),
    ("pattern-dom-write", "document.write of decoded content", r"document\.write\s*\(\s*(?:unescape|atob|decodeURIComponent)",
     "decoded content passed to document.write() \u2014 needs manual review"),
    ("pattern-beacon", "sendBeacon usage", r"navigator\.sendBeacon\s*\(",
     "navigator.sendBeacon() call found \u2014 needs manual review"),
    ("pattern-dom-inject", "decoded content DOM injection", r"\.innerHTML\s*=\s*[^;]*(?:atob|decodeURIComponent)",
     "decoded content assigned to innerHTML \u2014 needs manual review"),
]


def run(cmd, cwd=None):
    """Returns (stdout, stderr) separately so callers that need to
    json.loads() a tool's stdout aren't broken by warning noise on stderr."""
    try:
        result = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=TIMEOUT
        )
        return result.stdout, result.stderr
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return "", f"[scan step failed: {e}]"


def scan_repo(repo: str):
    """Returns a list of check dicts: secrets + semgrep, run against the repo."""
    checks = []
    run_url = ci_run_url()
    with tempfile.TemporaryDirectory() as tmp:
        clone_stdout, clone_stderr = run(
            ["git", "clone", "--depth", "1", f"https://github.com/{repo}.git", tmp]
        )
        if not Path(tmp, ".git").exists():
            note = f"could not clone repo: {(clone_stdout + clone_stderr).strip()[:200]}"
            return [
                {"id": "secrets", "label": "No leaked credentials (detect-secrets)", "status": "skip", "detail": note},
                {"id": "semgrep-security", "label": "Semgrep security-audit ruleset", "status": "skip", "detail": note},
                {"id": "semgrep-js", "label": "Semgrep javascript ruleset", "status": "skip", "detail": note},
            ]

        secrets_out, _ = run(["detect-secrets", "scan", tmp])
        try:
            secrets_json = json.loads(secrets_out)
            n = len(secrets_json.get("results", {}))
            checks.append({
                "id": "secrets",
                "label": "No leaked credentials (detect-secrets)",
                "status": "pass" if n == 0 else "fail",
                "detail": "" if n == 0 else f"{n} file(s) flagged with possible credentials",
            })
        except json.JSONDecodeError:
            checks.append({"id": "secrets", "label": "No leaked credentials (detect-secrets)", "status": "skip", "detail": "scan did not complete"})

        semgrep_out, _ = run(
            ["semgrep", "--config", "p/security-audit", "--json", "--quiet", tmp]
        )
        checks.append(semgrep_check(
            "semgrep-security", "Semgrep security-audit ruleset", semgrep_out, run_url
        ))

        semgrep_js_out, _ = run(
            ["semgrep", "--config", "p/javascript", "--json", "--quiet", tmp]
        )
        checks.append(semgrep_check(
            "semgrep-js", "Semgrep javascript ruleset", semgrep_js_out, run_url
        ))

    return checks


def scan_url(url: str):
    """Returns a list of check dicts, one per pattern test in PATTERN_TESTS."""

    def all_skipped(note):
        return [{"id": pid, "label": label, "status": "skip", "detail": note}
                for pid, label, _, _ in PATTERN_TESTS]

    ok, why = is_safe_url(url)
    if not ok:
        return all_skipped(f"URL failed safety check: {why}")

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "sfwa-directory-bot"})
        opener = urllib.request.build_opener(SafeRedirectHandler)
        with opener.open(req, timeout=20) as resp:
            # One byte past the cap, so a body sitting exactly at it is still
            # distinguishable from one that was cut off.
            raw = resp.read(MAX_SCAN_BYTES + 1)
    except Exception as e:
        return all_skipped(f"could not fetch URL for scanning: {e}")

    if len(raw) > MAX_SCAN_BYTES:
        return all_skipped(
            f"page exceeds the {MAX_SCAN_BYTES // 1_000_000} MB scan limit — "
            "reported as unscanned rather than scanned partially"
        )

    body = raw.decode("utf-8", errors="ignore")

    checks = []
    for pid, label, pattern, fail_detail in PATTERN_TESTS:
        hit = re.search(pattern, body)
        checks.append({
            "id": pid,
            "label": label,
            "status": "fail" if hit else "pass",
            "detail": "" if not hit else fail_detail,
        })
    return checks


def main():
    if len(sys.argv) != 2:
        print("usage: security_scan.py <new_entries.json>", file=sys.stderr)
        sys.exit(1)

    with open(sys.argv[1]) as f:
        entries = json.load(f)

    report = []
    for entry in entries:
        checks = []
        if entry.get("repo"):
            checks += scan_repo(entry["repo"])
        else:
            # Explicit skips, not a silent omission — otherwise an entry
            # with no repo looks "fully audited" on 6 checks instead of
            # visibly incomplete on 9.
            note = "no repo set — nothing to clone"
            checks += [
                {"id": "secrets", "label": "No leaked credentials (detect-secrets)", "status": "skip", "detail": note},
                {"id": "semgrep-security", "label": "Semgrep security-audit ruleset", "status": "skip", "detail": note},
                {"id": "semgrep-js", "label": "Semgrep javascript ruleset", "status": "skip", "detail": note},
            ]
        checks += scan_url(entry["url"])

        report.append({
            "name": entry["name"],
            "url": entry["url"],
            "checks": checks,
        })

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
