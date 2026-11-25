// Cloudflare Pages Function — aggregates public ATS job boards for JobQuest.
//
// The browser GETs /api/jobs (same origin, no CORS, no API keys). This function
// fans out to the public board APIs of Greenhouse, Lever, Ashby and Remotive in
// parallel, normalises every posting into one shape, and returns full job
// description text so the client can filter and score without a second fetch.
//
// Path convention: this file lives at  functions/api/jobs.js  →  /api/jobs
//
// Two modes:
//   /api/jobs?q=product&gh=lirio,hs&lever=...&ashby=...   → search for postings
//   /api/jobs?probe=Headspace                             → find a company's slug
//
// WHY PROBE EXISTS: ATS slugs are arbitrary and unguessable. Headspace is
// "hs". WellPower is "mentalhealthcenterofdenver" (a former name). A user
// typing the company name into a slug box gets nothing back and reasonably
// concludes there are no openings. Probe resolves a name to slugs that
// actually respond, so slug discovery stops being the user's problem.
//
// WHY EVERY RESPONSE CARRIES `sources`: a 404 from a wrong slug and a real
// board with zero openings are the same empty array. Swallowing per-source
// errors makes the single most common failure invisible, so each source
// reports its own status and the client can surface "lirio: ok (1)" next to
// "headspace: not found".

// Defaults only. The client sends limit / jd / timeout from the user's saved
// search settings, so these apply to a bare call. MAX_SLUGS_PER_ATS is not
// user-settable on purpose: it is an abuse guard on how much work one request
// can ask this function to do, not a search preference.
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_SLUGS_PER_ATS = 25;
const DEFAULT_JOBS_RETURNED = 120;
const DEFAULT_JD_CHARS = 6000;

// Clamp anything coming off a query string: a hand-edited URL should not be
// able to ask for a 10-minute timeout or a megabyte of JD text per posting.
function clampParam(raw, dflt, lo, hi) {
  // An absent param must fall back to the default, not clamp to the floor:
  // Number(null) is 0, not NaN, so testing Number.isFinite alone would turn a
  // missing ?limit into the minimum of 10 rather than 120.
  if (raw === null || raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt;
}

// Behavioral health, care navigation and digital health boards, which is where
// public-ATS coverage is actually good. Large medtech (Medtronic, Boston
// Scientific, Abbott, Stryker, Philips) runs on Workday and has no public board
// API, so it is not reachable here — keep using Adzuna for those.
// Verified against the live API: lirio, hs.
// Slug confirmed from a live board page, posting count unverified: the rest.
const DEFAULT_GH = 'lirio,hs,connectionshealthsolutions,daybreakhealth,cerulacare,mentalhealthcenterofdenver';
const DEFAULT_LEVER = '';
const DEFAULT_ASHBY = '';

export async function onRequestGet(context) {
  const { searchParams } = new URL(context.request.url);

  const probeName = (searchParams.get('probe') || '').trim();
  if (probeName) return probeCompanySlugs(probeName);

  const query = (searchParams.get('q') || '').toLowerCase().trim();
  const ghBoards = parseSlugs(searchParams.get('gh'), DEFAULT_GH);
  const leverBoards = parseSlugs(searchParams.get('lever'), DEFAULT_LEVER);
  const ashbyBoards = parseSlugs(searchParams.get('ashby'), DEFAULT_ASHBY);
  const srBoards = parseSlugs(searchParams.get('sr'), []);
  const workableBoards = parseSlugs(searchParams.get('workable'), []);
  const recruiteeBoards = parseSlugs(searchParams.get('recruitee'), []);
  const useRemotive = searchParams.get('remotive') !== '0';

  const cfg = {
    limit:   clampParam(searchParams.get('limit'),   DEFAULT_JOBS_RETURNED, 10, 300),
    jdChars: clampParam(searchParams.get('jd'),      DEFAULT_JD_CHARS,     500, 20000),
    timeout: clampParam(searchParams.get('timeout'), DEFAULT_TIMEOUT_MS,  2000, 20000),
  };

  const { jobs, sources } = await collectJobs({
    gh: ghBoards, lever: leverBoards, ashby: ashbyBoards,
    sr: srBoards, workable: workableBoards, recruitee: recruiteeBoards,
    remotive: useRemotive, query, cfg,
  });

  const okCount = sources.filter((s) => s.ok).length;
  const failed = sources.filter((s) => !s.ok);

  return json({
    count: jobs.length,
    truncated: jobs.length > cfg.limit,
    jobs: jobs.slice(0, cfg.limit),
    sources,
    summary: {
      sourcesQueried: sources.length,
      sourcesOk: okCount,
      sourcesFailed: failed.length,
      // Named explicitly so the client can show which slugs to fix.
      failedSlugs: failed.map((s) => `${s.ats}:${s.slug}`),
    },
  });
}

// ── SOURCE FETCHERS ───────────────────────────────────────────────────────────
// Each returns { source: {...status}, jobs: [...] } and never throws, so one
// bad slug cannot take down the whole search — but the failure is reported
// rather than silently folded into an empty result.

// Shared by /api/jobs and /api/scan. One place that knows how to read six
// boards, so the scheduled scan and the in-app search can never disagree
// about what is out there.
export async function collectJobs(opts = {}) {
  const cfg = opts.cfg || {};
  const query = (opts.query || '').toLowerCase().trim();
  const tasks = [
    ...(opts.gh || []).map((slug) => fetchGreenhouse(slug, cfg)),
    ...(opts.lever || []).map((slug) => fetchLever(slug, cfg)),
    ...(opts.ashby || []).map((slug) => fetchAshby(slug, cfg)),
    ...(opts.sr || []).map((slug) => fetchSmartRecruiters(slug, cfg)),
    ...(opts.workable || []).map((slug) => fetchWorkable(slug, cfg)),
    ...(opts.recruitee || []).map((slug) => fetchRecruitee(slug, cfg)),
  ];
  if (opts.remotive) tasks.push(fetchRemotive(query, cfg));

  const results = await Promise.all(tasks);
  const sources = results.map((r) => r.source);
  let jobs = dedupe(results.flatMap((r) => r.jobs));
  if (query) {
    jobs = jobs.filter((j) => `${j.role} ${j.company} ${j.location}`.toLowerCase().includes(query));
  }
  jobs.sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt));
  return { jobs, sources };
}

