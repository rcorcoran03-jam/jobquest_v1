// ─────────────────────────────────────────────────────────────────────────────
//  /api/scan — the segmented scan, server side
//
//  GET /api/scan?gh=…&lever=…&ashby=…&sr=…&workable=…&recruitee=…
//      [&slots=A:8,B:4,C:5,D:8] [&jd=6000] [&timeout=8000] [&limit=300]
//
//  WHY THIS IS NOT IN THE PAGE: the scheduled GitHub Action cannot read the
//  logic out of index.html, so a scan running on a cron and a scan running in
//  the browser would be two implementations of the same rules. They would
//  agree on the day they were written and quietly diverge after that, and the
//  divergence would show up as "the morning digest and the app disagree",
//  which is the hardest kind of bug to chase. One copy, both callers.
//
//  WHAT IT RETURNS: the same shape the app renders — segments, what filled
//  them, and crucially what did NOT. A segment that cannot fill its slots is
//  reported as short rather than topped up from elsewhere, because the
//  shortfall is the useful signal.
// ─────────────────────────────────────────────────────────────────────────────

import { collectJobs, clampParam, parseSlugs } from './jobs.js';

const TC_METRO = 'minneapolis, st paul, saint paul, twin cities, arden hills, maple grove, plymouth, eden prairie, brooklyn park, brooklyn center, mounds view, fridley, bloomington, eagan, chaska, shoreview, minnetonka, burnsville, new hope, golden valley, minnesota, mn';

const TITLES = 'product manager, product lead, product owner, product director, director of product, head of product, principal product, group product, senior manager, sr manager, offering manager, capability owner, business product owner, portfolio lead, program director, director, product strategy';

// "director" is deliberately absent. Excluding it dropped Director of Network
// Programs, Sr Director Digital Product and Director Marketing Transformation,
// all of which were being tracked by hand at the time.
const EXCLUDES = 'intern, associate product manager, junior, entry level, clearance, software engineer, staff engineer, quality engineer, r&d engineer, regulatory affairs, sales rep, territory manager, account executive';

// Global, not per-segment: licensure requirements turn up under payer and
// mid-market headings too, and no amount of product experience substitutes.
const EXCLUDES_CLINICAL = 'licsw, lpcc, lmft, licensed clinician, unrestricted license, unrestricted licence, board certified, registered nurse, rn required';

const C1 = 'behavioral health, behavioural health, mental health, eap, care navigation, care management, utilization management, member experience, patient engagement, benefits navigation, population health, substance use, collaborative care';
const C2 = 'ai-native, foundation model, large language model, llm, generative ai, agentic, machine learning platform, forward deployed, solutions engineer, solutions architect, solutions consultant, pre-sales';
const C2_TITLES = 'solutions engineer, solutions architect, solutions consultant, forward deployed, technical customer success, customer success manager, gtm engineer';

const D_SIGNALS = 'roadmap, product strategy, discovery, backlog, user research, requirements gathering, launch, platform, prioritization, prioritisation, mvp, go-to-market, own the product, product vision, cross-functional';
const EXCLUDES_D = 'intern, junior, entry level, software engineer, staff engineer, data engineer, sales rep, account executive, recruiter, sdr';

