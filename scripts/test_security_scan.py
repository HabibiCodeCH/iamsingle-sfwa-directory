#!/usr/bin/env python3
"""Tests for security_scan.py — stdlib unittest only, no extra CI deps.

Run: python3 scripts/test_security_scan.py

Covers the three things most likely to silently regress into a false "pass":
the SSRF guard actually being wired into scan_url(), oversized pages being
skipped instead of partially scanned, and semgrep's high-recall audit output
being filtered by severity rather than counted raw.
"""
import http.server
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import security_scan as ss  # noqa: E402


def semgrep_json(*findings):
    """Builds a semgrep-shaped JSON string from (severity, confidence) pairs.
    confidence=None omits the metadata key entirely, as some rules do."""
    results = []
    for severity, confidence in findings:
        extra = {"severity": severity, "metadata": {}}
        if confidence is not None:
            extra["metadata"]["confidence"] = confidence
        results.append({"check_id": "x", "extra": extra})
    return '{"results": ' + str(results).replace("'", '"') + "}"


class TestSemgrepCounts(unittest.TestCase):
    def test_error_severity_counts_as_blocking(self):
        self.assertEqual(ss.semgrep_counts(semgrep_json(("ERROR", "HIGH"))), (1, 0))

    def test_low_confidence_error_is_informational(self):
        self.assertEqual(ss.semgrep_counts(semgrep_json(("ERROR", "LOW"))), (0, 1))

    def test_non_error_severity_is_informational(self):
        self.assertEqual(
            ss.semgrep_counts(semgrep_json(("WARNING", "HIGH"), ("INFO", "HIGH"))),
            (0, 2),
        )

    def test_missing_confidence_is_treated_as_blocking(self):
        # Only an explicit LOW is discounted; an absent value must not
        # silently downgrade a high-severity finding.
        self.assertEqual(ss.semgrep_counts(semgrep_json(("ERROR", None))), (1, 0))

    def test_mixed_haul(self):
        raw = semgrep_json(
            ("ERROR", "HIGH"), ("ERROR", "LOW"), ("WARNING", "HIGH"), ("ERROR", "MEDIUM")
        )
        self.assertEqual(ss.semgrep_counts(raw), (2, 2))

    def test_empty(self):
        self.assertEqual(ss.semgrep_counts('{"results": []}'), (0, 0))


class TestSemgrepCheck(unittest.TestCase):
    def test_blocking_finding_fails(self):
        c = ss.semgrep_check("semgrep-security", "L", semgrep_json(("ERROR", "HIGH")), None)
        self.assertEqual(c["status"], "fail")
        self.assertIn("1 high-severity", c["detail"])

    def test_informational_only_passes_but_is_disclosed(self):
        # The old behaviour failed this outright; the count still has to be
        # visible so a 502-finding entry isn't presented as spotless.
        c = ss.semgrep_check("semgrep-security", "L", semgrep_json(("WARNING", "HIGH")), None)
        self.assertEqual(c["status"], "pass")
        self.assertIn("1 informational", c["detail"])

    def test_clean_passes_with_no_detail(self):
        c = ss.semgrep_check("semgrep-security", "L", '{"results": []}', None)
        self.assertEqual(c["status"], "pass")
        self.assertEqual(c["detail"], "")

    def test_unparseable_output_skips_rather_than_passes(self):
        c = ss.semgrep_check("semgrep-security", "L", "boom not json", None)
        self.assertEqual(c["status"], "skip")

    def test_run_url_is_appended_when_present(self):
        c = ss.semgrep_check("x", "L", semgrep_json(("ERROR", "HIGH")), "https://ci.example/run/1")
        self.assertIn("https://ci.example/run/1", c["detail"])


class TestIsSafeUrl(unittest.TestCase):
    def test_rejects_non_http_scheme(self):
        self.assertFalse(ss.is_safe_url("file:///etc/passwd")[0])

    def test_rejects_localhost(self):
        self.assertFalse(ss.is_safe_url("http://localhost/")[0])

    def test_rejects_loopback_literal(self):
        self.assertFalse(ss.is_safe_url("http://127.0.0.1/")[0])

    def test_rejects_cloud_metadata_address(self):
        self.assertFalse(ss.is_safe_url("http://169.254.169.254/latest/meta-data/")[0])

    def test_rejects_private_range(self):
        self.assertFalse(ss.is_safe_url("http://10.0.0.5/")[0])


class TestSafeRedirectHandler(unittest.TestCase):
    def test_blocks_redirect_to_internal_address(self):
        handler = ss.SafeRedirectHandler()
        with self.assertRaises(ss.urllib.error.URLError):
            handler.redirect_request(
                mock.Mock(), mock.Mock(), 302, "Found", {}, "http://169.254.169.254/"
            )

    def test_allows_redirect_to_public_address(self):
        handler = ss.SafeRedirectHandler()
        with mock.patch.object(ss, "is_safe_url", return_value=(True, "")):
            with mock.patch.object(
                ss.urllib.request.HTTPRedirectHandler, "redirect_request", return_value="ok"
            ):
                self.assertEqual(
                    handler.redirect_request(
                        mock.Mock(), mock.Mock(), 302, "Found", {}, "https://example.com/"
                    ),
                    "ok",
                )


class TestScanUrlGuard(unittest.TestCase):
    def test_unsafe_url_is_skipped_without_fetching(self):
        with mock.patch.object(ss.urllib.request, "build_opener") as opener:
            checks = ss.scan_url("http://169.254.169.254/")
        opener.assert_not_called()  # the guard must short-circuit before any request
        self.assertTrue(checks)
        self.assertTrue(all(c["status"] == "skip" for c in checks))
        self.assertIn("failed safety check", checks[0]["detail"])


class _Body(http.server.BaseHTTPRequestHandler):
    payload = b""

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(self.payload)

    def log_message(self, *a):
        pass


class TestScanUrlSizeCap(unittest.TestCase):
    """The regression that mattered: a body cut off at the cap matches no
    pattern, so truncation used to be reported as a clean pass."""

    def setUp(self):
        # The padding is separated from the payload: \beval\s*\( requires a
        # word boundary, so "xxxeval(" would (correctly) not match and the
        # test would be asserting the wrong thing.
        _Body.payload = b"<html><script>" + b"x " * 2500 + b"; eval(1)</script></html>"
        self.server = http.server.HTTPServer(("127.0.0.1", 0), _Body)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/"
        # Loopback is (correctly) rejected by the guard, so bypass just the
        # guard here to exercise the size logic itself.
        self.guard = mock.patch.object(ss, "is_safe_url", return_value=(True, ""))
        self.guard.start()

    def tearDown(self):
        self.guard.stop()
        self.server.shutdown()
        self.server.server_close()

    def test_oversized_body_skips_instead_of_passing(self):
        with mock.patch.object(ss, "MAX_SCAN_BYTES", 1000):
            checks = ss.scan_url(self.url)
        self.assertTrue(all(c["status"] == "skip" for c in checks))
        self.assertIn("exceeds", checks[0]["detail"])

    def test_body_within_cap_is_actually_scanned(self):
        with mock.patch.object(ss, "MAX_SCAN_BYTES", 100_000):
            checks = ss.scan_url(self.url)
        by_id = {c["id"]: c for c in checks}
        self.assertEqual(by_id["pattern-eval"]["status"], "fail")
        self.assertEqual(by_id["pattern-beacon"]["status"], "pass")


if __name__ == "__main__":
    unittest.main(verbosity=2)
