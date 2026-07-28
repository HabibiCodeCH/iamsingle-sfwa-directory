// Vercel serverless function: POST /api/recheck  { slug }
//
// Backs the "I fixed it" button on an entry page. It opens a PR that DELETES
// that entry's cached measurement from data/network.json — it never writes a
// verdict.
//
// That distinction is the whole point. If this endpoint could set an entry's
// status, the "certified sfwa" badge would be self-declared and worth
// nothing. Instead the PR only invalidates the cache; merging it makes
// build-pages.yml re-run scripts/screenshot.mjs, which re-measures the live
// app and writes whatever is actually true. Claiming a fix you didn't make
// therefore achieves nothing: the re-measurement just restores the same
// verdict.
//
// Required env vars (set in the Vercel project, not committed):
//   GITHUB_BOT_TOKEN   fine-grained PAT scoped to this one repo only,
//                      permissions: Contents (write), Pull requests (write)
//   — the same token api/submit.js already uses; nothing new to configure.
//
// Same known gap as api/submit.js: no persistent rate limiting. The PR-count
// cap below plus GitHub's own abuse detection are the only throttles. The
// blast radius of abuse is PR spam rather than bad data, since this endpoint
// structurally cannot write a verdict.

const OWNER = "HabibiCodeCH";
const REPO = "iamsingle-sfwa-directory";
const BASE_BRANCH = "main";
const GITHUB_API = "https://api.github.com";
const NETWORK_PATH = "data/network.json";
const FIXES_PATH = "data/fixes.json";
const DAILY_RECHECK_CAP = 50;

function ghHeaders(token, extra) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(extra || {}),
  };
}

