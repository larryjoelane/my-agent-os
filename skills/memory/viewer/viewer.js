// Memory graph viewer. Reads window.MEMORY_GRAPH (set by graph-data.js,
// which skills/memory/scripts/graph.js writes) and draws it as a
// force-directed SVG graph plus an edge table. No dependencies: the
// layout is a small hand-rolled force simulation.
(function () {
  'use strict';

  const data = window.MEMORY_GRAPH;
  const $ = (id) => document.getElementById(id);
  if (!data) {
    $('summary').textContent = 'No graph data found: graph-data.js is missing. Build it with skills/memory/scripts/graph.js.';
    return;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const state = { mode: 'decayed', min: 0, query: '', labels: true, selected: null };

  // ---------- model ----------
  const nodes = data.memories.map((m, i) => {
    const angle = (i / data.memories.length) * Math.PI * 2;
    return { ...m, x: Math.cos(angle) * 180, y: Math.sin(angle) * 180, vx: 0, vy: 0, fixed: false };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = data.edges.map((e) => ({ ...e, source: byId.get(e.a), target: byId.get(e.b) }));

  const w = (e) => e[state.mode];
  const visibleEdges = () => edges.filter((e) => w(e) >= state.min);
  const label = (n) => (n.kind === 'session' ? (n.text.match(/Session ([\w-]+)/) || [])[1] : null)
    || (n.terms && n.terms.length ? n.terms.slice(0, 2).join(' · ') : `#${n.id}`);
  const short = (s, len) => (s.length > len ? s.slice(0, len - 1) + '…' : s);
  const fmt = (x) => x.toFixed(3);
  const date = (iso) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const kindColor = (k) => (k === 'memory' ? 'var(--kind-memory)' : k === 'session' ? 'var(--kind-session)' : 'var(--kind-other)');

  function el(tag, attrs, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }
  function h(tag, props, children) {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    for (const c of [].concat(children || [])) node.append(c);
    return node;
  }

  // ---------- header ----------
  const sourceText = data.source === 'sqlite' ? 'local sqlite store' : 'synthetic examples';
  $('summary').replaceChildren(
    h('span', { className: `badge ${data.source}`, textContent: sourceText }),
    ` ${nodes.length} memories · ${edges.length} edges · weights as of ${date(data.asOf)}`,
  );
  $('halfLife').textContent = data.halfLifeDays;

  // ---------- svg ----------
  const svg = $('svg');
  const viewport = $('viewport');
  const edgeLayer = $('edges');
  const nodeLayer = $('nodes');
  const view = { x: 0, y: 0, k: 1 };

  const nodeEls = new Map();
  for (const n of nodes) {
    const g = el('g', { class: 'node', tabindex: 0, role: 'button', 'aria-label': short(n.text, 80) }, nodeLayer);
    el('circle', { fill: kindColor(n.kind) }, g);
    el('text', { dy: '0.32em' }, g).textContent = label(n);
    nodeEls.set(n.id, g);
    g.addEventListener('pointerdown', (ev) => startDrag(ev, n));
    g.addEventListener('pointerenter', (ev) => showTip(ev, n));
    g.addEventListener('pointermove', (ev) => moveTip(ev));
    g.addEventListener('pointerleave', hideTip);
    g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(n.id); } });
  }
  let edgeEls = [];

  function radius(n) { return 5 + 11 * Math.sqrt(n.strength / (maxStrength || 1)); }
  let maxStrength = 1;

  function rebuildEdges() {
    const vis = visibleEdges();
    for (const n of nodes) n.strength = 0;
    for (const e of vis) { e.source.strength += w(e); e.target.strength += w(e); }
    maxStrength = Math.max(0.0001, ...nodes.map((n) => n.strength));
    edgeLayer.replaceChildren();
    edgeEls = vis.map((e) => ({ e, line: el('line', { class: 'edge' }, edgeLayer) }));
  }

  function applyTransform() {
    const r = svg.getBoundingClientRect();
    viewport.setAttribute('transform', `translate(${r.width / 2 + view.x},${r.height / 2 + view.y}) scale(${view.k})`);
  }

  // Everything that depends on selection / search / weight mode.
  function paint() {
    const q = state.query.toLowerCase();
    const matches = (n) => !q || n.text.toLowerCase().includes(q)
      || (n.tags || []).some((t) => t.toLowerCase().includes(q))
      || (n.terms || []).some((t) => t.includes(q));
    const sel = state.selected;
    const neighbors = new Set(sel == null ? [] : edgeEls.filter(({ e }) => e.a === sel || e.b === sel).flatMap(({ e }) => [e.a, e.b]));
    for (const n of nodes) {
      const g = nodeEls.get(n.id);
      const r = radius(n);
      g.firstChild.setAttribute('r', r);
      g.lastChild.setAttribute('x', r + 4);
      g.lastChild.style.display = state.labels || n.id === sel ? '' : 'none';
      g.classList.toggle('sel', n.id === sel);
      const dim = (q && !matches(n)) || (sel != null && !neighbors.has(n.id) && n.id !== sel);
      g.classList.toggle('dim', dim);
    }
    for (const { e, line } of edgeEls) {
      const weight = w(e);
      line.setAttribute('stroke-width', (0.6 + weight * 5).toFixed(2));
      line.setAttribute('stroke-opacity', (0.15 + weight * 0.75).toFixed(2));
      const touches = sel != null && (e.a === sel || e.b === sel);
      line.classList.toggle('hl', touches);
      line.classList.toggle('dim', (sel != null && !touches) || (q && !(matches(e.source) && matches(e.target))));
    }
  }

  function draw() {
    for (const n of nodes) nodeEls.get(n.id).setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
    for (const { e, line } of edgeEls) {
      line.setAttribute('x1', e.source.x.toFixed(1)); line.setAttribute('y1', e.source.y.toFixed(1));
      line.setAttribute('x2', e.target.x.toFixed(1)); line.setAttribute('y2', e.target.y.toFixed(1));
    }
  }

  // ---------- force simulation ----------
  let alpha = 1;
  let running = false;

  function tick() {
    const links = edgeEls.map(({ e }) => e);
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = b.x - a.x; let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const f = (3200 * alpha) / d2;
        const d = Math.sqrt(d2);
        a.vx -= (dx / d) * f; a.vy -= (dy / d) * f;
        b.vx += (dx / d) * f; b.vy += (dy / d) * f;
      }
    }
    for (const e of links) {
      const a = e.source; const b = e.target; const weight = w(e);
      const dx = b.x - a.x; const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const target = 200 - 110 * weight;
      const k = ((d - target) / d) * (0.04 + 0.1 * weight) * alpha;
      a.vx += dx * k; a.vy += dy * k;
      b.vx -= dx * k; b.vy -= dy * k;
    }
    for (const n of nodes) {
      n.vx -= n.x * 0.008 * alpha; n.vy -= n.y * 0.008 * alpha;
      if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
      n.vx *= 0.55; n.vy *= 0.55;
      n.x += n.vx; n.y += n.vy;
    }
    alpha = Math.max(0, alpha * 0.985);
  }

  // Zoom and centre so every node fits the canvas. Runs once, when the
  // first layout settles; after that the user owns the view.
  let fitted = false;
  function fit() {
    fitted = true;
    const r = svg.getBoundingClientRect();
    const pad = 70;
    const xs = nodes.map((n) => n.x); const ys = nodes.map((n) => n.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    view.k = Math.min(2, Math.max(0.25, Math.min((r.width - pad * 2) / (x1 - x0 || 1), (r.height - pad * 2) / (y1 - y0 || 1))));
    view.x = -((x0 + x1) / 2) * view.k; view.y = -((y0 + y1) / 2) * view.k;
    applyTransform();
  }

  function loop() {
    tick(); draw();
    if (!fitted && alpha < 0.05) fit();
    if (alpha > 0.004) requestAnimationFrame(loop);
    else running = false;
  }
  function reheat(to) {
    alpha = Math.max(alpha, to);
    if (reduceMotion) { for (let i = 0; i < 300 && alpha > 0.004; i++) tick(); draw(); if (!fitted) fit(); return; }
    if (!running) { running = true; requestAnimationFrame(loop); }
  }

  // ---------- interaction ----------
  function toWorld(ev) {
    const r = svg.getBoundingClientRect();
    return { x: (ev.clientX - r.left - r.width / 2 - view.x) / view.k, y: (ev.clientY - r.top - r.height / 2 - view.y) / view.k };
  }

  let drag = null;
  function startDrag(ev, n) {
    ev.stopPropagation();
    drag = { n, moved: false, sx: ev.clientX, sy: ev.clientY };
    n.fixed = true;
    svg.setPointerCapture(ev.pointerId);
  }
  let pan = null;
  svg.addEventListener('pointerdown', (ev) => {
    if (drag) return;
    pan = { sx: ev.clientX, sy: ev.clientY, x: view.x, y: view.y, moved: false };
    svg.classList.add('panning');
    svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener('pointermove', (ev) => {
    if (drag) {
      if (Math.abs(ev.clientX - drag.sx) + Math.abs(ev.clientY - drag.sy) > 3) drag.moved = true;
      const p = toWorld(ev);
      drag.n.x = p.x; drag.n.y = p.y;
      hideTip();
      reheat(0.3); draw();
    } else if (pan) {
      if (Math.abs(ev.clientX - pan.sx) + Math.abs(ev.clientY - pan.sy) > 3) pan.moved = true;
      view.x = pan.x + ev.clientX - pan.sx; view.y = pan.y + ev.clientY - pan.sy;
      applyTransform();
    }
  });
  svg.addEventListener('pointerup', () => {
    if (drag) {
      drag.n.fixed = false;
      if (!drag.moved) select(drag.n.id === state.selected ? null : drag.n.id);
      drag = null;
    } else if (pan) {
      if (!pan.moved) select(null);
      pan = null;
      svg.classList.remove('panning');
    }
  });
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const r = svg.getBoundingClientRect();
    const k = Math.min(4, Math.max(0.25, view.k * Math.exp(-ev.deltaY * 0.0015)));
    const cx = ev.clientX - r.left - r.width / 2; const cy = ev.clientY - r.top - r.height / 2;
    view.x = cx - ((cx - view.x) * k) / view.k;
    view.y = cy - ((cy - view.y) * k) / view.k;
    view.k = k;
    applyTransform();
  }, { passive: false });
  window.addEventListener('resize', applyTransform);

  const tip = $('tip');
  function showTip(ev, n) {
    if (drag || pan) return;
    tip.replaceChildren(h('b', { textContent: `#${n.id} · ${n.kind}` }), h('div', { textContent: short(n.text, 180) }));
    tip.style.display = 'block';
    moveTip(ev);
  }
  function moveTip(ev) {
    const r = $('graph').getBoundingClientRect();
    const x = ev.clientX - r.left + 14; const y = ev.clientY - r.top + 14;
    tip.style.left = Math.min(x, r.width - tip.offsetWidth - 8) + 'px';
    tip.style.top = Math.min(y, r.height - tip.offsetHeight - 8) + 'px';
  }
  function hideTip() { tip.style.display = 'none'; }

  // ---------- side panel ----------
  function bar(weight) {
    return h('div', { className: 'bar' }, [
      h('span', { className: 'track' }, h('i', { style: `width:${(weight * 100).toFixed(1)}%` })),
      h('span', { textContent: fmt(weight) }),
    ]);
  }
  function select(id) {
    state.selected = id;
    paint();
    const panel = $('panel');
    if (id == null) {
      panel.replaceChildren(h('p', { className: 'empty', textContent: 'Select a memory to see its text and the memories it\'s linked to.' }));
      return;
    }
    const n = byId.get(id);
    const links = edges
      .filter((e) => e.a === id || e.b === id)
      .map((e) => ({ e, other: e.a === id ? e.target : e.source }))
      .sort((x, y) => w(y.e) - w(x.e));
    panel.replaceChildren(
      h('h2', { textContent: `Memory #${n.id}` }),
      h('div', { className: 'meta', textContent: `${n.kind} · ${n.source || 'no source'} · saved ${date(n.ts)}` }),
      h('p', { className: 'text', textContent: n.text }),
      h('div', { className: 'chips' }, [
        ...(n.tags || []).map((t) => h('span', { className: 'chip', textContent: `#${t}` })),
        ...(n.terms || []).map((t) => h('span', { className: 'chip', textContent: t, title: 'distinctive TF-IDF term' })),
      ]),
      h('h3', { textContent: `Linked memories (${links.length})` }),
      links.length
        ? h('ul', { className: 'links' }, links.map(({ e, other }) => {
          const li = h('li', {}, [h('div', { className: 'ltext', textContent: `#${other.id} ${other.text}` }), bar(w(e))]);
          li.title = `stored ${fmt(e.weight)} · decayed ${fmt(e.decayed)} · last co-retrieved ${date(e.lastUpdated)}`;
          li.addEventListener('click', () => select(other.id));
          return li;
        }))
        : h('p', { className: 'empty', textContent: 'Never returned in the same search as another memory.' }),
    );
  }

  // ---------- edge table ----------
  function renderTable() {
    const rows = visibleEdges().sort((x, y) => w(y) - w(x)).slice(0, 250);
    $('rows').replaceChildren(...rows.map((e) => {
      const tr = h('tr', {}, [
        h('td', {}, h('div', { className: 'clip', textContent: `#${e.a} ${e.source.text}` })),
        h('td', {}, h('div', { className: 'clip', textContent: `#${e.b} ${e.target.text}` })),
        h('td', { style: 'min-width:120px' }, bar(w(e))),
        h('td', { className: 'num', textContent: fmt(e.weight) }),
        h('td', { className: 'num', textContent: fmt(e.decayed) }),
        h('td', { className: 'num', textContent: date(e.lastUpdated) }),
      ]);
      tr.addEventListener('click', () => { select(e.a); $('graph').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' }); });
      return tr;
    }));
    if (!rows.length) $('rows').append(h('tr', {}, h('td', { colSpan: 6, className: 'empty', textContent: 'No edges at this weight.' })));
  }

  // ---------- controls ----------
  function refresh(heat) {
    rebuildEdges(); paint(); renderTable(); draw();
    if (state.selected != null) select(state.selected);
    if (heat) reheat(heat);
  }
  $('q').addEventListener('input', (ev) => { state.query = ev.target.value.trim(); paint(); });
  $('min').addEventListener('input', (ev) => {
    state.min = Number(ev.target.value);
    $('minOut').textContent = state.min.toFixed(2);
    refresh(0.5);
  });
  for (const b of document.querySelectorAll('.seg button')) {
    b.addEventListener('click', () => {
      state.mode = b.dataset.mode;
      for (const o of document.querySelectorAll('.seg button')) o.setAttribute('aria-pressed', String(o === b));
      refresh(0.3);
    });
  }
  $('labels').addEventListener('change', (ev) => { state.labels = ev.target.checked; paint(); });
  $('reset').addEventListener('click', () => { fit(); });

  applyTransform();
  refresh(1);
})();
