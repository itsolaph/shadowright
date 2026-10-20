// Licence Board front end: plain DOM, no dependencies. All text goes through textContent.

const STATE_ICON = { LOCKED: '🔒', SHADOWING: '👀', LICENSED: '✅' };
const LICENCE_THRESHOLD = 0.8;
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = (id) => document.getElementById(id);
const subjectSelect = $('subject');
const statusLine = $('status');

/** Creates an element: h('p', { class: 'x' }, 'text', child). */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined) el.setAttribute(key, value);
  for (const child of children.flat()) if (child !== null && child !== undefined) el.append(child);
  return el;
}

function svg(tag, attrs = {}, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  if (text !== undefined) el.textContent = text;
  return el;
}

const pct = (value) => (value === undefined || value === null ? '–' : `${Math.round(value * 100)}%`);
const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const short = (id) => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
const suiscanTx = (digest) => `https://suiscan.xyz/mainnet/tx/${encodeURIComponent(digest)}`;
const walruscanBlob = (blobId) => `https://walruscan.com/mainnet/blob/${encodeURIComponent(blobId)}`;

function setStatus(text, isError = false) {
  statusLine.textContent = text;
  statusLine.classList.toggle('error', isError);
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function renderSummary(view) {
  const licensed = view.categories.filter((c) => c.state === 'LICENSED').length;
  const judged = view.categories.filter((c) => c.state !== 'LOCKED').length;
  const tile = (label, value, small = false) =>
    h('div', { class: 'tile' }, h('div', { class: 'label' }, label), h('div', { class: small ? 'value small' : 'value' }, value));
  $('summary').replaceChildren(
    tile('Memories on Walrus', String(view.memories)),
    tile('Overall accuracy', view.memories ? `${pct(view.correct / view.memories)} (${view.correct}/${view.memories})` : '–'),
    tile('Categories judged', `${judged} / ${view.categories.length}`),
    tile('Licensed', String(licensed)),
    tile('Namespace', view.subject.namespace, true),
  );
}

function renderCards(view) {
  $('cards').replaceChildren(
    ...view.categories.map((card) => {
      const dots = h(
        'div',
        { class: 'dots', role: 'img', 'aria-label': `last ${card.recent.length}: ${card.recent.filter(Boolean).length} correct` },
        card.recent.map((hit) => h('span', { class: `dot ${hit ? 'hit' : 'miss'}`, title: hit ? 'correct' : 'wrong' })),
      );
      const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(card.progress * 100)) });
      bar.append(h('span', { style: `width:${Math.round(card.progress * 100)}%` }));
      return h(
        'article',
        { class: `card ${card.state.toLowerCase()}` },
        h('header', {}, h('h3', {}, card.label), h('span', { class: `badge ${card.state}` }, `${STATE_ICON[card.state]} ${card.state}`)),
        h('div', { class: 'metric' }, 'Accuracy, last 10', h('strong', {}, card.recent.length ? `${pct(card.accuracy)} (${card.recent.filter(Boolean).length}/${card.recent.length})` : '–')),
        card.recent.length ? dots : null,
        h('div', { class: 'metric' }, 'Memories', h('strong', {}, String(card.memories))),
        h('div', { class: 'metric' }, 'Streak · revoked', h('strong', {}, `${card.streak} · ${card.revocations}`)),
        bar,
        h('p', { class: 'needed' }, card.onProbation ? `On probation: ${card.needed}` : card.needed),
        card.lastRevokeReason ? h('p', { class: 'revoke' }, `Last revoke: ${card.lastRevokeReason}`) : null,
      );
    }),
  );
}

