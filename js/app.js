import * as db from './db.js';
import * as sync from './sync.js';
import {
  esc, pad, dstr, today, parseD, addDays, daysBetween, isDate, cap, lower, fmtLong, fmtDate, fmtShort,
  fmtWeekday, nowTime, clock, listSv, doseLabel, num, TRAINING, INTENSITY, trainingOf, sectionActive,
  LEGACY_TYPE_LABELS, isoDay, WEEKDAYS, scheduledOn,
} from './util.js';
import { buildDays, weekSummary, findPatterns, medChangeEffects, rolling } from './analysis.js';
import { timeChart, barChart, geometry, PAD_R_CMP } from './charts.js';

const APP_VERSION = '0.4.2';
const BACKUP_INTERVAL_DAYS = 7;

const DEFAULT_SCALES = [
  { key: 'wellbeing', label: 'Allmänt mående', good: 'high', visible: true },
  { key: 'energy', label: 'Energi', good: 'high', visible: true },
  { key: 'weakness', label: 'Muskelsvaghet', good: 'low', visible: true, hint: 'Resa sig, gå i trappor, lyfta armarna' },
  { key: 'pain', label: 'Muskel- och ledvärk', good: 'low', visible: true },
  { key: 'breath', label: 'Andfåddhet', good: 'low', visible: true },
  { key: 'cough', label: 'Hosta', good: 'low', visible: true },
  { key: 'stress', label: 'Stress', good: 'low', visible: true },
];

const DEFAULT_FLAGS = [
  { key: 'raynaud', label: 'Raynaud', hint: 'Kalla, vita eller blå fingrar', visible: true },
  { key: 'skin', label: 'Hudbesvär på händerna', visible: true },
  { key: 'fever', label: 'Feber', visible: true },
  { key: 'infection', label: 'Infektionstecken', visible: true },
  { key: 'flare', label: 'Dålig period', hint: 'Dagar som känns som ett skov', visible: true },
];

const DEFAULT_DIET = [
  { key: 'gluten', label: 'Gluten', visible: true },
  { key: 'sugar', label: 'Socker', visible: true },
  { key: 'dairy', label: 'Mejeri', visible: true },
  { key: 'processed', label: 'Processad mat', visible: true },
  { key: 'redmeat', label: 'Rött kött', visible: true },
  { key: 'antiinfl', label: 'Antiinflammatorisk kost', hint: 'T.ex. fet fisk, grönsaker, bär, olivolja', visible: true },
];

const INT_LABEL = new Map(INTENSITY);
const SECTIONS = ['cardio', 'strength'];

// Stegknappar för siffror. Ett tryck på ett tomt fält ger startvärdet.
const STEPPERS = {
  sleepHours: { step: 0.5, min: 0, max: 16, def: 7, unit: 'h' },
  alcohol: { step: 1, min: 0, max: 30, def: 1, unit: 'glas' },
  cardioMinutes: { step: 10, min: 0, max: 600, def: 30, unit: 'min' },
  strengthMinutes: { step: 5, min: 0, max: 600, def: 20, unit: 'min' },
};

const STIFFNESS = [
  ['none', 'Ingen'],
  ['lt30', '< 30 min'],
  ['30to60', '30–60 min'],
  ['gt60', '> 60 min'],
];

const SCALE_ENDS = {
  high: ['Mycket dåligt', 'Mycket bra'],
  low: ['Inga besvär', 'Värsta tänkbara'],
};

const UNITS = ['mg', 'µg', 'g', 'ml', 'st', 'E', 'droppar'];

const view = document.getElementById('view');
const sheet = document.getElementById('sheet');
const toastEl = document.getElementById('toast');

/* ---------- Hjälpfunktioner ---------- */

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const I = {
  prev: svg('<path d="M15 5l-7 7 7 7"/>'),
  next: svg('<path d="M9 5l7 7-7 7"/>'),
  x: svg('<path d="M7 7l10 10M17 7L7 17"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  up: svg('<path d="M6 14l6-6 6 6"/>'),
  down: svg('<path d="M6 10l6 6 6-6"/>'),
  camera: svg('<path d="M4 8h3.2l1.8-2.6h6l1.8 2.6H20v11H4z"/><circle cx="12" cy="13.2" r="3.4"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  chev: svg('<path d="M10 6l6 6-6 6"/>'),
};

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

/* ---------- Ark (dialog) ---------- */

let sheetDismiss = null;

function openSheet(html, mount, onDismiss) {
  sheetDismiss = onDismiss || null;
  sheet.innerHTML = `<div class="sheet-body">${html}</div>`;
  sheet.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dismissSheet()));
  if (!sheet.open) sheet.showModal();
  sheet.scrollTop = 0;
  mount?.(sheet);
}

function closeSheet() {
  sheetDismiss = null;
  if (sheet.open) sheet.close();
  sheet.innerHTML = '';
}

function dismissSheet() {
  const f = sheetDismiss;
  closeSheet();
  f?.();
}

sheet.addEventListener('click', (e) => { if (e.target === sheet) dismissSheet(); });
sheet.addEventListener('cancel', (e) => { e.preventDefault(); dismissSheet(); });

function confirmSheet({ title, text = '', ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    openSheet(`
      <h2>${esc(title)}</h2>
      ${text ? `<p class="sheet-text">${esc(text)}</p>` : ''}
      <div class="sheet-actions">
        <button type="button" class="btn" data-r="0">Avbryt</button>
        <button type="button" class="btn ${danger ? 'danger-solid' : 'primary'}" data-r="1">${esc(ok)}</button>
      </div>`, (dlg) => {
      dlg.querySelectorAll('[data-r]').forEach((b) => {
        b.onclick = () => { closeSheet(); resolve(b.dataset.r === '1'); };
      });
    }, () => resolve(false));
  });
}

function infoSheet(title, text) {
  openSheet(`
    <h2>${esc(title)}</h2>
    <p class="sheet-text">${esc(text)}</p>
    <div class="sheet-actions one"><button type="button" class="btn primary" data-close>OK</button></div>`);
}

/* ---------- Inställningar ---------- */

let settings = mergeSettings(null);

function mergeSettings(stored) {
  const out = {
    scales: Array.isArray(stored?.scales) ? stored.scales.map((s) => ({ ...s })) : [],
    flags: Array.isArray(stored?.flags) ? stored.flags.map((f) => ({ ...f })) : [],
    diet: Array.isArray(stored?.diet) ? stored.diet.map((f) => ({ ...f })) : [],
    cardioTypes: Array.isArray(stored?.cardioTypes) ? stored.cardioTypes.map((f) => ({ ...f })) : [],
    strengthTypes: Array.isArray(stored?.strengthTypes) ? stored.strengthTypes.map((f) => ({ ...f })) : [],
  };
  for (const d of DEFAULT_SCALES) if (!out.scales.some((s) => s.key === d.key)) out.scales.push({ ...d });
  for (const d of DEFAULT_FLAGS) if (!out.flags.some((f) => f.key === d.key)) out.flags.push({ ...d });
  for (const d of DEFAULT_DIET) if (!out.diet.some((f) => f.key === d.key)) out.diet.push({ ...d });
  for (const sec of ['cardio', 'strength']) {
    const list = out[`${sec}Types`];
    for (const [key, label] of TRAINING[sec].types) if (!list.some((f) => f.key === key)) list.push({ key, label, visible: true });
  }
  return out;
}

async function loadSettings() {
  const r = await db.get('settings');
  settings = mergeSettings(r?.data);
}

function saveSettings() {
  return db.put({ id: 'settings', type: 'settings', data: settings });
}

/* ---------- Mediciner ---------- */

const sortChanges = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt);

async function loadMeds() {
  const [meds, changes] = await Promise.all([db.list('med'), db.list('medchange')]);
  meds.sort((a, b) => a.data.name.localeCompare(b.data.name, 'sv'));
  changes.sort(sortChanges);
  return { meds, changes };
}

// Status för en medicin ett visst datum, härledd ur dos-historiken.
function medState(medId, changes, date) {
  const own = changes.filter((c) => c.data.medId === medId);
  const upto = own.filter((c) => c.date <= date);
  const last = upto[upto.length - 1];
  if (!last) {
    const first = own[0];
    return { active: false, started: false, startsAt: first?.date ?? null };
  }
  if (last.data.action === 'stop') return { active: false, started: true, stoppedAt: last.date };
  return { active: true, started: true, dose: last.data.dose, since: last.date };
}

function timesLabel(med) {
  if (med.data.kind === 'prn') return 'Vid behov';
  const t = med.data.times || [];
  const wd = med.data.weekdays || [];
  const days = wd.length && wd.length < 7 ? cap(listSv(WEEKDAYS.filter(([n]) => wd.includes(n)).map((x) => x[2]))) : '';
  if (days) return t.length ? `${days} kl. ${listSv(t)}` : days;
  return t.length ? `Kl. ${listSv(t)}` : 'Dagligen';
}

/* ---------- Routing ---------- */

let cur = null; // tillstånd för dagens incheckning
let saveTimer = null;
let objectUrls = [];
let historyDays = 30;
let lastRoute = '';

