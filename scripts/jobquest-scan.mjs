#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  JobQuest scheduled scan
//
//  Reads the saved search profile out of the Gist, asks the deployed
//  /api/scan endpoint for a segmented board, and writes the result back to
//  the Gist as its OWN files.
//
//  WHY IT WRITES A DIGEST RATHER THAN ADDING TO THE TRACKER:
//  jobquest.json sits around 442 KB against a ~942 KB write ceiling, and a
//  scan-added card with trimmed JD measures ~2.3 KB. Auto-adding ten roles a
//  day would exhaust the headroom in three weeks and sync would start
//  refusing to write. The digest is overwritten on every run, so it costs the
//  same few KB forever, and roles enter the tracker only when a human picks
//  them.
//
//  WHY IT READS THE PROFILE FROM THE GIST:
//  the slug lists and quotas already live there. Duplicating them into repo
//  secrets would mean two sources of truth and a silent drift the first time
//  a board is added in the app.
//
//  Env: JQ_GIST_TOKEN (gist scope), JQ_GIST_ID, JQ_SITE (optional)
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN = process.env.JQ_GIST_TOKEN;
const GIST_ID = process.env.JQ_GIST_ID;
const SITE = (process.env.JQ_SITE || 'https://jobquest.ryan-corcoran.com').replace(/\/+$/, '');
const DATA_FILE = process.env.JQ_DATA_FILE || 'jobquest.json';

if (!TOKEN || !GIST_ID) {
  console.error('Missing JQ_GIST_TOKEN or JQ_GIST_ID. Set both as repository secrets.');
  process.exit(1);
}

const GH = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'jobquest-scan',
};

async function readGist() {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: GH });
  if (!res.ok) {
    const hint = res.status === 401 ? ' — the token is invalid or expired'
               : res.status === 403 ? ' — the token is valid but lacks the gist scope'
               : res.status === 404 ? ' — wrong gist id, or the token cannot see it'
               : '';
    throw new Error(`Gist read failed: ${res.status}${hint}`);
  }
  const gist = await res.json();
  const file = gist.files?.[DATA_FILE];
  if (!file) {
    throw new Error(`Gist has no file named ${DATA_FILE}. Files present: ${Object.keys(gist.files || {}).join(', ') || 'none'}`);
  }
  // GitHub stops inlining content around 1 MB and sets truncated. Following
  // raw_url is the difference between reading the profile and silently
  // scanning with no boards at all.
  const text = file.truncated
    ? await (await fetch(file.raw_url, { headers: { 'User-Agent': 'jobquest-scan' } })).text()
    : file.content;
  return JSON.parse(text);
}

const csvLen = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean).length;

function slugParams(profile) {
  const map = {
    gh: profile.ghSlugs, lever: profile.leverSlugs, ashby: profile.ashbySlugs,
    sr: profile.srSlugs, workable: profile.workableSlugs, recruitee: profile.recruiteeSlugs,
  };
  const p = new URLSearchParams();
  let boards = 0;
  for (const [k, v] of Object.entries(map)) {
    const val = String(v || '').trim();
    if (val) { p.set(k, val); boards += csvLen(val); }
  }
  return { params: p, boards };
}