function renderCurve(view) {
  const figure = $('curve');
  const points = view.curve;
  if (points.length < 2) {
    figure.replaceChildren(h('p', { class: 'hint' }, 'Not enough memories for a curve yet.'));
    return;
  }

  const width = 860;
  const height = 280;
  const m = { top: 16, right: 96, bottom: 34, left: 44 };
  const x = (i) => m.left + ((i - 1) / Math.max(1, points.length - 1)) * (width - m.left - m.right);
  const y = (v) => m.top + (1 - v) * (height - m.top - m.bottom);
  const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Accuracy over memories: rolling last 10 and cumulative' });

  for (const tick of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    chart.append(svg('line', { x1: m.left, x2: width - m.right, y1: y(tick), y2: y(tick), stroke: tick === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }));
    chart.append(svg('text', { x: m.left - 8, y: y(tick) + 4, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 11 }, pct(tick)));
  }
  const step = Math.max(1, Math.ceil(points.length / 10));
  for (const p of points.filter((p) => p.index === 1 || p.index % step === 0)) {
    chart.append(svg('text', { x: x(p.index), y: height - m.bottom + 18, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 11 }, String(p.index)));
  }
  chart.append(svg('text', { x: (m.left + width - m.right) / 2, y: height - 4, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 11 }, 'memory #'));

  chart.append(svg('line', { x1: m.left, x2: width - m.right, y1: y(LICENCE_THRESHOLD), y2: y(LICENCE_THRESHOLD), stroke: 'var(--muted)', 'stroke-dasharray': '4 3', 'stroke-width': 1 }));
  // Labelled at the left end, so it never collides with the series' end labels on the right.
  chart.append(svg('text', { x: m.left + 6, y: y(LICENCE_THRESHOLD) - 6, fill: 'var(--muted)', 'font-size': 11 }, 'licence threshold 80%'));

  const series = [
    { key: 'rolling', label: 'last 10', color: 'var(--series-1)' },
    { key: 'cumulative', label: 'all so far', color: 'var(--series-2)' },
  ];
  for (const s of series) {
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.index).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join('');
    chart.append(svg('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    const last = points.at(-1);
    chart.append(svg('text', { x: x(last.index) + 8, y: y(last[s.key]) + (s.key === 'rolling' ? -4 : 12), fill: 'var(--ink-2)', 'font-size': 11 }, `${s.label} ${pct(last[s.key])}`));
  }

  // Hover layer: crosshair, markers and a tooltip for the nearest memory.
  const crosshair = svg('line', { y1: m.top, y2: height - m.bottom, stroke: 'var(--muted)', 'stroke-width': 1, visibility: 'hidden' });
  const markers = series.map((s) => svg('circle', { r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }));
  const hit = svg('rect', { x: m.left, y: m.top, width: width - m.left - m.right, height: height - m.top - m.bottom, fill: 'transparent' });
  chart.append(crosshair, ...markers, hit);

  const tooltip = h('div', { class: 'tooltip', hidden: '' });
  const legend = h(
    'div',
    { class: 'legend' },
    series.map((s) => h('span', {}, h('span', { class: 'key', style: `background:${s.color}` }), s.label === 'last 10' ? 'Accuracy, last 10 memories' : 'Accuracy, all memories so far')),
    h('span', {}, h('span', { class: 'key dashed' }), 'Licence threshold'),
  );

  hit.addEventListener('pointermove', (event) => {
    const box = chart.getBoundingClientRect();
    const sx = ((event.clientX - box.left) / box.width) * width;
    const ratio = (sx - m.left) / (width - m.left - m.right);
    const p = points[Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))))];
    crosshair.setAttribute('x1', x(p.index));
    crosshair.setAttribute('x2', x(p.index));
    crosshair.setAttribute('visibility', 'visible');
    series.forEach((s, i) => {
      markers[i].setAttribute('cx', x(p.index));
      markers[i].setAttribute('cy', y(p[s.key]));
      markers[i].setAttribute('visibility', 'visible');
    });
    tooltip.replaceChildren(
      h('div', {}, h('strong', {}, `Memory #${p.index}`), ` · ${p.correct ? '✓ correct' : '✗ wrong'}`),
      h('div', {}, `Last 10: ${pct(p.rolling)} · all: ${pct(p.cumulative)}`),
      h('div', { style: 'color:var(--muted)' }, when(p.timestampMs)),
    );
    tooltip.hidden = false;
    const fig = figure.getBoundingClientRect();
    const left = box.left - fig.left + (x(p.index) / width) * box.width;
    tooltip.style.left = `${Math.min(left + 12, fig.width - 220)}px`;
    tooltip.style.top = `${box.top - fig.top + 24}px`;
  });
  hit.addEventListener('pointerleave', () => {
    tooltip.hidden = true;
    crosshair.setAttribute('visibility', 'hidden');
    markers.forEach((marker) => marker.setAttribute('visibility', 'hidden'));
  });

  figure.replaceChildren(legend, chart, tooltip);
}

