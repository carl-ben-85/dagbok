// Gemensamma hjälpfunktioner för datum och text.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
export const pad = (n) => String(n).padStart(2, '0');
export const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => dstr(new Date());
export const parseD = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate() + n); return dstr(d); };
export const daysBetween = (a, b) => Math.round((parseD(b) - parseD(a)) / 86400000);
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
export const fmtLong = (s) => cap(new Intl.DateTimeFormat('sv-SE', { weekday: 'long', day: 'numeric', month: 'long' }).format(parseD(s)));
export const fmtDate = (s) => {
  const d = parseD(s);
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return new Intl.DateTimeFormat('sv-SE', opts).format(d).replace('.', '');
};
export const fmtShort = (s) => new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short' }).format(parseD(s)).replace('.', '');
export const fmtWeekday = (s) => cap(new Intl.DateTimeFormat('sv-SE', { weekday: 'short' }).format(parseD(s)).replace('.', ''));
export const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const clock = (ts) => {
  const d = new Date(ts);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return dstr(d) === today() ? t : `${fmtDate(dstr(d))} ${t}`;
};
export const listSv = (arr) => (arr.length < 2 ? arr.join('') : `${arr.slice(0, -1).join(', ')} och ${arr[arr.length - 1]}`);
export const doseLabel = (dose, unit) => (dose ? `${dose} ${unit || ''}`.trim() : '');
// Decimaltal med svenskt komma, t.ex. 1,5
export const num = (v, d = 1) => (v == null || Number.isNaN(v) ? '–' : Number(v).toFixed(d).replace(/\.0+$/, '').replace('.', ','));

// Två sorters träning, var och en med typer, tid och ansträngning.
export const TRAINING = {
  cardio: {
    title: 'Kondition',
    types: [['walk', 'Promenad'], ['cardio_other', 'Annat']],
  },
  strength: {
    title: 'Styrka och rörlighet',
    types: [['strength', 'Styrka'], ['mobility', 'Rörlighet'], ['stretch', 'Stretch'], ['yoga', 'Yoga'], ['strength_other', 'Annat']],
  },
};
export const INTENSITY = [['light', 'Lätt'], ['medium', 'Medel'], ['hard', 'Hård']];

const emptySection = () => ({ types: [], minutes: null, intensity: null });

// Läser träning från en dag. Hanterar även det äldre formatet { exercise: { type, minutes, intensity } }.
export function trainingOf(d) {
  const out = {
    cardio: { ...emptySection(), ...(d?.cardio || {}), types: [...(d?.cardio?.types || [])] },
    strength: { ...emptySection(), ...(d?.strength || {}), types: [...(d?.strength?.types || [])] },
  };
  const ex = d?.exercise;
  if (ex?.type && !d.cardio && !d.strength) {
    if (ex.type === 'none') {
      out.cardio.types = ['none'];
      out.strength.types = ['none'];
    } else {
      const sec = ['strength', 'yoga'].includes(ex.type) ? 'strength' : 'cardio';
      const type = ex.type === 'other' ? 'cardio_other' : ex.type;
      out[sec] = { types: [type], minutes: ex.minutes ?? null, intensity: ex.intensity ?? null };
    }
  }
  return out;
}

export const sectionActive = (s) => s.types.length > 0 && !s.types.includes('none');

// Namn för typer som fanns i tidigare versioner, så att gammal historik får rätt etikett.
export const LEGACY_TYPE_LABELS = { run: 'Löpning', bike: 'Cykel', swim: 'Simning' };

// Veckodag 1 = måndag … 7 = söndag
export const isoDay = (s) => ((parseD(s).getDay() + 6) % 7) + 1;
export const WEEKDAYS = [[1, 'Mån', 'måndagar'], [2, 'Tis', 'tisdagar'], [3, 'Ons', 'onsdagar'], [4, 'Tor', 'torsdagar'], [5, 'Fre', 'fredagar'], [6, 'Lör', 'lördagar'], [7, 'Sön', 'söndagar']];
export const scheduledOn = (med, date) => !med.data.weekdays?.length || med.data.weekdays.includes(isoDay(date));