const DEFAULT_CFG = {
  topN: 25,
  precedence: ['C', 'A', 'B', 'D'],
  segments: [
    { key: 'A', name: 'Anchor medtech', slots: 8, perCompany: 2, rollover: true,
      companies: 'boston scientific, medtronic, philips, abbott, stryker, teleflex',
      titles: TITLES, excludes: EXCLUDES, locations: TC_METRO,
      minSalaryK: 120, maxAgeDays: 30 },
    { key: 'B', name: 'Twin Cities corporate', slots: 4, perCompany: 2, rollover: true,
      companies: 'target, unitedhealth, optum, best buy, u.s. bank, us bank, 3m, solventum, ecolab, thrivent, securian, general mills, cargill, ameriprise',
      titles: TITLES, excludes: EXCLUDES, locations: TC_METRO, allowRemote: true,
      minSalaryK: 120, maxAgeDays: 30 },
    // salaryFloorIfStated, NOT minSalaryK. Salary is regex-scraped from jdText,
    // which is truncated at jdChars (6000 by default), and pay-transparency
    // statements sit at the bottom of a JD — so a strict floor rejects roles
    // for having no *detected* pay rather than for paying too little. That
    // emptied this segment completely: 527 postings read, 0 matched.
    { key: 'C', name: 'Domain & AI-native', slots: 5, perCompany: 2, rollover: true,
      titles: `${TITLES}, ${C2_TITLES}`, excludes: EXCLUDES,
      jdAny: `${C1}, ${C2}`, allowRemote: true,
      salaryFloorIfStated: 120, maxAgeDays: 30 },
    // rollover:false on purpose. This is the hardest segment to fill and the
    // easiest to lose. If its empty slots quietly went to A and B, the scan
    // would revert to a medtech feed within a month and nothing would say so.
    { key: 'D', name: 'Twin Cities mid-market', slots: 8, perCompany: 1, rollover: false,
      titleBlind: true, jdSignals: D_SIGNALS, jdMin: 2,
      excludes: EXCLUDES_D, locations: TC_METRO, noRemote: true,
      excludeSegmentCompanies: ['A', 'B'], salaryFloorIfStated: 100, maxAgeDays: 45 },
  ],
};

// ── matching ─────────────────────────────────────────────────────────────────

const csv = (s) => String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

// Substring matching is wrong for a keyword list: "eap" sits inside
// "Minneapolis", so every metro posting matched the behavioural-health gate
// and, because C has precedence, took its slots with unrelated medtech roles.
// Anchor each term to a word START but not a word END, so "launch" still
// matches "launched" and "launching".
const rxCache = new Map();
function termHit(text, term) {
  if (!term) return false;
  if (!/^[a-z0-9]/i.test(term)) return text.includes(term);
  let rx = rxCache.get(term);
  if (!rx) {
    rx = new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    rxCache.set(term, rx);
  }
  return rx.test(text);
}
const anyTerm = (text, list) => csv(list).some((t) => termHit(text, t));
const countTerms = (text, list) => csv(list).filter((t) => termHit(text, t)).length;

const deepOf = (j) => `${j.role || ''} ${j.company || ''} ${j.location || ''} ${String(j.jdText || '').slice(0, 4000)}`.toLowerCase();
const titleCoOf = (j) => `${j.role || ''} ${j.company || ''}`.toLowerCase();
const isRemote = (j) => /remote|anywhere|work from home/i.test(String(j.location || '')) || j.source === 'Remotive';