function markdown(scan, meta) {
  const when = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'short' });
  const out = [
    `# JobQuest scan — ${when} CT`,
    '',
    `${scan.scanned} postings read from ${meta.boards} boards · ${scan.classified} matched a segment · **${scan.total} of ${scan.cfg.topN} slots filled**`,
  ];
  const dead = (scan.sources || []).filter((s) => !s.ok);
  if (dead.length) {
    out.push('', `> ${dead.length} board${dead.length === 1 ? '' : 's'} did not respond: ${dead.map((d) => `${d.ats}/${d.slug}`).join(', ')}`);
  }
  for (const row of scan.result || []) {
    const g = row.seg;
    out.push('', `## ${g.key} · ${g.name} — ${row.picked.length}/${g.slots}${row.rolled ? ` (${row.rolled} rolled in)` : ''}`);
    if (row.short > 0 && !g.rollover) {
      out.push('', `> **${row.picked.length} of ${g.slots} slots filled, and the rest stay empty.** ` +
        (row.pool === 0
          ? 'Nothing on the saved boards matched. Add more Twin Cities companies with the probe in Sync.'
          : `Only ${row.pool} posting${row.pool === 1 ? '' : 's'} matched and the one-per-company cap allows ${Math.min(row.pool, g.slots)}.`));
    }
    if (!row.picked.length) { out.push('', '_Nothing this run._'); continue; }
    out.push('');
    for (const j of row.picked) {
      const bits = [j.location, j.salary, j.signals ? `${j.signals} product signals` : ''].filter(Boolean).join(' · ');
      out.push(`- **${j.company}** — ${j.url ? `[${j.role}](${j.url})` : j.role}  `);
      if (bits) out.push(`  ${bits}`);
    }
  }
  out.push('', '---', '', 'Nothing here is in the tracker. Open JobQuest and use **Run scan** to add what you want.');
  return out.join('\n');
}

async function writeGist(files) {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: { ...GH, 'content-type': 'application/json' },
    body: JSON.stringify({ files }),
  });
  if (!res.ok) throw new Error(`Gist write failed: ${res.status} ${await res.text()}`);
}

(async () => {
  const data = await readGist();
  // The app writes settings under prefs (SYNC_PREF_KEYS in index.html), not at
  // the top level. The fallbacks cover a hand-edited gist and the pre-prefs
  // payload shape.
  const profile = data.prefs?.profile || data.profile || {};
  const { params, boards } = slugParams(profile);

  if (!boards) {
    throw new Error('No board slugs in the saved profile. Open JobQuest → Sync → Job boards and add some, then sync before the next run.');
  }
  // Not written by the app. It is here so slot counts can be retuned by
  // editing the gist's profile object directly — "A:8,B:4,C:5,D:8" — without
  // redeploying the function.
  if (profile.scanSlots) params.set('slots', profile.scanSlots);
  params.set('limit', '300');
  params.set('jd', '6000');

  const url = `${SITE}/api/scan?${params}`;
  console.log(`Scanning ${boards} boards via ${SITE}/api/scan`);

  const res = await fetch(url, { headers: { 'User-Agent': 'jobquest-scan' } });
  if (!res.ok) {
    throw new Error(res.status === 404
      ? `${SITE}/api/scan returned 404 — functions/api/scan.js is not deployed.`
      : `Scan request failed: ${res.status}`);
  }
  const scan = await res.json();

  // Keep only what the digest needs. The full JD is what makes a card
  // expensive, and nobody reads it from a digest.
  const slim = {
    generatedAt: scan.generatedAt,
    scanned: scan.scanned, classified: scan.classified, total: scan.total, cfg: scan.cfg,
    sources: scan.sources,
    result: (scan.result || []).map((r) => ({
      seg: { key: r.seg.key, name: r.seg.name, slots: r.seg.slots, rollover: r.seg.rollover },
      pool: r.pool, short: r.short, rolled: r.rolled,
      picked: r.picked.map((j) => ({
        company: j.company, role: j.role, location: j.location,
        salary: j.salary, url: j.url, updatedAt: j.updatedAt, signals: j.signals,
      })),
    })),
  };

  await writeGist({
    'scan-digest.json': { content: JSON.stringify(slim, null, 2) },
    'scan-digest.md': { content: markdown({ ...slim, sources: scan.sources }, { boards }) },
  });

  const line = (slim.result || []).map((r) => `${r.seg.key} ${r.picked.length}/${r.seg.slots}`).join(' · ');
  console.log(`Wrote scan-digest.json and scan-digest.md — ${line}`);

  // Surface the result in the Actions run summary so a failure to fill a
  // segment is visible without opening the gist.
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### JobQuest scan\n\n${slim.total} of ${slim.cfg.topN} slots filled from ${slim.scanned} postings.\n\n${line}\n`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