export { clampParam, parseSlugs };

async function fetchGreenhouse(slug, cfg = {}) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
  const r = await getJson(url, cfg.timeout);
  if (!r.ok) return { source: srcStatus('greenhouse', slug, r), jobs: [] };

  const jobs = (r.data?.jobs || []).map((j) => {
    const jdText = stripHtml(decodeEntities(j.content || '')).slice(0, cfg.jdChars || DEFAULT_JD_CHARS);
    return {
      id: `gh-${slug}-${j.id}`,
      source: 'Greenhouse',
      sourceSlug: slug,
      company: j.company_name || titleise(slug),
      role: j.title || '',
      location: j.location?.name || 'Unspecified',
      url: j.absolute_url || '',
      updatedAt: j.updated_at || j.first_published || null,
      salary: extractSalaryRange(jdText),
      jdText,
    };
  });
  return { source: srcStatus('greenhouse', slug, r, jobs.length), jobs };
}

async function fetchLever(slug, cfg = {}) {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
  const r = await getJson(url, cfg.timeout);
  if (!r.ok) return { source: srcStatus('lever', slug, r), jobs: [] };

  const list = Array.isArray(r.data) ? r.data : [];
  const jobs = list.map((j) => {
    const jdText = (j.descriptionPlain || stripHtml(j.description || '')).slice(0, cfg.jdChars || DEFAULT_JD_CHARS);
    return {
      id: `lv-${slug}-${j.id}`,
      source: 'Lever',
      sourceSlug: slug,
      company: titleise(slug),
      role: j.text || '',
      location: j.categories?.location || 'Unspecified',
      url: j.hostedUrl || '',
      updatedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      salary: formatLeverSalary(j) || extractSalaryRange(jdText),
      jdText,
    };
  });
  return { source: srcStatus('lever', slug, r, jobs.length), jobs };
}

