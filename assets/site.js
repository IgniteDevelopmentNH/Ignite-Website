(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const ease = (t) => t * t * (3 - 2 * t);
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = document.documentElement;
  if (still) root.classList.add('still');

  /* ---------- Nav ---------- */
  const nav = $('#nav');
  const btn = $('#navBtn');
  const setMenu = (open) => {
    root.classList.toggle('menu-open', open);
    btn.setAttribute('aria-expanded', open);
  };
  btn.addEventListener('click', () => setMenu(!root.classList.contains('menu-open')));
  $$('#navLinks a').forEach((a) => a.addEventListener('click', () => setMenu(false)));
  addEventListener('keydown', (e) => e.key === 'Escape' && setMenu(false));
  $$('[data-year]').forEach((el) => { el.textContent = new Date().getFullYear(); });

  /* ---------- Headline word splitting ---------- */
  $$('[data-split]').forEach((el) => {
    let i = 0;
    const walk = (node) => {
      [...node.childNodes].forEach((n) => {
        if (n.nodeType === 3) {
          const frag = document.createDocumentFragment();
          n.textContent.split(/(\s+)/).forEach((w) => {
            if (!w) return;
            if (/^\s+$/.test(w)) return frag.append(' ');
            const outer = document.createElement('span');
            outer.className = 'w';
            const inner = document.createElement('span');
            inner.textContent = w;
            inner.style.setProperty('--i', i++);
            outer.append(inner);
            frag.append(outer);
          });
          n.replaceWith(frag);
        } else if (n.nodeType === 1 && n.tagName !== 'BR') walk(n);
      });
    };
    walk(el);
  });

  /* ---------- Reveal once / play while visible ---------- */
  const once = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      once.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  $$('.rv, [data-split]').forEach((el) => once.observe(el));

  const play = new IntersectionObserver((entries) => {
    entries.forEach((e) => e.target.classList.toggle('play', e.isIntersecting));
  }, { threshold: 0.2 });
  $$('.viz').forEach((el) => play.observe(el));

  /* ---------- Contact form ---------- */
  const form = $('#contactForm');
  if (form) {
    const status = $('#formStatus');
    const submit = form.querySelector('button[type=submit]');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      status.className = 'form-status';
      status.textContent = 'Sending...';
      try {
        const res = await fetch(form.action, {
          method: 'POST',
          body: new FormData(form),
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(String(res.status));
        form.reset();
        form.classList.add('sent');
        status.className = 'form-status ok';
        status.textContent = "Thanks. Your message is on its way, and we'll reach out to set up a conversation.";
      } catch {
        status.className = 'form-status bad';
        status.textContent = 'That didn’t send. Please try again or email contact@ignitedevelopment.net.';
      }
      submit.disabled = false;
    });
  }

  /* ---------- Scroll-linked scenes ---------- */
  const bar = $('.progress');
  const story = $('.story');
  const tiles = story ? $$('.tile', story) : [];
  const steps = story ? $$('.story-step', story) : [];
  const links = story && $('.story-links', story);
  const shell = story && $('.shell', story);
  const meter = story && $('.story-meter i', story);
  const track = story && $('.story-meter b', story);
  const scrubs = $$('.scrub').map((el) => {
    const words = el.textContent.trim().split(/\s+/);
    el.setAttribute('aria-label', el.textContent.trim());
    el.textContent = '';
    const spans = words.map((w) => {
      const s = document.createElement('span');
      s.textContent = w;
      s.setAttribute('aria-hidden', 'true');
      el.append(s, ' ');
      return s;
    });
    return { el, spans };
  });
  const lines = $$('.tl');
  const ghost = $('.hero-mark');
  const fills = $$('.stack, .hrs-title');

  if (story && still) story.classList.add('is-static');

  const renderStory = (vh) => {
    const r = story.getBoundingClientRect();
    if (r.bottom < -vh || r.top > vh * 1.5) return;
    const p = clamp(-r.top / (r.height - vh));
    tiles.forEach((tile, i) => {
      const t = ease(clamp((p - 0.3 - i * 0.022) / 0.34));
      const drift = Math.sin(p * 14 + i * 1.7) * 3 * (1 - t);
      tile.style.setProperty('--t', t.toFixed(4));
      tile.style.setProperty('--dy', drift.toFixed(3));
    });
    links.style.opacity = (0.75 * (1 - clamp((p - 0.26) / 0.16))).toFixed(3);
    shell.style.opacity = clamp((p - 0.5) / 0.18).toFixed(3);
    meter.style.transform = `scaleX(${p.toFixed(4)})`;
    track.style.setProperty('--m', p.toFixed(4));
    track.setAttribute('aria-valuenow', Math.round(p * 100));
    story.classList.toggle('done', p > 0.72);
    const ranges = [[-1, 0, 0.26, 0.32], [0.28, 0.34, 0.56, 0.62], [0.6, 0.66, 2, 3]];
    steps.forEach((s, i) => {
      const [a, b, c, d] = ranges[i];
      const o = clamp((p - a) / (b - a)) * (1 - clamp((p - c) / (d - c)));
      s.style.opacity = o.toFixed(3);
      s.style.transform = `translateY(${((1 - o) * (p < b ? 18 : -18)).toFixed(1)}px)`;
      s.style.visibility = o < 0.01 ? 'hidden' : 'visible';
    });
  };

  const render = () => {
    const vh = innerHeight;
    const y = scrollY;
    const max = root.scrollHeight - vh;
    bar.style.transform = `scaleX(${max > 0 ? (y / max).toFixed(4) : 0})`;
    nav.classList.toggle('scrolled', y > 24);
    if (ghost && y < vh * 1.2) ghost.style.transform = `translate3d(0,${(y * 0.16).toFixed(1)}px,0) rotate(${(y * 0.012).toFixed(2)}deg)`;
    if (story && !still) renderStory(vh);
    if (!still) fills.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.bottom < -vh || r.top > vh * 1.5) return;
      el.style.setProperty('--p', clamp((vh * 0.92 - r.top) / (vh * 0.42 + r.height / 2)).toFixed(4));
    });
    scrubs.forEach(({ el, spans }) => {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh) return;
      const p = clamp((vh * 0.88 - r.top) / (r.height + vh * 0.42));
      const lit = p * (spans.length + 2);
      spans.forEach((s, i) => { s.style.opacity = (0.16 + 0.84 * clamp(lit - i)).toFixed(3); });
    });
    lines.forEach((tl) => {
      const r = tl.getBoundingClientRect();
      if (r.bottom < -vh || r.top > vh * 1.5) return;
      const p = clamp((vh * 0.62 - r.top) / r.height);
      tl.style.setProperty('--p', p.toFixed(4));
      $$('.tl-step', tl).forEach((s) => {
        const offset = s.getBoundingClientRect().top - r.top;
        s.classList.toggle('on', p * r.height >= offset - 4);
      });
    });
  };

  if (still) {
    scrubs.forEach(({ spans }) => spans.forEach((s) => { s.style.opacity = 1; }));
    lines.forEach((tl) => {
      tl.style.setProperty('--p', 1);
      $$('.tl-step', tl).forEach((s) => s.classList.add('on'));
    });
  }

  let queued = false;
  const request = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(); });
  };
  addEventListener('scroll', request, { passive: true });
  addEventListener('resize', request, { passive: true });
  render();

  /* ---------- Story slider: tap or drag to move through the scene ---------- */
  if (track && !still) {
    const seek = (p, behavior) => {
      const r = story.getBoundingClientRect();
      scrollTo({ top: scrollY + r.top + clamp(p) * (r.height - innerHeight), behavior });
    };
    const at = (e) => {
      const r = track.getBoundingClientRect();
      return (e.clientX - r.left) / r.width;
    };
    let startX = null;
    let dragging = false;
    track.addEventListener('pointerdown', (e) => {
      startX = e.clientX;
      dragging = false;
      track.setPointerCapture(e.pointerId);
    });
    track.addEventListener('pointermove', (e) => {
      if (startX === null) return;
      if (Math.abs(e.clientX - startX) > 4) dragging = true;
      if (dragging) seek(at(e), 'instant');
    });
    track.addEventListener('pointerup', (e) => {
      if (startX !== null && !dragging) seek(at(e), 'smooth');
      startX = null;
    });
    track.addEventListener('pointercancel', () => { startX = null; });
    track.addEventListener('keydown', (e) => {
      const now = Number(track.getAttribute('aria-valuenow')) / 100;
      const next = { ArrowRight: now + 0.1, ArrowUp: now + 0.1, ArrowLeft: now - 0.1, ArrowDown: now - 0.1, Home: 0, End: 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      seek(next, 'smooth');
    });
  }

  /* ---------- Pointer spotlight (mouse only) ---------- */
  if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
    $$('.spot').forEach((el) => {
      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        el.style.setProperty('--mx', e.clientX - r.left + 'px');
        el.style.setProperty('--my', e.clientY - r.top + 'px');
      }, { passive: true });
    });
  }

  /* ---------- Hero embers (starts after load, pauses offscreen) ---------- */
  const canvas = $('#embers');
  if (canvas && !still) {
    const start = () => {
      const ctx = canvas.getContext('2d');
      const small = innerWidth < 760;
      const count = small ? 26 : 60;
      let w, h, visible = true, raf = 0, last = 0;
      const size = () => {
        w = canvas.width = canvas.offsetWidth;
        h = canvas.height = canvas.offsetHeight;
      };
      const spawn = (fresh) => ({
        x: Math.random() * w,
        y: fresh ? Math.random() * h : h + 10,
        r: 0.6 + Math.random() * 1.9,
        v: 14 + Math.random() * 46,
        phase: Math.random() * 6.28,
        sway: 6 + Math.random() * 20,
        life: 0.35 + Math.random() * 0.65,
      });
      size();
      addEventListener('resize', size, { passive: true });
      const parts = Array.from({ length: count }, () => spawn(true));
      ctx.fillStyle = '#ff6b00';
      const frame = (now) => {
        const dt = Math.min(0.05, (now - last) / 1000 || 0);
        last = now;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#ff6b00';
        parts.forEach((p, i) => {
          p.y -= p.v * dt;
          if (p.y < -10) { parts[i] = spawn(false); return; }
          const x = p.x + Math.sin(now / 900 + p.phase) * p.sway;
          ctx.globalAlpha = clamp((p.y / h) * 1.1) * p.life;
          ctx.beginPath();
          ctx.arc(x, p.y, p.r, 0, 6.29);
          ctx.fill();
        });
        raf = visible && !document.hidden ? requestAnimationFrame(frame) : 0;
      };
      const wake = () => { if (!raf && visible && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); } };
      new IntersectionObserver(([e]) => { visible = e.isIntersecting; wake(); }).observe(canvas);
      document.addEventListener('visibilitychange', wake);
      wake();
    };
    ('requestIdleCallback' in window) ? requestIdleCallback(start, { timeout: 1200 }) : setTimeout(start, 400);
  }
})();
