// Vercel serverless function: POST /api/submit
//
// Replaces the old "open a pre-filled GitHub issue" flow. Validates the
// submission, then opens a PR against data/entries.json via the GitHub API.
// The security_scan.py checks (repo clone, semgrep, detect-secrets) run
// separately via the maintainer-triggered review-submission.yml workflow —
// too slow/heavy for a synchronous request here.
//
// Required env vars (set in the Vercel project, not committed):
//   GITHUB_BOT_TOKEN   fine-grained PAT scoped to this one repo only,
//                      permissions: Contents (write), Pull requests (write)
//
// Known gap: no persistent rate limiting (would need e.g. Vercel KV /
// Upstash). The honeypot field + GitHub's own abuse detection + manual PR
// review are the only anti-spam measures for now.

const OWNER = "HabibiCodeCH";
const REPO = "iamsingle-sfwa-directory";
const BASE_BRANCH = "main";
const VALID_TAGS = ["notes", "slides", "tools", "ai", "games", "collab"];
const GITHUB_API = "https://api.github.com";
const DAILY_SUBMISSION_CAP = 100;

function ghHeaders(token, extra) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(extra || {}),
  };
}

function slugify(s) {
  return (
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "entry"
  );
}

function validate(body) {
  const errors = [];
  const name = String(body.name || "").trim().slice(0, 100);
  const url = String(body.url || "").trim();
  const repo = String(body.repo || "").trim();
  const desc = String(body.desc || "").trim().slice(0, 500);
  const tagsRaw = String(body.tags || "").trim();

  if (!name) errors.push("name is required");
  if (!/^https?:\/\/.+/i.test(url)) errors.push("url must be http(s)");
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) errors.push("repo must look like owner/name");
  if (!desc) errors.push("desc is required");

  const tags = tagsRaw
    ? tagsRaw.split(",").map((t) => t.trim().toLowerCase()).filter((t) => VALID_TAGS.includes(t))
    : [];

  if (errors.length) return { errors };
  return { entry: { name, url, repo: repo || null, desc, tags } };
}

async function ghJson(url, token, init) {
  const res = await fetch(url, { ...(init || {}), headers: ghHeaders(token, (init || {}).headers) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} on ${url}: ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

// Uses GitHub's own PR history as the counter — no extra infra. Caps both
// Anthropic spend and PR/branch spam from repeated submissions. Not a
// substitute for a hard spend cap in the Anthropic Console (a bug here
// shouldn't be the only thing standing between a bad actor and the bill).
async function submissionsInLast24h(token) {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const prs = await ghJson(
    `${GITHUB_API}/repos/${OWNER}/${REPO}/pulls?state=all&per_page=100&sort=created&direction=desc`,
    token
  );
  return prs.filter((pr) => pr.head.ref.startsWith("submit/") && new Date(pr.created_at).getTime() > since).length;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, errors: ["POST only"] });
    return;
  }

  const body = req.body || {};

  if (body.hp) {
    // honeypot tripped — pretend success, do nothing further
    res.status(200).json({ ok: true });
    return;
  }

  const { entry, errors } = validate(body);
  if (errors) {
    res.status(400).json({ ok: false, errors });
    return;
  }

  const token = process.env.GITHUB_BOT_TOKEN;
  if (!token) {
    res.status(503).json({ ok: false, errors: ["submission pipeline not configured (GITHUB_BOT_TOKEN unset)"] });
    return;
  }

  try {
    const recentCount = await submissionsInLast24h(token);
    if (recentCount >= DAILY_SUBMISSION_CAP) {
      res.status(429).json({
        ok: false,
        errors: [`Too many submissions in the last 24h (limit: ${DAILY_SUBMISSION_CAP}). Try again later, or file it manually as an issue.`],
      });
      return;
    }

    const entriesFile = await ghJson(
      `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/data/entries.json?ref=${BASE_BRANCH}`,
      token
    );
    const currentEntries = JSON.parse(Buffer.from(entriesFile.content, "base64").toString("utf-8"));

    if (currentEntries.some((e) => e.url === entry.url)) {
      res.status(409).json({ ok: false, errors: ["an entry with this url already exists"] });
      return;
    }

    const baseRef = await ghJson(`${GITHUB_API}/repos/${OWNER}/${REPO}/git/ref/heads/${BASE_BRANCH}`, token);
    const branch = `submit/${slugify(entry.name)}-${Date.now()}`;
    await ghJson(`${GITHUB_API}/repos/${OWNER}/${REPO}/git/refs`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha }),
    });

    const updated = [...currentEntries, entry];
    await ghJson(`${GITHUB_API}/repos/${OWNER}/${REPO}/contents/data/entries.json`, token, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Add entry: ${entry.name}`,
        content: Buffer.from(JSON.stringify(updated, null, 2) + "\n").toString("base64"),
        sha: entriesFile.sha,
        branch,
      }),
    });

    const pr = await ghJson(`${GITHUB_API}/repos/${OWNER}/${REPO}/pulls`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `Submission: ${entry.name}`,
        head: branch,
        base: BASE_BRANCH,
        body:
          `Auto-opened from the site's submission form.\n\n` +
          `**URL**: ${entry.url}\n` +
          (entry.repo ? `**GitHub repo**: ${entry.repo}\n` : "") +
          `**Description**: ${entry.desc}\n` +
          (entry.tags.length ? `**Tags**: ${entry.tags.join(", ")}\n` : "") +
          `\nA maintainer still needs to manually run "Review submission" (Actions tab) for the full security scan before merging.`,
      }),
    });

    res.status(200).json({ ok: true, prUrl: pr.html_url });
  } catch (e) {
    res.status(502).json({ ok: false, errors: [String((e && e.message) || e)] });
  }
}
