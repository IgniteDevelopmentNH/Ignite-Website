// Worker for the /meet availability scheduler. Everything else on the site is a
// static asset and never reaches this code (see run_worker_first in wrangler.jsonc).
//
// Public:  GET  /api/events/:code              event + responses (as the event allows)
//          POST /api/events/:code/responses    add or update your availability
//          POST /api/events/:code/me           reopen your own response
// Admin:   POST /api/admin/login | /logout, GET /api/admin/session
//          GET/POST /api/admin/events, GET/PUT/DELETE /api/admin/events/:id
//          POST /api/admin/events/:id/duplicate, DELETE /api/admin/events/:id/responses/:rid
//          GET /api/admin/code                 an unused four-digit code

const SESSION_DAYS = 14;
const COOKIE = 'ignite_meet';
const MAX_SLOTS = 6000;
const DEFAULT_SETTINGS = {
  host: 'Ignite Development',
  visibility: 'all', // all: names and times, anon: group totals only, private: nothing
  ifNeeded: true,
  askEmail: true,
  requireEmail: false,
  askCompany: false,
  askComment: true,
  deadline: null,
  showFinal: true,
};

let schemaReady = false;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        await ensureSchema(env);
        return withSecurityHeaders(await route(request, env, url));
      }
      // /meet/1234 is the same page as /meet; the page reads the code from the path.
      if (url.pathname.startsWith('/meet/')) {
        const page = await env.ASSETS.fetch(new URL('/meet', url));
        return withSecurityHeaders(new Response(page.body, page));
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      if (err instanceof HttpError) return withSecurityHeaders(json({ error: err.message }, err.status));
      console.error(err);
      return withSecurityHeaders(json({ error: 'Something went wrong. Please try again.' }, 500));
    }
  },
};

async function route(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const method = request.method;

  if (parts[0] === 'events' && /^\d{4}$/.test(parts[1] || '')) {
    const code = parts[1];
    if (parts.length === 2 && method === 'GET') return getPublicEvent(request, env, code);
    if (parts[2] === 'responses' && method === 'POST') return saveResponse(request, env, code);
    if (parts[2] === 'me' && method === 'POST') return findMyResponse(request, env, code);
  }

  if (parts[0] === 'admin') {
    if (parts[1] === 'login' && method === 'POST') return login(request, env);
    if (parts[1] === 'logout' && method === 'POST') return logout();
    const admin = await isAdmin(request, env);
    if (parts[1] === 'session' && method === 'GET') return json({ admin, configured: Boolean(env.ADMIN_PASSWORD) });
    if (!admin) throw new HttpError(401, 'Please log in.');
    sameOrigin(request, url);

    if (parts[1] === 'code' && method === 'GET') return json({ code: await unusedCode(env) });
    if (parts[1] === 'events') {
      const id = parts[2];
      if (!id && method === 'GET') return listEvents(env);
      if (!id && method === 'POST') return createEvent(request, env);
      if (id && parts.length === 3 && method === 'GET') return getAdminEvent(env, id);
      if (id && parts.length === 3 && method === 'PUT') return updateEvent(request, env, id);
      if (id && parts.length === 3 && method === 'DELETE') return deleteEvent(env, id);
      if (id && parts[3] === 'duplicate' && method === 'POST') return duplicateEvent(env, id);
      if (id && parts[3] === 'responses' && parts[4] && method === 'DELETE') return deleteResponse(env, id, parts[4]);
    }
  }
  throw new HttpError(404, 'Not found.');
}

