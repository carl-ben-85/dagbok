// Beräkningar för analysfliken. Inga DOM-anrop här, så att allt kan testas fristående.
import { addDays, daysBetween, lower, trainingOf, sectionActive } from './util.js';

const MIN_GROUP = 5; // minsta antal dagar i varje grupp för att visa ett mönster

// Bygger en rad per kalenderdag från `from` till `to`.
export function buildDays({ days, prns, from, to }) {
  const byDate = new Map(days.map((d) => [d.date, d.data]));
  const prnCount = new Map();
  for (const p of prns) prnCount.set(p.date, (prnCount.get(p.date) || 0) + 1);
  const rows = [];
  const n = daysBetween(from, to);
  for (let i = 0; i <= n; i += 1) {
    const date = addDays(from, i);
    const d = byDate.get(date);
    const scales = d?.scales || {};
    const logged = !!d && (Object.keys(scales).length > 0 || !!d.stiffness || Object.values(d.flags || {}).some(Boolean)
      || d.sleep?.hours != null || d.rest != null || d.alcohol != null || !!d.exercise?.type || !!d.cardio?.types?.length || !!d.strength?.types?.length
      || Object.values(d.diet || {}).some(Boolean));
    const tr = trainingOf(d);
    const sec = (x) => ({
      any: sectionActive(x),
      min: sectionActive(x) ? (x.minutes ?? null) : (x.types.includes('none') ? 0 : null),
      int: sectionActive(x) ? (x.intensity || null) : null,
    });
    const c = sec(tr.cardio);
    const st = sec(tr.strength);
    rows.push({
      date,
      logged,
      scales,
      flags: d?.flags || {},
      sleepH: d?.sleep?.hours ?? null,
      sleepQ: d?.sleep?.quality ?? null,
      rest: d?.rest ?? null,
      alcohol: d?.alcohol ?? null,
      cardioAny: c.any, cardioMin: c.min, cardioInt: c.int,
      strengthAny: st.any, strengthMin: st.min, strengthInt: st.int,
      diet: d?.diet || {},
      taken: d?.taken || {},
      prn: prnCount.get(date) || 0,
    });
  }
  return rows;
}

// Utfall: alla skalor utom stress (som behandlas som påverkan), plus andel dåliga dagar.
export function outcomeDefs(settings) {
  const list = settings.scales
    .filter((s) => s.key !== 'stress' && !s.deleted)
    .map((s) => ({ key: s.key, label: s.label, good: s.good, type: 'scale', get: (r) => r.scales[s.key] ?? null }));
  if (settings.flags.some((f) => f.key === 'flare' && !f.deleted)) {
    list.push({ key: 'flare', label: 'Dålig period', good: 'low', type: 'rate', get: (r) => (r.logged ? (r.flags.flare ? 1 : 0) : null) });
  }
  return list;
}

const LAG_PHRASES = ['på dagar med', 'dagen efter', 'två dagar efter'];