async function fetchAshby(slug, cfg = {}) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`;
  const r = await getJson(url, cfg.timeout);
  if (!r.ok) return { source: srcStatus('ashby', slug, r), jobs: [] };

  const jobs = (r.data?.jobs || []).map((j) => {
    const jdText = stripHtml(decodeEntities(j.descriptionHtml || j.descriptionPlain || '')).slice(0, cfg.jdChars || DEFAULT_JD_CHARS);
    return {
      id: `ab-${slug}-${j.id}`,
      source: 'Ashby',
      sourceSlug: slug,
      company: j.organizationName || titleise(slug),
      role: j.title || '',
      location: j.location || (j.isRemote ? 'Remote' : 'Unspecified'),
      url: j.jobUrl || '',
      updatedAt: j.publishedAt || null,
      salary: j.compensationTierSummary || extractSalaryRange(jdText),
      jdText,
    };
  });
  return { source: srcStatus('ashby', slug, r, jobs.length), jobs };
}

// Mid-market employers, which is exactly the Twin Cities segment, skew away
// from Greenhouse/Lever/Ashby and toward these three. Workable and Recruitee
// return the job description in the same call, so they feed a JD-based filter
// directly. SmartRecruiters does not: its list endpoint carries titles only,
// so the description needs a second request per posting and is capped below.

async function fetchWorkable(slug, cfg = {}) {
  const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`;
  const r = await getJson(url, cfg.timeout);
  if (!r.ok) return { source: srcStatus('workable', slug, r), jobs: [] };

  const list = Array.isArray(r.data?.jobs) ? r.data.jobs : [];
  const jobs = list.map((j) => {
    const jdText = stripHtml(decodeEntities(
      [j.description, j.requirements, j.benefits].filter(Boolean).join(' ')
    )).slice(0, cfg.jdChars || DEFAULT_JD_CHARS);
    return {
      id: `wk-${slug}-${j.shortcode || j.id}`,
      source: 'Workable',
      sourceSlug: slug,
      company: r.data?.name || titleise(slug),
      role: j.title || '',
      location: [j.city, j.state, j.country].filter(Boolean).join(', ')
                || (j.telecommuting ? 'Remote' : 'Unspecified'),
      url: j.url || j.application_url || '',
      updatedAt: j.published_on || j.created_at || null,
      salary: extractSalaryRange(jdText),
      jdText,
    };
  });
  return { source: srcStatus('workable', slug, r, jobs.length), jobs };
}

async function fetchRecruitee(slug, cfg = {}) {
  const url = `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`;
  const r = await getJson(url, cfg.timeout);
  if (!r.ok) return { source: srcStatus('recruitee', slug, r), jobs: [] };

  const list = Array.isArray(r.data?.offers) ? r.data.offers : [];
  const jobs = list.map((j) => {
    const jdText = stripHtml(decodeEntities(
      [j.description, j.requirements].filter(Boolean).join(' ')
    )).slice(0, cfg.jdChars || DEFAULT_JD_CHARS);
    return {
      id: `rc-${slug}-${j.id}`,
      source: 'Recruitee',
      sourceSlug: slug,
      company: j.company_name || titleise(slug),
      role: j.title || '',
      location: [j.city, j.state_name, j.country_code].filter(Boolean).join(', ')
                || (j.remote ? 'Remote' : 'Unspecified'),
      url: j.careers_url || j.careers_apply_url || '',
      updatedAt: j.published_at || j.created_at || null,
      salary: (j.salary && j.salary.min)
        ? `${j.salary.min}-${j.salary.max} ${j.salary.currency || ''}`.trim()
        : extractSalaryRange(jdText),
      jdText,
    };
  });
  return { source: srcStatus('recruitee', slug, r, jobs.length), jobs };
}

// SmartRecruiters splits the board from the job ad, so a usable description
// costs one extra request per posting. Capped hard: a JD-filtered segment is
// worth the fan-out, an unbounded one is not.
const SR_DETAIL_CAP = 20;