function renderEvents(view) {
  const events = [...view.events].reverse();
  $('events').replaceChildren(
    ...(events.length
      ? events.map((e) => h('li', {}, h('time', {}, when(e.timestampMs)), ` · ${e.category}: ${STATE_ICON[e.from]} ${e.from} → ${STATE_ICON[e.to]} ${e.to} (${e.reason})`))
      : [h('li', {}, 'No licence changes yet.')]),
  );
}

const TIMELINE_PAGE = 15;
let showWholeTimeline = false;

function renderTimeline(view) {
  const shown = showWholeTimeline ? view.timeline : view.timeline.slice(0, TIMELINE_PAGE);
  const toggle = $('timeline-toggle');
  toggle.hidden = view.timeline.length <= TIMELINE_PAGE;
  toggle.textContent = showWholeTimeline ? `Show the newest ${TIMELINE_PAGE}` : `Show all ${view.timeline.length} memories`;
  toggle.onclick = () => {
    showWholeTimeline = !showWholeTimeline;
    renderTimeline(view);
  };
  $('timeline').replaceChildren(
    ...shown.map((m) =>
      h(
        'li',
        { class: `memory ${m.correct ? 'correct' : 'wrong'}` },
        h(
          'div',
          { class: 'head' },
          h('span', { class: 'verdict' }, m.correct ? '✓ correct' : `✗ wrong (${m.misses.join(', ')})`),
          h('span', { class: 'tag' }, m.category),
          m.predictedAtMs ? h('span', { class: 'tag', title: `predicted ${when(m.predictedAtMs)}, before the transaction was read` }, 'live') : null,
          h('time', {}, when(m.timestampMs)),
        ),
        h('dl', { class: 'pair' }, h('dt', {}, 'Predicted'), h('dd', {}, m.predicted), h('dt', {}, 'User did'), h('dd', {}, m.actual), h('dt', {}, 'Lesson'), h('dd', {}, m.lesson)),
        h(
          'div',
          { class: 'links' },
          h('a', { href: suiscanTx(m.digest), target: '_blank', rel: 'noopener noreferrer' }, `tx ${short(m.digest)} on Suiscan`),
          m.blobId ? h('a', { href: walruscanBlob(m.blobId), target: '_blank', rel: 'noopener noreferrer' }, `memory blob ${short(m.blobId)} on Walruscan`) : null,
        ),
      ),
    ),
  );
}

function render(view) {
  renderSummary(view);
  renderCards(view);
  renderCurve(view);
  renderEvents(view);
  renderTimeline(view);
}

async function load({ fresh = false } = {}) {
  setStatus('Recalling memories from Walrus Memory…');
  const query = new URLSearchParams({ subject: subjectSelect.value });
  if (fresh) query.set('fresh', '1');
  const view = await api(`/api/board?${query}`);
  render(view);
  setStatus(`${view.memories} memories recalled for ${view.subject.name} (${view.subject.short}…).`);
}

async function restore() {
  const button = $('restore');
  button.disabled = true;
  setStatus('Fresh instance: re-indexing this namespace from Walrus, then rebuilding the board from recall only…');
  try {
    const view = await api(`/api/restore?${new URLSearchParams({ subject: subjectSelect.value })}`, { method: 'POST' });
    render(view);
    const r = view.restore;
    setStatus(`Restored from Walrus in a fresh client: ${r.restored} re-indexed, ${r.skipped} already indexed, ${r.total} on chain. Board rebuilt from ${view.memories} recalled memories.`);
  } finally {
    button.disabled = false;
  }
}

async function start() {
  const subjects = await api('/api/subjects');
  subjectSelect.replaceChildren(...subjects.map((s) => h('option', { value: s.name }, `${s.name} · ${s.short}…`)));
  const preferred = new URLSearchParams(location.search).get('subject') ?? subjects.find((s) => s.isDefault)?.name;
  if (preferred) subjectSelect.value = preferred;
  await load();
}

const guard = (fn) => () => fn().catch((error) => setStatus(error.message, true));
subjectSelect.addEventListener('change', guard(() => load()));
$('refresh').addEventListener('click', guard(() => load({ fresh: true })));
$('restore').addEventListener('click', guard(restore));
guard(start)();