function ageDays(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

// Take the TOP of a stated range: a posting banded 90-150 clears a 120 floor.
function maxSalaryK(text) {
  const s = String(text || '');
  if (!s) return 0;
  const nums = [...s.matchAll(/\$?\s?(\d[\d,.]*)\s*(k)?/gi)].map((m) => {
    let n = Number(String(m[1]).replace(/,/g, ''));
    if (!Number.isFinite(n)) return 0;
    if (m[2]) return n;              // explicit K
    if (n > 1000) return n / 1000;   // 150000 -> 150
    return n < 20 ? 0 : n;           // ignore stray small numbers (hours, years)
  }).filter(Boolean);
  return nums.length ? Math.max(...nums) : 0;
}

// tally is optional. When present, every rejection is counted under the gate
// that caused it, which is the difference between "the scan found nothing" and
// "the salary gate ate 412 of them".
function matches(j, seg, cfg, tally) {
  const deep = deepOf(j);
  const titleCo = titleCoOf(j);
  const loc = String(j.location || '').toLowerCase();
  const no = (gate) => { if (tally) tally[gate] = (tally[gate] || 0) + 1; return false; };

  if (anyTerm(deep, EXCLUDES_CLINICAL)) return no('clinicalLicence');
  if (seg.excludes && anyTerm(deep, seg.excludes)) return no('excludedTitle');
  if (seg.companies && !anyTerm(titleCo, seg.companies)) return no('companyNotInList');

  if (seg.excludeSegmentCompanies) {
    const banned = seg.excludeSegmentCompanies
      .flatMap((k) => csv((cfg.segments.find((x) => x.key === k) || {}).companies || ''));
    if (banned.some((c) => termHit(titleCo, c))) return no('ownedByAnotherSegment');
  }

  if (!seg.titleBlind && seg.titles && !anyTerm(titleCo, seg.titles)) return no('titleNoMatch');
  if (seg.jdAny && !anyTerm(deep, seg.jdAny)) return no('jdNoDomainTerm');
  if (seg.jdSignals && countTerms(deep, seg.jdSignals) < (seg.jdMin || 1)) return no('tooFewProductSignals');

  const remote = isRemote(j);
  if (seg.noRemote && remote) return no('remoteNotAllowed');
  if (seg.locations) {
    const inMetro = anyTerm(loc, seg.locations);
    if (!inMetro && !(seg.allowRemote && remote)) return no('outsideMetro');
  }

  const age = ageDays(j.updatedAt);
  if (seg.maxAgeDays && age !== null && age > seg.maxAgeDays) return no('tooOld');

  // Two different salary rules. A floor needs a stated band at or above it.
  // A floor-if-stated rejects only a band that is demonstrably too low,
  // because most mid-market postings state nothing and treating silence as
  // failure would empty that segment before it started.
  const maxK = maxSalaryK(j.salary);
  if (seg.minSalaryK && !maxK) return no('noSalaryDetected');
  if (seg.minSalaryK && maxK < seg.minSalaryK) return no('salaryBelowFloor');
  if (seg.salaryFloorIfStated && maxK && maxK < seg.salaryFloorIfStated) return no('salaryBelowFloor');

  return true;
}

function normCompany(name) {
  return String(name || '').toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(inc|corp|corporation|llc|ltd|co|company|labs|health|healthcare|medical|technologies|technology|group|holdings)\b\.?/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

const toTimeSafe = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : 0; };

// Newest, then best fit, then Minnesota. Segment D ranks on signal count
// first: with no title filter, how many product signals a posting carries is
// the only thing separating real product work from a passing mention.
function rank(a, b, seg) {
  if (seg.jdSignals) {
    const d = countTerms(deepOf(b), seg.jdSignals) - countTerms(deepOf(a), seg.jdSignals);
    if (d) return d;
  }
  const ta = toTimeSafe(a.updatedAt), tb = toTimeSafe(b.updatedAt);
  if (tb !== ta) return tb - ta;
  const fa = Number(a.fit) || 0, fb = Number(b.fit) || 0;
  if (fb !== fa) return fb - fa;
  const mn = (x) => (/minnesota|, mn|minneapolis|st paul|saint paul/i.test(String(x.location || '')) ? 1 : 0);
  return mn(b) - mn(a);
}

export function buildScan(jobs, cfg = DEFAULT_CFG) {
  const assigned = new Map();
  jobs.forEach((j) => {
    for (const key of cfg.precedence) {
      const seg = cfg.segments.find((x) => x.key === key);
      if (seg && matches(j, seg, cfg)) { assigned.set(j.id, key); return; }
    }
  });

  const pools = {};
  cfg.segments.forEach((seg) => { pools[seg.key] = []; });
  jobs.forEach((j) => { const k = assigned.get(j.id); if (k) pools[k].push(j); });

  const take = (seg, pool, limit) => {
    const perCo = {};
    const picked = [];
    [...pool].sort((a, b) => rank(a, b, seg)).forEach((j) => {
      if (picked.length >= limit) return;
      const co = normCompany(j.company) || String(j.company || '').toLowerCase();
      if ((perCo[co] || 0) >= (seg.perCompany || 99)) return;
      perCo[co] = (perCo[co] || 0) + 1;
      // Carry the signal count through so the client can show why a
      // title-blind pick qualified, without reimplementing the matcher.
      picked.push(seg.jdSignals ? { ...j, signals: countTerms(deepOf(j), seg.jdSignals) } : j);
    });
    return picked;
  };

  const result = cfg.segments.map((seg) => {
    const picked = take(seg, pools[seg.key], seg.slots);
    return { seg, picked, pool: pools[seg.key].length, short: seg.slots - picked.length, rolled: 0 };
  });

  const spare = result.filter((r) => r.seg.rollover).reduce((n, r) => n + r.short, 0);
  if (spare > 0) {
    const used = new Set(result.flatMap((r) => r.picked.map((j) => j.id)));
    const leftovers = result.filter((r) => r.seg.rollover)
      .flatMap((r) => pools[r.seg.key].filter((j) => !used.has(j.id)).map((j) => ({ j, seg: r.seg })));
    leftovers.sort((x, y) => rank(x.j, y.j, x.seg));
    const perCo = {};
    result.forEach((r) => r.picked.forEach((j) => {
      const co = normCompany(j.company) || '';
      perCo[co] = (perCo[co] || 0) + 1;
    }));
    let filled = 0;
    for (const { j, seg } of leftovers) {
      if (filled >= spare) break;
      const co = normCompany(j.company) || '';
      if ((perCo[co] || 0) >= (seg.perCompany || 99)) continue;
      perCo[co] = (perCo[co] || 0) + 1;
      const row = result.find((r) => r.seg.key === seg.key);
      row.picked.push(j);
      row.rolled += 1;
      filled += 1;
    }
  }

  const out = {
    cfg: { topN: cfg.topN },
    result,
    total: result.reduce((n, r) => n + r.picked.length, 0),
    classified: assigned.size,
    scanned: jobs.length,
  };

  // Run every job against every segment, ignoring precedence, so the counts
  // answer "why did segment C get nothing" rather than "what won the race".
  if (cfg.debug) {
    out.debug = cfg.segments.map((seg) => {
      const tally = {};
      let passed = 0;
      jobs.forEach((j) => { if (matches(j, seg, cfg, tally)) passed += 1; });
      const rejected = Object.entries(tally).sort((a, b) => b[1] - a[1])
        .map(([gate, n]) => ({ gate, n }));
      return { key: seg.key, name: seg.name, wouldPass: passed, rejectedBy: rejected };
    });
  }

  return out;
}

// Quota overrides as A:8,B:4,C:5,D:8 so the Action and the app can share one
// config without posting a whole JSON body.
function applySlotOverrides(cfg, raw) {
  if (!raw) return cfg;
  const wanted = Object.fromEntries(
    String(raw).split(',').map((p) => p.split(':')).filter((p) => p.length === 2)
      .map(([k, v]) => [k.trim().toUpperCase(), Number(v)])
  );
  return {
    ...cfg,
    segments: cfg.segments.map((s) =>
      (Number.isFinite(wanted[s.key]) && wanted[s.key] >= 0 ? { ...s, slots: wanted[s.key] } : s)),
    topN: cfg.segments.reduce((n, s) =>
      n + (Number.isFinite(wanted[s.key]) ? wanted[s.key] : s.slots), 0),
  };
}

export async function onRequestGet(context) {
  const { searchParams } = new URL(context.request.url);

  const cfg = {
    limit: clampParam(searchParams.get('limit'), 300, 10, 400),
    jdChars: clampParam(searchParams.get('jd'), 6000, 500, 20000),
    timeout: clampParam(searchParams.get('timeout'), 8000, 2000, 20000),
  };

  const { jobs, sources } = await collectJobs({
    gh: parseSlugs(searchParams.get('gh'), []),
    lever: parseSlugs(searchParams.get('lever'), []),
    ashby: parseSlugs(searchParams.get('ashby'), []),
    sr: parseSlugs(searchParams.get('sr'), []),
    workable: parseSlugs(searchParams.get('workable'), []),
    recruitee: parseSlugs(searchParams.get('recruitee'), []),
    remotive: searchParams.get('remotive') === '1',
    cfg,
  });

  const base = applySlotOverrides(DEFAULT_CFG, searchParams.get('slots'));
  const scan = buildScan(jobs, { ...base, debug: searchParams.get('debug') === '1' });

  return new Response(JSON.stringify({ ...scan, sources, generatedAt: new Date().toISOString() }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}