async function ghJson(url, token, init) {
  const res = await fetch(url, { ...(init || {}), headers: ghHeaders(token, (init || {}).headers) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} on ${url}: ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function rechecksInLast24h(token) {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const prs = await ghJson(
    `${GITHUB_API}/repos/${OWNER}/${REPO}/pulls?state=all&per_page=100&sort=created&direction=desc`,
    token
  );
  return prs.filter((pr) => pr.head.ref.startsWith("recheck/") && new Date(pr.created_at).getTime() > since).length;
}


// Accepts a commit URL, a PR URL, or a bare sha (resolved against the entry's
// own repo). Anything else is reported back rather than silently ignored.
function parseFixRef(input, entryRepo) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  let m = raw.match(/^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/commit\/([0-9a-f]{7,40})/i);
  if (m) return { repo: m[1], kind: "commit", ref: m[2] };
  m = raw.match(/^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i);
  if (m) return { repo: m[1], kind: "pull", ref: m[2] };
  if (/^[0-9a-f]{7,40}$/i.test(raw) && entryRepo) return { repo: entryRepo, kind: "commit", ref: raw };
  return { invalid: true, raw: raw.slice(0, 120) };
}

// Turns the cited commit into evidence. This is what makes crediting safe
// without OAuth: the author comes from GitHub's record of the commit, not
// from what the visitor typed. Citing someone else's commit therefore
// credits that someone else — the person who actually did the work.
async function verifyFix(ref, entryRepo, token) {
  if (!ref) return { state: "none" };
  if (ref.invalid) return { state: "unparseable", raw: ref.raw };
  if (entryRepo && ref.repo.toLowerCase() !== entryRepo.toLowerCase()) {
    return { state: "wrong-repo", repo: ref.repo, expected: entryRepo };
  }
  try {
    if (ref.kind === "commit") {
      const c = await ghJson(`${GITHUB_API}/repos/${ref.repo}/commits/${ref.ref}`, token);
      return {
        state: "ok", kind: "commit", url: c.html_url, sha: String(c.sha || "").slice(0, 7),
        author: (c.author && c.author.login) || null,
        message: String((c.commit && c.commit.message) || "").split("\n")[0].slice(0, 120),
      };
    }
    const pr = await ghJson(`${GITHUB_API}/repos/${ref.repo}/pulls/${ref.ref}`, token);
    if (!pr.merged_at) return { state: "not-merged", url: pr.html_url };
    return {
      state: "ok", kind: "pull", url: pr.html_url,
      sha: String(pr.merge_commit_sha || "").slice(0, 7),
      author: (pr.user && pr.user.login) || null,
      message: String(pr.title || "").slice(0, 120),
    };
  } catch (e) {
    return { state: "not-found" };
  }
}


// Renders the "where the fix landed" block for the PR body, and the
// Co-authored-by trailer — but only when GitHub itself confirmed who wrote
// the commit. An unverified claim gets a warning instead of a trailer.
function fixSection(fix) {
  const lines = ["\n\n---\n"];
  if (fix.state === "ok") {
    const who = fix.author ? `@${fix.author}` : "an unknown author";
    lines.push(`**Fix referenced**: ${fix.url}`);
    lines.push(`> ${fix.message}`);
    lines.push("");
    lines.push(`GitHub records that ${fix.kind} as authored by ${who}${fix.sha ? ` (\`${fix.sha}\`)` : ""}.`);
    if (fix.author) {
      lines.push("");
      lines.push("If the re-check confirms the fix, add this to the merge commit message to credit them officially:");
      lines.push("");
      lines.push("```");
      lines.push(`Co-authored-by: ${fix.author} <${fix.author}@users.noreply.github.com>`);
      lines.push("```");
    }
  } else if (fix.state === "wrong-repo") {
    lines.push(`⚠️ **Unverified.** The referenced commit is in \`${fix.repo}\`, but this entry's repo is \`${fix.expected}\`. No co-author credit.`);
  } else if (fix.state === "not-merged") {
    lines.push(`⚠️ **Unverified.** ${fix.url} is not merged yet. No co-author credit.`);
  } else if (fix.state === "not-found") {
    lines.push("⚠️ **Unverified.** The referenced commit couldn't be found. No co-author credit.");
  } else if (fix.state === "unparseable") {
    lines.push(`⚠️ **Unverified.** Couldn't read \`${fix.raw}\` as a commit or PR URL. No co-author credit.`);
  } else {
    lines.push("_No commit was referenced, so there's nothing to verify and no co-author credit._");
  }
  return lines.join("\n");
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

  // Slugs are produced by slugify() elsewhere, so anything outside this shape
  // can't match a real entry and isn't worth a GitHub round trip.
  const slug = String(body.slug || "").trim();
  if (!/^[a-z0-9-]{1,40}$/.test(slug)) {
    res.status(400).json({ ok: false, errors: ["invalid slug"] });
    return;
  }

  const token = process.env.GITHUB_BOT_TOKEN;
  if (!token) {
    res.status(503).json({ ok: false, errors: ["recheck pipeline not configured (GITHUB_BOT_TOKEN unset)"] });
    return;
  }

  try {
    if ((await rechecksInLast24h(token)) >= DAILY_RECHECK_CAP) {
      res.status(429).json({
        ok: false,
        errors: [`Too many recheck requests in the last 24h (limit: ${DAILY_RECHECK_CAP}). Try again later.`],
      });
      return;
    }

    const networkFile = await ghJson(
      `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${NETWORK_PATH}?ref=${BASE_BRANCH}`,
      token
    );
    const network = JSON.parse(Buffer.from(networkFile.content, "base64").toString("utf-8"));

    // The entry's own repo — a cited commit has to live there, otherwise
    // anyone could point at an unrelated repo's commit as "proof".
    const entriesFile = await ghJson(
      `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/data/entries.json?ref=${BASE_BRANCH}`,
      token
    );
    const entries = JSON.parse(Buffer.from(entriesFile.content, "base64").toString("utf-8"));
    const slugify = (x) => (x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "entry");
    const entry = entries.find((e) => slugify(e.name) === slug);
    const entryRepo = entry && entry.repo ? entry.repo : null;

    const fix = await verifyFix(parseFixRef(body.commit, entryRepo), entryRepo, token);

    if (!(slug in network)) {
      // Already absent means it's queued for measurement anyway — a no-op
      // success, not an error the visitor could act on.
      res.status(200).json({ ok: true, alreadyPending: true });
      return;
    }

    const before = network[slug];
    delete network[slug];

    const baseRef = await ghJson(`${GITHUB_API}/repos/${OWNER}/${REPO}/git/ref/heads/${BASE_BRANCH}`, token);
    const branch = `recheck/${slug}-${Date.now()}`;
    await ghJson(`${GITHUB_API}/repos/${OWNER}/${REPO}/git/refs`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha }),
    });

    await ghJson(`${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${NETWORK_PATH}`, token, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Recheck requested: ${slug}`,
        content: Buffer.from(JSON.stringify(network, null, 2) + "\n").toString("base64"),
        sha: networkFile.sha,
        branch,
      }),
    });

    // Only a GitHub-confirmed fix is recorded. This file survives the
    // re-measurement (screenshot.mjs only rewrites network.json), so the
    // credit persists once the entry actually turns certified.
    if (fix.state === "ok" && fix.author) {
      let fixes = {}, fixesSha;
      try {
        const f = await ghJson(`${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${FIXES_PATH}?ref=${BASE_BRANCH}`, token);
        fixes = JSON.parse(Buffer.from(f.content, "base64").toString("utf-8"));
        fixesSha = f.sha;
      } catch (e) {
        // file doesn't exist yet — created fresh below
      }
      fixes[slug] = {
        by: fix.author,
        url: fix.url,
        sha: fix.sha || null,
        date: new Date().toISOString().slice(0, 10),
      };
      await ghJson(`${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${FIXES_PATH}`, token, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `Record fix credit: ${slug} (@${fix.author})`,
          content: Buffer.from(JSON.stringify(fixes, null, 2) + "\n").toString("base64"),
          ...(fixesSha ? { sha: fixesSha } : {}),
          branch,
        }),
      });
    }

    const previously = before.selfContained
      ? "certified"
      : `${(before.codeDeps || []).length} external file(s)`;
    const pr = await ghJson(`${GITHUB_API}/repos/${OWNER}/${REPO}/pulls`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `Recheck: ${slug}`,
        head: branch,
        base: BASE_BRANCH,
        body:
          (fix.state === "ok" && fix.author
            ? `**${slug}** has been reported fixed, via the "I fixed it" button. GitHub records the referenced fix as authored by @${fix.author}.\n\n`
            : `**${slug}** has been reported fixed, via the "I fixed it" button.\n\n`) +
          "This PR only clears that entry's cached measurement — it asserts nothing. " +
          "Merging it makes `build-pages.yml` re-run `scripts/screenshot.mjs`, which " +
          "re-measures the live app from scratch (network profile, file size, " +
          "screenshot, OG card, QR eligibility) and writes whatever is actually true.\n\n" +
          `**Last measurement**: ${previously}\n` +
          `**Measured from**: ${before.measured || "n/a"}\n\n` +
          "If the app wasn't really fixed, the re-measurement simply restores the same verdict." +
          fixSection(fix),
      }),
    });

    res.status(200).json({ ok: true, prUrl: pr.html_url });
  } catch (e) {
    res.status(502).json({ ok: false, errors: [String((e && e.message) || e)] });
  }
}