function parseRoute() {
  const h = decodeURIComponent(location.hash.replace(/^#/, '')) || 'idag';
  // Adresser av typen #idag, #idag-2026-10-31, #medicin-<id>
  const i = h.indexOf('-');
  const tab = i < 0 ? h : h.slice(0, i);
  const arg = i < 0 ? undefined : h.slice(i + 1);
  return { tab, arg, key: h };
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function revokeUrls() {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
}

async function render({ keep = false } = {}) {
  await flushSave();
  const r = parseRoute();
  const sameRoute = r.key === lastRoute;
  const y = window.scrollY;
  lastRoute = r.key;
  revokeUrls();
  document.querySelectorAll('.tabs a').forEach((a) => {
    if (a.dataset.tab === r.tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  try {
    if (r.tab === 'idag') {
      const d = isDate(r.arg) && r.arg <= today() ? r.arg : today();
      await renderToday(d);
    } else {
      cur = null;
      if (r.tab === 'medicin') await (r.arg ? renderMedDetail(r.arg) : renderMeds());
      else if (r.tab === 'analys') await renderAnalysis();
      else if (r.tab === 'historik') await renderHistory();
      else if (r.tab === 'mer') await renderMore();
      else { location.hash = '#idag'; return; }
    }
  } catch (err) {
    console.error(err);
    view.innerHTML = `
      <div class="page-error">
        <h1>Sidan kunde inte visas</h1>
        <p>${esc(err?.message || 'Okänt fel')}</p>
        <a class="btn primary" href="#idag">Till dagens incheckning</a>
      </div>`;
  }
  window.scrollTo(0, keep && sameRoute ? y : 0);
}

window.addEventListener('hashchange', () => render());

/* ---------- Idag: incheckning ---------- */

const emptyDay = () => ({
  scales: {}, stiffness: null, flags: {}, note: '', taken: {}, photos: [],
  sleep: { hours: null, quality: null }, rest: null, alcohol: null,
  cardio: { types: [], minutes: null, intensity: null }, strength: { types: [], minutes: null, intensity: null }, diet: {},
});
function normDay(d) {
  const out = {
    ...emptyDay(),
    ...(d || {}),
    scales: { ...(d?.scales || {}) },
    flags: { ...(d?.flags || {}) },
    sleep: { hours: null, quality: null, ...(d?.sleep || {}) },
    ...trainingOf(d),
    diet: { ...(d?.diet || {}) },
    taken: { ...(d?.taken || {}) },
    photos: [...(d?.photos || [])],
  };
  delete out.exercise; // äldre format, ersatt av cardio och strength
  return out;
}

function scaleHTML(s, v) {
  const set = v != null;
  const segs = Array.from({ length: 11 }, (_, i) => `<button type="button" class="seg-n${set && i <= v ? ' on' : ''}${v === i ? ' cur' : ''}" style="--i:${i}" data-act="scale" data-key="${esc(s.key)}" data-v="${i}" aria-pressed="${v === i}" aria-label="${i}">${i}</button>`).join('');
  const ends = SCALE_ENDS[s.good === 'high' ? 'high' : 'low'];
  return `
    <div class="scale ${s.good === 'high' ? 'good-high' : 'good-low'}" data-key="${esc(s.key)}">
      <div class="scale-head">
        <span class="scale-label">${esc(s.label)}</span>
        <span class="scale-val${set ? ' set' : ''}">${set ? v : '–'}</span>
      </div>
      ${s.hint ? `<p class="scale-hint">${esc(s.hint)}</p>` : ''}
      <div class="scale-row" role="group" aria-label="${esc(s.label)}, 0 till 10">${segs}</div>
      <div class="scale-ends"><span>${ends[0]}</span><span>${ends[1]}</span></div>
    </div>`;
}

function paintScale(key) {
  const box = view.querySelector(`.scale[data-key="${CSS.escape(key)}"]`);
  if (!box) return;
  const v = cur.day.scales[key];
  box.querySelectorAll('.seg-n').forEach((b) => {
    const i = Number(b.dataset.v);
    b.classList.toggle('on', v != null && i <= v);
    b.classList.toggle('cur', v === i);
    b.setAttribute('aria-pressed', String(v === i));
  });
  const out = box.querySelector('.scale-val');
  out.textContent = v ?? '–';
  out.classList.toggle('set', v != null);
}

function savedText() {
  if (cur.updatedAt) return `Sparat ${clock(cur.updatedAt)}${syncSuffix()}`;
  return cur.date === today() ? 'Inget ifyllt ännu i dag' : 'Ingen incheckning den här dagen';
}

function stepGet(field) {
  if (field === 'sleepHours') return cur.day.sleep.hours;
  if (field === 'alcohol') return cur.day.alcohol;
  return cur.day[field === 'cardioMinutes' ? 'cardio' : 'strength'].minutes;
}

function stepSet(field, v) {
  if (field === 'sleepHours') cur.day.sleep.hours = v;
  else if (field === 'alcohol') cur.day.alcohol = v;
  else cur.day[field === 'cardioMinutes' ? 'cardio' : 'strength'].minutes = v;
}

function stepText(field) {
  const v = stepGet(field);
  return v == null ? '–' : `${num(v)} ${STEPPERS[field].unit}`;
}

function stepperHTML(field) {
  return `
    <div class="stepper" data-field="${field}">
      <button type="button" class="step-btn" data-act="step" data-field="${field}" data-dir="-1" aria-label="Minska">${I.minus}</button>
      <output class="step-val${stepGet(field) == null ? ' unset' : ''}" aria-live="polite">${esc(stepText(field))}</output>
      <button type="button" class="step-btn" data-act="step" data-field="${field}" data-dir="1" aria-label="Öka">${I.plus}</button>
    </div>`;
}

function doStep(field, dir) {
  const spec = STEPPERS[field];
  const v = stepGet(field);
  let next;
  if (v == null) next = spec.def;
  else if (dir < 0 && v <= spec.min) next = null;
  else next = Math.min(spec.max, Math.max(spec.min, Math.round((v + dir * spec.step) * 10) / 10));
  stepSet(field, next);
  const out = view.querySelector(`.stepper[data-field="${field}"] output`);
  if (out) {
    out.textContent = stepText(field);
    out.classList.toggle('unset', next == null);
  }
  queueSave();
}

const exActive = (sec) => sectionActive(cur.day[sec]);

function typeLabel(k) {
  const hit = [...settings.cardioTypes, ...settings.strengthTypes].find((t) => t.key === k);
  return hit?.label || LEGACY_TYPE_LABELS[k] || k;
}

function trainingHTML(sec) {
  const t = TRAINING[sec];
  const d = cur.day[sec];
  const id = `h-${sec}`;
  return `
    <section class="block" aria-labelledby="${id}">
      <h2 id="${id}">${t.title}</h2>
      <div class="chips" role="group" aria-labelledby="${id}">
        ${[['none', 'Ingen'], ...settings[`${sec}Types`].filter((x) => x.visible && !x.deleted).map((x) => [x.key, x.label]),
          ...d.types.filter((k) => k !== 'none' && !settings[`${sec}Types`].some((x) => x.key === k && x.visible && !x.deleted)).map((k) => [k, typeLabel(k)])].map(([k, l]) => {
          const on = d.types.includes(k);
          return `<button type="button" class="chip chip-ink${on ? ' on' : ''}" data-act="extype" data-sec="${sec}" data-v="${k}" aria-pressed="${on}">${l}</button>`;
        }).join('')}
      </div>
      <div class="group ctl-rows ex-detail" data-sec="${sec}"${exActive(sec) ? '' : ' hidden'}>
        <div class="ctl-row"><span class="ctl-label">Tid</span>${stepperHTML(`${sec}Minutes`)}</div>
        <div class="ctl-row stacked">
          <span class="ctl-label">Ansträngning</span>
          <div class="choice three" role="group" aria-label="Ansträngning, ${lower(t.title)}">
            ${INTENSITY.map(([k, l]) => `<button type="button" data-act="exint" data-sec="${sec}" data-v="${k}" class="${d.intensity === k ? 'on' : ''}" aria-pressed="${d.intensity === k}">${l}</button>`).join('')}
          </div>
        </div>
      </div>
    </section>`;
}

function paintChoice(container, value) {
  container.querySelectorAll('button[data-v]').forEach((b) => {
    const on = b.dataset.v === String(value);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

async function renderToday(date) {
  const [rec, medsData, prns, dayCount, lastExport] = await Promise.all([
    db.get(`day-${date}`),
    loadMeds(),
    db.listByDate('prn', date),
    db.count('day'),
    db.getMeta('lastExportAt'),
  ]);
  const { meds, changes } = medsData;
  cur = { date, day: normDay(rec?.deleted ? null : rec?.data), updatedAt: rec && !rec.deleted ? rec.updatedAt : null };

  const isToday = date === today();
  const medById = new Map(meds.map((m) => [m.id, m]));
  const active = meds.map((m) => ({ m, st: medState(m.id, changes, date) })).filter((x) => x.st.active);
  const fixed = active.filter((x) => x.m.data.kind !== 'prn');
  const prnMeds = active.filter((x) => x.m.data.kind === 'prn');
  prns.sort((a, b) => (a.data.time || '').localeCompare(b.data.time || ''));

  // Påminnelse om säkerhetskopia
  let banner = '';
  const sst = sync.getState();
  const syncFresh = syncOn(sst) && sst.lastSyncAt && Date.now() - sst.lastSyncAt < BACKUP_INTERVAL_DAYS * 86400000;
  if (dayCount >= 3 && !syncFresh) {
    const ago = lastExport ? Math.floor((Date.now() - lastExport) / 86400000) : null;
    if (ago == null) banner = 'Du har inte exporterat någon säkerhetskopia ännu.';
    else if (ago >= BACKUP_INTERVAL_DAYS) banner = `Det är ${ago} dagar sedan senaste säkerhetskopian.`;
  }

  const scales = settings.scales.filter((s) => s.visible);
  const flags = settings.flags.filter((f) => f.visible);
  const diet = settings.diet.filter((f) => f.visible);

  const checkRows = (list) => list.flatMap(({ m, st }) => {
    const times = m.data.times?.length ? m.data.times : [''];
    return times.map((tm) => {
      const k = `${m.id}@${tm || 'dag'}`;
      return `
        <label class="check">
          <input type="checkbox" class="vh" data-act="taken" data-k="${esc(k)}"${cur.day.taken[k] ? ' checked' : ''}>
          <span class="box">${I.check}</span>
          <span class="check-text"><b>${esc(m.data.name)}</b> <span>${esc(doseLabel(st.dose, m.data.unit))}</span></span>
          <span class="check-time">${esc(tm)}</span>
        </label>`;
    });
  }).join('');

  const scheduled = fixed.filter(({ m }) => scheduledOn(m, date));
  const others = fixed.filter(({ m }) => !scheduledOn(m, date));
  const othersTaken = others.some(({ m }) => Object.keys(cur.day.taken).some((k) => k.startsWith(`${m.id}@`) && cur.day.taken[k]));
  const checks = checkRows(scheduled);
  const otherChecks = others.length ? `
    <details class="more-meds"${othersTaken ? ' open' : ''}>
      <summary>Inte schemalagt i dag: ${esc(listSv(others.map(({ m }) => m.data.name)))}</summary>
      <div class="group checks">${checkRows(others)}</div>
    </details>` : '';

  const prnButtons = prnMeds.map(({ m }) => `<button type="button" class="pill" data-act="prn-add" data-med="${esc(m.id)}">${I.plus}${esc(m.data.name)}</button>`).join('');

  const prnList = prns.map((p) => {
    const m = medById.get(p.data.medId);
    return `
      <li class="prn-item">
        <span class="prn-time">${esc(p.data.time || '')}</span>
        <span class="prn-text"><b>${esc(m ? m.data.name : 'Borttagen medicin')}</b> ${esc(doseLabel(p.data.dose, m?.data.unit))}${p.data.note ? `<small>${esc(p.data.note)}</small>` : ''}</span>
        <button type="button" class="iconbtn" data-act="prn-del" data-id="${esc(p.id)}" aria-label="Ta bort">${I.x}</button>
      </li>`;
  }).join('');

  const medSection = (!fixed.length && !prnMeds.length && !prns.length)
    ? `<p class="empty">Inga mediciner inlagda ännu. <a href="#medicin">Lägg till under Medicin</a>.</p>`
    : `
      ${checks ? `<div class="group checks">${checks}</div>` : ''}
      ${otherChecks}
      ${prnButtons ? `<p class="sub">Vid behov</p><div class="pills">${prnButtons}</div>` : ''}
      ${prnList ? `<ul class="group prn-list">${prnList}</ul>` : ''}`;

  const photos = cur.day.photos.map((id) => `<button type="button" class="thumb" data-act="photo" data-id="${esc(id)}" aria-label="Visa foto"><img data-blob="${esc(id)}" alt=""></button>`).join('');

  view.innerHTML = `
    <header class="dayhead">
      <button type="button" class="iconbtn" data-act="prev" aria-label="Föregående dag">${I.prev}</button>
      <div class="dayhead-mid">
        <h1>${isToday ? 'I dag' : esc(fmtLong(date))}</h1>
        <p class="dayhead-sub">${isToday ? esc(fmtLong(date)) : `<a href="#idag">Till i dag</a>`}</p>
      </div>
      <button type="button" class="iconbtn" data-act="next" aria-label="Nästa dag"${isToday ? ' disabled' : ''}>${I.next}</button>
    </header>
    <p class="saved" id="saved" aria-live="polite">${esc(savedText())}</p>

    ${banner ? `<a class="banner" href="#mer">${esc(banner)} <span>Exportera nu</span></a>` : ''}

    <section class="block" aria-labelledby="h-scales">
      <h2 id="h-scales">Hur mår du?</h2>
      <div class="group scales">${scales.map((s) => scaleHTML(s, cur.day.scales[s.key])).join('') || '<p class="empty pad">Alla skalor är dolda. Visa dem under Mer.</p>'}</div>
    </section>

    <section class="block" aria-labelledby="h-stiff">
      <h2 id="h-stiff">Morgonstelhet</h2>
      <div class="choice four" role="group" aria-labelledby="h-stiff">
        ${STIFFNESS.map(([v, l]) => `<button type="button" data-act="stiff" data-v="${v}" class="${cur.day.stiffness === v ? 'on' : ''}" aria-pressed="${cur.day.stiffness === v}">${l}</button>`).join('')}
      </div>
    </section>

    <section class="block" aria-labelledby="h-sleep">
      <h2 id="h-sleep">Sömn och vila</h2>
      <div class="group ctl-rows">
        <div class="ctl-row"><span class="ctl-label">Sömn i natt</span>${stepperHTML('sleepHours')}</div>
        <div class="ctl-row stacked">
          <span class="ctl-label">Hur sov du?</span>
          <div class="choice five" role="group" aria-label="Sömnkvalitet 1 till 5">
            ${[1, 2, 3, 4, 5].map((q) => `<button type="button" data-act="sleepq" data-v="${q}" class="${cur.day.sleep.quality === q ? 'on' : ''}" aria-pressed="${cur.day.sleep.quality === q}">${q}</button>`).join('')}
          </div>
          <div class="scale-ends"><span>Mycket dåligt</span><span>Mycket bra</span></div>
        </div>
        <div class="ctl-row">
          <span class="ctl-label">Vila under dagen<small>T.ex. lagt dig, sovit middag eller tagit det helt lugnt</small></span>
          <div class="choice two yesno" role="group" aria-label="Vila under dagen">
            ${[['yes', 'Ja', true], ['no', 'Nej', false]].map(([k, l, v]) => `<button type="button" data-act="rest" data-v="${k}" class="${cur.day.rest === v ? 'on' : ''}" aria-pressed="${cur.day.rest === v}">${l}</button>`).join('')}
          </div>
        </div>
      </div>
    </section>

    <section class="block" aria-labelledby="h-meds">
      <h2 id="h-meds">Mediciner</h2>
      ${medSection}
    </section>

    ${trainingHTML('cardio')}
    ${trainingHTML('strength')}

    <section class="block" aria-labelledby="h-alc">
      <h2 id="h-alc">Alkohol</h2>
      <div class="group ctl-rows">
        <div class="ctl-row">
          <span class="ctl-label">Antal glas<small>Ett glas vin, en starköl eller 4 cl sprit</small></span>
          ${stepperHTML('alcohol')}
        </div>
      </div>
    </section>

    ${diet.length ? `
    <section class="block" aria-labelledby="h-diet">
      <h2 id="h-diet">Kost i dag</h2>
      <div class="chips">
        ${diet.map((f) => `<button type="button" class="chip chip-ink${cur.day.diet[f.key] ? ' on' : ''}" data-act="diet" data-key="${esc(f.key)}" aria-pressed="${!!cur.day.diet[f.key]}"${f.hint ? ` title="${esc(f.hint)}"` : ''}>${esc(f.label)}</button>`).join('')}
      </div>
    </section>` : ''}

    ${flags.length ? `
    <section class="block" aria-labelledby="h-flags">
      <h2 id="h-flags">Har du märkt något av detta?</h2>
      <div class="chips">
        ${flags.map((f) => `<button type="button" class="chip${f.key === 'flare' ? ' chip-flare' : ''}${cur.day.flags[f.key] ? ' on' : ''}" data-act="flag" data-key="${esc(f.key)}" aria-pressed="${!!cur.day.flags[f.key]}"${f.hint ? ` title="${esc(f.hint)}"` : ''}>${esc(f.label)}</button>`).join('')}
      </div>
    </section>` : ''}

    <section class="block" aria-labelledby="h-note">
      <h2 id="h-note">Anteckning</h2>
      <textarea id="note" data-act="note" rows="4" placeholder="Hur var dagen? Något som stack ut?" aria-labelledby="h-note">${esc(cur.day.note)}</textarea>
      <div class="photos">
        ${photos}
        <label class="btn add-photo">${I.camera}<span>Lägg till foto</span><input type="file" accept="image/*" class="vh" data-act="photo-input"></label>
      </div>
    </section>`;

  loadThumbs();
}

function setSaved(text) {
  const el = document.getElementById('saved');
  if (el) el.textContent = text;
}

function queueSave() {
  clearTimeout(saveTimer);
  setSaved('Sparar …');
  saveTimer = setTimeout(saveDay, 400);
}

async function saveDay() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!cur) return;
  try {
    const r = await db.put({ id: `day-${cur.date}`, type: 'day', date: cur.date, data: cur.day });
    cur.updatedAt = r.updatedAt;
    setSaved(`Sparat ${clock(r.updatedAt)}`);
  } catch (err) {
    console.error(err);
    setSaved('Kunde inte spara – försök igen');
  }
}

async function flushSave() {
  if (saveTimer) await saveDay();
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
window.addEventListener('pagehide', () => { flushSave(); });

async function loadThumbs() {
  for (const img of view.querySelectorAll('img[data-blob]')) {
    const b = await db.getBlob(img.dataset.blob);
    if (b) {
      const u = URL.createObjectURL(b);
      objectUrls.push(u);
      img.src = u;
    } else {
      img.closest('.thumb')?.classList.add('missing');
    }
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bilden kunde inte läsas')); };
    img.src = url;
  });
}

async function compressImage(file, max = 1600, quality = 0.8) {
  const img = await loadImage(file);
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Bilden kunde inte komprimeras'))), 'image/jpeg', quality));
}

async function addPhoto(file) {
  try {
    setSaved('Sparar foto …');
    const blob = await compressImage(file);
    const id = uuid();
    await db.putBlob(id, blob);
    await db.put({ id, type: 'photo', date: cur.date, data: { mime: blob.type, size: blob.size } });
    cur.day.photos.push(id);
    await saveDay();
    render({ keep: true });
  } catch (err) {
    console.error(err);
    setSaved(savedText());
    infoSheet('Fotot sparades inte', 'Bilden kunde inte läsas. Prova att välja den igen eller ta ett nytt foto.');
  }
}

async function openPhotoSheet(id) {
  const b = await db.getBlob(id);
  const u = b ? URL.createObjectURL(b) : '';
  if (u) objectUrls.push(u);
  openSheet(`
    ${u ? `<img class="photo-full" src="${u}" alt="Foto från ${esc(fmtLong(cur.date))}">` : '<p class="sheet-text">Fotot finns inte längre på den här telefonen.</p>'}
    <div class="sheet-actions">
      <button type="button" class="btn danger" data-del>Ta bort foto</button>
      <button type="button" class="btn primary" data-close>Stäng</button>
    </div>`, (dlg) => {
    dlg.querySelector('[data-del]').onclick = async () => {
      closeSheet();
      const ok = await confirmSheet({ title: 'Ta bort fotot?', text: 'Det går inte att ångra.', ok: 'Ta bort', danger: true });
      if (!ok) return;
      cur.day.photos = cur.day.photos.filter((p) => p !== id);
      await saveDay();
      await db.remove(id);
      await db.delBlob(id);
      toast('Fotot är borttaget');
      render({ keep: true });
    };
  });
}

async function openPrnSheet(medId) {
  const { changes } = await loadMeds();
  const med = await db.get(medId);
  if (!med) return;
  const st = medState(medId, changes, cur.date);
  openSheet(`
    <form class="form" novalidate>
      <h2>${esc(med.data.name)}</h2>
      <p class="sheet-text">Vid behov, ${esc(fmtLong(cur.date).toLowerCase())}</p>
      <div class="field-row">
        <label class="field"><span>Tid</span><input type="time" name="time" value="${cur.date === today() ? nowTime() : '12:00'}"></label>
        <label class="field"><span>Dos (${esc(med.data.unit)})</span><input name="dose" inputmode="decimal" autocomplete="off" value="${esc(st.dose ?? '')}"></label>
      </div>
      <label class="field"><span>Kommentar</span><input name="note" autocomplete="off" placeholder="Valfritt, t.ex. varför"></label>
      <div class="sheet-actions">
        <button type="button" class="btn" data-close>Avbryt</button>
        <button class="btn primary">Spara</button>
      </div>
    </form>`, (dlg) => {
    dlg.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      await flushSave();
      await db.put({
        id: uuid(),
        type: 'prn',
        date: cur.date,
        data: { medId, time: String(f.get('time') || ''), dose: String(f.get('dose') || '').trim(), note: String(f.get('note') || '').trim() },
      });
      closeSheet();
      toast(`${med.data.name} sparad`);
      render({ keep: true });
    };
  });
}

async function deletePrn(id) {
  const ok = await confirmSheet({ title: 'Ta bort intaget?', ok: 'Ta bort', danger: true });
  if (!ok) return;
  await db.remove(id);
  render({ keep: true });
}

/* ---------- Medicin ---------- */

function medRow({ m, st }) {
  let status = '';
  if (st.active) status = `Sedan ${fmtDate(st.since)}`;
  else if (!st.started && st.startsAt) status = `Börjar ${fmtDate(st.startsAt)}`;
  else if (st.stoppedAt) status = `Utsatt ${fmtDate(st.stoppedAt)}`;
  const dose = st.active ? doseLabel(st.dose, m.data.unit) : '';
  return `
    <a class="row-link" href="#medicin-${encodeURIComponent(m.id)}">
      <span class="row-main">
        <b>${esc(m.data.name)}</b>
        <span>${esc([dose, timesLabel(m)].filter(Boolean).join(', '))}</span>
      </span>
      <span class="row-side">${esc(status)}</span>
      ${I.chev}
    </a>`;
}

async function renderMeds() {
  const { meds, changes } = await loadMeds();
  const t = today();
  const rows = meds.map((m) => ({ m, st: medState(m.id, changes, t) }));
  const fixed = rows.filter((r) => r.st.active && r.m.data.kind !== 'prn');
  const prn = rows.filter((r) => r.st.active && r.m.data.kind === 'prn');
  const planned = rows.filter((r) => !r.st.started);
  const stopped = rows.filter((r) => !r.st.active && r.st.started);

  const group = (title, list) => (list.length ? `
    <section class="block">
      <h2>${title}</h2>
      <div class="group">${list.map(medRow).join('')}</div>
    </section>` : '');

  view.innerHTML = `
    <header class="pagehead">
      <h1>Mediciner</h1>
      <button type="button" class="btn primary" data-act="med-add">${I.plus}Lägg till</button>
    </header>
    ${rows.length ? '' : `
      <div class="empty-state">
        <p>Lägg in de mediciner du tar, både fasta och vid behov. Dosändringar sparas som historik, så att de kan jämföras med hur du mår.</p>
        <button type="button" class="btn primary" data-act="med-add">${I.plus}Lägg till första medicinen</button>
      </div>`}
    ${group('Fasta', fixed)}
    ${group('Vid behov', prn)}
    ${group('Planerade', planned)}
    ${group('Utsatta', stopped)}`;
}

function changeText(c, prev, unit) {
  const dose = doseLabel(c.data.dose, unit);
  if (c.data.action === 'stop') return 'Utsatt';
  if (c.data.action === 'start') return prev ? `Insatt igen${dose ? `, ${dose}` : ''}` : `Insatt${dose ? `, ${dose}` : ''}`;
  const prevDose = prev && prev.data.action !== 'stop' ? doseLabel(prev.data.dose, unit) : '';
  return prevDose ? `Dos ändrad från ${prevDose} till ${dose}` : `Dos ändrad till ${dose}`;
}

async function renderMedDetail(id) {
  const med = await db.get(id);
  if (!med || med.deleted) {
    view.innerHTML = `
      <div class="page-error">
        <h1>Medicinen finns inte</h1>
        <p>Den kan ha tagits bort.</p>
        <a class="btn primary" href="#medicin">Till mediciner</a>
      </div>`;
    return;
  }
  const { changes } = await loadMeds();
  const own = changes.filter((c) => c.data.medId === id);
  const st = medState(id, changes, today());
  const unit = med.data.unit;

  let now;
  if (st.active) now = `<b>${esc(doseLabel(st.dose, unit) || 'Pågår')}</b><span>sedan ${esc(fmtDate(st.since))}</span>`;
  else if (!st.started) now = `<b>Inte påbörjad</b><span>börjar ${esc(fmtDate(st.startsAt))}</span>`;
  else now = `<b>Utsatt</b><span>sedan ${esc(fmtDate(st.stoppedAt))}</span>`;

  const actions = st.active || !st.started
    ? `<button type="button" class="btn" data-act="dose-change">Ändra dos</button>
       ${st.active ? '<button type="button" class="btn" data-act="dose-stop">Sätt ut</button>' : ''}`
    : '<button type="button" class="btn" data-act="dose-restart">Sätt in igen</button>';

  const items = own.map((c, i) => ({ c, text: changeText(c, own[i - 1], unit) })).reverse();

  view.innerHTML = `
    <header class="pagehead stacked">
      <a class="back" href="#medicin">${I.prev}Mediciner</a>
      <h1>${esc(med.data.name)}</h1>
      <p class="pagehead-sub">${esc(timesLabel(med))}${med.data.note ? `. ${esc(med.data.note)}` : ''}</p>
    </header>
    <section class="now-panel">${now}</section>
    <div class="actions" data-med="${esc(id)}">
      ${actions}
      <button type="button" class="btn" data-act="med-edit">Redigera</button>
    </div>
    <section class="block">
      <h2>Historik</h2>
      <ol class="group timeline">
        ${items.map(({ c, text }) => `
          <li>
            <button type="button" class="tl-item" data-act="change-edit" data-id="${esc(c.id)}">
              <span class="tl-date">${esc(fmtDate(c.date))}</span>
              <span class="tl-text">${esc(text)}${c.data.note ? `<small>${esc(c.data.note)}</small>` : ''}</span>
            </button>
          </li>`).join('')}
      </ol>
    </section>
    <div class="danger-zone">
      <button type="button" class="btn danger" data-act="med-delete">Ta bort medicinen</button>
    </div>`;
}

function timeRow(v) {
  return `<div class="time-row"><input type="time" name="time" value="${esc(v)}" aria-label="Tid"><button type="button" class="iconbtn" data-rm aria-label="Ta bort tiden">${I.x}</button></div>`;
}

function unitOptions(sel) {
  const list = UNITS.includes(sel) ? UNITS : [sel, ...UNITS];
  return list.map((u) => `<option${u === sel ? ' selected' : ''}>${esc(u)}</option>`).join('');
}

async function openMedSheet(med) {
  const isNew = !med;
  const d = med ? med.data : { name: '', kind: 'fixed', unit: 'mg', times: ['08:00'], note: '' };
  const times = d.times?.length ? d.times : [''];
  openSheet(`
    <form class="form" novalidate>
      <h2>${isNew ? 'Lägg till medicin' : 'Redigera medicin'}</h2>
      <label class="field"><span>Namn</span><input name="name" value="${esc(d.name)}" autocomplete="off" autocapitalize="sentences" placeholder="t.ex. Metotrexat"></label>
      <fieldset class="field">
        <legend>Typ</legend>
        <div class="choice two">
          <label><input type="radio" name="kind" value="fixed" class="vh"${d.kind !== 'prn' ? ' checked' : ''}><span>Fast schema</span></label>
          <label><input type="radio" name="kind" value="prn" class="vh"${d.kind === 'prn' ? ' checked' : ''}><span>Vid behov</span></label>
        </div>
      </fieldset>
      <div class="field-row">
        ${isNew ? '<label class="field"><span>Dos</span><input name="dose" inputmode="decimal" autocomplete="off" placeholder="t.ex. 15"></label>' : ''}
        <label class="field"><span>Enhet</span><select name="unit">${unitOptions(d.unit)}</select></label>
      </div>
      ${isNew ? `<label class="field"><span>Började</span><input type="date" name="start" value="${today()}"></label>` : ''}
      <fieldset class="field" data-days${d.kind === 'prn' ? ' hidden' : ''}>
        <legend>Vilka dagar</legend>
        <div class="choice two">
          <label><input type="radio" name="freq" value="daily" class="vh"${d.weekdays?.length ? '' : ' checked'}><span>Varje dag</span></label>
          <label><input type="radio" name="freq" value="weekly" class="vh"${d.weekdays?.length ? ' checked' : ''}><span>Vissa veckodagar</span></label>
        </div>
        <div class="weekdays"${d.weekdays?.length ? '' : ' hidden'}>
          ${WEEKDAYS.map(([n, short, plural]) => `<label><input type="checkbox" name="wd" value="${n}" class="vh"${d.weekdays?.includes(n) ? ' checked' : ''}><span aria-label="${cap(plural)}">${short}</span></label>`).join('')}
        </div>
      </fieldset>
      <div class="field" data-times${d.kind === 'prn' ? ' hidden' : ''}>
        <span class="label">Tider</span>
        <div class="times">${times.map(timeRow).join('')}</div>
        <button type="button" class="btn small" data-addtime>${I.plus}Lägg till tid</button>
      </div>
      <label class="field"><span>Anteckning</span><input name="note" value="${esc(d.note || '')}" autocomplete="off" placeholder="Valfritt, t.ex. tas med mat"></label>
      <p class="form-error" role="alert" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" data-close>Avbryt</button>
        <button class="btn primary">${isNew ? 'Lägg till' : 'Spara'}</button>
      </div>
    </form>`, (dlg) => {
    const form = dlg.querySelector('form');
    const timesBox = dlg.querySelector('[data-times]');
    const daysBox = dlg.querySelector('[data-days]');
    form.querySelectorAll('input[name=kind]').forEach((r) => r.addEventListener('change', () => {
      timesBox.hidden = form.kind.value === 'prn';
      daysBox.hidden = form.kind.value === 'prn';
    }));
    form.querySelectorAll('input[name=freq]').forEach((r) => r.addEventListener('change', () => {
      dlg.querySelector('.weekdays').hidden = form.freq.value !== 'weekly';
    }));
    dlg.querySelector('[data-addtime]').onclick = () => {
      dlg.querySelector('.times').insertAdjacentHTML('beforeend', timeRow(''));
    };
    dlg.querySelector('.times').addEventListener('click', (e) => {
      const b = e.target.closest('[data-rm]');
      if (b) b.closest('.time-row').remove();
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const name = String(f.get('name') || '').trim();
      const err = form.querySelector('.form-error');
      if (!name) {
        err.textContent = 'Skriv medicinens namn.';
        err.hidden = false;
        form.name.focus();
        return;
      }
      const kind = f.get('kind') === 'prn' ? 'prn' : 'fixed';
      const weekdays = kind === 'fixed' && f.get('freq') === 'weekly' ? f.getAll('wd').map(Number).sort() : [];
      if (kind === 'fixed' && f.get('freq') === 'weekly' && !weekdays.length) {
        err.textContent = 'Välj minst en veckodag.';
        err.hidden = false;
        return;
      }
      const data = {
        weekdays: weekdays.length === 7 ? [] : weekdays,
        name,
        kind,
        unit: String(f.get('unit') || 'mg'),
        times: kind === 'prn' ? [] : [...new Set(f.getAll('time').map(String).filter(Boolean))].sort(),
        note: String(f.get('note') || '').trim(),
      };
      if (isNew) {
        const start = isDate(f.get('start')) ? f.get('start') : today();
        const id = uuid();
        await db.put({ id, type: 'med', data });
        await db.put({ id: uuid(), type: 'medchange', date: start, data: { medId: id, action: 'start', dose: String(f.get('dose') || '').trim(), note: '' } });
        closeSheet();
        toast(`${name} är tillagd`);
        render();
      } else {
        await db.put({ id: med.id, type: 'med', data });
        closeSheet();
        toast('Ändringarna är sparade');
        render({ keep: true });
      }
    };
  });
}

// action: 'change' | 'stop' | 'start'. Med `change` redigeras en befintlig händelse.
async function openChangeSheet(med, action, change) {
  const editing = !!change;
  const act = editing ? change.data.action : action;
  const name = med.data.name;
  const title = editing ? 'Ändra händelse'
    : act === 'stop' ? `Sätt ut ${name}`
      : act === 'start' ? `Sätt in ${name} igen`
        : `Ändra dos för ${name}`;
  const { changes } = await loadMeds();
  const own = changes.filter((c) => c.data.medId === med.id);
  openSheet(`
    <form class="form" novalidate>
      <h2>${esc(title)}</h2>
      <label class="field"><span>Datum</span><input type="date" name="date" value="${esc(editing ? change.date : today())}"></label>
      ${act !== 'stop' ? `<label class="field"><span>${act === 'change' && !editing ? 'Ny dos' : 'Dos'} (${esc(med.data.unit)})</span><input name="dose" inputmode="decimal" autocomplete="off" value="${esc(editing ? change.data.dose ?? '' : '')}"></label>` : ''}
      <label class="field"><span>Kommentar</span><input name="note" autocomplete="off" value="${esc(editing ? change.data.note ?? '' : '')}" placeholder="Valfritt, t.ex. ordinerat av läkaren"></label>
      <p class="form-error" role="alert" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" data-close>Avbryt</button>
        <button class="btn primary">Spara</button>
      </div>
      ${editing ? '<button type="button" class="btn danger wide" data-del>Ta bort händelsen</button>' : ''}
    </form>`, (dlg) => {
    const form = dlg.querySelector('form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const err = form.querySelector('.form-error');
      const date = String(f.get('date') || '');
      const dose = String(f.get('dose') ?? '').trim();
      if (!isDate(date)) { err.textContent = 'Välj ett datum.'; err.hidden = false; return; }
      if (act === 'change' && !dose) { err.textContent = 'Skriv den nya dosen.'; err.hidden = false; return; }
      const data = { medId: med.id, action: act, dose: act === 'stop' ? '' : dose, note: String(f.get('note') || '').trim() };
      await db.put({ id: editing ? change.id : uuid(), type: 'medchange', date, data });
      closeSheet();
      toast(act === 'stop' ? `${name} är utsatt` : 'Sparat');
      render({ keep: true });
    };
    dlg.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (own.length <= 1) {
        closeSheet();
        infoSheet('Händelsen kan inte tas bort', 'Det här är den enda händelsen för medicinen. Ta bort hela medicinen i stället om den lades in av misstag.');
        return;
      }
      closeSheet();
      const ok = await confirmSheet({ title: 'Ta bort händelsen?', text: `${fmtDate(change.date)}: ${changeText(change, null, med.data.unit)}`, ok: 'Ta bort', danger: true });
      if (!ok) return;
      await db.remove(change.id);
      render({ keep: true });
    });
  });
}

async function deleteMed(med) {
  const ok = await confirmSheet({
    title: `Ta bort ${med.data.name}?`,
    text: 'Medicinen och hela dos-historiken tas bort. Det går inte att ångra.',
    ok: 'Ta bort',
    danger: true,
  });
  if (!ok) return;
  const { changes } = await loadMeds();
  for (const c of changes.filter((x) => x.data.medId === med.id)) await db.remove(c.id);
  await db.remove(med.id);
  toast(`${med.data.name} är borttagen`);
  go('#medicin');
}

/* ---------- Historik ---------- */

async function renderHistory() {
  const [days, prns, { meds }] = await Promise.all([db.list('day'), db.list('prn'), loadMeds()]);
  const byDate = new Map(days.map((d) => [d.date, d.data]));
  const medName = new Map(meds.map((m) => [m.id, m.data.name]));
  const prnBy = new Map();
  for (const p of prns) {
    if (!prnBy.has(p.date)) prnBy.set(p.date, []);
    prnBy.get(p.date).push(p);
  }
  const t = today();
  const dates = [...byDate.keys(), ...prnBy.keys()].filter((d) => d <= t).sort();

  if (!dates.length) {
    view.innerHTML = `
      <header class="pagehead"><h1>Historik</h1></header>
      <div class="empty-state">
        <p>Här visas varje dag som har loggats, med de viktigaste värdena och anteckningarna.</p>
        <a class="btn primary" href="#idag">Gör dagens incheckning</a>
      </div>`;
    return;
  }

  const total = daysBetween(dates[0], t) + 1;
  const span = Math.min(historyDays, total);
  const meterScales = settings.scales.filter((s) => s.visible).slice(0, 2);
  const flagLabel = new Map(settings.flags.map((f) => [f.key, f.label]));

  const rows = [];
  for (let i = 0; i < span; i += 1) {
    const date = addDays(t, -i);
    const d = byDate.get(date);
    const p = prnBy.get(date) || [];
    const href = date === t ? '#idag' : `#idag-${date}`;
    const head = `<span class="dr-date"><b>${esc(fmtWeekday(date))}</b><span>${esc(fmtDate(date))}</span></span>`;
    if (!d && !p.length) {
      rows.push(`<a class="dayrow empty-day" href="${href}">${head}<span class="dr-body"><span class="muted">Ingen incheckning</span></span></a>`);
      continue;
    }
    const meters = meterScales.map((s) => {
      const v = d?.scales?.[s.key];
      return `<span class="meter ${s.good === 'high' ? 'good-high' : 'good-low'}"><span class="meter-label">${esc(s.label)}</span><span class="meter-track"><span class="meter-fill" style="--w:${v != null ? v * 10 : 0}%"></span></span><span class="meter-val">${v ?? '–'}</span></span>`;
    }).join('');
    const tags = Object.keys(d?.flags || {}).filter((k) => d.flags[k]).map((k) => `<span class="tag${k === 'flare' ? ' tag-flare' : ''}">${esc(flagLabel.get(k) || k)}</span>`);
    if (d?.sleep?.hours != null) tags.push(`<span class="tag tag-life">Sömn ${esc(num(d.sleep.hours))} h</span>`);
    if (d?.rest) tags.push('<span class="tag tag-life">Vila</span>');
    const tr = trainingOf(d);
    for (const sec of SECTIONS) {
      if (!sectionActive(tr[sec])) continue;
      const names = tr[sec].types.map((k) => typeLabel(k)).join(', ');
      tags.push(`<span class="tag tag-life">${esc(names)}${tr[sec].minutes ? ` ${tr[sec].minutes} min` : ''}${tr[sec].intensity === 'hard' ? ', hård' : ''}</span>`);
    }
    if (d?.alcohol) tags.push(`<span class="tag tag-life">Alkohol ${esc(num(d.alcohol))}</span>`);
    if (p.length) {
      const counts = new Map();
      p.forEach((x) => { const n = medName.get(x.data.medId) || 'Borttagen'; counts.set(n, (counts.get(n) || 0) + 1); });
      tags.push(...[...counts].map(([n, c]) => `<span class="tag tag-prn">${esc(n)}${c > 1 ? ` ×${c}` : ''}</span>`));
    }
    const note = d?.note ? `<span class="dr-note">${esc(d.note.length > 90 ? `${d.note.slice(0, 90).trim()} …` : d.note)}</span>` : '';
    rows.push(`<a class="dayrow" href="${href}">${head}<span class="dr-body">${meters}${tags.length ? `<span class="tags">${tags.join('')}</span>` : ''}${note}</span></a>`);
  }

  view.innerHTML = `
    <header class="pagehead"><h1>Historik</h1></header>
    <div class="group history">${rows.join('')}</div>
    ${total > span ? '<div class="more-wrap"><button type="button" class="btn" data-act="history-more">Visa 30 dagar till</button></div>' : ''}`;
}

/* ---------- Analys ---------- */

let anaRange = 30;
let anaWindow = 28;
let anaShowAll = false;
let anaCompare = null; // nyckel för jämförelsekurvan, 'none' för ingen. Läses från meta vid första visning.
let anaCtx = null;

const RANGES = [[14, '2 veckor'], [30, '1 månad'], [90, '3 månader'], [0, 'Allt']];
const WINDOWS = [[14, '14 dagar'], [28, '28 dagar'], [56, '56 dagar']];
const pct = (v) => `${Math.round(v * 100)} %`;
const fmtOut = (o, v) => (v == null ? '–' : o.type === 'rate' ? pct(v) : num(v));

function diffPill(diff, better, type, small = 0.3) {
  if (diff == null) return '<span class="pill-diff neutral">–</span>';
  const size = type === 'rate' ? Math.abs(diff) < 0.05 : Math.abs(diff) < small;
  if (size) return '<span class="pill-diff neutral">Oförändrat</span>';
  const txt = type === 'rate' ? `${diff > 0 ? '+' : '−'}${Math.round(Math.abs(diff) * 100)} %` : `${diff > 0 ? '+' : '−'}${num(Math.abs(diff))}`;
  return `<span class="pill-diff ${better ? 'better' : 'worse'}">${txt} ${better ? 'bättre' : 'sämre'}</span>`;
}

function seg(act, list, cur) {
  return `<div class="seg" role="group">${list.map(([v, l]) => `<button type="button" data-act="${act}" data-v="${v}" class="${v === cur ? 'on' : ''}" aria-pressed="${v === cur}">${l}</button>`).join('')}</div>`;
}

async function renderAnalysis() {
  const [days, prns, { meds, changes }] = await Promise.all([db.list('day'), db.list('prn'), loadMeds()]);
  const t = today();
  const dated = days.map((d) => d.date).filter((d) => d <= t).sort();
  if (!dated.length) {
    view.innerHTML = `
      <header class="pagehead"><h1>Analys</h1></header>
      <div class="empty-state">
        <p>Här visas grafer över hur du mår och vad du gjort, och mönster som appen hittar i datan. Det behövs några dagars incheckningar innan det finns något att visa.</p>
        <a class="btn primary" href="#idag">Gör dagens incheckning</a>
      </div>`;
    return;
  }

  const earliestChange = changes.length ? addDays(changes[0].date, -56) : t;
  const from = [dated[0], addDays(t, -13), earliestChange].sort()[0];
  const rows = buildDays({ days, prns, from, to: t });
  const loggedDays = rows.filter((r) => r.logged);
  const firstLogged = loggedDays.length ? loggedDays[0].date : dated[0];
  const medBy = new Map(meds.map((m) => [m.id, m]));
  // Vid behov-mediciner är inte behandlingsändringar och jämförs inte före/efter.
  const txChanges = changes.filter((c) => medBy.get(c.data.medId)?.data.kind !== 'prn');

  // Graferna
  let rs = anaRange ? addDays(t, -(anaRange - 1)) : firstLogged;
  if (rs < firstLogged) rs = firstLogged;
  if (daysBetween(rs, t) < 6) rs = addDays(t, -6);
  if (rs < from) rs = from;
  const i0 = rows.findIndex((r) => r.date === rs);
  const slice = rows.slice(i0);
  const dates = slice.map((r) => r.date);

  const inRange = txChanges.filter((c) => c.date >= rs && c.date <= t);
  const marks = inRange.map((c, k) => ({ i: dates.indexOf(c.date), n: k + 1, c }));
  const flareIdx = slice.map((r, i) => (r.flags.flare ? i : -1)).filter((i) => i >= 0);

  const scaleCharts = settings.scales.filter((s) => s.visible).map((s) => {
    const all = rows.map((r) => r.scales[s.key] ?? null);
    const vals = all.slice(i0);
    const avgAll = rolling(all);
    const present = vals.filter((v) => v != null);
    return { kind: 'line', key: s.key, label: s.label, good: s.good, values: vals, avg: avgAll.slice(i0), unit: '', mean: present.length ? present.reduce((a, b) => a + b, 0) / present.length : null, n: present.length };
  }).filter((c) => c.n > 0);

  const lifeDefs = [
    { key: 'sleep', label: 'Sömn', unit: 'h', minMax: 10, ref: 7, get: (r) => r.sleepH },
    { key: 'rest', label: 'Vila under dagen', unit: '', minMax: 1, binary: true, height: 76, get: (r) => (r.rest != null ? (r.rest ? 1 : 0) : r.logged ? 0 : null) },
    { key: 'cardio', label: 'Kondition', unit: 'min', minMax: 60, get: (r) => (r.cardioAny ? r.cardioMin : r.logged ? 0 : null), intensity: (r) => r.cardioInt },
    { key: 'strength', label: 'Styrka och rörlighet', unit: 'min', minMax: 30, get: (r) => (r.strengthAny ? r.strengthMin : r.logged ? 0 : null), intensity: (r) => r.strengthInt },
    { key: 'alcohol', label: 'Alkohol', unit: 'glas', minMax: 4, get: (r) => (r.logged ? r.alcohol || 0 : null) },
    { key: 'prn', label: 'Vid behov-medicin', unit: 'st', minMax: 4, get: (r) => (r.logged || r.prn ? r.prn : null) },
  ];
  const lifeCharts = lifeDefs.map((d) => {
    const vals = slice.map(d.get);
    const present = vals.filter((v) => v != null);
    const levels = d.intensity ? slice.map(d.intensity) : null;
    return { kind: 'bar', ...d, values: vals, levels, mean: present.length ? present.reduce((a, b) => a + b, 0) / present.length : null, any: present.some((v) => v > 0) };
  }).filter((c) => c.any);

  // Jämförelsekurva: standard är Allmänt mående
  if (anaCompare == null) anaCompare = (await db.getMeta('anaCompare')) || 'wellbeing';
  const cmpOptions = settings.scales.filter((x) => x.visible && !x.deleted);
  let cmpDef = anaCompare === 'none' ? null : cmpOptions.find((x) => x.key === anaCompare) || cmpOptions[0] || null;
  let cmp = null;
  if (cmpDef) {
    const all = rows.map((r) => r.scales[cmpDef.key] ?? null);
    cmp = { key: cmpDef.key, label: cmpDef.label, values: all.slice(i0), avg: rolling(all).slice(i0) };
  }
  const cmpSel = cmp ? cmp.key : 'none';

  anaCtx = { dates, marks, flareIdx, charts: [...scaleCharts, ...lifeCharts], sel: null, cmp, padR: cmp ? PAD_R_CMP : undefined };

  const chartCard = (c, idx) => `
    <div class="chart-card">
      <div class="chart-head">
        <span class="chart-title">${esc(c.label)}${c.unit ? ` <small>${esc(c.unit)}</small>` : ''}</span>
        <span class="chart-read" data-ci="${idx}">${esc(defaultRead(c))}</span>
      </div>
      ${cmp && c.key !== cmp.key ? `<p class="chart-cmp-read" data-ci="${idx}" hidden></p>` : ''}
      <div class="chart-box" data-ci="${idx}"></div>
      ${c.levels ? `<div class="lvl-legend" aria-hidden="true">${INTENSITY.map(([k, l]) => `<span><i class="sw lvl-${k}"></i>${l}</span>`).join('')}</div>` : ''}
    </div>`;

  // Veckan
  const week = weekSummary(rows, settings);
  const weekRows = week.filter((w) => w.nCur > 0 || w.nPrev > 0).map((w) => `
    <li class="week-row">
      <span class="week-label">${esc(w.label)}</span>
      <span class="week-val ${w.good === 'high' ? 'good-high' : 'good-low'}">${w.cur == null ? '–' : num(w.cur)}</span>
      ${w.prev == null || w.cur == null ? '<span class="pill-diff neutral">Ingen jämförelse</span>' : diffPill(w.diff, w.better, 'scale')}
    </li>`).join('');

  // Samband
  // Mediciner som tas vissa veckodagar (t.ex. Metotrexat på tisdagar) jämförs som påverkan.
  // En dag räknas som dosdag om den är avbockad, eller om den är schemalagd och ingen dos är avbockad inom 3 dagar.
  const medFactors = meds.filter((m) => m.data.kind !== 'prn' && m.data.weekdays?.length && m.data.weekdays.length < 7).map((m) => {
    const tickDates = new Set(rows.filter((r) => Object.keys(r.taken).some((k) => k.startsWith(`${m.id}@`) && r.taken[k])).map((r) => r.date));
    const near = (date) => { for (let k = -3; k <= 3; k += 1) if (tickDates.has(addDays(date, k))) return true; return false; };
    const doseDay = (r) => tickDates.has(r.date) || (!near(r.date) && scheduledOn(m, r.date) && medState(m.id, changes, r.date).active);
    return { key: `med_${m.id}`, label: m.data.name, noun: lower(m.data.name), lags: [0, 1, 2], get: (r) => (r.logged ? (doseDay(r) ? 1 : 0) : null) };
  });
  const pat = findPatterns(rows, settings, medFactors);
  const MIN_DAYS = 14;
  let patternsHTML;
  if (pat.logged < MIN_DAYS) {
    patternsHTML = `
      <div class="empty-state">
        <p>Appen letar efter mönster när det finns minst ${MIN_DAYS} dagar med incheckning. Nu finns ${pat.logged}.</p>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${MIN_DAYS}" aria-valuenow="${pat.logged}"><span style="--w:${Math.round((pat.logged / MIN_DAYS) * 100)}%"></span></div>
      </div>`;
  } else if (!pat.results.length) {
    patternsHTML = `
      <div class="empty-state">
        <p>Inga tydliga mönster ännu, efter ${pat.tested} jämförelser. Ju fler dagar som loggas, och ju oftare sömn, träning, alkohol och kost fylls i, desto lättare blir det att se samband.</p>
      </div>`;
  } else {
    const shown = anaShowAll ? pat.results : pat.results.slice(0, 6);
    patternsHTML = `
      <ul class="findings">${shown.map(findingHTML).join('')}</ul>
      ${pat.results.length > shown.length ? `<div class="more-wrap"><button type="button" class="btn" data-act="ana-more">Visa alla ${pat.results.length} mönster</button></div>` : ''}
      <p class="caveat">Mönstren är jämförelser, inte bevis. Flera saker ändras ofta samtidigt, och sambandet kan gå åt andra hållet: man tränar kanske oftare de dagar man redan mår bra. Appen har gjort ${pat.tested} jämförelser, och bland så många dyker en del mönster upp av en slump. Ett mönster som finns kvar när fler dagar har loggats är mer pålitligt. Ta gärna med det som underlag till läkaren.</p>`;
  }

  // Medicinändringar
  const effects = medChangeEffects(rows, txChanges, settings, anaWindow).filter((e) => e.change.date >= firstLogged || e.loggedAfter > 0);
  const own = (medId) => changes.filter((c) => c.data.medId === medId);
  const medHTML = effects.length ? effects.map((e) => {
    const c = e.change;
    const m = medBy.get(c.data.medId);
    const list = own(c.data.medId);
    const prev = list[list.findIndex((x) => x.id === c.id) - 1];
    const others = e.others.map((o) => `${medBy.get(o.data.medId)?.data.name || 'Borttagen medicin'} ${fmtDate(o.date)}`);
    const rowsHTML = e.per.filter((p) => p.before.n || p.after.n).map((p) => {
      const few = p.before.n < 3 || p.after.n < 3;
      return `
        <tr>
          <th scope="row">${esc(p.outcome.type === 'rate' ? 'Dåliga dagar' : p.outcome.label)}</th>
          <td>${fmtOut(p.outcome, p.before.mean)}</td>
          <td>${fmtOut(p.outcome, p.after.mean)}</td>
          <td>${few ? '<span class="pill-diff neutral">För få dagar</span>' : diffPill(p.diff, p.better, p.outcome.type)}</td>
        </tr>`;
    }).join('');
    return `
      <li class="effect">
        <p class="effect-title"><b>${esc(m?.data.name || 'Borttagen medicin')}</b> ${esc(fmtDate(c.date))}</p>
        <p class="effect-sub">${esc(changeText(c, prev, m?.data.unit))}${c.data.note ? `. ${esc(c.data.note)}` : ''}</p>
        <p class="effect-meta">${anaWindow} dagar före jämfört med ${e.afterDays} ${e.afterDays === 1 ? 'dag' : 'dagar'} efter. Ifyllt ${e.loggedBefore} och ${e.loggedAfter} dagar.${e.afterDays < anaWindow ? ' Perioden efter pågår fortfarande.' : ''}</p>
        ${others.length ? `<p class="effect-warn">Under samma tid ändrades även ${esc(listSv(others))}, så skillnaden kan bero på flera saker.</p>` : ''}
        ${e.loggedBefore < 3 ? '<p class="muted effect-none">Det finns för få ifyllda dagar före ändringen att jämföra med.</p>' : rowsHTML ? `<div class="table-wrap"><table class="effect-table"><thead><tr><th scope="col"></th><th scope="col">Före</th><th scope="col">Efter</th><th scope="col">Skillnad</th></tr></thead><tbody>${rowsHTML}</tbody></table></div>` : '<p class="muted">Inga ifyllda dagar att jämföra ännu.</p>'}
      </li>`;
  }).join('') : '';

  view.innerHTML = `
    <header class="pagehead"><h1>Analys</h1></header>

    ${weekRows ? `
    <section class="block">
      <h2>Senaste 7 dagarna</h2>
      <p class="block-intro">Snitt jämfört med veckan innan.</p>
      <ul class="group week">${weekRows}</ul>
    </section>` : ''}

    <section class="block">
      <h2>Över tid</h2>
      ${seg('ana-range', RANGES, anaRange)}
      <div class="cmp-pick">
        <label for="ana-cmp">Jämför med</label>
        <select id="ana-cmp" data-act="ana-cmp">
          <option value="none"${cmpSel === 'none' ? ' selected' : ''}>Ingen jämförelse</option>
          ${cmpOptions.map((x) => `<option value="${esc(x.key)}"${cmpSel === x.key ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}
        </select>
      </div>
      ${cmp ? `<p class="cmp-legend"><svg class="sw-line" viewBox="0 0 26 8" aria-hidden="true"><path d="M1 4h24"/></svg><span>${esc(cmp.label)} visas streckad som snitt för 7 dagar. I staplarna visas den dag för dag, med skala till höger.</span></p>` : ''}
      <p class="block-intro chart-help">Linjen är snittet för 7 dagar och punkterna är enskilda dagar.${flareIdx.length ? ' Rosa fält är dagar med dålig period.' : ''} Dra fingret över en graf för att se en dag.</p>
      <div class="charts">
        ${scaleCharts.map((c, i) => chartCard(c, i)).join('')}
        ${lifeCharts.length ? `<p class="charts-sub">Sömn, träning och medicin</p>${lifeCharts.map((c, i) => chartCard(c, scaleCharts.length + i)).join('')}` : ''}
      </div>
      ${marks.length ? `
        <ol class="mark-legend">
          ${marks.map((mk) => {
            const m = medBy.get(mk.c.data.medId);
            const list = own(mk.c.data.medId);
            const prev = list[list.findIndex((x) => x.id === mk.c.id) - 1];
            return `<li><span class="mark-badge">${mk.n}</span><span><b>${esc(m?.data.name || 'Borttagen medicin')}</b> ${esc(fmtDate(mk.c.date))}: ${esc(lower(changeText(mk.c, prev, m?.data.unit)))}</span></li>`;
          }).join('')}
        </ol>` : ''}
    </section>

    <section class="block">
      <h2>Möjliga samband</h2>
      <p class="block-intro">Appen jämför dagar med och utan sömnbrist, vila, träning, alkohol, stress och kost${medFactors.length ? ` samt dosdagar för ${esc(listSv(medFactors.map((f) => f.label)))}` : ''}, samma dag och upp till två dagar efter.</p>
      ${patternsHTML}
    </section>

    <section class="block">
      <h2>Före och efter medicinändringar</h2>
      ${txChanges.length ? `
        ${seg('ana-window', WINDOWS, anaWindow)}
        <p class="block-intro chart-help">Många mediciner verkar först efter flera veckor. Välj en längre period när det har gått tillräckligt lång tid.</p>
        ${medHTML ? `<ul class="effects">${medHTML}</ul>` : '<p class="empty">Inga ändringar under perioden med incheckningar.</p>'}`
      : '<p class="empty">När en medicin läggs till eller dosen ändras visas en jämförelse här. <a href="#medicin">Gå till Medicin</a>.</p>'}
    </section>

    <p class="disclaimer">Appen ger inga medicinska råd. Ändringar av mediciner görs tillsammans med läkaren.</p>`;

  drawCharts();
}

function defaultRead(c) {
  if (c.mean == null) return 'Inga värden';
  if (c.binary) {
    const n = c.values.filter((v) => v != null).length;
    const yes = c.values.filter((v) => v === 1).length;
    return `${yes} av ${n} dagar`;
  }
  return `Snitt ${num(c.mean)}${c.unit && c.unit !== 'st' ? ` ${c.unit}` : ''}`;
}

function findingHTML(f) {
  const rate = f.outcome.type === 'rate';
  const title = rate
    ? `Dåliga dagar är ${f.diff > 0 ? 'vanligare' : 'ovanligare'} ${f.phrase} ${f.factor.noun}`
    : `${f.outcome.label} är ${f.diff > 0 ? 'högre' : 'lägre'} ${f.phrase} ${f.factor.noun}`;
  const body = rate
    ? `${pct(f.yes.mean)} av dagarna jämfört med ${pct(f.no.mean)} övriga dagar.`
    : `Snitt ${num(f.yes.mean)} jämfört med ${num(f.no.mean)} övriga dagar.`;
  const max = rate ? 1 : 10;
  const tone = f.outcome.good === 'high' ? 'good-high' : 'good-low';
  return `
    <li class="finding ${f.better ? 'better' : 'worse'}">
      <div class="finding-top">
        <span class="strength ${f.strength}">${f.strength === 'clear' ? 'Tydligt mönster' : 'Möjligt mönster'}</span>
        <span class="dir">${f.better ? 'Bättre' : 'Sämre'}</span>
      </div>
      <p class="finding-title">${esc(cap(title))}</p>
      <div class="compare ${tone}">
        <span class="cmp-label">${esc(cap(f.phrase))} ${esc(f.factor.noun)}</span>
        <span class="cmp-track"><span class="cmp-fill yes" style="--w:${(f.yes.mean / max) * 100}%"></span></span>
        <span class="cmp-val">${fmtOut(f.outcome, f.yes.mean)}</span>
        <span class="cmp-label">Övriga dagar</span>
        <span class="cmp-track"><span class="cmp-fill no" style="--w:${(f.no.mean / max) * 100}%"></span></span>
        <span class="cmp-val">${fmtOut(f.outcome, f.no.mean)}</span>
      </div>
      <p class="finding-body">${esc(body)} Bygger på ${f.yes.n} och ${f.no.n} dagar.</p>
    </li>`;
}

function drawCharts() {
  if (!anaCtx) return;
  const boxes = view.querySelectorAll('.chart-box');
  if (!boxes.length) return;
  const width = Math.floor(boxes[0].clientWidth);
  if (width < 50) return;
  anaCtx.width = width;
  boxes.forEach((box) => {
    const c = anaCtx.charts[Number(box.dataset.ci)];
    const opts = { dates: anaCtx.dates, values: c.values, width, marks: anaCtx.marks, flareIdx: anaCtx.flareIdx, label: c.label, padR: anaCtx.padR };
    const cm = anaCtx.cmp && anaCtx.cmp.key !== c.key ? anaCtx.cmp : null;
    box.innerHTML = c.kind === 'line'
      ? timeChart({ ...opts, avg: c.avg, good: c.good, cmp: cm && { label: cm.label, avg: cm.avg } })
      : barChart({ ...opts, unit: c.unit, minMax: c.minMax, refLine: c.ref ?? null, levels: c.levels, binary: !!c.binary, height: c.height, cmp: cm && { label: cm.label, values: cm.values } });
  });
  if (anaCtx.sel != null) selectDay(anaCtx.sel);
}

function selectDay(i) {
  if (!anaCtx) return;
  anaCtx.sel = i;
  const g = geometry(anaCtx.width, 100, anaCtx.dates.length, anaCtx.padR);
  view.querySelectorAll('.chart-box .cursor').forEach((l) => {
    if (i == null) { l.setAttribute('visibility', 'hidden'); return; }
    l.setAttribute('x1', g.x(i));
    l.setAttribute('x2', g.x(i));
    l.setAttribute('visibility', 'visible');
  });
  view.querySelectorAll('.chart-read').forEach((el) => {
    const c = anaCtx.charts[Number(el.dataset.ci)];
    if (i == null) {
      el.textContent = defaultRead(c);
      el.classList.remove('picked');
      return;
    }
    const v = c.values[i];
    const val = v == null ? '–' : c.binary ? (v ? 'Ja' : 'Nej') : `${num(v)}${c.unit && c.unit !== 'st' ? ` ${c.unit}` : ''}`;
    el.textContent = `${fmtWeekday(anaCtx.dates[i])} ${fmtShort(anaCtx.dates[i])}: ${val}`;
    el.classList.add('picked');
  });
  view.querySelectorAll('.chart-cmp-read').forEach((el) => {
    if (i == null || !anaCtx.cmp) { el.hidden = true; return; }
    const v = anaCtx.cmp.values[i];
    el.textContent = `${anaCtx.cmp.label}: ${v == null ? 'inte ifyllt' : num(v)}`;
    el.hidden = false;
  });
}

function scrub(e) {
  const box = e.target.closest('.chart-box');
  if (!box || !anaCtx) return;
  const rect = box.getBoundingClientRect();
  const g = geometry(anaCtx.width, 100, anaCtx.dates.length, anaCtx.padR);
  const x = e.clientX - rect.left;
  const i = Math.max(0, Math.min(anaCtx.dates.length - 1, Math.floor((x - g.left) / g.step)));
  if (i !== anaCtx.sel) selectDay(i);
}

view.addEventListener('pointerdown', (e) => { if (e.target.closest('.chart-box')) scrub(e); });
view.addEventListener('pointermove', (e) => {
  if (!e.target.closest('.chart-box')) {
    if (e.pointerType === 'mouse' && anaCtx?.sel != null) selectDay(null);
    return;
  }
  if (e.pointerType === 'mouse' || e.buttons) scrub(e);
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (parseRoute().tab === 'analys') drawCharts(); }, 150);
});

/* ---------- Synk ---------- */

const SYNC_TEXT = {
  idle: 'Synkar snart.',
  syncing: 'Synkar …',
  ok: 'Allt är synkat.',
  pending: 'Ändringar väntar på att skickas.',
  offline: 'Ingen kontakt med servern. Ändringarna skickas när det finns nät.',
  auth: 'Inloggningen har gått ut. Logga in igen för att fortsätta synka.',
};
const syncOn = (st) => ['idle', 'syncing', 'ok', 'pending', 'offline', 'error'].includes(st.status);

// Tillägg till "Sparat 14:02" på dagens sida.
function syncSuffix() {
  const st = sync.getState();
  if (!st.available || st.status === 'off') return '';
  if (st.status === 'ok' && cur?.updatedAt && st.lastSyncAt >= cur.updatedAt) return ' och synkat';
  if (st.status === 'offline') return '. Synkas när det finns nät';
  if (st.status === 'auth') return '. Synken är pausad, se Mer';
  if (st.status === 'error') return '. Synken misslyckades, se Mer';
  return '';
}

function syncSectionHTML() {
  const st = sync.getState();
  let body;
  if (!st.available) {
    body = '<p class="block-intro">Synk finns inte i testversionen.</p>';
  } else if (st.status === 'off') {
    body = `
      ${st.error ? `<p class="sync-status bad">${esc(st.error)}</p>` : ''}
      <p class="block-intro">Datan finns just nu bara på den här telefonen. Logga in för att spara den på servern, så att den finns kvar om telefonen byts ut eller tappas bort.</p>
      <button type="button" class="btn primary" data-act="sync-login">Logga in</button>`;
  } else {
    const tone = st.status === 'ok' ? 'ok' : ['error', 'auth'].includes(st.status) ? 'bad' : 'wait';
    const text = st.status === 'error' ? `Synken misslyckades: ${st.error}` : SYNC_TEXT[st.status] || '';
    body = `
      <p class="sync-status ${tone}" id="sync-status" aria-live="polite">${esc(text)}</p>
      <p class="sync-meta">Inloggad som ${esc(st.email)}${st.lastSyncAt ? `. Senast synkat ${esc(clock(st.lastSyncAt))}` : ''}.</p>
      <div class="stack">
        ${st.status === 'auth'
          ? '<button type="button" class="btn primary" data-act="sync-login">Logga in igen</button>'
          : `<button type="button" class="btn" data-act="sync-now"${st.status === 'syncing' ? ' disabled' : ''}>Synka nu</button>`}
        <button type="button" class="btn" data-act="sync-logout">Logga ut</button>
      </div>
      <button type="button" class="btn danger wide" data-act="sync-wipe">Radera all data på servern</button>`;
  }
  return `
    <section class="block" id="sync-section">
      <h2>Synk mellan telefoner</h2>
      ${body}
    </section>`;
}

function onSyncStatus() {
  const r = parseRoute();
  if (r.tab === 'mer') {
    const el = document.getElementById('sync-section');
    if (el) el.outerHTML = syncSectionHTML();
  } else if (r.tab === 'idag' && cur && !saveTimer) {
    setSaved(savedText());
  }
}

async function onSyncRemote(changed) {
  if (changed.some((r) => r.type === 'settings')) await loadSettings();
  const busy = saveTimer || sheet.open || ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement?.tagName);
  if (!busy) render({ keep: true });
}

function busyButton(btn, text) {
  btn.disabled = true;
  btn.dataset.label = btn.textContent;
  btn.textContent = text;
}
function freeButton(btn) {
  btn.disabled = false;
  if (btn.dataset.label) btn.textContent = btn.dataset.label;
}
function showError(form, msg) {
  const err = form.querySelector('.form-error');
  err.textContent = msg;
  err.hidden = false;
}
const errText = (e) => (e instanceof sync.NetError ? 'Ingen kontakt med servern. Kontrollera uppkopplingen och försök igen.' : e?.message || 'Något gick fel.');

function openLoginSheet() {
  const st = sync.getState();
  openSheet(`
    <form class="form" novalidate>
      <h2>Logga in för synk</h2>
      <p class="sheet-text">Använd kontot som har skapats för dagboken. Allt som finns på telefonen skickas upp, och det som finns på servern hämtas hit.</p>
      <label class="field"><span>E-post</span><input type="email" name="email" autocomplete="username" autocapitalize="off" spellcheck="false" value="${esc(st.email)}"></label>
      <label class="field"><span>Lösenord</span><input type="password" name="password" autocomplete="current-password"></label>
      <p class="form-error" role="alert" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" data-close>Avbryt</button>
        <button class="btn primary">Logga in</button>
      </div>
    </form>`, (dlg) => {
    const form = dlg.querySelector('form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const email = form.email.value.trim();
      const password = form.password.value;
      if (!email || !password) { showError(form, 'Fyll i e-post och lösenord.'); return; }
      const btn = form.querySelector('button.primary');
      busyButton(btn, 'Loggar in …');
      try {
        await sync.signIn(email, password);
        closeSheet();
        toast('Inloggad. Synken är på.');
        render({ keep: true });
      } catch (err) {
        freeButton(btn);
        showError(form, errText(err));
      }
    };
  });
}

async function syncLogout() {
  const ok = await confirmSheet({
    title: 'Logga ut från synken?',
    text: 'Datan finns kvar på den här telefonen men synkas inte förrän du loggar in igen.',
    ok: 'Logga ut',
  });
  if (!ok) return;
  await sync.signOut();
  toast('Utloggad');
  render({ keep: true });
}

async function syncWipe() {
  const ok = await confirmSheet({
    title: 'Radera all data på servern?',
    text: 'All dagboksdata och alla foton tas bort från servern, även för andra telefoner som synkar. Datan på den här telefonen finns kvar.',
    ok: 'Fortsätt',
    danger: true,
  });
  if (!ok) return;
  openSheet(`
    <form class="form" novalidate>
      <h2>Bekräfta radering</h2>
      <p class="sheet-text">Skriv RADERA för att ta bort allt på servern. Det går inte att ångra.</p>
      <label class="field"><span>Bekräftelse</span><input name="word" autocomplete="off" autocapitalize="characters" spellcheck="false"></label>
      <p class="form-error" role="alert" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" data-close>Avbryt</button>
        <button class="btn danger-solid">Radera</button>
      </div>
    </form>`, (dlg) => {
    const form = dlg.querySelector('form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (form.word.value.trim().toUpperCase() !== 'RADERA') { showError(form, 'Skriv RADERA för att bekräfta.'); return; }
      const btn = form.querySelector('button.danger-solid');
      busyButton(btn, 'Raderar …');
      try {
        await sync.deleteServerData();
        closeSheet();
        toast('Datan på servern är raderad');
        render({ keep: true });
      } catch (err) {
        freeButton(btn);
        showError(form, errText(err));
      }
    };
  });
}

/* ---------- Mer: inställningar och export ---------- */

async function renderMore() {
  const [lastExport, persisted] = await Promise.all([
    db.getMeta('lastExportAt'),
    navigator.storage?.persisted ? navigator.storage.persisted().catch(() => false) : Promise.resolve(false),
  ]);

  view.innerHTML = `
    <header class="pagehead"><h1>Mer</h1></header>

    ${syncSectionHTML()}

    ${Object.keys(LISTS).map(listSectionHTML).join('')}

    <section class="block">
      <h2>Säkerhetskopia och export</h2>
      <p class="block-intro">${syncOn(sync.getState()) ? 'Synken sparar allt på servern. En egen säkerhetskopia i Filer eller iCloud Drive då och då är en extra trygghet.' : 'Allt sparas på den här telefonen. Exportera en säkerhetskopia till Filer eller iCloud Drive minst en gång i veckan.'}
        ${lastExport ? `Senaste säkerhetskopia: ${esc(clock(lastExport))}.` : 'Ingen säkerhetskopia är exporterad ännu.'}</p>
      <div class="stack">
        <button type="button" class="btn primary" data-act="export-json">Exportera säkerhetskopia</button>
        <button type="button" class="btn" data-act="export-days">Exportera dagboken som CSV</button>
        <button type="button" class="btn" data-act="export-meds">Exportera medicinhistorik som CSV</button>
        <label class="btn">Importera säkerhetskopia<input type="file" accept="application/json,.json" class="vh" data-act="import-input"></label>
      </div>
    </section>

    <section class="block about">
      <h2>Om appen</h2>
      <p>${persisted ? 'Telefonen har lovat att inte rensa appens data automatiskt.' : 'Lägg appen på hemskärmen så att telefonen inte rensar datan automatiskt.'}</p>
      <p>Appen ger inga medicinska råd. Ändringar av mediciner görs tillsammans med läkaren.</p>
      <p class="muted">Version ${APP_VERSION}</p>
    </section>`;
}

const LISTS = {
  scales: { title: 'Skalor i incheckningen', intro: 'Skattas 0–10 varje dag. Lägg de viktigaste överst.', add: 'Lägg till skala', newTitle: 'Ny skala', placeholder: 't.ex. Illamående' },
  flags: { title: 'Besvär och åkommor', intro: 'Visas som knappar under "Har du märkt något av detta?".', add: 'Lägg till besvär', newTitle: 'Nytt besvär', placeholder: 't.ex. Svullna leder' },
  cardioTypes: { title: 'Kondition', intro: 'Typer att välja mellan under Kondition.', add: 'Lägg till typ', newTitle: 'Ny konditionstyp', placeholder: 't.ex. Cykel' },
  strengthTypes: { title: 'Styrka och rörlighet', intro: 'Typer att välja mellan under Styrka och rörlighet.', add: 'Lägg till typ', newTitle: 'Ny typ', placeholder: 't.ex. Pilates' },
  diet: { title: 'Kost', intro: 'Visas under "Kost i dag". Analysen jämför dagar med och utan varje markering.', add: 'Lägg till kost', newTitle: 'Ny kostmarkering', placeholder: 't.ex. Sen middag' },
};
// Används av analysen och kan bara döljas.
const LOCKED = new Set(['flags:flare']);

const liveItems = (list) => settings[list].filter((x) => !x.deleted);

function listSectionHTML(list) {
  const cfg = LISTS[list];
  const items = liveItems(list);
  const rows = items.map((x, i) => {
    let sub = x.visible ? (x.hint || '') : 'Dold';
    if (list === 'scales') sub = `${x.good === 'high' ? 'Högt värde är bra' : 'Högt värde är besvär'}${x.visible ? '' : ', dold'}`;
    return `
    <li class="setrow">
      <button type="button" class="setrow-main" data-act="item-edit" data-list="${list}" data-key="${esc(x.key)}">
        <b>${esc(x.label)}</b>
        ${sub ? `<span>${esc(sub)}</span>` : ''}
      </button>
      <button type="button" class="iconbtn" data-act="item-move" data-list="${list}" data-key="${esc(x.key)}" data-dir="-1" aria-label="Flytta upp ${esc(x.label)}"${i === 0 ? ' disabled' : ''}>${I.up}</button>
      <button type="button" class="iconbtn" data-act="item-move" data-list="${list}" data-key="${esc(x.key)}" data-dir="1" aria-label="Flytta ner ${esc(x.label)}"${i === items.length - 1 ? ' disabled' : ''}>${I.down}</button>
    </li>`;
  }).join('');
  return `
    <section class="block">
      <h2>${cfg.title}</h2>
      <p class="block-intro">${esc(cfg.intro)}</p>
      ${rows ? `<ul class="group">${rows}</ul>` : '<p class="empty">Listan är tom.</p>'}
      <button type="button" class="btn small add" data-act="item-new" data-list="${list}">${I.plus}${cfg.add}</button>
    </section>`;
}

function openItemSheet(list, key) {
  const cfg = LISTS[list];
  const isNew = key == null;
  const idx = isNew ? -1 : settings[list].findIndex((x) => x.key === key);
  const item = isNew ? { key: `c_${uuid().slice(0, 8)}`, label: '', hint: '', visible: true, ...(list === 'scales' ? { good: 'low' } : {}) } : settings[list][idx];
  if (!item) return;
  const locked = LOCKED.has(`${list}:${item.key}`);
  const showHint = list === 'scales' || list === 'flags' || list === 'diet';
  openSheet(`
    <form class="form" novalidate>
      <h2>${isNew ? cfg.newTitle : `Redigera ${esc(item.label)}`}</h2>
      <label class="field"><span>Namn</span><input name="label" value="${esc(item.label)}" autocomplete="off" autocapitalize="sentences" placeholder="${esc(cfg.placeholder)}"></label>
      ${showHint ? `<label class="field"><span>Förklaring</span><input name="hint" value="${esc(item.hint || '')}" autocomplete="off" placeholder="Valfritt"></label>` : ''}
      ${list === 'scales' ? `
      <fieldset class="field">
        <legend>Vad betyder ett högt värde?</legend>
        <div class="choice two">
          <label><input type="radio" name="good" value="low" class="vh"${item.good !== 'high' ? ' checked' : ''}><span>Mer besvär</span></label>
          <label><input type="radio" name="good" value="high" class="vh"${item.good === 'high' ? ' checked' : ''}><span>Att det är bra</span></label>
        </div>
      </fieldset>` : ''}
      <label class="switch"><input type="checkbox" name="visible"${item.visible ? ' checked' : ''}><span>Visa i incheckningen</span></label>
      <p class="form-error" role="alert" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" data-close>Avbryt</button>
        <button class="btn primary">${isNew ? 'Lägg till' : 'Spara'}</button>
      </div>
      ${!isNew && !locked ? '<button type="button" class="btn danger wide" data-del>Ta bort</button>' : ''}
      ${locked ? '<p class="sheet-text form-note">Den här används i analysen och kan bara döljas.</p>' : ''}
    </form>`, (dlg) => {
    const form = dlg.querySelector('form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const label = String(f.get('label') || '').trim();
      const err = form.querySelector('.form-error');
      if (!label) {
        err.textContent = 'Skriv ett namn.';
        err.hidden = false;
        return;
      }
      if (liveItems(list).some((x) => x.key !== item.key && x.label.toLowerCase() === label.toLowerCase())) {
        err.textContent = `${label} finns redan i listan.`;
        err.hidden = false;
        return;
      }
      const next = { ...item, label, visible: f.get('visible') === 'on' };
      if (showHint) next.hint = String(f.get('hint') || '').trim();
      if (list === 'scales') next.good = f.get('good') === 'high' ? 'high' : 'low';
      if (isNew) settings[list].push(next);
      else settings[list][idx] = next;
      await saveSettings();
      closeSheet();
      toast(isNew ? `${label} är tillagd` : 'Ändringarna är sparade');
      render({ keep: true });
    };
    dlg.querySelector('[data-del]')?.addEventListener('click', async () => {
      closeSheet();
      const ok = await confirmSheet({
        title: `Ta bort ${item.label}?`,
        text: 'Den försvinner från incheckningen och analysen. Det som redan har loggats finns kvar i historiken och säkerhetskopian.',
        ok: 'Ta bort',
        danger: true,
      });
      if (!ok) return;
      settings[list][idx] = { ...item, visible: false, deleted: true };
      await saveSettings();
      toast(`${item.label} är borttagen`);
      render({ keep: true });
    });
  });
}

async function moveItem(list, key, dir) {
  const arr = settings[list];
  const live = arr.map((x, i) => (x.deleted ? -1 : i)).filter((i) => i >= 0);
  const pos = live.findIndex((i) => arr[i].key === key);
  const other = live[pos + dir];
  if (pos < 0 || other == null) return;
  const i = live[pos];
  [arr[i], arr[other]] = [arr[other], arr[i]];
  await saveSettings();
  render({ keep: true });
}

/* ---------- Export och import ---------- */

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function dataURLToBlob(url) {
  const [head, b64] = url.split(',');
  const mime = /data:([^;]+)/.exec(head)?.[1] || 'application/octet-stream';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// Filen förbereds först och delas sedan med ett eget tryck,
// eftersom iOS kräver att delning startas direkt av en knapptryckning.
function offerFile(file, { title, text, onShared }) {
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  openSheet(`
    <h2>${esc(title)}</h2>
    <p class="sheet-text">${esc(text)}</p>
    <p class="file-name">${esc(file.name)} <span>${(file.size / 1024).toFixed(file.size > 1048576 ? 0 : 1)} kB</span></p>
    <div class="sheet-actions">
      <button type="button" class="btn" data-close>Avbryt</button>
      <button type="button" class="btn primary" data-go>${canShare ? 'Spara eller dela' : 'Ladda ned'}</button>
    </div>`, (dlg) => {
    dlg.querySelector('[data-go]').onclick = () => {
      if (canShare) {
        navigator.share({ files: [file], title: file.name })
          .then(() => { closeSheet(); onShared?.(); })
          .catch((err) => { if (err?.name !== 'AbortError') { closeSheet(); download(file); onShared?.(); } });
      } else {
        download(file);
        closeSheet();
        onShared?.();
      }
    };
  });
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportJSON() {
  await flushSave();
  const records = await db.all();
  const blobs = {};
  for (const r of records) {
    if (r.type === 'photo' && !r.deleted) {
      const b = await db.getBlob(r.id);
      if (b) blobs[r.id] = await blobToDataURL(b);
    }
  }
  const payload = {
    app: 'dagbok',
    format: 1,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    records: records.map(({ pending, ...r }) => r),
    blobs,
  };
  const file = new File([JSON.stringify(payload)], `dagbok-sakerhetskopia-${today()}.json`, { type: 'application/json' });
  const nDays = records.filter((r) => r.type === 'day' && !r.deleted).length;
  offerFile(file, {
    title: 'Säkerhetskopian är klar',
    text: `${nDays} dagar och ${Object.keys(blobs).length} foton. Välj "Spara i Filer" och lägg den i iCloud Drive.`,
    onShared: async () => {
      await db.setMeta('lastExportAt', Date.now());
      toast('Säkerhetskopian är exporterad');
      if (parseRoute().tab === 'mer') render({ keep: true });
    },
  });
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCSV = (rows) => `﻿${rows.map((r) => r.map(csvCell).join(';')).join('\r\n')}`;

async function exportDaysCSV() {
  await flushSave();
  const [days, prns, { meds, changes }] = await Promise.all([db.list('day'), db.list('prn'), loadMeds()]);
  const medBy = new Map(meds.map((m) => [m.id, m]));
  const prnBy = new Map();
  prns.forEach((p) => { if (!prnBy.has(p.date)) prnBy.set(p.date, []); prnBy.get(p.date).push(p); });
  const dates = [...new Set([...days.map((d) => d.date), ...prnBy.keys()])].sort();
  const dayBy = new Map(days.map((d) => [d.date, d.data]));
  const stiff = new Map(STIFFNESS);

  const header = ['Datum', ...liveItems('scales').map((s) => s.label), 'Morgonstelhet', ...liveItems('flags').map((f) => f.label),
    'Sömn (h)', 'Sömnkvalitet (1–5)', 'Vila under dagen', 'Kondition', 'Kondition (min)', 'Kondition ansträngning',
    'Styrka och rörlighet', 'Styrka och rörlighet (min)', 'Styrka och rörlighet ansträngning', 'Alkohol (glas)', ...liveItems('diet').map((f) => `Kost: ${f.label}`),
    'Tagna mediciner', 'Vid behov', 'Antal foton', 'Anteckning'];
  const rows = dates.map((date) => {
    const d = dayBy.get(date) || emptyDay();
    const taken = Object.keys(d.taken || {}).filter((k) => d.taken[k]).map((k) => {
      const [medId, time] = k.split('@');
      const m = medBy.get(medId);
      if (!m) return 'Borttagen medicin';
      const st = medState(medId, changes, date);
      return [m.data.name, doseLabel(st.dose, m.data.unit), time !== 'dag' ? `kl. ${time}` : ''].filter(Boolean).join(' ');
    }).join(', ');
    const prn = (prnBy.get(date) || []).sort((a, b) => (a.data.time || '').localeCompare(b.data.time || '')).map((p) => {
      const m = medBy.get(p.data.medId);
      return [m ? m.data.name : 'Borttagen medicin', doseLabel(p.data.dose, m?.data.unit), p.data.time ? `kl. ${p.data.time}` : ''].filter(Boolean).join(' ');
    }).join(', ');
    return [
      date,
      ...liveItems('scales').map((s) => d.scales?.[s.key] ?? ''),
      d.stiffness ? stiff.get(d.stiffness) : '',
      ...liveItems('flags').map((f) => (d.flags?.[f.key] ? 'Ja' : '')),
      d.sleep?.hours != null ? num(d.sleep.hours) : '',
      d.sleep?.quality ?? '',
      d.rest == null ? '' : d.rest ? 'Ja' : 'Nej',
      ...SECTIONS.flatMap((sec) => {
        const x = trainingOf(d)[sec];
        return [
          x.types.includes('none') ? 'Ingen' : x.types.map((k) => typeLabel(k)).join(', '),
          sectionActive(x) ? x.minutes ?? '' : '',
          sectionActive(x) && x.intensity ? INT_LABEL.get(x.intensity) : '',
        ];
      }),
      d.alcohol ?? '',
      ...liveItems('diet').map((f) => (d.diet?.[f.key] ? 'Ja' : '')),
      taken,
      prn,
      (d.photos || []).length || '',
      d.note || '',
    ];
  });
  const file = new File([toCSV([header, ...rows])], `dagbok-${today()}.csv`, { type: 'text/csv' });
  offerFile(file, { title: 'Dagboken är klar', text: `${rows.length} dagar. Filen kan öppnas i Numbers eller Excel.` });
}

async function exportMedsCSV() {
  const [prns, { meds, changes }] = await Promise.all([db.list('prn'), loadMeds()]);
  const medBy = new Map(meds.map((m) => [m.id, m]));
  const label = { start: 'Insatt', change: 'Dosändring', stop: 'Utsatt' };
  const rows = [
    ...changes.map((c) => {
      const m = medBy.get(c.data.medId);
      return [c.date, '', m?.data.name ?? 'Borttagen medicin', m?.data.kind === 'prn' ? 'Vid behov' : 'Fast', label[c.data.action] || c.data.action, c.data.dose || '', m?.data.unit ?? '', c.data.note || ''];
    }),
    ...prns.map((p) => {
      const m = medBy.get(p.data.medId);
      return [p.date, p.data.time || '', m?.data.name ?? 'Borttagen medicin', 'Vid behov', 'Taget', p.data.dose || '', m?.data.unit ?? '', p.data.note || ''];
    }),
  ].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  const header = ['Datum', 'Tid', 'Medicin', 'Typ', 'Händelse', 'Dos', 'Enhet', 'Kommentar'];
  const file = new File([toCSV([header, ...rows])], `medicinhistorik-${today()}.csv`, { type: 'text/csv' });
  offerFile(file, { title: 'Medicinhistoriken är klar', text: `${rows.length} händelser. Filen kan öppnas i Numbers eller Excel.` });
}

const validRecord = (r) => r && typeof r.id === 'string' && typeof r.type === 'string'
  && typeof r.updatedAt === 'number' && (r.date == null || isDate(r.date));

async function importFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    infoSheet('Filen kunde inte läsas', 'Välj en säkerhetskopia som har exporterats från appen. Den slutar på .json.');
    return;
  }
  if (data?.app !== 'dagbok' || !Array.isArray(data.records)) {
    infoSheet('Fel sorts fil', 'Filen är inte en säkerhetskopia från dagboken.');
    return;
  }
  const records = data.records.filter(validRecord);
  const live = records.filter((r) => !r.deleted);
  const dayDates = live.filter((r) => r.type === 'day').map((r) => r.date).sort();
  const nMeds = live.filter((r) => r.type === 'med').length;
  const nPhotos = live.filter((r) => r.type === 'photo').length;
  const range = dayDates.length ? ` (${fmtDate(dayDates[0])} – ${fmtDate(dayDates[dayDates.length - 1])})` : '';
  const when = data.exportedAt ? new Date(data.exportedAt) : null;

  const ok = await confirmSheet({
    title: 'Importera säkerhetskopian?',
    text: `${when ? `Exporterad ${clock(when.getTime())}. ` : ''}${dayDates.length} dagar${range}, ${nMeds} mediciner och ${nPhotos} foton. Poster som har ändrats senare här i appen behålls.`,
    ok: 'Importera',
  });
  if (!ok) return;

  try {
    await flushSave();
    const written = await db.importRecords(records);
    for (const [id, url] of Object.entries(data.blobs || {})) {
      if (typeof url === 'string' && url.startsWith('data:') && !(await db.hasBlob(id))) {
        await db.putBlob(id, dataURLToBlob(url));
      }
    }
    await loadSettings();
    toast(written ? `${written} poster importerade` : 'Inget nytt att importera');
    render();
  } catch (err) {
    console.error(err);
    infoSheet('Importen avbröts', `Inget har ändrats. Felet var: ${err?.message || 'okänt'}.`);
  }
}

/* ---------- Händelser ---------- */

view.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !view.contains(el)) return;
  const act = el.dataset.act;
  const medId = parseRoute().tab === 'medicin' ? parseRoute().arg : null;

  switch (act) {
    case 'prev':
      go(`#idag-${addDays(cur.date, -1)}`);
      break;
    case 'next': {
      const n = addDays(cur.date, 1);
      go(n >= today() ? '#idag' : `#idag-${n}`);
      break;
    }
    case 'scale': {
      const k = el.dataset.key;
      const v = Number(el.dataset.v);
      if (cur.day.scales[k] === v) delete cur.day.scales[k];
      else cur.day.scales[k] = v;
      paintScale(k);
      queueSave();
      break;
    }
    case 'stiff': {
      const v = el.dataset.v;
      cur.day.stiffness = cur.day.stiffness === v ? null : v;
      el.parentElement.querySelectorAll('button').forEach((b) => {
        const on = b.dataset.v === cur.day.stiffness;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
      queueSave();
      break;
    }
    case 'flag': {
      const k = el.dataset.key;
      if (cur.day.flags[k]) delete cur.day.flags[k];
      else cur.day.flags[k] = true;
      el.classList.toggle('on', !!cur.day.flags[k]);
      el.setAttribute('aria-pressed', String(!!cur.day.flags[k]));
      queueSave();
      break;
    }
    case 'step': doStep(el.dataset.field, Number(el.dataset.dir)); break;
    case 'rest': {
      const v = el.dataset.v === 'yes';
      cur.day.rest = cur.day.rest === v ? null : v;
      paintChoice(el.parentElement, cur.day.rest == null ? null : cur.day.rest ? 'yes' : 'no');
      queueSave();
      break;
    }
    case 'sleepq': {
      const v = Number(el.dataset.v);
      cur.day.sleep.quality = cur.day.sleep.quality === v ? null : v;
      paintChoice(el.parentElement, cur.day.sleep.quality);
      queueSave();
      break;
    }
    case 'extype': {
      const sec = el.dataset.sec;
      const v = el.dataset.v;
      const d = cur.day[sec];
      if (v === 'none') d.types = d.types.includes('none') ? [] : ['none'];
      else if (d.types.includes(v)) d.types = d.types.filter((x) => x !== v);
      else d.types = [...d.types.filter((x) => x !== 'none'), v];
      if (!exActive(sec)) { d.minutes = null; d.intensity = null; }
      el.parentElement.querySelectorAll('button[data-v]').forEach((b) => {
        const on = d.types.includes(b.dataset.v);
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
      const det = view.querySelector(`.ex-detail[data-sec="${sec}"]`);
      det.hidden = !exActive(sec);
      if (!exActive(sec)) {
        paintChoice(det, null);
        const out = det.querySelector('output');
        out.textContent = stepText(`${sec}Minutes`);
        out.classList.add('unset');
      }
      queueSave();
      break;
    }
    case 'exint': {
      const d = cur.day[el.dataset.sec];
      const v = el.dataset.v;
      d.intensity = d.intensity === v ? null : v;
      paintChoice(el.parentElement, d.intensity);
      queueSave();
      break;
    }
    case 'diet': {
      const k = el.dataset.key;
      if (cur.day.diet[k]) delete cur.day.diet[k];
      else cur.day.diet[k] = true;
      el.classList.toggle('on', !!cur.day.diet[k]);
      el.setAttribute('aria-pressed', String(!!cur.day.diet[k]));
      queueSave();
      break;
    }
    case 'prn-add': openPrnSheet(el.dataset.med); break;
    case 'prn-del': deletePrn(el.dataset.id); break;
    case 'photo': openPhotoSheet(el.dataset.id); break;

    case 'med-add': openMedSheet(); break;
    case 'med-edit': openMedSheet(await db.get(medId)); break;
    case 'med-delete': deleteMed(await db.get(medId)); break;
    case 'dose-change': openChangeSheet(await db.get(medId), 'change'); break;
    case 'dose-stop': openChangeSheet(await db.get(medId), 'stop'); break;
    case 'dose-restart': openChangeSheet(await db.get(medId), 'start'); break;
    case 'change-edit': {
      const c = await db.get(el.dataset.id);
      if (c) openChangeSheet(await db.get(medId), c.data.action, c);
      break;
    }

    case 'ana-range': anaRange = Number(el.dataset.v); anaCtx = null; render({ keep: true }); break;
    case 'ana-window': anaWindow = Number(el.dataset.v); render({ keep: true }); break;
    case 'ana-more': anaShowAll = true; render({ keep: true }); break;
    case 'history-more':
      historyDays += 30;
      render({ keep: true });
      break;

    case 'item-edit': openItemSheet(el.dataset.list, el.dataset.key); break;
    case 'item-new': openItemSheet(el.dataset.list, null); break;
    case 'item-move': moveItem(el.dataset.list, el.dataset.key, Number(el.dataset.dir)); break;

    case 'sync-login': openLoginSheet(); break;
    case 'sync-now': sync.syncNow(); break;
    case 'sync-logout': syncLogout(); break;
    case 'sync-wipe': syncWipe(); break;
    case 'export-json': exportJSON(); break;
    case 'export-days': exportDaysCSV(); break;
    case 'export-meds': exportMedsCSV(); break;
    default: break;
  }
});

view.addEventListener('change', async (e) => {
  const el = e.target;
  const act = el.dataset.act;
  if (act === 'taken' && cur) {
    const k = el.dataset.k;
    if (el.checked) cur.day.taken[k] = true;
    else delete cur.day.taken[k];
    queueSave();
  } else if (act === 'ana-cmp') {
    anaCompare = el.value;
    db.setMeta('anaCompare', anaCompare).catch(() => {});
    render({ keep: true });
  } else if (act === 'photo-input' && el.files?.[0]) {
    const f = el.files[0];
    el.value = '';
    await addPhoto(f);
  } else if (act === 'import-input' && el.files?.[0]) {
    const f = el.files[0];
    el.value = '';
    await importFile(f);
  }
});

view.addEventListener('input', (e) => {
  if (e.target.dataset.act === 'note' && cur) {
    cur.day.note = e.target.value;
    queueSave();
  }
});

/* ---------- Start ---------- */

async function start() {
  try {
    await loadSettings();
  } catch (err) {
    console.error(err);
    view.innerHTML = `
      <div class="page-error">
        <h1>Lagringen går inte att öppna</h1>
        <p>Safari blockerar lagring, till exempel i privat surfning. Öppna appen från hemskärmen eller i ett vanligt Safari-fönster.</p>
      </div>`;
    return;
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  try {
    await sync.init({ onStatus: onSyncStatus, onRemote: onSyncRemote });
  } catch (err) {
    console.warn('Synk kunde inte starta:', err);
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker:', err));
  }
  render();
}

start();