// ---------- Schema ----------

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      tz TEXT NOT NULL, dates TEXT NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL,
      slot_min INTEGER NOT NULL, duration_min INTEGER NOT NULL, excluded TEXT NOT NULL DEFAULT '[]',
      settings TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'open', final_slot INTEGER,
      notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS responses (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name TEXT NOT NULL, name_key TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '',
      comment TEXT NOT NULL DEFAULT '', avail TEXT NOT NULL DEFAULT '{}', token_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (event_id, name_key))`),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS attempts (key TEXT NOT NULL, at INTEGER NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS attempts_key ON attempts (key, at)'),
  ]);
  schemaReady = true;
}

// ---------- Public ----------

async function getPublicEvent(request, env, code) {
  await checkLimit(request, env, 'code', 40, 10);
  const row = await env.DB.prepare('SELECT * FROM events WHERE code = ?').bind(code).first();
  if (!row) {
    await recordFailure(request, env, 'code', 40, 10);
    throw new HttpError(404, "We couldn't find an event with that code. Double-check it and try again.");
  }
  const event = publicEvent(row);
  const { results } = await env.DB.prepare('SELECT name, avail FROM responses WHERE event_id = ? ORDER BY created_at')
    .bind(row.id).all();
  const visibility = event.settings.visibility;
  const payload = { event, count: results.length };
  if (visibility === 'all') payload.responses = results.map((r) => ({ name: r.name, avail: JSON.parse(r.avail) }));
  if (visibility === 'anon') payload.totals = totals(results);
  return json(payload);
}

async function saveResponse(request, env, code) {
  const row = await env.DB.prepare('SELECT * FROM events WHERE code = ?').bind(code).first();
  if (!row) throw new HttpError(404, 'This event no longer exists.');
  const event = publicEvent(row);
  if (!event.open) throw new HttpError(403, 'This event is closed to new responses.');

  const body = await readJson(request);
  const name = clean(body.name, 80);
  if (!name) throw new HttpError(400, 'Please enter your name.');
  const email = event.settings.askEmail ? clean(body.email, 160).toLowerCase() : '';
  if (event.settings.askEmail && event.settings.requireEmail && !email) throw new HttpError(400, 'Please enter your email.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'That email address doesn’t look right.');
  const company = event.settings.askCompany ? clean(body.company, 120) : '';
  const comment = event.settings.askComment ? clean(body.comment, 1000) : '';
  const avail = cleanAvail(body.avail, event.settings.ifNeeded);

  const now = Date.now();
  const existing = await env.DB.prepare('SELECT * FROM responses WHERE event_id = ? AND name_key = ?')
    .bind(row.id, nameKey(name)).first();

  if (existing) {
    await assertOwner(existing, body, email);
    const token = body.token && (await sha256(body.token)) === existing.token_hash ? body.token : randomHex(24);
    await env.DB.prepare(`UPDATE responses SET name = ?, email = ?, company = ?, comment = ?, avail = ?,
      token_hash = ?, updated_at = ? WHERE id = ?`)
      .bind(name, email || existing.email, company, comment, JSON.stringify(avail), await sha256(token), now, existing.id).run();
    return json({ token, updated: true });
  }

  const token = randomHex(24);
  await env.DB.prepare(`INSERT INTO responses (id, event_id, name, name_key, email, company, comment, avail, token_hash,
    created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(randomHex(8), row.id, name, nameKey(name), email, company, comment, JSON.stringify(avail), await sha256(token), now, now).run();
  return json({ token, updated: false });
}

async function findMyResponse(request, env, code) {
  const row = await env.DB.prepare('SELECT id FROM events WHERE code = ?').bind(code).first();
  if (!row) throw new HttpError(404, 'This event no longer exists.');
  const body = await readJson(request);
  const name = clean(body.name, 80);
  const existing = name && await env.DB.prepare('SELECT * FROM responses WHERE event_id = ? AND name_key = ?')
    .bind(row.id, nameKey(name)).first();
  if (!existing) return json({ found: false });
  await assertOwner(existing, body, clean(body.email, 160).toLowerCase());
  return json({
    found: true,
    response: { name: existing.name, email: existing.email, company: existing.company, comment: existing.comment, avail: JSON.parse(existing.avail) },
  });
}

// Someone can reopen a response by name. If they gave an email the first time, they
// need it again (or the token their browser kept) so others can't overwrite them.
async function assertOwner(existing, body, email) {
  if (body.token && (await sha256(String(body.token))) === existing.token_hash) return;
  if (!existing.email) return;
  if (email && email === existing.email) return;
  throw new HttpError(409, 'Someone already responded with that name. Enter the email you used, or use a different name.');
}

// ---------- Admin ----------

async function login(request, env) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'Admin login isn’t set up yet. Add the ADMIN_PASSWORD secret.');
  const { password } = await readJson(request);
  await checkLimit(request, env, 'login', 8, 15);
  if (!(await safeEqual(String(password || ''), env.ADMIN_PASSWORD))) {
    await recordFailure(request, env, 'login', 8, 15);
    throw new HttpError(401, 'Wrong password.');
  }
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const value = `${exp}.${await sign(env, String(exp))}`;
  return json({ admin: true }, 200, {
    'Set-Cookie': `${COOKIE}=${value}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`,
  });
}

function logout() {
  return json({ admin: false }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
}

async function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = (request.headers.get('Cookie') || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!cookie) return false;
  const [exp, sig] = cookie.slice(COOKIE.length + 1).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await sign(env, exp));
}