// Påverkan: saker man gör. En dag utan markering räknas som "nej" om dagen har en incheckning.
export function FACTOR_DEFS(settings) {
  const f = [
    { key: 'alcohol', label: 'Alkohol', noun: 'alkohol', lags: [0, 1, 2], get: (r) => (r.logged ? ((r.alcohol || 0) > 0 ? 1 : 0) : null) },
    { key: 'shortSleep', label: 'Kort natt', noun: 'en kort natt (under 6 h)', phrases: ['efter', 'två dagar efter'], lags: [0, 1], get: (r) => (r.sleepH == null ? null : r.sleepH < 6 ? 1 : 0) },
    { key: 'rest', label: 'Vila', noun: 'vila under dagen', lags: [0, 1, 2], get: (r) => (r.rest === true ? 1 : r.rest === false || r.logged ? 0 : null) },
    { key: 'poorSleep', label: 'Dålig sömn', noun: 'en natt med dålig sömn', phrases: ['efter', 'två dagar efter'], lags: [0, 1], get: (r) => (r.sleepQ == null ? null : r.sleepQ <= 2 ? 1 : 0) },
    { key: 'cardio', label: 'Kondition', noun: 'konditionsträning', lags: [0, 1, 2], get: (r) => (r.logged ? (r.cardioAny ? 1 : 0) : null) },
    { key: 'hardCardio', label: 'Hård kondition', noun: 'hård konditionsträning', lags: [0, 1, 2], get: (r) => (r.logged ? (r.cardioInt === 'hard' ? 1 : 0) : null) },
    { key: 'strength', label: 'Styrka och rörlighet', noun: 'styrke- eller rörlighetsträning', lags: [0, 1, 2], get: (r) => (r.logged ? (r.strengthAny ? 1 : 0) : null) },
    { key: 'hardStrength', label: 'Hård styrka', noun: 'hård styrke- eller rörlighetsträning', lags: [0, 1, 2], get: (r) => (r.logged ? (r.strengthInt === 'hard' ? 1 : 0) : null) },
  ];
  if (settings.scales.some((s) => s.key === 'stress' && !s.deleted)) {
    f.push({ key: 'stress', label: 'Hög stress', noun: 'hög stress (6 eller mer)', lags: [0, 1, 2], get: (r) => (r.scales.stress == null ? null : r.scales.stress >= 6 ? 1 : 0) });
  }
  for (const t of (settings.diet || []).filter((x) => !x.deleted)) {
    f.push({ key: `diet_${t.key}`, label: t.label, noun: lower(t.label), lags: [0, 1, 2], get: (r) => (r.logged ? (r.diet[t.key] ? 1 : 0) : null) });
  }
  return f;
}

function stats(arr) {
  const n = arr.length;
  if (!n) return { n: 0, mean: null, varr: 0 };
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const varr = n > 1 ? arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { n, mean, varr };
}

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

// Tvåsidigt p-värde från t med normalapproximation (räcker för att sålla).
function pFromT(t) {
  const z = Math.abs(t) / Math.SQRT2;
  // Abramowitz–Stegun 7.1.26
  const k = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * k - 1.453152027) * k) + 1.421413741) * k - 0.284496736) * k + 0.254829592) * k * Math.exp(-z * z);
  return Math.max(1e-12, 1 - erf);
}

// Welch t-värde. Används bara för att rangordna och sålla, visas aldrig.
function welch(a, b, floor) {
  const se = Math.sqrt(Math.max(a.varr, floor) / a.n + Math.max(b.varr, floor) / b.n);
  return (a.mean - b.mean) / se;
}

// Letar mönster. Eftersom många jämförelser görs samtidigt används Benjamini–Hochberg
// för att hålla nere andelen mönster som bara är slump.
const FDR_POSSIBLE = 0.05;
const FDR_CLEAR = 0.01;

export function findPatterns(rows, settings, extraFactors = []) {
  const outcomes = outcomeDefs(settings);
  const factors = [...FACTOR_DEFS(settings), ...extraFactors];
  const tests = [];
  for (const fac of factors) {
    for (const out of outcomes) {
      for (const lag of fac.lags) {
        const yes = [];
        const no = [];
        for (let i = lag; i < rows.length; i += 1) {
          const fv = fac.get(rows[i - lag]);
          const ov = out.get(rows[i]);
          if (fv == null || ov == null) continue;
          (fv ? yes : no).push(ov);
        }
        if (yes.length < MIN_GROUP || no.length < MIN_GROUP) continue;
        const a = stats(yes);
        const b = stats(no);
        const t = welch(a, b, out.type === 'rate' ? 0.05 : 0.5);
        tests.push({ fac, out, lag, a, b, t, p: pFromT(t) });
      }
    }
  }

  // q-värden enligt Benjamini–Hochberg
  const m = tests.length;
  const order = [...tests].sort((x, y) => x.p - y.p);
  let minQ = 1;
  for (let k = m - 1; k >= 0; k -= 1) {
    minQ = Math.min(minQ, (order[k].p * m) / (k + 1));
    order[k].q = minQ;
  }

  // Bästa fördröjning per kombination av påverkan och utfall
  const best = new Map();
  for (const x of tests) {
    const key = `${x.fac.key}|${x.out.key}`;
    const cur = best.get(key);
    if (!cur || x.q < cur.q || (x.q === cur.q && Math.abs(x.t) > Math.abs(cur.t))) best.set(key, x);
  }

  const results = [];
  for (const x of best.values()) {
    const diff = x.a.mean - x.b.mean;
    const big = x.out.type === 'rate' ? Math.abs(diff) >= 0.15 : Math.abs(diff) >= 0.5;
    if (!big || x.q > FDR_POSSIBLE) continue;
    const strength = x.q <= FDR_CLEAR && Math.min(x.a.n, x.b.n) >= 8 ? 'clear' : 'possible';
    const better = x.out.good === 'high' ? diff > 0 : diff < 0;
    const phrase = (x.fac.phrases || LAG_PHRASES)[x.fac.lags.indexOf(x.lag)];
    results.push({
      factor: x.fac, outcome: x.out, lag: x.lag, phrase,
      yes: { n: x.a.n, mean: x.a.mean }, no: { n: x.b.n, mean: x.b.mean },
      diff, t: x.t, q: x.q, strength, better,
    });
  }
  results.sort((x, y) => x.q - y.q || Math.abs(y.t) - Math.abs(x.t));
  return { results, tested: m, logged: rows.filter((r) => r.logged).length };
}

