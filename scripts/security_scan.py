#!/usr/bin/env python3
"""
Best-effort security pass over newly submitted directory entries.
This is a heuristic first filter for human reviewers, NOT a guarantee
that an entry is free of malicious code. It:

  1. Shallow-clones the entry's GitHub repo (if given) and runs:
       - detect-secrets  (leaked credentials / tokens)
       - semgrep p/security-audit + p/javascript  (dangerous patterns)
  2. Fetches the entry's live URL and runs it through a fixed set of
     pattern tests (eval/Function on dynamic data, decode-then-exec
     chains, decoded content written into the DOM, etc). Every test is
     reported individually as pass/fail/skip so results can be shown
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
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

TIMEOUT = 60


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


PATTERN_TESTS = [
    ("pattern-eval", "No eval() on dynamic content", r"\beval\s*\("),
    ("pattern-function", "No dynamic Function() construction", r"new\s+Function\s*\("),
    ("pattern-decode-exec", "No decode\u2192eval chain", r"atob\s*\([^)]*\)\s*\)?\s*;?\s*eval"),
    ("pattern-dom-write", "No decoded content written via document.write", r"document\.write\s*\(\s*(?:unescape|atob|decodeURIComponent)"),
    ("pattern-beacon", "No sendBeacon calls", r"navigator\.sendBeacon\s*\("),
    ("pattern-dom-inject", "No decoded content injected into the DOM", r"\.innerHTML\s*=\s*[^;]*(?:atob|decodeURIComponent)"),
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
        try:
            n = len(json.loads(semgrep_out).get("results", []))
            checks.append({
                "id": "semgrep-security",
                "label": "Semgrep security-audit ruleset",
                "status": "pass" if n == 0 else "fail",
                "detail": "" if n == 0 else (f"{n} finding(s) — {run_url}" if run_url else f"{n} finding(s)"),
            })
        except json.JSONDecodeError:
            checks.append({"id": "semgrep-security", "label": "Semgrep security-audit ruleset", "status": "skip", "detail": "scan did not complete"})

        semgrep_js_out, _ = run(
            ["semgrep", "--config", "p/javascript", "--json", "--quiet", tmp]
        )
        try:
            n = len(json.loads(semgrep_js_out).get("results", []))
            checks.append({
                "id": "semgrep-js",
                "label": "Semgrep javascript ruleset",
                "status": "pass" if n == 0 else "fail",
                "detail": "" if n == 0 else (f"{n} finding(s) — {run_url}" if run_url else f"{n} finding(s)"),
            })
        except json.JSONDecodeError:
            checks.append({"id": "semgrep-js", "label": "Semgrep javascript ruleset", "status": "skip", "detail": "scan did not complete"})

    return checks


def scan_url(url: str):
    """Returns a list of check dicts, one per pattern test in PATTERN_TESTS."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "sfwa-directory-bot"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read(2_000_000).decode("utf-8", errors="ignore")
    except Exception as e:
        note = f"could not fetch URL for scanning: {e}"
        return [{"id": pid, "label": label, "status": "skip", "detail": note} for pid, label, _ in PATTERN_TESTS]

    checks = []
    for pid, label, pattern in PATTERN_TESTS:
        hit = re.search(pattern, body)
        checks.append({
            "id": pid,
            "label": label,
            "status": "fail" if hit else "pass",
            "detail": "" if not hit else "pattern matched — needs manual review",
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
