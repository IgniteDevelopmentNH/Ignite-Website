// /meet availability scheduler. Clients enter a four-digit code and paint the times
// they're free; admins log in (top right) to create events and read the results.
// Slots are identified by their start time in UTC epoch minutes, so every viewer
// can see the same grid in their own time zone.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  const S = { admin: false, configured: true };

  $$('[data-year]').forEach((el) => { el.textContent = new Date().getFullYear(); });

  // ---------- Small utilities ----------

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`/api/${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data.error || `Something went wrong (${res.status}).`);
      err.status = res.status;
      if (res.status === 401 && path.startsWith('admin/') && path !== 'admin/login') { S.admin = false; renderBar(); }
      throw err;
    }
    return data;
  }

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  async function copy(text, msg = 'Copied') {
    try { await navigator.clipboard.writeText(text); toast(msg); } catch { prompt('Copy this:', text); }
  }

  function status(el, msg, kind = '') {
    el.textContent = msg;
    el.className = `form-status ${kind}`;
  }

  function show(id) {
    const changed = $(`#${id}`).hidden;
    $$('.m-view').forEach((v) => { v.hidden = v.id !== id; });
    if (changed) scrollTo(0, 0);
  }

  // ---------- Time ----------

  const fmts = new Map();
  function dtf(tz, o) {
    const k = tz + JSON.stringify(o);
    if (!fmts.has(k)) fmts.set(k, new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o }));
    return fmts.get(k);
  }

  function parts(ts, tz) {
    const p = {};
    for (const x of dtf(tz, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ts)) p[x.type] = x.value;
    return { date: `${p.year}-${p.month}-${p.day}`, min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
  }

  function offset(ts, tz) {
    const p = parts(ts, tz);
    const [y, m, d] = p.date.split('-').map(Number);
    return Date.UTC(y, m - 1, d) + p.min * 6e4 - Math.floor(ts / 6e4) * 6e4;
  }

  // Wall-clock date + minutes in a time zone -> UTC milliseconds.
  function toUtc(date, min, tz) {
    const [y, m, d] = date.split('-').map(Number);
    const wall = Date.UTC(y, m - 1, d) + min * 6e4;
    let ts = wall - offset(wall, tz);
    const again = offset(ts, tz);
    if (again !== wall - ts) ts = wall - again;
    return ts;
  }

  function slotsOf(ev, withExcluded = false) {
    const out = new Set();
    const ex = new Set(ev.excluded || []);
    for (const date of ev.dates) {
      for (let m = ev.startMin; m + ev.slotMin <= ev.endMin; m += ev.slotMin) {
        const k = toUtc(date, m, ev.tz) / 6e4;
        if (withExcluded || !ex.has(k)) out.add(k);
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  function layout(slots, tz) {
    const dates = new Set(), rows = new Set(), at = new Map();
    for (const s of slots) {
      const p = parts(s * 6e4, tz);
      dates.add(p.date);
      rows.add(p.min);
      at.set(`${p.date}|${p.min}`, s);
    }
    return { dates: [...dates].sort(), rows: [...rows].sort((a, b) => a - b), at };
  }

  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const noon = (date) => new Date(`${date}T12:00:00Z`);
  const dateLabel = (date) => ({
    wd: dtf('UTC', { weekday: 'short' }).format(noon(date)),
    md: dtf('UTC', { month: 'short', day: 'numeric' }).format(noon(date)),
  });
  function timeLabel(min) {
    const h = Math.floor(min / 60) % 24, m = min % 60;
    return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
  }
  const tzName = (tz, ts = Date.now()) => dtf(tz, { timeZoneName: 'short' }).formatToParts(ts).find((p) => p.type === 'timeZoneName')?.value || tz;
  function slotLabel(slot, tz, minutes) {
    const a = slot * 6e4, b = a + minutes * 6e4;
    const day = dtf(tz, { weekday: 'short', month: 'short', day: 'numeric' }).format(a);
    const t = dtf(tz, { hour: 'numeric', minute: '2-digit' });
    return `${day} · ${t.format(a)} – ${t.format(b)} ${tzName(tz, a)}`;
  }
  function rangeLabel(dates) {
    if (!dates.length) return '';
    const a = dateLabel(dates[0]).md, b = dateLabel(dates[dates.length - 1]).md;
    return `${dates.length === 1 ? a : `${a} – ${b}`} · ${dates.length} day${dates.length === 1 ? '' : 's'}`;
  }
  const durLabel = (m) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m / 60} hr${m > 60 ? 's' : ''}`);

  const COMMON_TZ = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'Europe/London', 'Europe/Paris', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'];
  function tzOptions(select, selected, extra = []) {
    let all = [];
    try { all = Intl.supportedValuesOf('timeZone'); } catch {}
    const first = [...new Set([...extra, ...COMMON_TZ])];
    const opt = (tz, label) => `<option value="${esc(tz)}"${tz === selected ? ' selected' : ''}>${esc(label || tz.replace(/_/g, ' '))}</option>`;
    const label = (tz) => `${tz.replace(/_/g, ' ')} (${tzName(tz)})`;
    select.innerHTML = `<optgroup label="Common">${first.map((tz) => opt(tz, label(tz))).join('')}</optgroup>`
      + `<optgroup label="All time zones">${all.filter((tz) => !first.includes(tz)).map((tz) => opt(tz)).join('')}</optgroup>`;
    if (!select.value) select.value = selected;
  }

  // ---------- Grid ----------
  // A day-by-time grid that pages through days instead of scrolling sideways.
  // o.cls(slot) gives each cell's classes; o.p(slot) its heat level; o.paint makes
  // it a drag-to-select grid; o.hover makes it a hover/tap-to-inspect grid.
  function makeGrid(el, o) {
    let page = 0, L, drag = null, lastW = 0, marked = null;

    function render() {
      L = layout(o.slots, o.tz);
      lastW = el.clientWidth;
      if (!L.dates.length) { el.innerHTML = '<p class="m-grid-empty">No times to show yet.</p>'; return; }
      const small = innerWidth < 640;
      const per = Math.max(1, Math.floor(((el.clientWidth || 600) - (small ? 48 : 58)) / (small ? 46 : 60)));
      const pages = Math.ceil(L.dates.length / per);
      page = Math.max(0, Math.min(page, pages - 1));
      const cols = L.dates.slice(page * per, page * per + per);
      let h = '';
      if (pages > 1) {
        h += `<div class="m-grid-nav"><button type="button" data-pg="-1"${page ? '' : ' disabled'} aria-label="Earlier days">&lsaquo;</button>`
          + `<span>Days ${page * per + 1}–${page * per + cols.length} of ${L.dates.length}</span>`
          + `<button type="button" data-pg="1"${page < pages - 1 ? '' : ' disabled'} aria-label="Later days">&rsaquo;</button></div>`;
      }
      h += `<div class="m-tbl" style="--cols:${cols.length}"><div class="m-dh"></div>`;
      for (const d of cols) { const l = dateLabel(d); h += `<div class="m-dh">${l.wd}<b>${l.md}</b></div>`; }
      const base = L.rows[0];
      L.rows.forEach((r, ri) => {
        const hr = (r - base) % 60 === 0;
        h += `<div class="m-th">${hr ? `<span>${timeLabel(r)}</span>` : ''}</div>`;
        cols.forEach((d, ci) => {
          const s = L.at.get(`${d}|${r}`);
          h += s == null ? `<div class="m-c x${hr ? ' hr' : ''}"></div>` : `<div class="m-c" data-s="${s}" data-ci="${ci}" data-ri="${ri}"${hr ? ' data-h' : ''}></div>`;
        });
      });
      el.innerHTML = `${h}</div>`;
      $$('[data-pg]', el).forEach((b) => { b.onclick = () => { page += Number(b.dataset.pg); render(); }; });
      refresh();
    }

    function refresh() {
      for (const c of $$('.m-c[data-s]', el)) {
        const s = Number(c.dataset.s);
        c.className = `m-c${c.hasAttribute('data-h') ? ' hr' : ''} ${o.cls(s) || ''}${c === marked ? ' on' : ''}`;
        const p = o.p?.(s);
        if (p == null) c.style.removeProperty('--p'); else c.style.setProperty('--p', p);
      }
    }

    function mark(c) {
      marked?.classList.remove('on');
      marked = c;
      c?.classList.add('on');
    }

    function paintTo(c) {
      const [a, b] = [drag.a, [Number(c.dataset.ci), Number(c.dataset.ri)]];
      const [c0, c1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
      const [r0, r1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
      const hit = $$('.m-c[data-s]', el).filter((x) => {
        const ci = Number(x.dataset.ci), ri = Number(x.dataset.ri);
        return ci >= c0 && ci <= c1 && ri >= r0 && ri <= r1;
      }).map((x) => Number(x.dataset.s));
      o.paint.apply(hit, drag.v);
    }

    el.classList.toggle('heatmap', Boolean(o.hover));
    el.classList.toggle('ro', !o.paint && !o.hover);
    el.addEventListener('pointerdown', (e) => {
      const c = e.target.closest('.m-c[data-s]');
      if (!c) return;
      if (o.paint) {
        e.preventDefault();
        drag = { a: [Number(c.dataset.ci), Number(c.dataset.ri)], v: o.paint.start(Number(c.dataset.s)) };
        paintTo(c);
      } else if (o.hover) {
        o.hover(Number(c.dataset.s));
        mark(c);
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (drag) {
        const c = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.m-c[data-s]');
        if (c && el.contains(c)) paintTo(c);
      } else if (o.hover && e.pointerType === 'mouse') {
        const c = e.target.closest('.m-c[data-s]');
        if (c && c !== marked) { o.hover(Number(c.dataset.s)); mark(c); }
      }
    });
    const stop = () => { if (drag) { drag = null; o.paint.end(); } };
    addEventListener('pointerup', stop);
    addEventListener('pointercancel', stop);
    new ResizeObserver(() => { if (Math.abs(el.clientWidth - lastW) > 30) render(); }).observe(el);

    return { render, refresh, set(next) { Object.assign(o, next); render(); }, o };
  }

  // Heat level and class for a group grid cell.
  function heat(counts, total, slot, extra = '') {
    const c = counts[slot];
    if (!c || !total || (!c[0] && !c[1])) return { cls: extra, p: null };
    if (c[0] === total) return { cls: `all ${extra}`, p: null };
    return { cls: `heat ${extra}`, p: (0.14 + 0.86 * ((c[0] + c[1] * 0.5) / total)).toFixed(3) };
  }

  function countAvail(list) {
    const out = {};
    for (const r of list) {
      for (const [s, v] of Object.entries(r.avail)) {
        out[s] ||= [0, 0];
        out[s][v === 2 ? 1 : 0]++;
      }
    }
    return out;
  }

  function legendHtml(total, ifNeeded) {
    if (!total) return '<span>No responses yet.</span>';
    return `<span>0/${total}</span><span class="ramp">${[0.14, 0.35, 0.57, 0.78, 1].map((p) => `<i style="background:rgba(255,107,0,${p})"></i>`).join('')}</span><span>${total}/${total} available</span>${ifNeeded ? '<span>“If needed” counts as half</span>' : ''}`;
  }

  function whoHtml(slot, ev, tz, list) {
    const yes = [], maybe = [], no = [];
    for (const r of list) (r.avail[slot] === 1 ? yes : r.avail[slot] === 2 ? maybe : no).push(esc(r.name));
    return `<h3>${esc(slotLabel(slot, tz, ev.slotMin))}</h3>`
      + `<p><b>Available (${yes.length}):</b> ${yes.join(', ') || '—'}</p>`
      + (ev.settings.ifNeeded ? `<p><b>If needed (${maybe.length}):</b> ${maybe.join(', ') || '—'}</p>` : '')
      + `<p><b>Can't make it (${no.length}):</b> ${no.join(', ') || '—'}</p>`;
  }

  // ---------- Calendar export ----------

  function icsFor(ev, slot) {
    const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const text = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
    const start = slot * 6e4;
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ignite Development//Meet//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
      `UID:${ev.code}-${slot}@ignitedevelopment.net`, `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(start + ev.durationMin * 6e4)}`, `SUMMARY:${text(ev.title)}`,
      `DESCRIPTION:${text(ev.description || `Hosted by ${ev.settings.host}`)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  }

  function download(name, type, content) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function googleLink(ev, slot) {
    const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const q = new URLSearchParams({ action: 'TEMPLATE', text: ev.title, dates: `${stamp(slot * 6e4)}/${stamp(slot * 6e4 + ev.durationMin * 6e4)}`, details: ev.description || '' });
    return `https://calendar.google.com/calendar/render?${q}`;
  }

  function finalHtml(ev, slot, tz, adminControls = '') {
    return `<span class="kick">Meeting time set</span><b>${esc(slotLabel(slot, tz, ev.durationMin))}</b>`
      + `<div class="m-final-acts">${adminControls}<button type="button" class="m-mini" data-ics>Add to calendar (.ics)</button>`
      + `<a class="m-mini" href="${esc(googleLink(ev, slot))}" target="_blank" rel="noopener">Google Calendar</a></div>`;
  }

  // ---------- Admin bar + login ----------

  function renderBar() {
    const bar = $('#adminBar');
    bar.innerHTML = S.admin
      ? '<a href="#admin">Events</a><button type="button" id="logoutBtn">Log out</button>'
      : '<button type="button" id="adminBtn">Admin</button>';
    $('#adminBtn')?.addEventListener('click', openLogin);
    $('#logoutBtn')?.addEventListener('click', async () => {
      await api('admin/logout', { method: 'POST' }).catch(() => {});
      S.admin = false;
      renderBar();
      history.pushState(null, '', '/meet');
      route();
    });
  }

  function openLogin() {
    const d = $('#loginDialog');
    status($('#loginStatus'), S.configured ? '' : 'Admin login isn’t set up yet. Add the ADMIN_PASSWORD secret in Cloudflare.', S.configured ? '' : 'bad');
    $('#loginPw').value = '';
    d.showModal();
    $('#loginPw').focus();
  }

  $('#loginCancel').addEventListener('click', () => $('#loginDialog').close());
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    status($('#loginStatus'), 'Checking…');
    try {
      await api('admin/login', { method: 'POST', body: { password: $('#loginPw').value } });
      S.admin = true;
      $('#loginDialog').close();
      renderBar();
      history.pushState(null, '', `/meet${location.hash.startsWith('#admin') ? location.hash : '#admin'}`);
      route();
    } catch (err) {
      status($('#loginStatus'), err.message, 'bad');
    }
  });

  // ---------- Router ----------

  async function route() {
    const hash = location.hash;
    if (hash.startsWith('#admin')) {
      if (!S.admin) { if (!$('#loginDialog').open) openLogin(); if ($$('.m-view').every((v) => v.hidden)) showEnter(); return; }
      const [, id, sub] = hash.match(/^#admin(?:\/e\/([\w]+))?(?:\/(edit))?/) || [];
      document.title = 'Admin | Find a Time';
      if (hash === '#admin/new') return openEditor(null);
      if (id && sub) return openEditor(id);
      if (id) return openResults(id);
      return openDash();
    }
    const m = location.pathname.match(/^\/meet\/(\d{4})\/?$/);
    if (m) return openEvent(m[1]);
    showEnter();
  }

  addEventListener('hashchange', route);
  addEventListener('popstate', route);

  // ---------- Client: code entry ----------

  const boxes = $$('.m-code-boxes input');
  function showEnter() {
    document.title = 'Find a Time | Ignite Development';
    show('viewEnter');
    boxes.forEach((b) => { b.value = ''; });
    status($('#codeStatus'), '');
    if (matchMedia('(pointer: fine)').matches) boxes[0].focus();
  }

  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      const digits = box.value.replace(/\D/g, '');
      if (digits.length > 1) {
        digits.slice(0, 4 - i).split('').forEach((d, j) => { boxes[i + j].value = d; });
        boxes[Math.min(3, i + digits.length)].focus();
      } else {
        box.value = digits;
        if (digits && i < 3) boxes[i + 1].focus();
      }
      if (boxes.every((b) => /^\d$/.test(b.value))) $('#codeForm').requestSubmit();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i) { boxes[i - 1].value = ''; boxes[i - 1].focus(); e.preventDefault(); }
      if (e.key === 'ArrowLeft' && i) boxes[i - 1].focus();
      if (e.key === 'ArrowRight' && i < 3) boxes[i + 1].focus();
    });
    box.addEventListener('focus', () => box.select());
  });

  $('#codeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = boxes.map((b) => b.value).join('');
    if (!/^\d{4}$/.test(code)) return status($('#codeStatus'), 'Enter all four digits.', 'bad');
    status($('#codeStatus'), 'Looking it up…');
    try {
      const data = await api(`events/${code}`);
      history.pushState(null, '', `/meet/${code}`);
      openEvent(code, data);
    } catch (err) {
      status($('#codeStatus'), err.message, 'bad');
      boxes.forEach((b) => { b.value = ''; });
      boxes[0].focus();
    }
  });

  // ---------- Client: event ----------

  const C = { mine: {}, saved: {}, tool: 1, tz: localTz, heatOf: () => ({ cls: '', p: null }) };
  const mineGrid = makeGrid($('#mineGrid'), {
    slots: [], tz: localTz,
    cls: (s) => (C.mine[s] === 1 ? 's1' : C.mine[s] === 2 ? 's2' : '') + (C.data?.event.finalSlot === s ? ' fin' : ''),
    paint: {
      start(s) {
        C.base = { ...C.mine };
        return C.tool === 0 ? 0 : C.mine[s] === C.tool ? 0 : C.tool;
      },
      apply(list, v) {
        C.mine = { ...C.base };
        for (const s of list) { if (v) C.mine[s] = v; else delete C.mine[s]; }
        mineGrid.refresh();
        refreshGroup();
      },
      end() { queueSave(); },
    },
  });
  const groupGrid = makeGrid($('#groupGrid'), {
    slots: [], tz: localTz,
    cls: (s) => C.heatOf(s).cls,
    p: (s) => C.heatOf(s).p,
    hover: (s) => {
      const ev = C.data.event;
      if (s == null) return;
      if (ev.settings.visibility === 'all') $('#groupHover').innerHTML = whoHtml(s, ev, C.tz, groupList());
      else {
        const c = groupCounts()[s] || [0, 0];
        $('#groupHover').innerHTML = `<h3>${esc(slotLabel(s, C.tz, ev.slotMin))}</h3><p><b>${c[0]}</b> of ${groupTotal()} available${ev.settings.ifNeeded ? `, <b>${c[1]}</b> if needed` : ''}</p>`;
      }
    },
  });

  // The group view includes your unsaved changes so you see the effect as you paint.
  function groupList() {
    const others = (C.data.responses || []).filter((r) => !C.me || r.name.toLowerCase() !== C.me.name.toLowerCase());
    return C.me && Object.keys(C.mine).length ? [...others, { name: `${C.me.name} (you)`, avail: C.mine }] : others;
  }
  function groupCounts() {
    if (C.data.event.settings.visibility === 'all') return countAvail(groupList());
    const t = structuredClone(C.data.totals || {});
    for (const [s, v] of Object.entries(C.saved)) if (t[s]) t[s][v === 2 ? 1 : 0]--;
    for (const [s, v] of Object.entries(C.mine)) { t[s] ||= [0, 0]; t[s][v === 2 ? 1 : 0]++; }
    return t;
  }
  function groupTotal() {
    if (C.data.event.settings.visibility === 'all') return groupList().length;
    return C.data.count - (C.savedExists ? 1 : 0) + (Object.keys(C.mine).length ? 1 : 0);
  }
  function refreshGroup() {
    if (C.data.event.settings.visibility === 'private') return;
    const counts = groupCounts(), total = groupTotal(), fin = C.data.event.finalSlot;
    C.heatOf = (s) => heat(counts, total, s, fin === s ? 'fin' : '');
    $('#groupCount').textContent = `${total} response${total === 1 ? '' : 's'}`;
    $('#groupLegend').innerHTML = legendHtml(total, C.data.event.settings.ifNeeded);
    groupGrid.refresh();
  }

  async function openEvent(code, data) {
    show('viewEvent');
    if (!data) {
      try { data = await api(`events/${code}`); } catch (err) {
        showEnter();
        return status($('#codeStatus'), err.message, 'bad');
      }
    }
    const ev = data.event;
    if (C.code !== code) { C.me = null; C.token = null; C.mine = {}; C.saved = {}; C.savedExists = false; }
    C.data = data;
    C.code = code;
    C.key = `meet:${code}`;
    document.title = `${ev.title} | Find a Time`;
    $('#evKick').textContent = `Hosted by ${ev.settings.host}`;
    $('#evTitle').textContent = ev.title;
    $('#evDesc').textContent = ev.description;
    const deadline = ev.settings.deadline ? ` · Responses close ${dtf(localTz, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ev.settings.deadline))}` : '';
    $('#evMeta').textContent = `${rangeLabel(ev.dates)} · ${durLabel(ev.durationMin)} meeting${deadline}`;

    const saved = store.get(C.key);
    if (!C.tzChosen) C.tz = saved?.tz || localTz;
    tzOptions($('#tzSelect'), C.tz, [localTz, ev.tz]);

    renderFinal();
    $('#evClosed').hidden = ev.open;
    $('#toolMaybe').hidden = !ev.settings.ifNeeded;
    if (!ev.settings.ifNeeded && C.tool === 2) setTool(1);
    $('#whoEmailF').hidden = !ev.settings.askEmail;
    $('#whoEmail').required = ev.settings.askEmail && ev.settings.requireEmail;
    $('#whoEmailOpt').textContent = ev.settings.requireEmail ? '' : '(optional)';
    $('#whoCompanyF').hidden = !ev.settings.askCompany;
    $('#commentF').hidden = !ev.settings.askComment;

    const vis = ev.settings.visibility;
    $('#groupPanel').hidden = vis === 'private';
    $('#panels').classList.toggle('solo', vis === 'private' || !ev.open);
    $('#minePanel').hidden = !ev.open;
    $('#groupHover').innerHTML = `<span class="muted">${vis === 'all' ? 'Hover or tap a time to see who’s free.' : 'Hover or tap a time to see how many people are free.'}</span>`;

    if (!ev.open) {
      C.me = null;
      $('#whoForm').hidden = true;
      $('#board').hidden = vis === 'private';
      $('.m-save').hidden = true;
      $('#meLine').textContent = '';
      C.mine = {}; C.saved = {};
      drawGrids();
      return;
    }
    $('.m-save').hidden = false;

    if (C.me) return enterBoard();
    if (saved?.name && saved?.token) {
      try {
        const found = await api(`events/${code}/me`, { method: 'POST', body: { name: saved.name, token: saved.token } });
        if (found.found) return enterBoard(found.response, saved.token);
      } catch {}
    }
    $('#board').hidden = true;
    $('#whoForm').hidden = false;
    $('#whoName').value = saved?.name || '';
    $('#whoEmail').value = saved?.email || '';
    $('#whoCompany').value = saved?.company || '';
    status($('#whoStatus'), '');
  }

  function renderFinal() {
    const ev = C.data.event, box = $('#evFinal');
    box.hidden = ev.finalSlot == null;
    if (ev.finalSlot == null) return;
    box.innerHTML = finalHtml(ev, ev.finalSlot, C.tz);
    $('[data-ics]', box).onclick = () => download(`${ev.title.replace(/[^\w]+/g, '-')}.ics`, 'text/calendar', icsFor(ev, ev.finalSlot));
  }

  $('#whoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#whoName').value.trim();
    const email = $('#whoEmail').value.trim();
    if (!name) return status($('#whoStatus'), 'Please enter your name.', 'bad');
    if ($('#whoEmail').required && !email) return status($('#whoStatus'), 'Please enter your email.', 'bad');
    status($('#whoStatus'), 'One moment…');
    const saved = store.get(C.key);
    const token = saved?.name?.toLowerCase() === name.toLowerCase() ? saved.token : undefined;
    try {
      const found = await api(`events/${C.code}/me`, { method: 'POST', body: { name, email, token } });
      C.me = { name, email, company: $('#whoCompany').value.trim(), comment: '' };
      enterBoard(found.found ? found.response : null, token);
      if (found.found) toast('Welcome back. Your saved times are loaded.');
    } catch (err) {
      status($('#whoStatus'), err.message, 'bad');
    }
  });

  function enterBoard(resp, token) {
    if (resp) {
      C.me = { name: resp.name, email: C.me?.email || resp.email, company: C.me?.company || resp.company, comment: resp.comment };
      C.mine = { ...resp.avail };
      C.saved = { ...resp.avail };
      C.savedExists = true;
    } else if (resp === null) {
      C.mine = {}; C.saved = {}; C.savedExists = false;
    }
    if (token) C.token = token;
    store.set(C.key, { ...store.get(C.key), name: C.me.name, email: C.me.email, company: C.me.company, token: C.token, tz: C.tz });
    $('#whoForm').hidden = true;
    $('#board').hidden = false;
    $('#comment').value = C.me.comment || '';
    $('#meLine').innerHTML = `Responding as <b>${esc(C.me.name)}</b><button type="button" id="notMe">Not you?</button>`;
    $('#notMe').onclick = () => {
      store.del(C.key);
      C.me = null; C.token = null; C.mine = {}; C.saved = {}; C.savedExists = false;
      openEvent(C.code, C.data);
    };
    status($('#saveStatus'), Object.keys(C.saved).length ? 'Your times are saved. Changes save automatically.' : 'Pick your times. Changes save automatically.');
    drawGrids();
  }

  function drawGrids() {
    const ev = C.data.event;
    const slots = slotsOf(ev);
    mineGrid.set({ slots, tz: C.tz });
    groupGrid.set({ slots, tz: C.tz });
    refreshGroup();
  }

  function setTool(t) {
    C.tool = t;
    $$('#paintTools button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.tool) === t)));
  }
  $$('#paintTools button').forEach((b) => b.addEventListener('click', () => setTool(Number(b.dataset.tool))));

  $('#tzSelect').addEventListener('change', (e) => {
    C.tz = e.target.value;
    C.tzChosen = true;
    if (C.key) store.set(C.key, { ...store.get(C.key), tz: C.tz });
    renderFinal();
    drawGrids();
  });

  let saveTimer;
  function queueSave() {
    status($('#saveStatus'), 'Unsaved changes…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 900);
  }
  $('#comment').addEventListener('input', queueSave);
  $('#saveBtn').addEventListener('click', () => { clearTimeout(saveTimer); save(); });

  async function save() {
    if (!C.me) return;
    status($('#saveStatus'), 'Saving…');
    try {
      const res = await api(`events/${C.code}/responses`, {
        method: 'POST',
        body: { ...C.me, comment: $('#comment').value, avail: C.mine, token: C.token },
      });
      C.token = res.token;
      C.saved = { ...C.mine };
      C.savedExists = true;
      store.set(C.key, { ...store.get(C.key), name: C.me.name, email: C.me.email, company: C.me.company, token: C.token, tz: C.tz });
      const fresh = await api(`events/${C.code}`).catch(() => null);
      if (fresh) { C.data = fresh; refreshGroup(); }
      status($('#saveStatus'), `Saved at ${dtf(localTz, { hour: 'numeric', minute: '2-digit' }).format(Date.now())}. You can close this page or come back to change it.`, 'ok');
    } catch (err) {
      status($('#saveStatus'), err.message, 'bad');
    }
  }

  addEventListener('beforeunload', (e) => {
    if (C.me && JSON.stringify(C.mine) !== JSON.stringify(C.saved)) e.preventDefault();
  });

  // ---------- Admin: dashboard ----------

  const inviteText = (ev) => `Hi! Please share your availability for "${ev.title}". Go to ${location.origin}/meet and enter code ${ev.code}, or open ${location.origin}/meet/${ev.code} directly. It takes about a minute.`;

  function pills(ev) {
    const past = ev.settings.deadline && Date.parse(ev.settings.deadline) < Date.now();
    let h = ev.status === 'closed' ? '<span class="m-pill off">Closed</span>' : past ? '<span class="m-pill off">Deadline passed</span>' : '<span class="m-pill">Open</span>';
    if (ev.finalSlot != null) h += '<span class="m-pill set">Time set</span>';
    return h;
  }

  async function openDash() {
    show('viewDash');
    const list = $('#eventList');
    list.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const { events } = await api('admin/events');
      S.events = events;
      if (!events.length) {
        list.innerHTML = '<div class="m-empty"><p>No events yet. Create one, then send clients the link and code.</p><a class="btn" href="#admin/new">Create your first event</a></div>';
        return;
      }
      list.innerHTML = events.map((ev) => `<article class="m-row">
        <div class="m-row-code">${esc(ev.code)}</div>
        <div><h2><a href="#admin/e/${ev.id}">${esc(ev.title)}</a>${pills(ev)}</h2>
          <p>${esc(rangeLabel(ev.dates))} · ${ev.responseCount} response${ev.responseCount === 1 ? '' : 's'}</p></div>
        <div class="m-row-acts">
          <a class="m-mini hot" href="#admin/e/${ev.id}">Results</a>
          <button type="button" class="m-mini" data-invite="${ev.id}">Copy invite</button>
          <a class="m-mini" href="#admin/e/${ev.id}/edit">Edit</a>
          <button type="button" class="m-mini" data-dup="${ev.id}">Duplicate</button>
        </div></article>`).join('');
      $$('[data-invite]', list).forEach((b) => { b.onclick = () => copy(inviteText(events.find((x) => x.id === b.dataset.invite)), 'Invite copied'); });
      $$('[data-dup]', list).forEach((b) => {
        b.onclick = async () => {
          const { event } = await api(`admin/events/${b.dataset.dup}/duplicate`, { method: 'POST' });
          toast(`Duplicated as code ${event.code}`);
          location.hash = `#admin/e/${event.id}/edit`;
        };
      });
    } catch (err) {
      list.innerHTML = `<p class="form-status bad">${esc(err.message)}</p>`;
    }
  }

  // ---------- Admin: editor ----------

  const E = { dates: new Set(), excluded: new Set() };
  const timeOpts = (from, to, sel) => {
    let h = '';
    for (let m = from; m <= to; m += 15) h += `<option value="${m}"${m === sel ? ' selected' : ''}>${m === 1440 ? '12 AM (midnight)' : timeLabel(m)}</option>`;
    return h;
  };
  $('#eDur').innerHTML = [15, 20, 30, 45, 60, 75, 90, 120, 150, 180, 240, 300, 360, 480].map((m) => `<option value="${m}">${durLabel(m)}</option>`).join('');

  function nextWeekdays(n, from = new Date()) {
    const out = [];
    const d = new Date(from);
    d.setDate(d.getDate() + 1);
    while (out.length < n) {
      if (d.getDay() % 6) out.push(ymd(d));
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  async function openEditor(id) {
    show('viewEdit');
    const form = $('#editForm');
    status($('#eStatusMsg'), id ? 'Loading…' : '');
    let ev;
    try {
      ev = id ? (await api(`admin/events/${id}`)).event : {
        title: '', description: '', code: (await api('admin/code')).code, tz: 'America/New_York', dates: nextWeekdays(5),
        startMin: 540, endMin: 1020, slotMin: 30, durationMin: 60, excluded: [], notes: '', status: 'open', finalSlot: null,
        settings: { host: 'Ignite Development', visibility: 'all', ifNeeded: true, askEmail: true, requireEmail: false, askCompany: true, askComment: true, deadline: null, showFinal: true },
      };
    } catch (err) {
      return status($('#eStatusMsg'), err.message, 'bad');
    }
    E.id = id;
    E.ev = ev;
    E.dates = new Set(ev.dates);
    E.excluded = new Set(ev.excluded);
    const first = ev.dates[0] ? noon(ev.dates[0]) : new Date();
    E.month = new Date(first.getUTCFullYear(), first.getUTCMonth(), 1);
    $('#editTitle').textContent = id ? `Edit: ${ev.title}` : 'New event';
    $('#eTitle').value = ev.title;
    $('#eDesc').value = ev.description;
    $('#eCode').value = ev.code;
    $('#eHost').value = ev.settings.host;
    $('#eNotes').value = ev.notes || '';
    $('#eStart').innerHTML = timeOpts(0, 1425, ev.startMin);
    $('#eEnd').innerHTML = timeOpts(15, 1440, ev.endMin);
    $('#eSlot').value = String(ev.slotMin);
    $('#eDur').value = String(ev.durationMin);
    if ($('#eDur').value !== String(ev.durationMin)) { $('#eDur').insertAdjacentHTML('beforeend', `<option value="${ev.durationMin}">${durLabel(ev.durationMin)}</option>`); $('#eDur').value = String(ev.durationMin); }
    tzOptions($('#eTz'), ev.tz, [localTz]);
    $$('[name="eVis"]').forEach((r) => { r.checked = r.value === ev.settings.visibility; });
    $('#eIfNeeded').checked = ev.settings.ifNeeded;
    $('#eAskEmail').checked = ev.settings.askEmail;
    $('#eReqEmail').checked = ev.settings.requireEmail;
    $('#eAskCompany').checked = ev.settings.askCompany;
    $('#eAskComment').checked = ev.settings.askComment;
    $('#eShowFinal').checked = ev.settings.showFinal;
    $('#eStatus').value = ev.status;
    $('#eDeadline').value = ev.settings.deadline ? toLocalInput(ev.settings.deadline) : '';
    syncEmail();
    drawCal();
    drawBlock();
    if (id) status($('#eStatusMsg'), '');
    form.dataset.dirty = '';
    if (!id) $('#eTitle').focus();
  }

  const toLocalInput = (iso) => { const d = new Date(iso); return `${ymd(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const syncEmail = () => { $('#eReqEmail').disabled = !$('#eAskEmail').checked; if (!$('#eAskEmail').checked) $('#eReqEmail').checked = false; };
  $('#eAskEmail').addEventListener('change', syncEmail);
  $('#eCodeNew').addEventListener('click', async () => { $('#eCode').value = (await api('admin/code')).code; });
  $('#eCode').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });

  function draftEvent() {
    return {
      ...E.ev,
      title: $('#eTitle').value.trim(),
      description: $('#eDesc').value.trim(),
      code: $('#eCode').value.trim(),
      notes: $('#eNotes').value.trim(),
      tz: $('#eTz').value,
      dates: [...E.dates].sort(),
      startMin: Number($('#eStart').value),
      endMin: Number($('#eEnd').value),
      slotMin: Number($('#eSlot').value),
      durationMin: Number($('#eDur').value),
      excluded: [...E.excluded],
      status: $('#eStatus').value,
      settings: {
        host: $('#eHost').value.trim() || 'Ignite Development',
        visibility: $('[name="eVis"]:checked')?.value || 'all',
        ifNeeded: $('#eIfNeeded').checked,
        askEmail: $('#eAskEmail').checked,
        requireEmail: $('#eReqEmail').checked,
        askCompany: $('#eAskCompany').checked,
        askComment: $('#eAskComment').checked,
        showFinal: $('#eShowFinal').checked,
        deadline: $('#eDeadline').value ? new Date($('#eDeadline').value).toISOString() : null,
      },
    };
  }

  // Month calendars for picking dates; drag across days to select or clear a run.
  let calDrag = null;
  function drawCal() {
    const today = ymd(new Date());
    let h = '';
    for (let i = 0; i < 3; i++) {
      const m = new Date(E.month.getFullYear(), E.month.getMonth() + i, 1);
      h += `<div class="m-mo"><h3>${m.toLocaleString('en-US', { month: 'long', year: 'numeric' })}</h3><div class="m-mo-g">`;
      h += ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<span>${d}</span>`).join('');
      h += '<i></i>'.repeat(m.getDay());
      const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
      for (let d = 1; d <= days; d++) {
        const key = ymd(new Date(m.getFullYear(), m.getMonth(), d));
        const sel = E.dates.has(key);
        h += `<button type="button" class="m-d${sel ? ' sel' : ''}${key === today ? ' today' : ''}" data-d="${key}"${key < today && !sel ? ' disabled' : ''} aria-pressed="${sel}">${d}</button>`;
      }
      h += '</div></div>';
    }
    h += '<div class="m-datecal-more m-inline"><button type="button" class="m-mini" data-mo="-1">&larr; Earlier</button><button type="button" class="m-mini" data-mo="1">Later &rarr;</button></div>';
    $('#eCal').innerHTML = h;
    $$('[data-mo]', $('#eCal')).forEach((b) => { b.onclick = () => { E.month = new Date(E.month.getFullYear(), E.month.getMonth() + Number(b.dataset.mo), 1); drawCal(); }; });
    $('#eDateCount').textContent = E.dates.size ? `${E.dates.size} date${E.dates.size === 1 ? '' : 's'} picked: ${rangeLabel([...E.dates].sort())}` : 'No dates picked yet.';
  }

  // Dragging selects (or clears) every day between where the drag started and the pointer.
  function dragTo(to) {
    const [a, b] = [calDrag.from, to].sort();
    E.dates = new Set(calDrag.base);
    for (const btn of $$('.m-d:not(:disabled)', $('#eCal'))) {
      const d = btn.dataset.d;
      if (d >= a && d <= b) { if (calDrag.on) E.dates.add(d); else E.dates.delete(d); }
      btn.classList.toggle('sel', E.dates.has(d));
      btn.setAttribute('aria-pressed', String(E.dates.has(d)));
    }
  }
  $('#eCal').addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.m-d:not(:disabled)');
    if (!b) return;
    e.preventDefault();
    calDrag = { from: b.dataset.d, on: !E.dates.has(b.dataset.d), base: new Set(E.dates) };
    dragTo(b.dataset.d);
  });
  $('#eCal').addEventListener('pointermove', (e) => {
    if (calDrag == null) return;
    const b = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.m-d:not(:disabled)');
    if (b) dragTo(b.dataset.d);
  });
  addEventListener('pointerup', () => {
    if (calDrag == null) return;
    calDrag = null;
    drawCal();
    drawBlock();
  });

  $('#eQuick').addEventListener('click', (e) => {
    const q = e.target.closest('[data-quick]')?.dataset.quick;
    if (!q) return;
    if (q === 'clear') E.dates.clear();
    else if (q === 'noweekend') [...E.dates].forEach((d) => { if (noon(d).getUTCDay() % 6 === 0) E.dates.delete(d); });
    else if (q === 'week') {
      const d = new Date();
      d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7) - 1);
      nextWeekdays(5, d).forEach((x) => E.dates.add(x));
    } else nextWeekdays(Number(q)).forEach((x) => E.dates.add(x));
    const first = [...E.dates].sort()[0];
    if (first) { const f = noon(first); E.month = new Date(f.getUTCFullYear(), f.getUTCMonth(), 1); }
    drawCal();
    drawBlock();
  });

  const blockGrid = makeGrid($('#eBlockGrid'), {
    slots: [], tz: 'America/New_York',
    cls: (s) => (E.excluded.has(s) ? 'blk' : ''),
    paint: {
      start(s) { E.base = new Set(E.excluded); return E.excluded.has(s) ? 0 : 1; },
      apply(list, v) {
        E.excluded = new Set(E.base);
        for (const s of list) { if (v) E.excluded.add(s); else E.excluded.delete(s); }
        blockGrid.refresh();
      },
      end() {},
    },
  });
  function drawBlock() {
    const ev = draftEvent();
    if (ev.endMin <= ev.startMin) { $('#eBlockGrid').innerHTML = '<p class="m-grid-empty">The latest time has to be after the earliest time.</p>'; return; }
    blockGrid.set({ slots: slotsOf({ ...ev, excluded: [] }, true), tz: ev.tz });
  }
  ['#eStart', '#eEnd', '#eSlot', '#eTz'].forEach((s) => $(s).addEventListener('change', drawBlock));
  $('#eUnblock').addEventListener('click', () => { E.excluded.clear(); blockGrid.refresh(); });

  $('#editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ev = draftEvent();
    if (!ev.title) { $('#eTitle').focus(); return status($('#eStatusMsg'), 'Give the event a title.', 'bad'); }
    if (!/^\d{4}$/.test(ev.code)) { $('#eCode').focus(); return status($('#eStatusMsg'), 'The code must be four digits.', 'bad'); }
    if (!ev.dates.length) return status($('#eStatusMsg'), 'Pick at least one date.', 'bad');
    if (ev.endMin <= ev.startMin) return status($('#eStatusMsg'), 'The latest time has to be after the earliest time.', 'bad');
    const valid = new Set(slotsOf({ ...ev, excluded: [] }, true));
    ev.excluded = ev.excluded.filter((s) => valid.has(s));
    if (ev.finalSlot != null && !valid.has(ev.finalSlot)) ev.finalSlot = null;
    status($('#eStatusMsg'), 'Saving…');
    try {
      const { event } = E.id
        ? await api(`admin/events/${E.id}`, { method: 'PUT', body: ev })
        : await api('admin/events', { method: 'POST', body: ev });
      toast(E.id ? 'Event saved' : `Event created. Code ${event.code}`);
      location.hash = `#admin/e/${event.id}`;
    } catch (err) {
      status($('#eStatusMsg'), err.message, 'bad');
    }
  });

  // ---------- Admin: results ----------

  const R = { off: new Set(), tz: localTz, heatOf: () => ({ cls: '', p: null }) };
  const resGrid = makeGrid($('#rGrid'), {
    slots: [], tz: localTz,
    cls: (s) => R.heatOf(s).cls,
    p: (s) => R.heatOf(s).p,
    hover: (s) => { if (s != null) $('#rHover').innerHTML = whoHtml(s, R.ev, R.tz, R.included()); },
  });
  R.included = () => R.responses.filter((r) => !R.off.has(r.id));

  async function openResults(id, data) {
    show('viewResults');
    if (!data) {
      try { data = await api(`admin/events/${id}`); } catch (err) {
        $('#rTitle').textContent = '';
        return status($('#rMeta'), err.message, 'bad');
      }
    }
    if (R.id !== id) { R.off = new Set(); R.pick = null; }
    R.id = id;
    R.ev = data.event;
    R.responses = data.responses;
    const ev = R.ev;
    document.title = `${ev.title} | Admin`;
    $('#rKick').innerHTML = `Hosted by ${esc(ev.settings.host)} ${pills(ev)}`;
    $('#rTitle').textContent = ev.title;
    $('#rMeta').className = 'm-meta';
    $('#rMeta').textContent = `${rangeLabel(ev.dates)} · ${timeLabel(ev.startMin)} – ${timeLabel(ev.endMin)} ${tzName(ev.tz)} · ${durLabel(ev.durationMin)} meeting · ${{ all: 'Clients see names', anon: 'Clients see totals only', private: 'Clients see only their own times' }[ev.settings.visibility]}`;
    $('#rCode').textContent = ev.code;
    $('#rActions').innerHTML = `
      <button type="button" class="m-mini hot" data-a="invite">Copy invite message</button>
      <button type="button" class="m-mini" data-a="link">Copy link</button>
      <a class="m-mini" href="/meet/${esc(ev.code)}" target="_blank" rel="noopener">Open client page</a>
      <a class="m-mini" href="#admin/e/${ev.id}/edit">Edit event</a>
      <button type="button" class="m-mini" data-a="toggle">${ev.status === 'open' ? 'Close responses' : 'Reopen responses'}</button>
      <button type="button" class="m-mini" data-a="csv">Export CSV</button>
      <button type="button" class="m-mini" data-a="dup">Duplicate</button>
      <button type="button" class="m-mini danger" data-a="delete">Delete event</button>`;
    tzOptions($('#rTz'), R.tz, [localTz, ev.tz]);
    renderResFinal();
    renderPeople();
    drawResults();
  }

  function renderResFinal() {
    const ev = R.ev, box = $('#rFinal');
    box.hidden = ev.finalSlot == null;
    if (ev.finalSlot == null) return;
    box.innerHTML = finalHtml(ev, ev.finalSlot, R.tz, '<button type="button" class="m-mini" data-clear>Clear</button>');
    $('[data-ics]', box).onclick = () => download(`${ev.title.replace(/[^\w]+/g, '-')}.ics`, 'text/calendar', icsFor(ev, ev.finalSlot));
    $('[data-clear]', box).onclick = () => setFinal(null);
  }

  function renderPeople() {
    const list = R.responses;
    $('#rCount').textContent = `(${list.length})`;
    $('#rPeople').innerHTML = list.length ? list.map((r) => `<li>
      <input type="checkbox" data-inc="${r.id}"${R.off.has(r.id) ? '' : ' checked'} aria-label="Include ${esc(r.name)}">
      <div><b>${esc(r.name)}</b>${r.company ? `<small>${esc(r.company)}</small>` : ''}${r.email ? `<small><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></small>` : ''}
        <small>${Object.keys(r.avail).length} slots · updated ${dtf(localTz, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(r.updatedAt)}</small>
        ${r.comment ? `<q>${esc(r.comment)}</q>` : ''}</div>
      <button type="button" class="m-mini danger" data-del="${r.id}" aria-label="Delete ${esc(r.name)}'s response">&times;</button></li>`).join('')
      : '<li><span></span><span class="muted">No responses yet. Copy the invite and send it to your clients.</span></li>';
    $$('[data-inc]').forEach((c) => c.addEventListener('change', () => {
      if (c.checked) R.off.delete(c.dataset.inc); else R.off.add(c.dataset.inc);
      drawResults();
    }));
    $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      const r = R.responses.find((x) => x.id === b.dataset.del);
      if (!confirm(`Delete ${r.name}'s response? This can't be undone.`)) return;
      openResults(R.id, await api(`admin/events/${R.id}/responses/${r.id}`, { method: 'DELETE' }));
      toast('Response deleted');
    }));
  }

  // Rank every window of the meeting length by how many included people can make it.
  function bestTimes() {
    const ev = R.ev, people = R.included();
    const slots = slotsOf(ev), set = new Set(slots);
    const need = Math.max(1, Math.ceil(ev.durationMin / ev.slotMin));
    const wins = [];
    for (const s of slots) {
      const run = Array.from({ length: need }, (_, i) => s + i * ev.slotMin);
      if (!run.every((x) => set.has(x))) continue;
      const yes = [], maybe = [], no = [];
      for (const p of people) {
        const vals = run.map((x) => p.avail[x] || 0);
        (vals.includes(0) ? no : vals.includes(2) ? maybe : yes).push(p.name);
      }
      wins.push({ s, run, yes, maybe, no });
    }
    wins.sort((a, b) => (b.yes.length + b.maybe.length) - (a.yes.length + a.maybe.length) || b.yes.length - a.yes.length || a.s - b.s);
    const picked = [];
    for (const w of wins) {
      if (!w.yes.length && !w.maybe.length) break;
      if (picked.some((p) => Math.abs(p.s - w.s) < ev.durationMin)) continue;
      picked.push(w);
      if (picked.length === 6) break;
    }
    return { picked, total: people.length, possible: wins.length };
  }

  function drawResults() {
    const ev = R.ev, people = R.included();
    const counts = countAvail(people), total = people.length;
    const best = bestTimes();
    if (R.pick != null && !best.picked.some((w) => w.s === R.pick)) R.pick = null;
    const pickRun = new Set(best.picked.find((w) => w.s === R.pick)?.run || []);
    R.heatOf = (s) => heat(counts, total, s, `${ev.finalSlot === s ? 'fin' : ''}${pickRun.has(s) ? ' on' : ''}`);
    $('#rLegend').innerHTML = legendHtml(total, ev.settings.ifNeeded);
    resGrid.set({ slots: slotsOf(ev), tz: R.tz });

    $('#rBestNote').textContent = !best.possible ? `No ${durLabel(ev.durationMin)} window fits in the grid. Shorten the meeting length or widen the times.`
      : !total ? 'Best times show up once people respond.'
        : `${durLabel(ev.durationMin)} windows, ranked by how many of the ${total} included people can make it.`;
    $('#rBest').innerHTML = best.picked.map((w) => `<li data-pick="${w.s}"${w.s === R.pick ? ' class="on"' : ''}>
      <b>${esc(slotLabel(w.s, R.tz, ev.durationMin))}</b>
      <small>${w.yes.length + w.maybe.length} of ${total} can make it${w.maybe.length ? ` (${w.maybe.length} if needed: ${esc(w.maybe.join(', '))})` : ''}</small>
      ${w.no.length ? `<small>Can't: ${esc(w.no.join(', '))}</small>` : ''}
      <button type="button" class="m-mini${ev.finalSlot === w.s ? '' : ' hot'}" data-final="${w.s}">${ev.finalSlot === w.s ? 'Chosen' : 'Choose this time'}</button></li>`).join('');
    $$('[data-pick]').forEach((li) => li.addEventListener('click', (e) => {
      if (e.target.closest('[data-final]')) return;
      R.pick = R.pick === Number(li.dataset.pick) ? null : Number(li.dataset.pick);
      drawResults();
    }));
    $$('[data-final]').forEach((b) => b.addEventListener('click', () => setFinal(Number(b.dataset.final))));
  }

  async function setFinal(slot) {
    const data = await api(`admin/events/${R.id}`, { method: 'PUT', body: { finalSlot: slot } });
    toast(slot == null ? 'Meeting time cleared' : R.ev.settings.showFinal ? 'Meeting time set. Clients will see it.' : 'Meeting time set');
    openResults(R.id, data);
  }

  $('#rTz').addEventListener('change', (e) => { R.tz = e.target.value; renderResFinal(); drawResults(); });

  $('#rActions').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    const ev = R.ev;
    if (a === 'invite') copy(inviteText(ev), 'Invite copied');
    if (a === 'link') copy(`${location.origin}/meet/${ev.code}`, 'Link copied');
    if (a === 'toggle') {
      openResults(R.id, await api(`admin/events/${R.id}`, { method: 'PUT', body: { status: ev.status === 'open' ? 'closed' : 'open' } }));
      toast(ev.status === 'open' ? 'Responses closed' : 'Responses reopened');
    }
    if (a === 'dup') {
      const { event } = await api(`admin/events/${R.id}/duplicate`, { method: 'POST' });
      toast(`Duplicated as code ${event.code}`);
      location.hash = `#admin/e/${event.id}/edit`;
    }
    if (a === 'delete') {
      if (!confirm(`Delete “${ev.title}” and all ${R.responses.length} responses? This can't be undone.`)) return;
      await api(`admin/events/${R.id}`, { method: 'DELETE' });
      toast('Event deleted');
      location.hash = '#admin';
    }
    if (a === 'csv') {
      const people = R.responses;
      const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
      const rows = [['Date', `Time (${tzName(R.tz)})`, 'Available', 'If needed', ...people.map((p) => p.name)]];
      for (const s of slotsOf(ev)) {
        const ts = s * 6e4;
        const vals = people.map((p) => (p.avail[s] === 1 ? 'Yes' : p.avail[s] === 2 ? 'If needed' : ''));
        rows.push([dtf(R.tz, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }).format(ts), dtf(R.tz, { hour: 'numeric', minute: '2-digit' }).format(ts),
          vals.filter((v) => v === 'Yes').length, vals.filter((v) => v === 'If needed').length, ...vals]);
      }
      download(`${ev.title.replace(/[^\w]+/g, '-')}-availability.csv`, 'text/csv', rows.map((r) => r.map(cell).join(',')).join('\r\n'));
    }
  });

  // ---------- Start ----------

  renderBar();
  api('admin/session').then((s) => {
    S.admin = s.admin;
    S.configured = s.configured;
    renderBar();
    route();
  }).catch(() => route());
})();
