// Synk till Supabase. Lokal-först: appen fungerar alltid mot IndexedDB och synken
// skickar och hämtar ändringar i bakgrunden när det finns nät.
// Datan lagras läsbart på servern och skyddas av inloggning och databasens radsäkerhet.
import * as db from './db.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const available = !!(SUPABASE_URL && SUPABASE_KEY);

const BATCH = 100;
const PAGE = 500;
const OVERLAP_MS = 5000;

let meta = null; // { email, userId, refreshToken, cursor, lastSyncAt, serverTag }
let session = null; // { access, expiresAt }
let refreshing = null;
let running = false;
let again = false;
let timer = null;
let state = { status: 'off', error: '' };
let onStatus = () => {};
let onRemote = () => {};

export class AuthError extends Error {}
export class NetError extends Error {}
export class ApiError extends Error {
  constructor(status, msg, code) { super(msg); this.status = status; this.code = code; }
}

function setStatus(status, error = '') {
  state = { status, error };
  try { onStatus(getState()); } catch (e) { console.warn(e); }
}

export function getState() {
  return {
    available,
    status: state.status,
    error: state.error,
    email: meta?.email || '',
    lastSyncAt: meta?.lastSyncAt || null,
  };
}

const saveMeta = () => db.setMeta('sync', meta);
const signedIn = () => !!(available && meta?.refreshToken);

// Servern skickar mikrosekunder ("…:00.123456+00:00"); Safari klarar bara millisekunder.
const parseTs = (s) => {
  const t = Date.parse(String(s || '').replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(t) ? 0 : t;
};

/* ---------- Start ---------- */

export async function init(opts = {}) {
  onStatus = opts.onStatus || onStatus;
  onRemote = opts.onRemote || onRemote;
  if (!available) { setStatus('unavailable'); return; }
  meta = (await db.getMeta('sync')) || null;
  if (!meta?.refreshToken) setStatus('off');
  else { setStatus('idle'); schedule(200); }

  db.onChange(() => schedule(3000));
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => schedule(300));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - (meta?.lastSyncAt || 0) > 30000) schedule(300);
    });
  }
}

/* ---------- HTTP ---------- */

async function rawFetch(path, { method = 'GET', body, headers = {}, token } = {}) {
  const h = { apikey: SUPABASE_KEY, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(SUPABASE_URL + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  } catch (err) {
    const e = new NetError('Ingen kontakt med servern');
    e.detail = err?.message || String(err);
    throw e;
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const msg = json?.msg || json?.message || json?.error_description || json?.error || `Fel ${res.status}`;
    throw new ApiError(res.status, msg, json?.error_code || json?.code || json?.error);
  }
  return json;
}

function takeSession(j) {
  session = { access: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 };
  meta = { ...(meta || {}), refreshToken: j.refresh_token, userId: j.user?.id || meta?.userId, email: j.user?.email || meta?.email };
}

async function accessToken(force = false) {
  if (!force && session && session.expiresAt - 60000 > Date.now()) return session.access;
  if (!meta?.refreshToken) throw new AuthError('Inte inloggad');
  // Bara en förnyelse i taget: Supabase byter ut förnyelsetoken varje gång.
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const j = await rawFetch('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: meta.refreshToken } });
        takeSession(j);
        await saveMeta();
      } catch (e) {
        if (e instanceof ApiError && (e.status === 400 || e.status === 401 || e.status === 403)) {
          session = null;
          setStatus('auth', 'Inloggningen har gått ut');
          throw new AuthError('Inloggningen har gått ut');
        }
        throw e;
      } finally {
        refreshing = null;
      }
    })();
  }
  await refreshing;
  return session.access;
}

async function api(path, opts = {}) {
  const token = await accessToken();
  try {
    return await rawFetch(path, { ...opts, token });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      return rawFetch(path, { ...opts, token: await accessToken(true) });
    }
    throw e;
  }
}

/* ---------- Inloggning ---------- */