async function listEvents(env) {
  const { results } = await env.DB.prepare(`SELECT e.*, (SELECT COUNT(*) FROM responses r WHERE r.event_id = e.id) AS response_count
    FROM events e ORDER BY e.created_at DESC`).all();
  return json({ events: results.map((r) => ({ ...adminEvent(r), responseCount: r.response_count })) });
}

async function getAdminEvent(env, id) {
  const row = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'Event not found.');
  const { results } = await env.DB.prepare('SELECT * FROM responses WHERE event_id = ? ORDER BY created_at').bind(id).all();
  return json({
    event: adminEvent(row),
    responses: results.map((r) => ({
      id: r.id, name: r.name, email: r.email, company: r.company, comment: r.comment,
      avail: JSON.parse(r.avail), createdAt: r.created_at, updatedAt: r.updated_at,
    })),
  });
}

async function createEvent(request, env) {
  const input = validateEvent(await readJson(request));
  const code = input.code || (await unusedCode(env));
  await assertCodeFree(env, code);
  const id = randomHex(8);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO events (id, code, title, description, tz, dates, start_min, end_min, slot_min, duration_min,
    excluded, settings, status, final_slot, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, code, input.title, input.description, input.tz, JSON.stringify(input.dates), input.startMin, input.endMin,
      input.slotMin, input.durationMin, JSON.stringify(input.excluded), JSON.stringify(input.settings), input.status,
      input.finalSlot, input.notes, now, now).run();
  return getAdminEvent(env, id);
}

async function updateEvent(request, env, id) {
  const row = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'Event not found.');
  const input = validateEvent({ ...adminEvent(row), ...(await readJson(request)) });
  if (input.code !== row.code) await assertCodeFree(env, input.code);
  await env.DB.prepare(`UPDATE events SET code = ?, title = ?, description = ?, tz = ?, dates = ?, start_min = ?, end_min = ?,
    slot_min = ?, duration_min = ?, excluded = ?, settings = ?, status = ?, final_slot = ?, notes = ?, updated_at = ? WHERE id = ?`)
    .bind(input.code, input.title, input.description, input.tz, JSON.stringify(input.dates), input.startMin, input.endMin,
      input.slotMin, input.durationMin, JSON.stringify(input.excluded), JSON.stringify(input.settings), input.status,
      input.finalSlot, input.notes, Date.now(), id).run();
  return getAdminEvent(env, id);
}

async function duplicateEvent(env, id) {
  const row = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'Event not found.');
  const now = Date.now();
  const copyId = randomHex(8);
  await env.DB.prepare(`INSERT INTO events (id, code, title, description, tz, dates, start_min, end_min, slot_min, duration_min,
    excluded, settings, status, final_slot, notes, created_at, updated_at)
    SELECT ?, ?, title || ' (copy)', description, tz, dates, start_min, end_min, slot_min, duration_min, excluded, settings,
    'open', NULL, notes, ?, ? FROM events WHERE id = ?`).bind(copyId, await unusedCode(env), now, now, id).run();
  return getAdminEvent(env, copyId);
}

async function deleteEvent(env, id) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM responses WHERE event_id = ?').bind(id),
    env.DB.prepare('DELETE FROM events WHERE id = ?').bind(id),
  ]);
  return json({ deleted: true });
}

async function deleteResponse(env, id, rid) {
  await env.DB.prepare('DELETE FROM responses WHERE id = ? AND event_id = ?').bind(rid, id).run();
  return getAdminEvent(env, id);
}

function validateEvent(body) {
  const title = clean(body.title, 140);
  if (!title) throw new HttpError(400, 'Give the event a title.');
  const code = body.code ? String(body.code).trim() : '';
  if (code && !/^\d{4}$/.test(code)) throw new HttpError(400, 'The code must be exactly four digits.');
  const tz = String(body.tz || 'America/New_York');
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { throw new HttpError(400, 'Unknown time zone.'); }
  const dates = [...new Set((Array.isArray(body.dates) ? body.dates : []).map(String))]
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!dates.length) throw new HttpError(400, 'Pick at least one date.');
  if (dates.length > 62) throw new HttpError(400, 'Pick 62 dates or fewer.');
  const slotMin = [10, 15, 20, 30, 60].includes(Number(body.slotMin)) ? Number(body.slotMin) : 30;
  const startMin = int(body.startMin, 0, 1440 - slotMin);
  const endMin = int(body.endMin, startMin + slotMin, 1440);
  if ((dates.length * (endMin - startMin)) / slotMin > MAX_SLOTS) throw new HttpError(400, 'That grid is too big. Use fewer dates, shorter days, or longer slots.');
  const durationMin = int(body.durationMin, slotMin, 1440);
  const settings = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(body.settings || {})) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    if (typeof DEFAULT_SETTINGS[k] === 'boolean') settings[k] = Boolean(v);
    else if (k === 'visibility') settings[k] = ['all', 'anon', 'private'].includes(v) ? v : 'all';
    else if (k === 'deadline') settings[k] = v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
    else settings[k] = clean(v, 120) || DEFAULT_SETTINGS[k];
  }
  const excluded = [...new Set((Array.isArray(body.excluded) ? body.excluded : []).map(Number).filter(Number.isInteger))].slice(0, MAX_SLOTS);
  const finalSlot = Number.isInteger(Number(body.finalSlot)) && body.finalSlot !== null && body.finalSlot !== '' ? Number(body.finalSlot) : null;
  return {
    title, code, tz, dates, startMin, endMin, slotMin, durationMin, excluded, settings, finalSlot,
    description: clean(body.description, 4000),
    notes: clean(body.notes, 4000),
    status: body.status === 'closed' ? 'closed' : 'open',
  };
}

