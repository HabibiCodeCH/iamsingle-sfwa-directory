# 07. Review Checklist

Use it before shipping. Use it again when reviewing somebody else's submission.

---

## 1. Conformance

- [ ] Exactly one file, no sibling assets required
- [ ] Opens and works when double-clicked from a folder containing only it
- [ ] Zero network requests during load (DevTools, cache disabled, offline)
- [ ] `sfwa:level` declared and **accurate**
- [ ] `sfwa:network` declared, and any hosts listed match observed behaviour
- [ ] Verification procedure from [00-spec §4](00-spec.md#4-verification-procedure) run against this exact build
- [ ] Level claim re-verified since the last dependency change

> The defect we see most often is a Level 1 claim on an artifact that loads a
> font, an analytics script or a CDN module. Check it with DevTools. Reading the
> code will not tell you.

---

## 2. Data safety

- [ ] Export produces a complete, documented, versioned file
- [ ] Importing that file restores state exactly
- [ ] Export from the previous release imports cleanly into this one
- [ ] `schema` integer present in every persisted shape
- [ ] Migration chain covers every shipped schema, tested end to end
- [ ] Corrupt or unparseable saved data quarantined, never deleted
- [ ] Destructive actions confirm, or auto-export first
- [ ] Save flushed on `visibilitychange` and `pagehide`
- [ ] Quota errors caught and surfaced to the user
- [ ] Storage failure degrades to a working in-memory app, with no crash

---

## 3. Security

- [ ] CSP present, placed before all governed content
- [ ] `connect-src` set to `'none'` or an explicit host allowlist
- [ ] `base-uri 'none'` and `form-action 'none'` set
- [ ] No `innerHTML` or `insertAdjacentHTML` with runtime-derived values
- [ ] No `eval`, `new Function` or string-argument `setTimeout`, or a written
      justification where they are unavoidable
- [ ] User-supplied URLs validated against a protocol allowlist
- [ ] Every subresource on `https://`
- [ ] Embedded state is `type="application/json"`, with `<` escaped
- [ ] No credentials in source, exports, logs or URLs
- [ ] Dependencies pinned, SRI on any remote subresource
- [ ] Sink audit (`grep` for network and eval primitives) clean and explained
- [ ] Dependency licences preserved in the artifact

---

## 4. Quality

- [ ] Renders something meaningful within a second on a mid-range phone
- [ ] Never white-screens; a global error handler shows a recoverable message
- [ ] Works at 360 px wide and at 2,000 px
- [ ] Fully keyboard operable, with visible focus rings throughout
- [ ] Labels on every control, `aria-label` where text is absent
- [ ] Contrast meets WCAG AA in both light and dark
- [ ] `prefers-reduced-motion` respected
- [ ] `<noscript>` explains what is required
- [ ] `lang` set on `<html>`
- [ ] Empty state tells a first-time user what to do
- [ ] In-app help exists, so the file is usable away from its repository
- [ ] Version and build date visible in the UI

---

## 5. Craft

- [ ] Under the size budget for its band ([03 §6](03-build-tooling.md#6-size-budgets))
- [ ] Source readable via `view-source:`, or readable source published
- [ ] Script sections banner-commented and ordered
- [ ] No function much over 50 lines
- [ ] Dependencies point one direction, with no circular references between
      sections
- [ ] One rendering strategy throughout
- [ ] Licence header at the top of the file
- [ ] Reproducible build documented and verified

---

## 6. Scoring rubric

For directories, competitions and internal review. Twenty points.

| Dimension | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| **Conformance** | Multi-file | Level 0, undeclared | Level 0, declared with SRI | Level 1 verified | Level 2+ verified |
| **Data safety** | No persistence | Storage only, no export | Export exists | Export + import + versioned schema | Migrations tested, corruption recovery |
| **Security** | No CSP, unsafe sinks | CSP present but permissive | CSP restrictive, no unsafe sinks | Plus pinned deps and a clean sink audit | Plus hash-based CSP and signed releases |
| **Usability** | Unusable without instructions | Works, rough edges | Good empty state and error handling | Plus full keyboard and a11y | Plus in-app help and polish |
| **Craft** | Unreadable | Works but disorganised | Clear structure | Structured, documented, tested | Reproducible, exemplary source |

**Bands.** 16–20: reference quality. 11–15: solid, publish it. 6–10: usable,
needs work. 0–5: not yet.

---

## 7. Automated pre-submission script

```bash
#!/usr/bin/env bash
set -uo pipefail
FILE="${1:-dist/index.html}"
fail=0
note()  { printf '  %s\n' "$*"; }
pass()  { printf '✓ %s\n' "$1"; }
bad()   { printf '✗ %s\n' "$1"; fail=1; }

# Run a check without letting a non-zero exit status abort the script.
check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$label"; else bad "$label"; fi
}

# Size
BYTES=$(wc -c < "$FILE")
printf 'Size: %s KB raw, %s KB gzip\n' "$((BYTES/1024))" "$(($(gzip -c "$FILE" | wc -c)/1024))"
check "under 1 MB" test "$BYTES" -lt 1048576

# Required metadata
check "declares sfwa:level"        grep -q 'sfwa:level' "$FILE"
check "declares sfwa:version"      grep -q 'sfwa:version' "$FILE"
check "has a CSP"                  grep -q 'Content-Security-Policy' "$FILE"
check "declares document language" grep -q '<html lang=' "$FILE"

# Level 1 heuristic: no fetched subresources
if grep -qE '<(script|link|img)[^>]+(src|href)=["'"'"']https?://' "$FILE"; then
  bad "no remote subresources (Level 1)"
  note "remote subresources found:"
  grep -oE '<(script|link|img)[^>]+(src|href)=["'"'"']https?://[^"'"'"']+' "$FILE" | sed 's/^/    /'
else
  pass "no remote subresources (Level 1)"
fi

# Mixed content gets blocked in the browser
if grep -qE '(src|href)=["'"'"']http://' "$FILE"; then
  bad "no insecure http:// subresources"
else
  pass "no insecure http:// subresources"
fi

# Credentials
if grep -qEi 'sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY' "$FILE"; then
  bad "no embedded credentials"
else
  pass "no embedded credentials"
fi

# Dangerous sinks: advisory, review each hit by hand
printf '\nSinks to review:\n'
grep -oE 'fetch\(|XMLHttpRequest|sendBeacon|new WebSocket|EventSource|new Function|eval\(|innerHTML' "$FILE" \
  | sort | uniq -c | sed 's/^/  /' || note "none"

printf '\n'
if [ "$fail" = 0 ]; then printf 'PASS\n'; else printf 'FAIL\n'; exit 1; fi
```

Save it as `scripts/check.sh` and run it in CI. Note the deliberate absence of
`-e` in that `set` line: every check here is expected to be able to fail, and
the script has to survive one failure long enough to report the rest.

The sink report stays advisory. `innerHTML` on a build-time constant is fine,
and [FuzzyGraph](https://iamsingle.app/entry/fuzzygraph) has to call `eval()`
because plotting user-entered equations is the entire app. Only a human can tell
those apart from the real thing.

---

## 8. Reviewer's fast path

Ten minutes, in this order. Stop at the first hard failure.

1. **`view-source:`.** Readable? Licence header? Does the metadata match the
   claim?
2. **Ctrl+F for `https://`.** Every hit should be a hyperlink somebody clicks.
3. **Open it offline**, with the network genuinely off. Does it work?
4. **DevTools Network, cache disabled, reload.** Requests for anything but the
   document should be zero.
5. **Enter data, export, clear storage, import.** Does the round trip hold?
6. **Tab through the whole interface.** Can you reach and operate everything?
7. **Resize to 360 px.** Still usable?
8. **Break it.** Paste `</script>`, `<img src=x onerror=alert(1)>` and a 10 MB
   string into the largest text field. Import malformed JSON. Corrupt the
   embedded state block. Nothing should execute and nothing should white-screen.
9. **Read the boot function.** Does it match the documented structure?
10. **Check the claim against reality one more time.** The declared level is the
    most consequential piece of metadata on the page and the one most often
    wrong.