export async function signIn(email, password) {
  let j;
  try {
    j = await rawFetch('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: email.trim(), password } });
  } catch (e) {
    if (e instanceof ApiError) {
      const what = `${e.code || ''} ${e.message || ''}`;
      if (/confirm/i.test(what)) throw new AuthError('Kontot är inte bekräftat. Kryssa i Auto Confirm User eller bekräfta användaren i Supabase.');
      if (/api ?key|apikey/i.test(what)) throw new AuthError(`Appen har fel nyckel till servern (${e.message}). Kontrollera js/config.js.`);
      if (e.status === 400 && /invalid_credentials|invalid login|invalid_grant/i.test(what)) throw new AuthError('Fel e-post eller lösenord. Använd användaren som skapades under Authentication → Users i Supabase.');
      throw new AuthError(`Inloggningen misslyckades: ${e.message} (felkod ${e.status}${e.code ? `, ${e.code}` : ''}).`);
    }
    throw e;
  }
  // Samma konto på samma telefon (t.ex. efter att inloggningen gått ut): fortsätt där synken var.
  const sameUser = !!(meta?.userId && meta.userId === j.user?.id);
  meta = {
    email: j.user?.email || email.trim(),
    userId: j.user?.id,
    refreshToken: j.refresh_token,
    cursor: sameUser ? meta.cursor : null,
    lastSyncAt: sameUser ? meta.lastSyncAt : null,
    serverTag: sameUser ? meta.serverTag : null,
  };
  session = { access: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 };
  // Allt som redan finns på telefonen ska upp till servern.
  if (!sameUser) await db.markAllPending();
  await saveMeta();
  setStatus('idle');
  await syncNow();
}

export async function signOut(message = '') {
  clearTimeout(timer);
  try { if (session) await rawFetch('/auth/v1/logout', { method: 'POST', token: session.access }); } catch { /* spelar ingen roll */ }
  meta = null;
  session = null;
  await db.delMeta('sync');
  setStatus('off', message);
}

export async function deleteServerData() {
  await api('/rest/v1/rpc/delete_my_data', { method: 'POST', body: {} });
  await db.markAllPending();
  await signOut();
}

/* ---------- Synk ---------- */

export function schedule(ms = 3000) {
  if (!signedIn()) return;
  clearTimeout(timer);
  timer = setTimeout(() => { syncNow(); }, ms);
}

// Kontrollerar att serverdatan inte har raderats från en annan telefon.
// Returnerar false om synken ska avbrytas.
async function checkServer() {
  const rows = (await api('/rest/v1/sync_state?select=started_at')) || [];
  const tag = rows[0]?.started_at || null;
  if (tag && (!meta.serverTag || meta.serverTag === tag)) {
    if (!meta.serverTag) { meta.serverTag = tag; await saveMeta(); }
    return true;
  }
  if (!tag && !meta.serverTag) {
    // Första synken för kontot
    try {
      await api('/rest/v1/sync_state', { method: 'POST', body: { user_id: meta.userId }, headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } });
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) throw e;
    }
    const again2 = (await api('/rest/v1/sync_state?select=started_at')) || [];
    meta.serverTag = again2[0]?.started_at || null;
    await saveMeta();
    return true;
  }
  // Serverdatan har raderats (eller raderats och börjats om) från en annan telefon.
  await db.markAllPending();
  await signOut('Datan på servern har raderats, troligen från en annan telefon. Logga in igen för att börja synka på nytt.');
  return false;
}

export async function syncNow() {
  if (!signedIn()) return getState();
  if (running) { again = true; return getState(); }
  running = true;
  clearTimeout(timer);
  setStatus('syncing');
  try {
    if (await checkServer()) {
      await push();
      await pull();
      meta.lastSyncAt = Date.now();
      await saveMeta();
      const left = (await db.listPending()).length;
      setStatus(left ? 'pending' : 'ok');
    }
  } catch (e) {
    console.warn('Synk:', e);
    if (e instanceof NetError) setStatus('offline');
    else if (e instanceof AuthError) setStatus('auth', e.message);
    else setStatus('error', e.message || 'Okänt fel');
  } finally {
    running = false;
    if (again) { again = false; schedule(500); }
  }
  return getState();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'image/jpeg' });
}

const toRow = (r) => ({
  id: r.id,
  type: r.type,
  date: r.date || null,
  data: r.data ?? null,
  created_at: r.createdAt ?? null,
  updated_at: r.updatedAt,
  deleted: !!r.deleted,
  schema: r.schema ?? null,
});

const fromRow = (row) => ({
  id: row.id,
  type: row.type,
  date: row.date || null,
  data: row.data ?? null,
  createdAt: row.created_at == null ? null : Number(row.created_at),
  updatedAt: Number(row.updated_at),
  deleted: !!row.deleted,
  schema: row.schema ?? null,
});

async function push() {
  const pending = await db.listPending();
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    for (const r of batch) {
      if (r.type !== 'photo') continue;
      if (r.deleted) {
        await api(`/rest/v1/photos?id=eq.${encodeURIComponent(r.id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      } else {
        const blob = await db.getBlob(r.id);
        if (blob) {
          await api('/rest/v1/photos', {
            method: 'POST',
            body: { id: r.id, mime: blob.type || 'image/jpeg', data_base64: await blobToBase64(blob) },
            headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
          });
        }
      }
    }
    await api('/rest/v1/rpc/push_records', { method: 'POST', body: { rows: batch.map(toRow) } });
    await db.markSynced(batch.map((r) => ({ id: r.id, updatedAt: r.updatedAt })));
  }
}

async function pull() {
  const changed = [];
  let after = meta.cursor && parseTs(meta.cursor) ? new Date(parseTs(meta.cursor) - OVERLAP_MS).toISOString() : null;
  let maxSeen = meta.cursor;
  for (;;) {
    const q = `/rest/v1/records?select=id,type,date,data,created_at,updated_at,deleted,schema,synced_at&order=synced_at.asc,id.asc&limit=${PAGE}${after ? `&synced_at=gt.${encodeURIComponent(after)}` : ''}`;
    const rows = (await api(q)) || [];
    if (rows.length) changed.push(...(await db.applyRemote(rows.map(fromRow))));
    if (rows.length) {
      after = rows[rows.length - 1].synced_at;
      if (!maxSeen || parseTs(after) > parseTs(maxSeen)) maxSeen = after;
    }
    if (rows.length < PAGE) break;
  }
  meta.cursor = maxSeen;

  // Foton som saknas på telefonen
  const photos = changed.filter((r) => r.type === 'photo' && !r.deleted);
  for (let i = 0; i < photos.length; i += 5) {
    const missing = [];
    for (const p of photos.slice(i, i + 5)) if (!(await db.hasBlob(p.id))) missing.push(p);
    if (!missing.length) continue;
    const rows = (await api(`/rest/v1/photos?select=id,mime,data_base64&id=in.(${missing.map((p) => encodeURIComponent(p.id)).join(',')})`)) || [];
    for (const row of rows) await db.putBlob(row.id, base64ToBlob(row.data_base64, row.mime));
  }
  if (changed.length) {
    try { onRemote(changed); } catch (e) { console.warn(e); }
  }
}