async function fetchSmartRecruiters(slug, cfg = {}) {
  const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100`;
  const r = await getJson(url, cfg.timeout);
  if (!r.ok) return { source: srcStatus('smartrecruiters', slug, r), jobs: [] };

  const list = Array.isArray(r.data?.content) ? r.data.content : [];
  const base = list.map((j) => ({
    id: `sr-${slug}-${j.id}`,
    source: 'SmartRecruiters',
    sourceSlug: slug,
    company: j.company?.name || titleise(slug),
    role: j.name || '',
    location: [j.location?.city, j.location?.region, j.location?.country]
                .filter(Boolean).join(', ') || (j.location?.remote ? 'Remote' : 'Unspecified'),
    url: j.ref ? `https://jobs.smartrecruiters.com/${slug}/${j.id}` : '',
    updatedAt: j.releasedDate || null,
    salary: '',
    jdText: '',
    _srId: j.id,
  }));

  const details = await Promise.all(base.slice(0, SR_DETAIL_CAP).map(async (job) => {
    const d = await getJson(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings/${encodeURIComponent(job._srId)}`,
      cfg.timeout
    );
    if (!d.ok) return job;
    const secs = d.data?.jobAd?.sections || {};
    const text = ['companyDescription','jobDescription','qualifications','additionalInformation']
      .map((k) => secs[k]?.text || '').filter(Boolean).join(' ');
    const jdText = stripHtml(decodeEntities(text)).slice(0, cfg.jdChars || DEFAULT_JD_CHARS);
    return { ...job, jdText, salary: extractSalaryRange(jdText) };
  }));

  const jobs = [...details, ...base.slice(SR_DETAIL_CAP)].map(({ _srId, ...j }) => j);
  return { source: srcStatus('smartrecruiters', slug, r, jobs.length), jobs };
}

async function fetchRemotive(query, cfg = {}) {
  // Remotive's own page size follows the user's overall cap, bounded so a high
  // cap cannot turn one general feed into the bulk of the results.
  const n = Math.min(cfg.limit || 40, 100);
  const url = query
    ? `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}&limit=${n}`
    : `https://remotive.com/api/remote-jobs?limit=${n}`;
  const r = await getJson(url, cfg.timeout);
  if (!r.ok) return { source: srcStatus('remotive', '-', r), jobs: [] };

  const jobs = (r.data?.jobs || []).map((j) => {
    const jdText = stripHtml(decodeEntities(j.description || '')).slice(0, cfg.jdChars || DEFAULT_JD_CHARS);
    return {
      id: `rm-${j.id}`,
      source: 'Remotive',
      sourceSlug: '-',
      company: j.company_name || '',
      role: j.title || '',
      location: j.candidate_required_location || 'Remote',
      url: j.url || '',
      updatedAt: j.publication_date || null,
      salary: j.salary || extractSalaryRange(jdText),
      jdText,
    };
  });
  return { source: srcStatus('remotive', '-', r, jobs.length), jobs };
}

// ── SLUG PROBE ────────────────────────────────────────────────────────────────
// Derives plausible slugs from a company name and reports which ones resolve.
// Cheap HEAD-ish checks only: we ask each ATS for the board and keep the hits.

async function probeCompanySlugs(name) {
  const candidates = slugCandidates(name);
  const checks = [];

  for (const slug of candidates) {
    checks.push(probeOne('greenhouse', slug, `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`));
    checks.push(probeOne('lever', slug, `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`));
    checks.push(probeOne('ashby', slug, `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`));
    checks.push(probeOne('smartrecruiters', slug, `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=1`));
    checks.push(probeOne('workable', slug, `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}`));
    checks.push(probeOne('recruitee', slug, `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`));
  }

  const settled = await Promise.all(checks);
  const hits = settled.filter((x) => x.found);

  return json({
    probe: name,
    candidatesTried: candidates,
    hits,
    // An empty hits list is a real answer, not an error: the company very
    // likely runs Workday or Taleo, which have no public board API.
    note: hits.length
      ? 'Add the slug shown for each hit to the matching board list.'
      : 'No public board resolved on Greenhouse, Lever, Ashby, SmartRecruiters, Workable or Recruitee. This company most likely runs Workday, Taleo or iCIMS, none of which expose a public board API.',
  });
}

async function probeOne(ats, slug, url) {
  const r = await getJson(url);
  if (!r.ok) return { ats, slug, found: false, status: r.status };

  // A 200 is not proof of a board. Some hosts answer any path with a generic
  // body, so require the shape the ATS actually returns: a bare array (Lever)
  // or an object carrying a jobs array (Greenhouse, Ashby).
  const d = r.data;
  const isLeverShape = Array.isArray(d);                                   // Lever
  const isBoardShape = d && typeof d === 'object' && Array.isArray(d.jobs); // GH, Ashby, Workable
  const isSrShape    = d && typeof d === 'object' && Array.isArray(d.content);
  const isRcShape    = d && typeof d === 'object' && Array.isArray(d.offers);
  if (!isLeverShape && !isBoardShape && !isSrShape && !isRcShape) {
    return { ats, slug, found: false, status: r.status, error: 'responded but returned no job board' };
  }

  // SmartRecruiters is asked for one posting at probe time, so trust its own
  // totalFound rather than the length of the page it returned.
  const count = isLeverShape ? d.length
              : isBoardShape ? d.jobs.length
              : isSrShape    ? (Number(d.totalFound) || d.content.length)
              : d.offers.length;

  // Candidates now include short initials, which is how Headspace resolves at
  // "hs" — and also how a probe for Boston Scientific could land on some
  // unrelated company's board at "bs". Report whose board it actually is so a
  // wrong hit is obvious instead of being saved as if it were right.
  const name = (isBoardShape && (d.name || d.jobs[0]?.company_name || d.jobs[0]?.organizationName))
            || (isSrShape && d.content[0]?.company?.name)
            || (isRcShape && d.offers[0]?.company_name)
            || '';

  return { ats, slug, found: true, status: r.status, openings: count, company: name || undefined };
}

function slugCandidates(name) {
  const base = String(name || '').toLowerCase().trim();
  if (!base) return [];

  const alnum = base.replace(/[^a-z0-9]+/g, '');
  const hyphen = base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // Drop common corporate suffixes, which are rarely part of a slug.
  const stripped = base
    .replace(/\b(inc|corp|corporation|llc|ltd|co|company|group|holdings)\b\.?/g, '')
    .trim();
  const strippedAlnum = stripped.replace(/[^a-z0-9]+/g, '');
  // Many health companies drop a trailing "health"/"healthcare" in their slug.
  const noHealth = strippedAlnum.replace(/(health|healthcare|medical)$/, '');

  // Four candidates was too few. Real slugs seen in the wild include the
  // bare first word (Headspace is "hs"), the name with a corporate suffix
  // glued on, and "-inc"/"-hq"/"-careers" tails. Each extra candidate costs
  // one request per ATS and buys a company that would otherwise look like it
  // has no public board at all, which is the expensive mistake.
  const first = base.split(/[^a-z0-9]+/).filter(Boolean)[0] || '';
  const initials = base.split(/[^a-z0-9]+/).filter(Boolean).map((w) => w[0]).join('');
  const extras = [];
  for (const root of new Set([alnum, strippedAlnum, noHealth].filter(Boolean))) {
    extras.push(root + 'inc', root + 'hq', root + 'careers', root + 'jobs', root + '1');
  }
  if (hyphen) extras.push(hyphen + '-inc', hyphen + '-careers');

  return [...new Set(
    [alnum, hyphen, strippedAlnum, noHealth, first, initials, ...extras]
      .filter((x) => x && x.length >= 2)
  )].slice(0, 16);   // bound the fan-out: 16 candidates x 6 boards is already 96 requests
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

async function getJson(url, timeoutMs) {
  const ms = Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, status: res.status, data };
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      error: aborted ? `timed out after ${ms}ms` : `fetch failed: ${e?.message || 'unknown'}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function srcStatus(ats, slug, r, count = 0) {
  const s = { ats, slug, ok: Boolean(r.ok), status: r.status, count };
  if (!r.ok) {
    s.error = r.error || 'request failed';
    // 404 is the wrong-slug case and deserves its own label, since it is the
    // one the user can actually fix.
    s.hint = r.status === 404
      ? `No ${ats} board at "${slug}". Try /api/jobs?probe=<company name>.`
      : undefined;
  }
  return s;
}

function parseSlugs(raw, fallback) {
  const src = raw === null || raw === undefined ? fallback : raw;
  return [...new Set(
    String(src || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  )].slice(0, MAX_SLUGS_PER_ATS);
}

function dedupe(jobs) {
  const seen = new Set();
  const out = [];
  for (const j of jobs) {
    // Same posting can surface on a company board and on Remotive.
    const key = j.url
      ? j.url.split('?')[0].toLowerCase()
      : `${(j.company || '').toLowerCase()}|${(j.role || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(j);
  }
  return out;
}

function toTime(d) {
  const t = d ? new Date(d).getTime() : 0;
  return Number.isNaN(t) ? 0 : t;
}

function titleise(slug) {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function formatLeverSalary(j) {
  const r = j.salaryRange;
  if (!r || !r.min || !r.max) return '';
  const k = (n) => `$${Math.round(n / 1000)}K`;
  return `${k(r.min)}–${k(r.max)}`;
}

// Handles "$120,000 - $160,000", "$120k–160k", "120,000 to 160,000 USD".
function extractSalaryRange(text) {
  if (!text) return '';
  const m = text.match(
    /\$?\s?(\d{2,3})(?:,\d{3}|k|,000)\s*(?:-|–|—|to)\s*\$?\s?(\d{2,3})(?:,\d{3}|k|,000)/i
  );
  if (!m) return '';
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (!lo || !hi || hi < lo) return '';
  return `$${lo}K–$${hi}K`;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function stripHtml(html) {
  return String(html)
    // Keep paragraph and list breaks so the JD stays readable in a preview.
    .replace(/<\s*(br|\/p|\/li|\/div|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: {
      'Content-Type': 'application/json',
      // Short edge cache: repeated searches within a minute cost nothing,
      // and board listings do not change faster than that.
      'cache-control': 'public, max-age=60',
    },
  });
}

// Friendly response for anything that isn't a GET.
export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  return json({
    ok: true,
    message: 'JobQuest board aggregator is live. GET /api/jobs?q=&gh=&lever=&ashby=, or /api/jobs?probe=<company name>.',
  });
}
