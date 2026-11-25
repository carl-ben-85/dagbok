// SVG-grafer utan externa bibliotek. Färgerna kommer från CSS-klasser så att ljust och mörkt läge fungerar.
import { esc, fmtShort } from './util.js';

const PAD = { l: 26, r: 8, t: 18, b: 22 };
// Extra marginal till höger när en jämförelsekurva med egen skala visas.
export const PAD_R_CMP = 24;

// Alla grafer i samma vy använder samma geometri, så att dagarna hamnar rakt under varandra.
export function geometry(width, height, n, padR = PAD.r) {
  const pw = Math.max(10, width - PAD.l - padR);
  const ph = Math.max(10, height - PAD.t - PAD.b);
  const step = pw / Math.max(1, n);
  return {
    width, height, n, pw, ph, step,
    x: (i) => PAD.l + (i + 0.5) * step,
    top: PAD.t, bottom: PAD.t + ph, left: PAD.l, right: width - padR,
  };
}

function xTicks(dates, g) {
  const n = dates.length;
  const count = Math.min(n, g.width < 360 ? 4 : 5);
  const idx = new Set();
  for (let k = 0; k < count; k += 1) idx.add(Math.round((k * (n - 1)) / Math.max(1, count - 1)));
  return [...idx].map((i) => {
    const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    const x = i === 0 ? g.left : i === n - 1 ? g.right : g.x(i);
    return `<text class="ax" x="${x.toFixed(1)}" y="${g.height - 6}" text-anchor="${anchor}">${esc(fmtShort(dates[i]))}</text>`;
  }).join('');
}

function frame(g, yMax, yTicks, fmt) {
  const y = (v) => g.top + (1 - v / yMax) * g.ph;
  const grid = yTicks.map((v) => `
    <line class="grid" x1="${g.left}" x2="${g.right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
    <text class="ax" x="${g.left - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${esc(fmt(v))}</text>`).join('');
  return { y, grid };
}

function bands(g, flareIdx) {
  return flareIdx.map((i) => `<rect class="flare-band" x="${(g.x(i) - g.step / 2).toFixed(1)}" y="${g.top}" width="${g.step.toFixed(1)}" height="${g.ph}"/>`).join('');
}

function markers(g, marks) {
  return marks.map((m) => {
    const x = g.x(m.i).toFixed(1);
    return `
      <line class="mark-line" x1="${x}" x2="${x}" y1="${g.top}" y2="${g.bottom}"/>
      <circle class="mark-dot" cx="${x}" cy="${g.top - 9}" r="7.5"/>
      <text class="mark-num" x="${x}" y="${g.top - 5.5}" text-anchor="middle">${m.n}</text>`;
  }).join('');
}

// Linje genom värden; bryts där värde saknas.
function linePath(values, g, y) {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${g.x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

const cursor = (g) => `<line class="cursor" x1="0" x2="0" y1="${g.top - 2}" y2="${g.bottom}" visibility="hidden"/>`;

// Linjediagram 0–10: punkter för enskilda dagar och en linje för 7-dagarssnittet.
// cmp: 7-dagarssnitt för en jämförelseskala, ritas streckat på samma skala.
export function timeChart({ dates, values, avg, good, width, height = 132, marks = [], flareIdx = [], label, cmp = null, padR }) {
  const g = geometry(width, height, dates.length, padR);
  const { y, grid } = frame(g, 10, [0, 5, 10], (v) => String(v));
  const tone = good === 'high' ? 'tone-relief' : 'tone-burden';
  const r = g.step > 7 ? 2.8 : 2;
  const dots = values.map((v, i) => (v == null ? '' : `<circle class="dot" cx="${g.x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${r}"/>`)).join('');
  const d = linePath(avg, g, y);
  const c = cmp ? linePath(cmp.avg, g, y) : '';
  return `
    <svg class="chart ${tone}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(label)} över tid${cmp ? `, jämfört med ${esc(cmp.label)}` : ''}">
      ${bands(g, flareIdx)}
      ${grid}
      ${markers(g, marks)}
      ${c ? `<path class="cmp" d="${c}"/>` : ''}
      ${dots}
      ${d ? `<path class="avg" d="${d}"/>` : ''}
      ${xTicks(dates, g)}
      ${cursor(g)}
    </svg>`;
}

function niceMax(v, min) {
  const m = Math.max(min, v);
  const steps = [1, 2, 4, 5, 6, 8, 10, 12, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 600];
  return steps.find((s) => s >= m) || Math.ceil(m);
}

// Stapeldiagram för sömn, alkohol, träning och vid behov-medicin.
// cmp: dagsvärden för en jämförelseskala 0–10, med egen skala till höger.
export function barChart({ dates, values, width, height = 104, marks = [], flareIdx = [], minMax = 1, unit = '', label, refLine = null, levels = null, cmp = null, padR, binary = false }) {
  const g = geometry(width, height || 104, dates.length, padR);
  height = g.height;
  const top = binary ? 1 : niceMax(Math.max(0, ...values.filter((v) => v != null)), minMax);
  const half = top / 2;
  // Ja/nej-grafer: inga siffror på axeln, bara en baslinje
  const { y, grid } = binary
    ? frame(g, 1, [0], () => '')
    : frame(g, top, [0, Number.isInteger(half) ? half : top, top].filter((v, i, a) => a.indexOf(v) === i), (v) => `${v}`);
  const w = Math.max(1.5, Math.min(14, g.step * 0.66));
  const bars = values.map((v, i) => {
    if (v == null) return '';
    if (v === 0) return `<rect class="bar zero" x="${(g.x(i) - w / 2).toFixed(1)}" y="${(g.bottom - 1.5).toFixed(1)}" width="${w.toFixed(1)}" height="1.5"/>`;
    const yy = y(v);
    const lvl = levels ? ` lvl-${levels[i] || 'unknown'}` : '';
    return `<rect class="bar${lvl}" x="${(g.x(i) - w / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${w.toFixed(1)}" height="${(g.bottom - yy).toFixed(1)}" rx="${Math.min(3, w / 2).toFixed(1)}"/>`;
  }).join('');
  const ref = refLine != null && refLine <= top
    ? `<line class="ref" x1="${g.left}" x2="${g.right}" y1="${y(refLine).toFixed(1)}" y2="${y(refLine).toFixed(1)}"/>`
    : '';
  let cmpSvg = '';
  if (cmp) {
    const y2 = (v) => g.top + (1 - v / 10) * g.ph;
    const p = linePath(cmp.values, g, y2);
    const pts = cmp.values.map((v, i) => (v == null ? '' : `<circle class="cmp-dot" cx="${g.x(i).toFixed(1)}" cy="${y2(v).toFixed(1)}" r="${g.step > 7 ? 2.2 : 1.6}"/>`)).join('');
    const axis = [0, 5, 10].map((v) => `<text class="ax ax-cmp" x="${g.right + 5}" y="${(y2(v) + 3.5).toFixed(1)}" text-anchor="start">${v}</text>`).join('');
    cmpSvg = `${p ? `<path class="cmp cmp-daily" d="${p}"/>` : ''}${pts}${axis}`;
  }
  return `
    <svg class="chart bars" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(label)}${unit ? ` (${esc(unit)})` : ''} över tid${cmp ? `, jämfört med ${esc(cmp.label)}` : ''}">
      ${bands(g, flareIdx)}
      ${grid}
      ${ref}
      ${markers(g, marks)}
      ${bars}
      ${cmpSvg}
      ${xTicks(dates, g)}
      ${cursor(g)}
    </svg>`;
}