// Senaste 7 dagarna jämfört med de 7 dagarna innan. rows ska sluta med i dag.
export function weekSummary(rows, settings) {
  const outs = settings.scales.filter((s) => s.visible).map((s) => ({ key: s.key, label: s.label, good: s.good, get: (r) => r.scales[s.key] ?? null }));
  const last = rows.slice(-7);
  const prev = rows.slice(-14, -7);
  return outs.map((o) => {
    const c = last.map(o.get).filter((v) => v != null);
    const p = prev.map(o.get).filter((v) => v != null);
    const cm = mean(c);
    const pm = mean(p);
    const diff = cm != null && pm != null ? cm - pm : null;
    return { ...o, cur: cm, prev: pm, nCur: c.length, nPrev: p.length, diff, better: diff == null ? null : o.good === 'high' ? diff > 0 : diff < 0 };
  });
}

// Snitt före och efter varje medicinändring.
export function medChangeEffects(rows, changes, settings, window) {
  const outcomes = outcomeDefs(settings);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const lastDate = rows.length ? rows[rows.length - 1].date : null;
  return [...changes].sort((a, b) => (a.date < b.date ? 1 : -1)).map((c) => {
    const before = [];
    const after = [];
    for (let i = 1; i <= window; i += 1) before.push(byDate.get(addDays(c.date, -i)));
    let afterDays = 0;
    for (let i = 0; i < window; i += 1) {
      const d = addDays(c.date, i);
      if (lastDate && d > lastDate) break;
      afterDays += 1;
      after.push(byDate.get(d));
    }
    const b = before.filter(Boolean);
    const a = after.filter(Boolean);
    const per = outcomes.map((o) => {
      const bv = b.map(o.get).filter((v) => v != null);
      const av = a.map(o.get).filter((v) => v != null);
      const bm = mean(bv);
      const am = mean(av);
      const diff = bm != null && am != null ? am - bm : null;
      return { outcome: o, before: { n: bv.length, mean: bm }, after: { n: av.length, mean: am }, diff, better: diff == null ? null : o.good === 'high' ? diff > 0 : diff < 0 };
    });
    const others = changes.filter((x) => x.id !== c.id && daysBetween(c.date, x.date) >= -window && daysBetween(c.date, x.date) < window);
    return {
      change: c,
      afterDays,
      loggedBefore: b.filter((r) => r.logged).length,
      loggedAfter: a.filter((r) => r.logged).length,
      per,
      others,
    };
  });
}

// Glidande 7-dagarssnitt (bakåtblickande). Kräver minst 3 värden i fönstret.
export function rolling(values, size = 7, minCount = 3) {
  return values.map((_, i) => {
    const w = values.slice(Math.max(0, i - size + 1), i + 1).filter((v) => v != null);
    return w.length >= minCount ? mean(w) : null;
  });
}