async function assertCodeFree(env, code) {
  const taken = await env.DB.prepare('SELECT 1 FROM events WHERE code = ?').bind(code).first();
  if (taken) throw new HttpError(409, `Code ${code} is already used by another event.`);
}

async function unusedCode(env) {
  for (let i = 0; i < 50; i++) {
    const code = String(1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000));
    if (!(await env.DB.prepare('SELECT 1 FROM events WHERE code = ?').bind(code).first())) return code;
  }
  throw new HttpError(500, 'Couldn’t find a free code. Delete some old events.');
}

// ---------- Shaping ----------

function baseEvent(row) {
  const settings = { ...DEFAULT_SETTINGS, ...JSON.parse(row.settings) };
  const pastDeadline = settings.deadline && Date.parse(settings.deadline) < Date.now();
  return {
    code: row.code, title: row.title, description: row.description, tz: row.tz, dates: JSON.parse(row.dates),
    startMin: row.start_min, endMin: row.end_min, slotMin: row.slot_min, durationMin: row.duration_min,
    excluded: JSON.parse(row.excluded), settings, status: row.status, finalSlot: row.final_slot,
    open: row.status === 'open' && !pastDeadline,
  };
}

function publicEvent(row) {
  const event = baseEvent(row);
  if (!event.settings.showFinal) event.finalSlot = null;
  return event;
}

function adminEvent(row) {
  return { ...baseEvent(row), id: row.id, notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at };
}

function totals(rows) {
  const out = {};
  for (const r of rows) {
    for (const [slot, v] of Object.entries(JSON.parse(r.avail))) {
      out[slot] ||= [0, 0];
      out[slot][v === 2 ? 1 : 0]++;
    }
  }
  return out;
}

function cleanAvail(raw, allowIfNeeded) {
  const out = {};
  let n = 0;
  for (const [slot, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (!/^\d{6,9}$/.test(slot) || ++n > MAX_SLOTS) continue;
    if (v === 1 || (v === 2 && allowIfNeeded)) out[slot] = v;
  }
  return out;
}

// ---------- Helpers ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function withSecurityHeaders(response) {
  const res = new Response(response.body, response);
  res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'same-origin');
  res.headers.set('X-Frame-Options', 'DENY');
  return res;
}

function sameOrigin(request, url) {
  if (request.method === 'GET') return;
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-site request blocked.');
}

async function readJson(request) {
  try { return (await request.json()) || {}; } catch { throw new HttpError(400, 'Bad request.'); }
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);
const nameKey = (name) => name.toLowerCase().replace(/\s+/g, ' ');
const int = (v, min, max) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sign(env, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`meet-session:${env.ADMIN_PASSWORD}`),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// Simple per-IP throttle for password and code guessing, kept in D1.
async function checkLimit(request, env, kind, max, minutes) {
  const key = `${kind}:${request.headers.get('CF-Connecting-IP') || 'local'}`;
  const since = Date.now() - minutes * 60e3;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM attempts WHERE key = ? AND at > ?').bind(key, since).first();
  if (row.n >= max) throw new HttpError(429, `Too many tries. Wait ${minutes} minutes and try again.`);
}

async function recordFailure(request, env, kind, max, minutes) {
  await checkLimit(request, env, kind, max, minutes);
  const key = `${kind}:${request.headers.get('CF-Connecting-IP') || 'local'}`;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO attempts (key, at) VALUES (?, ?)').bind(key, Date.now()),
    env.DB.prepare('DELETE FROM attempts WHERE at < ?').bind(Date.now() - 86400e3),
  ]);
}
