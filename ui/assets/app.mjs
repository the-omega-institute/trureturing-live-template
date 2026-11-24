const $ = selector => document.querySelector(selector);
const ns = 'http://www.w3.org/2000/svg';
const themeKey = 'ai-org-live.theme';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  view: null,
  isDemo: false,
  selected: null,
  focused: null,
  hovered: null,
  hoveredSeat: null,
  mode: 'organization',
  follow: true,
  quiet: reduced,
  feedFilter: 'all',
  topic: null,
  positions: new Map(),
  palettes: new Map(),
  cells: new Map(),
  seen: new Set(),
  animated: new Set(),
  arrivals: [],
  busy: false,
  tickerTarget: null
};

const paletteColors = [
  'var(--c-direction)',
  'var(--c-research)',
  'var(--c-review)',
  'var(--c-verification)',
  'var(--c-books)',
  'var(--c-publication)',
  'var(--c-outreach)',
  'var(--c-studio)'
];

const executionLabels = {
  human: 'Human in the Loop',
  sessions: 'AI Sessions',
  actions: 'GitHub Actions',
  mixed: 'Sessions & Automation'
};

const glyphPaths = {
  human: ['M12 3v18M3 12h18', 'm7 7 5-4 5 4M7 17l5 4 5-4'],
  core: ['M17 4H6l7 8-7 8h11'],
  review: ['M3 8h17m-4-4 4 4-4 4M21 16H4m4-4-4 4 4 4'],
  actions: ['m5 12 4 4L19 6', 'M20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9'],
  docs: ['M12 6C8 3 4 4 3 5v14c3-2 6-1 9 1 3-2 6-3 9-1V5c-3-2-6-1-9 1Z', 'M12 6v14'],
  publish: ['M6 3h9l4 4v14H6Z', 'M14 3v5h5M9 12h7M9 16h5'],
  outreach: ['M4 5h16v12H9l-5 4V5Z', 'M8 9h8M8 13h5'],
  tools: ['M5 4v16M12 4v16M19 4v16', 'M2 8h6M9 16h6M16 10h6']
};

const bgHexLattice = [
  [120, 114], [310, 114], [690, 114], [880, 114],
  [55, 364], [352, 364], [648, 364], [945, 364],
  [270, 632], [500, 632], [730, 632]
];

const timestamp = value => Date.parse(value);
const relative = value => {
  const n = Math.max(0, (Date.now() - timestamp(value)) / 1000);
  if (!Number.isFinite(n)) return 'recently';
  if (n < 60) return 'just now';
  if (n < 3600) return `${Math.floor(n / 60)}m ago`;
  if (n < 86400) return `${Math.floor(n / 3600)}h ago`;
  return `${Math.floor(n / 86400)}d ago`;
};

const element = (tag, text = '', className = '') => {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (className) el.className = className;
  return el;
};

const safeURL = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '#';
  } catch {
    return '#';
  }
};

function safeDataURL(value) {
  if (!value) return null;
  try {
    const url = new URL(value, document.baseURI);
    if (url.username || url.password) return null;
    if (url.origin === location.origin || url.protocol === 'https:') return url.href;
    return null;
  } catch {
    return null;
  }
}

function external(label, url, className = '') {
  const el = element('a', label, className);
  el.href = safeURL(url);
  el.target = '_blank';
  el.rel = 'noopener noreferrer';
  return el;
}

const view = () => state.view;
const departments = () => view()?.departments || [];
const department = id => departments().find(d => d.id === id);
const activities = () => departments().flatMap(d => d.activities);
const key = ref => ref ? `${ref.repository}#${ref.number}` : '';
const eventKey = a => `${a.id}/${a.status}/${a.at}`;
const isStale = () => !view() || Date.now() - timestamp(view().observed_at) > 180000;
const fresh = a => Boolean(a.fresh && !isStale());
const active = a => fresh(a) && ['working', 'waiting'].includes(a.status) && ['automation', 'session'].includes(a.kind);
const sourceLabel = a => view()?.sources.find(s => s.id === a.source)?.label || 'New update';

const cleanTitle = text => String(text || '')
  .replace(/^(?:research|math|docs|feat|fix|chore|refactor|ci)(?:\([^)]*\))?\s*[:：]\s*/i, '')
  .replace(/\b[a-f0-9]{7,64}\b/gi, '')
  .replace(/[\r\n]+/g, ' ')
  .replace(/\s{2,}/g, ' ')
  .trim();

function findLinkedTaskActivity(ref) {
  if (!ref) return null;
  const targetKey = key(ref);
  return activities().find(item => ['task', 'contribution'].includes(item.kind) && key(item.task) === targetKey) || null;
}

function phase(a) {
  if (a.kind === 'automation') {
    return ({
      working: fresh(a) ? 'Running' : 'Ran earlier',
      waiting: fresh(a) ? 'Queued' : 'Queued earlier',
      succeeded: 'Passed',
      failed: 'Needs fix',
      cancelled: 'Cancelled',
      closed: 'Completed',
      unknown: 'Idle'
    })[a.status] || 'Check update';
  }
  if (a.kind === 'session') {
    return ({
      working: fresh(a) ? 'Active' : 'Idle',
      waiting: 'Waiting',
      succeeded: 'Completed',
      failed: 'Blocked',
      cancelled: 'Stopped',
      ready: 'Ready',
      unknown: 'Idle'
    })[a.status] || 'Session';
  }
  if (a.status === 'merged') return 'Merged';
  if (a.status === 'closed') return 'Closed';
  if (a.status === 'claimed') return 'Claimed';
  if (a.kind === 'review') return 'Reviewed';
  if (a.kind === 'discussion') return 'Discussed';
  if (a.kind === 'task') return 'Open task';
  return 'In progress';
}

function actorLabel(actor) {
  return actor?.kind === 'agent' && actor.tool
    ? `${actor.tool} · ${actor.label || actor.id}`
    : actor?.label || actor?.id || 'Public account';
}

function seatMonogram(actor) {
  const raw = String(actor?.label || actor?.id || '?').replace(/\[bot\]$/i, '');
  const words = raw.split(/[-_.\s]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return raw.slice(0, 2).toUpperCase();
}

function person(actor) {
  const label = actorLabel(actor);
  const el = element('span', '', 'person' + (actor.kind === 'agent' ? ' agent' : ''));
  const mark = element('span', seatMonogram(actor), 'person-mark');
  mark.setAttribute('aria-hidden', 'true');
  el.append(mark, document.createTextNode(label));
  return el;
}

function actorTasks(d, actor) {
  return d.activities
    .filter(a => a.actor?.id === actor.id && a.actor?.kind === actor.kind)
    .sort((a, b) => Number(active(b)) - Number(active(a)) || timestamp(b.at) - timestamp(a.at));
}

function departmentRoster(d) {
  const actors = new Map((d.participants || []).map(actor => [`${actor.kind}:${actor.id}`, actor]));
  for (const a of d.activities) if (a.actor) actors.set(`${a.actor.kind}:${a.actor.id}`, a.actor);
  return [...actors.values()].sort((a, b) => {
    const at = actorTasks(d, a);
    const bt = actorTasks(d, b);
    return Number(bt.some(active)) - Number(at.some(active))
      || timestamp(bt[0]?.at) - timestamp(at[0]?.at)
      || actorLabel(a).localeCompare(actorLabel(b));
  });
}

function actorTaskTitle(a) {
  if (a.kind === 'automation') {
    const linked = findLinkedTaskActivity(a.task);
    return linked ? `${sourceLabel(a)} · ${cleanTitle(linked.label)}` : sourceLabel(a);
  }
  if (a.task && ['discussion', 'review'].includes(a.kind)) {
    const linked = findLinkedTaskActivity(a.task);
    if (linked) return cleanTitle(linked.label);
  }
  return cleanTitle(a.label) || sourceLabel(a);
}

function glyphKeyFor(d) {
  const tag = `${d.id} ${d.label}`.toLowerCase();
  if (d.execution === 'human' || /direct|steer|lead|product/.test(tag)) return 'human';
  if (/review|audit|qa|critic/.test(tag)) return 'review';
  if (d.execution === 'actions' || /verif|check|ci|test|build/.test(tag)) return 'actions';
  if (/book|doc|write|spec/.test(tag)) return 'docs';
  if (/pub|paper|release|atlas|know/.test(tag)) return 'publish';
  if (/outreach|comm|devrel|market/.test(tag)) return 'outreach';
  if (/tool|plat|infra|studio|ops/.test(tag)) return 'tools';
  return 'core';
}

function icon(d) {
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const pathD of glyphPaths[glyphKeyFor(d)] || glyphPaths.core) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', pathD);
    svg.append(p);
  }
  return svg;
}

function assignPalettesAndLayout(list) {
  state.positions.clear();
  state.palettes.clear();

  let mixedCursor = 0;
  const mixedSlots = [4, 5, 6, 7];
  for (const d of list) {
    const tag = `${d.id} ${d.label}`.toLowerCase();
    let idx = 1;
    if (d.execution === 'human') idx = 0;
    else if (/review|qa|audit/.test(tag)) idx = 2;
    else if (/outreach|comm|devrel/.test(tag)) idx = 6;
    else if (/tool|plat|infra|studio|ops/.test(tag)) idx = 7;
    else if (d.execution === 'actions') idx = 3;
    else if (d.execution === 'sessions') idx = 1;
    else {
      idx = mixedSlots[mixedCursor % mixedSlots.length];
      mixedCursor += 1;
    }
    state.palettes.set(d.id, idx);
  }

  // Partition into 3 architectural tiers:
  // Tier 1: Human in the Loop (execution === 'human')
  // Tier 2: 24/7 AI Autonomous Loop (sessions & actions, ordered sessions -> actions)
  // Tier 3: Delivery & Platform (mixed & overflow)
  const tier1 = list.filter(d => d.execution === 'human');
  const tier2Raw = [
    ...list.filter(d => d.execution === 'sessions'),
    ...list.filter(d => d.execution === 'actions' && !/outreach|comm/.test(d.id.toLowerCase()))
  ];
  const tier2 = tier2Raw.slice(0, 4);
  const tier2Ids = new Set(tier2.map(d => d.id));
  const tier1Ids = new Set(tier1.map(d => d.id));
  const tier3 = list.filter(d => !tier1Ids.has(d.id) && !tier2Ids.has(d.id));

  const placeRow = (items, y, margin = 155) => {
    if (!items.length) return;
    if (items.length === 1) {
      state.positions.set(items[0].id, [500, y]);
      return;
    }
    const left = items.length === 2 ? 310 : items.length === 3 ? 205 : margin;
    const right = 1000 - left;
    const step = (right - left) / (items.length - 1);
    items.forEach((d, i) => {
      state.positions.set(d.id, [Math.round(left + i * step), y]);
    });
  };

  placeRow(tier1, 114);
  placeRow(tier2, 364);
  placeRow(tier3, 632);
}

function deptColor(id) {
  return paletteColors[state.palettes.get(id) ?? 1] || 'var(--accent)';
}

function hexShellSVG() {
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 200 173.2');
  svg.setAttribute('class', 'cell-hex-shell');
  svg.setAttribute('aria-hidden', 'true');
  const ptsOuter = '50,3 150,3 197,86.6 150,170.2 50,170.2 3,86.6';
  const ptsInner = '54,10 146,10 189,86.6 146,163.2 54,163.2 11,86.6';
  const pulse = document.createElementNS(ns, 'polygon');
  pulse.setAttribute('points', ptsOuter);
  pulse.setAttribute('class', 'cell-hex-pulse');
  const outer = document.createElementNS(ns, 'polygon');
  outer.setAttribute('points', ptsOuter);
  outer.setAttribute('class', 'cell-hex-outer');
  const inner = document.createElementNS(ns, 'polygon');
  inner.setAttribute('points', ptsInner);
  inner.setAttribute('class', 'cell-hex-inner');
  svg.append(pulse, outer, inner);
  return svg;
}

function flatHexPoints(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 180) * (60 * i);
    pts.push(`${(cx + r * Math.cos(ang)).toFixed(1)},${(cy + r * Math.sin(ang)).toFixed(1)}`);
  }
  return pts.join(' ');
}

function countRunning(d) {
  return isStale() ? null : (d.running_automations || 0) + (d.running_sessions || 0);
}

function queueStats(d) {
  const waiting = d.activities.filter(a =>
    ['waiting', 'queued', 'requested'].includes(a.status)
    || (a.kind === 'task' && ['open', 'claimed'].includes(a.status))
  ).length;
  const running = Math.max(
    d.activities.filter(active).length || 0,
    (d.running_automations || 0) + (d.running_sessions || 0)
  );
  const recent = d.activities.filter(a => timestamp(a.at) > Date.now() - 86400000).length;
  return {
    waiting,
    running,
    recent,
    label: waiting ? `${waiting}${d.activities.length >= 100 ? '+' : ''}` : '0'
  };
}

function departmentState(d) {
  if (d.execution === 'human') return 'Strategic steering';
  const count = countRunning(d);
  if (count === null) return 'Waiting for refresh';
  const q = queueStats(d);
  if (count && q.waiting) return `${count} running · ${q.label} queued`;
  if (count) return `${count} active right now`;
  if (q.waiting) return `${q.label} open to relay`;
  return d.activities.length ? `${d.activities.length} recent updates` : 'Ready';
}

function handoffSummary() {
  const map = new Map();
  for (const h of view()?.handoffs || []) {
    if (h.kind !== 'reference') continue;
    const k = `${h.from}->${h.to}`;
    const prev = map.get(k) || { from: h.from, to: h.to, count: 0 };
    prev.count += 1;
    map.set(k, prev);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function renderBrand() {
  const label = view()?.organization?.label || 'AI Organization';
  $('#brand-org').textContent = label;
  $('#org-title').textContent = label;
  $('#footer-org').textContent = label;
  document.title = `${label} · Live 24/7 Architecture`;
  const badge = $('#demo-badge');
  if (badge) badge.hidden = !state.isDemo;
}

function renderHealth() {
  const current = view();
  if (!current) return;
  const late = isStale();
  const connection = $('#connection');
  connection.classList.toggle('delayed', late);
  connection.lastElementChild.textContent = late ? 'Waiting for fresh update' : `Updated ${relative(current.observed_at)}`;
  $('#connection-note').hidden = !late;
  $('#connection-note').textContent = 'Observation data is older than the freshness threshold. Live execution badges are paused until the next update.';
}

function renderTicker() {
  const recent = view()?.recent || [];
  const item = recent.find(a => active(a)) || recent[0];
  if (!item) return;
  const d = department(item.department);
  const actor = item.actor?.label || executionLabels[d?.execution] || 'Organization';
  state.tickerTarget = item;
  $('#ticker-text').textContent = `${d?.label || item.department} · ${actor} · ${phase(item)}: ${actorTaskTitle(item)}`;
  $('#ticker-time').textContent = `${relative(item.at)} · Inspect →`;
}

function renderMetrics() {
  const list = departments();
  if (!list.length) return;
  const running = list.reduce((n, d) => n + (d.running_automations || 0), 0);
  const sessions = list.reduce((n, d) => n + (d.running_sessions || 0), 0);
  const handoffsCount = (view()?.handoffs || []).length;
  const metric = (n, label, className = '') => {
    const el = element('span', '', className);
    el.append(element('strong', String(n)), document.createTextNode(` ${label}`));
    return el;
  };
  const items = [
    metric(list.length, 'departments'),
    metric(isStale() ? '—' : running, 'CI runs active', 'metric-active')
  ];
  if (sessions) items.push(metric(isStale() ? '—' : sessions, 'sessions active', 'metric-active'));
  if (handoffsCount) items.push(metric(handoffsCount, 'cross-dept handoffs'));
  $('#institute-metrics').replaceChildren(...items);
  $('#institute-scope').textContent = `${(view()?.sources || []).length} registered sources`;

  // Dynamic relay pipeline strip (up to 5 primary departments)
  const strip = $('#method-steps');
  if (strip) {
    strip.replaceChildren();
    const pipeline = list.slice(0, 5);
    pipeline.forEach((d, idx) => {
      if (idx > 0) strip.append(element('i', '→', 'step-arrow'));
      const btn = element('button');
      btn.type = 'button';
      btn.dataset.methodDepartment = d.id;
      btn.setAttribute('aria-pressed', String(state.focused === d.id || (!state.focused && state.selected === d.id)));
      const body = element('span', '', 'step-body');
      body.append(element('strong', d.label), element('small', d.responsibility));
      const run = countRunning(d);
      const q = queueStats(d);
      const badge = element('span', run ? `${run} active` : q.waiting ? `${q.label} open` : d.execution === 'human' ? 'Steer' : 'Ready', 'step-badge' + (run ? ' is-hot' : ''));
      btn.append(element('span', String(idx + 1).padStart(2, '0'), 'step-num'), body, badge);
      btn.addEventListener('click', () => {
        setMode('organization');
        selectDepartment(d.id, true, true);
      });
      strip.append(btn);
    });
  }
}

function createCell(d, index) {
  const pos = state.positions.get(d.id) || [500, 364];
  const button = element('button', '', 'hive-cell');
  button.type = 'button';
  button.dataset.department = d.id;
  button.dataset.execution = d.execution;
  button.dataset.palette = String(state.palettes.get(d.id) ?? 1);
  button.dataset.focusKey = `department:${d.id}`;
  button.style.setProperty('--x', `${(pos[0] / 10).toFixed(2)}%`);
  button.style.setProperty('--y', `${(pos[1] / 7.4).toFixed(2)}%`);

  const content = element('span', '', 'cell-content');
  const topRow = element('span', '', 'cell-top-row');
  topRow.append(element('i', '', 'cell-live-dot'), element('span', String(index + 1).padStart(2, '0')));

  const head = element('span', '', 'cell-head');
  const glyph = element('span', '', 'cell-icon');
  glyph.append(icon(d));
  const title = element('strong', d.label, 'cell-title');
  head.append(glyph, title);

  const seats = element('span', '', 'cell-seats');
  const status = element('span', '', 'cell-status');
  const mode = element('span', executionLabels[d.execution] || d.execution, 'cell-mode');

  content.append(topRow, head, seats, status, mode);
  button.append(hexShellSVG(), content);

  button.addEventListener('click', () => selectDepartment(d.id, true, true));
  button.addEventListener('pointerenter', () => previewDepartment(d.id));
  button.addEventListener('keydown', event => {
    if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const ordered = departments();
      const i = ordered.findIndex(x => x.id === d.id);
      const delta = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
      const next = ordered[(i + delta + ordered.length) % ordered.length];
      selectDepartment(next.id, true, false);
      state.cells.get(next.id)?.button.focus();
    }
  });
  return { button, status, title, mode, seats };
}

function previewDepartment(id) {
  if (!department(id) || state.focused) return;
  state.hovered = id;
  if (state.selected === id) {
    highlightRoutes(id);
    updateHoverHint(id);
    return;
  }
  state.selected = id;
  for (const [deptId, cell] of state.cells) {
    cell.button.setAttribute('aria-pressed', String(deptId === id));
  }
  for (const btn of document.querySelectorAll('[data-method-department]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.methodDepartment === id));
  }
  highlightRoutes(id);
  updateHoverHint(id);
  renderDepartment();
}

function updateHoverHint(id) {
  const hint = $('#hive-hover-hint');
  if (!hint) return;
  const d = department(id);
  if (!d) {
    hint.textContent = 'Hover to trace handoffs, click to zoom inside';
    return;
  }
  const routes = view()?.routes || [];
  const inc = routes.filter(r => r.to === id).map(r => department(r.from)?.label).filter(Boolean);
  const out = routes.filter(r => r.from === id).map(r => department(r.to)?.label).filter(Boolean);
  const parts = [];
  if (inc.length) parts.push(`From: ${inc.join(', ')}`);
  if (out.length) parts.push(`To: ${out.join(', ')}`);
  hint.textContent = parts.length ? `${d.label} · ${parts.join(' → ')} (click to zoom inside)` : `${d.label} · Click to zoom inside`;
}

function renderCellSeats(d, container) {
  container.replaceChildren();
  if (d.execution === 'human') {
    const pip = element('span', 'H', 'seat-pip');
    pip.title = 'Human in the Loop';
    container.append(pip);
    return;
  }
  const roster = departmentRoster(d);
  for (const actor of roster.slice(0, 4)) {
    const busy = !isStale() && actorTasks(d, actor).some(active);
    const pip = element('span', seatMonogram(actor), 'seat-pip' + (busy ? ' is-active' : ''));
    pip.title = actorLabel(actor);
    container.append(pip);
  }
  if (roster.length > 4) container.append(element('span', `+${roster.length - 4}`, 'seat-pip-more'));
}

function renderHive() {
  const list = departments();
  const container = $('#hive-cells');
  if (!list.length || !container) return;
  assignPalettesAndLayout(list);
  container.replaceChildren();
  state.cells.clear();
  list.forEach((d, i) => {
    const cell = createCell(d, i);
    state.cells.set(d.id, cell);
    container.append(cell.button);
    cell.title.textContent = d.label;
    cell.status.textContent = departmentState(d);
    renderCellSeats(d, cell.seats);
    cell.button.setAttribute('aria-pressed', String(d.id === state.selected));
    cell.button.setAttribute('aria-label', `${d.label}. ${d.responsibility}. ${departmentState(d)}`);
    cell.button.classList.toggle('is-running', Boolean(countRunning(d)));
    cell.button.classList.toggle('has-arrival', state.arrivals.some(a => a.department === d.id));
    cell.button.classList.toggle('is-focused', Boolean(state.focused && d.id === state.focused));
    cell.button.classList.toggle('is-dimmed', Boolean(state.focused && d.id !== state.focused));
  });
  renderRoutes();
  updateHoverHint(state.hovered || state.selected);
}

function quadPoint(p, c, q, t) {
  const u = 1 - t;
  return [u * u * p[0] + 2 * u * t * c[0] + t * t * q[0], u * u * p[1] + 2 * u * t * c[1] + t * t * q[1]];
}

function quadTangent(p, c, q, t) {
  const dx = 2 * (1 - t) * (c[0] - p[0]) + 2 * t * (q[0] - c[0]);
  const dy = 2 * (1 - t) * (c[1] - p[1]) + 2 * t * (q[1] - c[1]);
  return Math.atan2(dy, dx) * (180 / Math.PI);
}

function curveBetween(from, to, bend = 0) {
  const p = state.positions.get(from);
  const q = state.positions.get(to);
  if (!p || !q) return null;
  const mx = (p[0] + q[0]) / 2;
  const my = (p[1] + q[1]) / 2;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len = Math.hypot(dx, dy) || 1;
  const c = [mx + (-dy / len) * bend, my + (dx / len) * bend];
  return {
    d: `M ${p[0].toFixed(1)} ${p[1].toFixed(1)} Q ${c[0].toFixed(1)} ${c[1].toFixed(1)} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`,
    mid: quadPoint(p, c, q, 0.5),
    angle: quadTangent(p, c, q, 0.5)
  };
}

function svgText(x, y, text, className) {
  const el = document.createElementNS(ns, 'text');
  el.setAttribute('x', String(x));
  el.setAttribute('y', String(y));
  el.setAttribute('class', className);
  el.textContent = text;
  return el;
}

function renderRoutes() {
  const svg = $('#hive-routes');
  const badges = $('#hive-badges');
  if (!svg) return;
  svg.replaceChildren();
  badges?.replaceChildren();

  const defs = document.createElementNS(ns, 'defs');
  for (const d of departments()) {
    const grad = document.createElementNS(ns, 'radialGradient');
    grad.setAttribute('id', `halo-${d.id}`);
    const c = deptColor(d.id);
    [['0%', countRunning(d) ? '0.24' : '0.12'], ['62%', countRunning(d) ? '0.07' : '0.03'], ['100%', '0']].forEach(([off, op]) => {
      const s = document.createElementNS(ns, 'stop');
      s.setAttribute('offset', off);
      s.setAttribute('stop-color', c);
      s.setAttribute('stop-opacity', op);
      grad.append(s);
    });
    defs.append(grad);
  }
  svg.append(defs);

  // Subtle architectural honeycomb background lattice
  const ghostGroup = document.createElementNS(ns, 'g');
  for (const [gx, gy] of bgHexLattice) {
    const poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points', flatHexPoints(gx, gy, 84));
    poly.setAttribute('class', 'ghost-hex');
    ghostGroup.append(poly);
  }
  svg.append(ghostGroup);

  // 3 Architectural Company Tiers
  const archGroup = document.createElementNS(ns, 'g');
  const tier1 = document.createElementNS(ns, 'rect');
  tier1.setAttribute('x', '22'); tier1.setAttribute('y', '12'); tier1.setAttribute('width', '956'); tier1.setAttribute('height', '182'); tier1.setAttribute('rx', '16');
  tier1.setAttribute('class', 'arch-tier-box');
  archGroup.append(tier1, svgText(42, 36, 'TIER 01 · HUMAN IN THE LOOP', 'arch-tier-tag'), svgText(42, 54, 'Strategic direction, goals & feedback intake', 'arch-tier-sub'));

  const tier2 = document.createElementNS(ns, 'rect');
  tier2.setAttribute('x', '22'); tier2.setAttribute('y', '210'); tier2.setAttribute('width', '956'); tier2.setAttribute('height', '274'); tier2.setAttribute('rx', '18');
  tier2.setAttribute('class', 'arch-loop-bay');
  const loopDot = document.createElementNS(ns, 'circle');
  loopDot.setAttribute('cx', '44'); loopDot.setAttribute('cy', '234'); loopDot.setAttribute('r', '4.2');
  loopDot.setAttribute('class', 'arch-loop-dot');
  const t2Sub = svgText(958, 238, 'Continuous AI sessions ⇄ review → automated CI loop', 'arch-tier-sub');
  t2Sub.setAttribute('text-anchor', 'end');
  archGroup.append(tier2, loopDot, svgText(56, 238, 'TIER 02 · 24/7 AI AUTONOMOUS LOOP', 'arch-loop-tag'), t2Sub);

  const loopOrbitD = 'M 795 284 C 710 250, 290 250, 205 284';
  const loopOrbit = document.createElementNS(ns, 'path');
  loopOrbit.setAttribute('d', loopOrbitD);
  loopOrbit.setAttribute('class', 'arch-loop-orbit');
  archGroup.append(loopOrbit);
  if (!state.quiet && !reduced && !isStale()) {
    const flowDot = document.createElementNS(ns, 'circle');
    flowDot.setAttribute('r', '3.6');
    flowDot.setAttribute('class', 'arch-flow-dot');
    const motion = document.createElementNS(ns, 'animateMotion');
    motion.setAttribute('dur', '6s');
    motion.setAttribute('path', loopOrbitD);
    motion.setAttribute('repeatCount', 'indefinite');
    flowDot.append(motion);
    archGroup.append(flowDot);
  }

  const tier3 = document.createElementNS(ns, 'rect');
  tier3.setAttribute('x', '22'); tier3.setAttribute('y', '500'); tier3.setAttribute('width', '956'); tier3.setAttribute('height', '226'); tier3.setAttribute('rx', '16');
  tier3.setAttribute('class', 'arch-tier-box');
  const t3Sub = svgText(958, 526, 'Publishing, outreach & shared platform infrastructure', 'arch-tier-sub');
  t3Sub.setAttribute('text-anchor', 'end');
  archGroup.append(tier3, svgText(42, 526, 'TIER 03 · 24/7 DELIVERY & PLATFORM', 'arch-tier-tag'), t3Sub);
  svg.append(archGroup);

  // Soft feathered territory halos
  const haloGroup = document.createElementNS(ns, 'g');
  for (const d of departments()) {
    const pos = state.positions.get(d.id);
    if (!pos) continue;
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', String(pos[0]));
    circle.setAttribute('cy', String(pos[1]));
    circle.setAttribute('r', countRunning(d) ? '124' : '104');
    circle.setAttribute('fill', `url(#halo-${d.id})`);
    circle.setAttribute('class', 'dept-halo' + (countRunning(d) ? ' is-active' : ''));
    haloGroup.append(circle);
  }
  svg.append(haloGroup);

  // Clean orthogonal architectural conduits (zero chaotic diagonal crossings)
  const routePairs = new Set((view()?.routes || []).map(r => `${r.from}|${r.to}`));
  const drawnUndirected = new Set();
  const orthogonalRoute = (from, to) => {
    const p = state.positions.get(from);
    const q = state.positions.get(to);
    if (!p || !q) return null;
    const sameRow = Math.abs(p[1] - q[1]) < 10;
    const sameRowFar = sameRow && Math.abs(p[0] - q[0]) > 420;
    const returnToTop = p[1] > 500 && q[1] < 200;
    const topToMid = p[1] < 200 && q[1] > 200 && q[1] < 500;
    const midToBottom = p[1] > 200 && p[1] < 500 && q[1] > 500;
    if (returnToTop) {
      return {
        d: `M ${p[0]} ${p[1]} L 72 ${p[1]} Q 52 ${p[1]} 52 ${p[1] - 20} L 52 ${q[1] + 20} Q 52 ${q[1]} 72 ${q[1]} L ${q[0]} ${q[1]}`,
        mid: [52, 364],
        angle: -90
      };
    }
    if (topToMid) {
      const dx = q[0] < p[0] ? -20 : 20;
      return {
        d: `M ${p[0]} ${p[1]} L ${q[0] - dx} ${p[1]} Q ${q[0]} ${p[1]} ${q[0]} ${p[1] + 20} L ${q[0]} ${q[1]}`,
        mid: [q[0], 198],
        angle: 90
      };
    }
    if (sameRowFar) {
      const yBus = p[1] + 98;
      const sx = q[0] > p[0] ? 20 : -20;
      return {
        d: `M ${p[0]} ${p[1]} L ${p[0]} ${yBus - 16} Q ${p[0]} ${yBus} ${p[0] + sx} ${yBus} L ${q[0] - sx} ${yBus} Q ${q[0]} ${yBus} ${q[0]} ${yBus - 16} L ${q[0]} ${q[1]}`,
        mid: [(p[0] + q[0]) / 2, yBus],
        angle: q[0] > p[0] ? 0 : 180,
        isLoop: true
      };
    }
    if (midToBottom) {
      const busY = 492;
      if (Math.abs(p[0] - q[0]) < 12) {
        return { d: `M ${p[0]} ${p[1]} L ${q[0]} ${q[1]}`, mid: [q[0], 520], angle: 90 };
      }
      const sx = q[0] > p[0] ? 16 : -16;
      return {
        d: `M ${p[0]} ${p[1]} L ${p[0]} ${busY - 14} Q ${p[0]} ${busY} ${p[0] + sx} ${busY} L ${q[0] - sx} ${busY} Q ${q[0]} ${busY} ${q[0]} ${busY + 16} L ${q[0]} ${q[1]}`,
        mid: [q[0], 532],
        angle: 90
      };
    }
    if (sameRow) {
      return {
        d: `M ${p[0]} ${p[1]} L ${q[0]} ${q[1]}`,
        mid: [(p[0] + q[0]) / 2, p[1]],
        angle: q[0] > p[0] ? 0 : 180,
        isLoop: p[1] > 200 && p[1] < 500
      };
    }
    return curveBetween(from, to, 0);
  };

  for (const route of view()?.routes || []) {
    const pairKey = [route.from, route.to].sort().join('|');
    const bidir = routePairs.has(`${route.to}|${route.from}`);
    if (bidir && drawnUndirected.has(pairKey)) continue;
    if (bidir) drawnUndirected.add(pairKey);

    const curve = orthogonalRoute(route.from, route.to);
    if (!curve) continue;
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', curve.d);
    path.setAttribute('class', 'responsibility-route' + (curve.isLoop ? ' is-loop' : ''));
    path.dataset.from = route.from;
    path.dataset.to = route.to;
    svg.append(path);

    if (badges) {
      if (bidir) {
        const right = document.createElementNS(ns, 'path');
        right.setAttribute('d', 'M 2 -3.4 L 8.5 0 L 2 3.4');
        right.setAttribute('class', 'route-chevron');
        right.setAttribute('transform', `translate(${curve.mid[0].toFixed(1)} ${curve.mid[1].toFixed(1)})`);
        right.dataset.from = route.from; right.dataset.to = route.to;
        const left = document.createElementNS(ns, 'path');
        left.setAttribute('d', 'M -2 -3.4 L -8.5 0 L -2 3.4');
        left.setAttribute('class', 'route-chevron');
        left.setAttribute('transform', `translate(${curve.mid[0].toFixed(1)} ${curve.mid[1].toFixed(1)})`);
        left.dataset.from = route.from; left.dataset.to = route.to;
        badges.append(left, right);
      } else {
        const chevron = document.createElementNS(ns, 'path');
        chevron.setAttribute('d', 'M -4.2 -3.4 L 3.8 0 L -4.2 3.4');
        chevron.setAttribute('class', 'route-chevron');
        chevron.setAttribute('transform', `translate(${curve.mid[0].toFixed(1)} ${curve.mid[1].toFixed(1)}) rotate(${curve.angle.toFixed(1)})`);
        chevron.dataset.from = route.from; chevron.dataset.to = route.to;
        badges.append(chevron);
      }
    }
  }

  // Observed cross-department reference connections (revealed cleanly on hover)
  const grouped = new Map();
  for (const relation of view()?.handoffs || []) {
    if (relation.kind !== 'reference') continue;
    const identity = [relation.from, relation.to].sort().join('|');
    const existing = grouped.get(identity);
    if (!existing) grouped.set(identity, { relation, count: 1, activities: new Set([relation.activity]) });
    else { existing.count += 1; existing.activities.add(relation.activity); }
  }

  for (const [identity, entry] of grouped) {
    const { relation, count, activities: relActs } = entry;
    const curve = orthogonalRoute(relation.from, relation.to);
    if (!curve) continue;

    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', curve.d);
    path.setAttribute('class', 'research-connection');
    path.dataset.from = relation.from;
    path.dataset.to = relation.to;
    svg.append(path);

    if (badges && count >= 1) {
      const badge = document.createElementNS(ns, 'g');
      badge.dataset.from = relation.from;
      badge.dataset.to = relation.to;
      badge.setAttribute('class', 'route-badge');
      const label = String(count);
      const w = Math.max(24, label.length * 7 + 12);
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', (curve.mid[0] - w / 2).toFixed(1));
      rect.setAttribute('y', (curve.mid[1] - 9).toFixed(1));
      rect.setAttribute('width', String(w));
      rect.setAttribute('height', '18');
      rect.setAttribute('rx', '9');
      rect.setAttribute('class', 'route-badge-bg');
      const txt = svgText(curve.mid[0].toFixed(1), curve.mid[1].toFixed(1), label, 'route-badge-text');
      badge.append(rect, txt);
      badges.append(badge);
    }

    const arrival = state.arrivals.find(a => relActs.has(a.id));
    const animationKey = arrival && `${identity}/${eventKey(arrival)}`;
    if (!state.quiet && !reduced && arrival && !state.animated.has(animationKey)) {
      state.animated.add(animationKey);
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('r', '5');
      dot.setAttribute('class', 'arrival-particle');
      const motion = document.createElementNS(ns, 'animateMotion');
      motion.setAttribute('dur', '1.5s');
      motion.setAttribute('path', curve.d);
      motion.setAttribute('repeatCount', '1');
      dot.append(motion);
      svg.append(dot);
    }
  }
  highlightRoutes(state.hovered || state.selected);
}

function highlightRoutes(id) {
  for (const path of document.querySelectorAll('#hive-routes path.responsibility-route, #hive-routes path.research-connection, #hive-badges .route-chevron')) {
    path.classList.toggle('selected', path.dataset.from === id || path.dataset.to === id);
  }
  for (const badge of document.querySelectorAll('#hive-badges .route-badge')) {
    const match = badge.dataset.from === id || badge.dataset.to === id;
    badge.classList.toggle('selected', match);
  }
}

function renderDepartment() {
  const list = departments();
  const d = department(state.selected) || list.find(x => x.execution !== 'human') || list[0];
  if (!d) return;
  state.selected = d.id;

  $('#department-mode').textContent = executionLabels[d.execution] || d.execution;
  $('#department-mode').dataset.execution = d.execution;
  $('#department-title').textContent = d.label;
  $('#department-responsibility').textContent = d.responsibility;
  $('#department-state').textContent = departmentState(d);

  const roster = departmentRoster(d);
  $('#department-people').replaceChildren(
    element('span', roster.length ? `${roster.length} public work seats` : 'Human steering layer', 'people-label'),
    element('span', `${d.observed_activities || d.activities.length} observed events`, 'people-summary')
  );

  $('#department-agent-count').textContent = roster.length ? `${roster.length} seats` : '';
  const seatBox = $('#department-agents');
  seatBox.replaceChildren();
  if (!roster.length) {
    seatBox.append(element('p', d.execution === 'human' ? 'Humans set goals and direction here; AI seats execute continuously below.' : 'No public seats observed in this department yet.', 'loading'));
  }
  for (const actor of roster) {
    const tasks = actorTasks(d, actor);
    const running = !isStale() ? tasks.filter(active) : [];
    const card = element('article', '', 'agent-card');
    const head = element('div', '', 'agent-card-head');
    const identity = element('div', '', 'agent-identity');
    identity.append(person(actor), element('span', actor.kind === 'agent' ? 'Registered agent' : 'Public account', 'agent-kind'));
    head.append(identity, element('span', running.length ? `${running.length} active` : tasks.length ? relative(tasks[0].at) : 'Registered', 'agent-state' + (running.length ? ' is-running' : '')));
    card.append(head);

    const taskList = element('div', '', 'agent-task-list');
    for (const a of tasks.slice(0, 2)) {
      const row = a.task ? element('button', '', 'agent-task') : external('', a.url || '#', 'agent-task');
      if (a.task) row.type = 'button';
      row.append(
        element('span', phase(a), 'agent-task-state' + (active(a) ? ' is-running' : '')),
        element('strong', actorTaskTitle(a)),
        element('small', `${sourceLabel(a)} · ${relative(a.at)}`)
      );
      if (a.task) row.addEventListener('click', () => selectTopic(a));
      taskList.append(row);
    }
    if (!tasks.length) taskList.append(element('p', 'Waiting for new public activity.', 'agent-empty'));
    card.append(taskList);
    seatBox.append(card);
  }

  const workBox = $('#department-work');
  workBox.replaceChildren();
  const work = [...d.activities].sort((a, b) => Number(active(b)) - Number(active(a)) || timestamp(b.at) - timestamp(a.at)).slice(0, 3);
  $('#department-work-count').textContent = countRunning(d) ? `${countRunning(d)} active` : '';
  for (const a of work) {
    const card = a.task ? element('button', '', 'work-item') : external('', a.url || '#', 'work-item');
    if (a.task) card.type = 'button';
    card.classList.toggle('is-active', active(a));
    const meta = element('div', '', 'work-meta');
    meta.append(element('span', phase(a), 'work-state'), element('time', relative(a.at)));
    card.append(meta, element('strong', actorTaskTitle(a)), element('p', sourceLabel(a)));
    const bottom = element('div', '', 'work-bottom');
    bottom.append(element('span', a.actor?.label || executionLabels[d.execution]), element('span', a.task ? 'Trace relay ↗' : 'Open source ↗', 'work-arrow'));
    card.append(bottom);
    if (a.task) card.addEventListener('click', () => selectTopic(a));
    workBox.append(card);
  }
  if (!work.length) workBox.append(element('p', 'New department updates will appear here.', 'loading'));

  const related = new Set((view()?.routes || []).filter(r => r.from === d.id || r.to === d.id).map(r => r.from === d.id ? r.to : r.from));
  const links = $('#department-connections');
  links.replaceChildren();
  if (related.size) {
    links.append(element('span', 'Connected relay departments', 'people-label'));
    for (const id of related) {
      const target = department(id);
      if (!target) continue;
      const btn = element('button', `${target.label} ↗`, 'connection-chip');
      btn.type = 'button';
      btn.addEventListener('click', () => selectDepartment(id, true, false));
      links.append(btn);
    }
  }
}

// ============================================================================
// ZOOMED-IN SPATIAL DEPARTMENT MAP
// ============================================================================
function seatSlotsFor(count) {
  const layouts = {
    1: [[320, 290]],
    2: [[318, 198], [318, 386]],
    3: [[318, 144], [288, 294], [318, 446]],
    4: [[322, 120], [282, 236], [282, 352], [322, 470]],
    5: [[325, 118], [278, 234], [278, 354], [325, 472], [590, 108]],
    6: [[320, 114], [276, 234], [276, 354], [320, 474], [590, 106], [590, 488]]
  };
  return layouts[Math.min(6, Math.max(1, count))] || layouts[6];
}

function verticalSlots(count, x, top = 126, bottom = 454) {
  if (count <= 0) return [];
  if (count === 1) return [[x, 290]];
  const step = (bottom - top) / (count - 1);
  return Array.from({ length: count }, (_, i) => [x, Math.round(top + i * step)]);
}

function departmentTopicNodes(d) {
  const map = new Map();
  const sorted = [...d.activities].sort((a, b) => Number(active(b)) - Number(active(a)) || timestamp(b.at) - timestamp(a.at));
  for (const a of sorted) {
    const title = actorTaskTitle(a);
    const topicKey = a.task ? key(a.task) : `${a.source}:${title}`;
    const existing = map.get(topicKey);
    if (!existing) {
      map.set(topicKey, {
        id: topicKey,
        title,
        tag: sourceLabel(a),
        status: phase(a),
        running: active(a),
        activity: a,
        actors: a.actor ? [a.actor.id] : []
      });
    } else {
      if (active(a)) existing.running = true;
      if (a.actor && !existing.actors.includes(a.actor.id)) existing.actors.push(a.actor.id);
    }
    if (map.size >= 4) break;
  }
  return [...map.values()];
}

function highlightZoomSeat(seatId) {
  const svg = $('#lens-map-svg');
  if (!svg) return;
  for (const beam of svg.querySelectorAll('.zoom-beam')) {
    if (!seatId) {
      beam.classList.remove('is-highlighted', 'is-dimmed');
      continue;
    }
    const actors = (beam.dataset.actors || '').split('|').filter(Boolean);
    const match = beam.dataset.seat === seatId || actors.includes(seatId);
    beam.classList.toggle('is-highlighted', match);
    beam.classList.toggle('is-dimmed', !match && beam.dataset.role !== 'portal');
  }
  for (const card of document.querySelectorAll('#lens-agents .lens-agent')) {
    card.classList.toggle('is-selected', card.dataset.seatId === seatId);
  }
}

function updateLensSpotlight(d, actor) {
  const spot = $('#lens-spotlight');
  if (!spot) return;
  spot.replaceChildren();
  if (!actor) {
    spot.append(element('span', 'Hover or click any work seat to highlight its live beams · Click a work node to trace its relay · Click portals to jump between departments'));
    return;
  }
  const tasks = actorTasks(d, actor);
  spot.append(element('strong', `${actorLabel(actor)}:`));
  if (!tasks.length) {
    spot.append(element('span', 'Standby — waiting for new public records.'));
    return;
  }
  for (const a of tasks.slice(0, 3)) {
    const chip = a.task
      ? element('button', `${phase(a)} · ${actorTaskTitle(a)}`, 'spotlight-chip')
      : external(`${phase(a)} · ${actorTaskTitle(a)} ↗`, a.url || '#', 'spotlight-chip');
    if (a.task) {
      chip.type = 'button';
      chip.addEventListener('click', () => selectTopic(a));
    }
    spot.append(chip);
  }
}

function renderDepartmentLens(d) {
  const lens = $('#department-lens');
  const room = $('#research-room');
  if (!lens || !room) return;
  if (!d || state.mode !== 'organization' || !state.focused) {
    lens.hidden = true;
    room.classList.remove('is-department-focused');
    return;
  }
  lens.hidden = false;
  lens.dataset.palette = String(state.palettes.get(d.id) ?? 1);
  room.classList.add('is-department-focused');

  const switcher = $('#lens-switcher');
  switcher.replaceChildren();
  for (const dept of departments()) {
    const pill = element('button', '', 'lens-switch-pill' + (countRunning(dept) ? ' has-running' : ''));
    pill.type = 'button';
    pill.setAttribute('role', 'tab');
    pill.setAttribute('aria-selected', String(dept.id === d.id));
    pill.append(element('i', '', 'lens-switch-dot'), document.createTextNode(dept.label));
    pill.addEventListener('click', () => selectDepartment(dept.id, true, true));
    switcher.append(pill);
  }

  $('#lens-title').textContent = d.label;
  $('#lens-responsibility').textContent = d.responsibility;
  $('#lens-exec-pill').textContent = executionLabels[d.execution] || d.execution;
  $('#lens-exec-pill').dataset.execution = d.execution;
  $('#lens-freshness').textContent = view()?.observed_at ? `Updated ${relative(view().observed_at)}` : '';

  const stats = queueStats(d);
  const metric = (value, label, cls = '') => {
    const item = element('div', '', 'lens-metric' + (cls ? ' ' + cls : ''));
    item.append(element('strong', String(value)), element('span', label));
    return item;
  };
  $('#lens-metrics').replaceChildren(
    metric(departmentRoster(d).length, 'seats'),
    metric(isStale() ? '—' : stats.running, 'active', !isStale() && stats.running ? 'is-running' : ''),
    metric(stats.label, 'queued', stats.waiting ? 'is-queued' : ''),
    metric(d.observed_activities || stats.recent, 'events')
  );

  const routes = view()?.routes || [];
  const handoffs = view()?.handoffs || [];
  const upIds = [...new Set(routes.filter(r => r.to === d.id).map(r => r.from))];
  let downIds = [...new Set(routes.filter(r => r.from === d.id).map(r => r.to))];
  if (!downIds.length) {
    downIds = [...new Set(handoffs.filter(h => h.from === d.id && h.to !== d.id).map(h => h.to))].slice(0, 2);
  }

  const inRoute = routes.find(r => r.to === d.id);
  const outRoute = routes.find(r => r.from === d.id);
  $('#lens-input').textContent = inRoute?.label || 'Incoming issues & triggers';
  $('#lens-output').textContent = outRoute?.label || 'Verified deliverables';

  const hubEl = $('#lens-hub');
  const runCount = countRunning(d);
  hubEl.classList.toggle('is-running', Boolean(runCount));
  hubEl.replaceChildren(
    element('span', d.execution === 'actions' ? '24/7 CI ENGINE' : d.execution === 'human' ? 'HUMAN IN THE LOOP' : '24/7 AI LOOP', 'map-hub-code'),
    element('strong', d.label, 'map-hub-title'),
    element('span', runCount ? `${runCount} active` : d.execution === 'human' ? 'Steering hub' : `${departmentRoster(d).length} seats`, 'map-hub-stat')
  );

  const roster = departmentRoster(d);
  const primarySeats = roster.slice(0, 6);
  const extraSeats = roster.slice(6);
  const topics = departmentTopicNodes(d);

  const hubXY = [590, 290];
  const upSlots = verticalSlots(upIds.length, 76, 175, 405);
  const downSlots = verticalSlots(downIds.length, 1122, 175, 405);
  const seatSlots = seatSlotsFor(primarySeats.length);
  const topicSlots = verticalSlots(topics.length, 872, 128, 452);

  const svg = $('#lens-map-svg');
  svg.replaceChildren();
  const outerHex = document.createElementNS(ns, 'polygon');
  outerHex.setAttribute('points', flatHexPoints(590, 290, 292));
  outerHex.setAttribute('class', 'zoom-hex-wall-outer');
  const wallHex = document.createElementNS(ns, 'polygon');
  wallHex.setAttribute('points', flatHexPoints(590, 290, 266));
  wallHex.setAttribute('class', 'zoom-hex-wall');
  svg.append(
    outerHex,
    wallHex,
    svgText(76, 24, 'UPSTREAM', 'zoom-zone-label'),
    svgText(310, 24, 'WORK SEATS', 'zoom-zone-label'),
    svgText(590, 24, 'DEPARTMENT CORE', 'zoom-zone-label'),
    svgText(872, 24, 'ACTIVE WORK', 'zoom-zone-label'),
    svgText(1122, 24, 'DOWNSTREAM', 'zoom-zone-label')
  );

  const drawBeam = (x1, y1, x2, y2, cls, extra = {}) => {
    const mx = (x1 + x2) / 2;
    const dPath = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', dPath);
    path.setAttribute('class', `zoom-beam ${cls}`);
    if (extra.seat) path.dataset.seat = extra.seat;
    if (extra.actors) path.dataset.actors = extra.actors;
    if (extra.role) path.dataset.role = extra.role;
    svg.append(path);
    if (extra.pulse && !state.quiet && !reduced && !isStale()) {
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('r', '3.5');
      dot.setAttribute('class', 'zoom-pulse-dot');
      const motion = document.createElementNS(ns, 'animateMotion');
      motion.setAttribute('dur', extra.dur || '3.2s');
      motion.setAttribute('path', dPath);
      motion.setAttribute('repeatCount', 'indefinite');
      dot.append(motion);
      svg.append(dot);
    }
  };

  upSlots.forEach(([px, py]) => drawBeam(px + 54, py, hubXY[0] - 65, hubXY[1], 'is-portal', { role: 'portal' }));
  primarySeats.forEach((actor, idx) => {
    const [sx, sy] = seatSlots[idx];
    const running = !isStale() && actorTasks(d, actor).some(active);
    const startX = sx < hubXY[0] - 80 ? sx + 96 : sx;
    const startY = sx < hubXY[0] - 80 ? sy : (sy < hubXY[1] ? sy + 40 : sy - 40);
    const endX = sx < hubXY[0] - 80 ? hubXY[0] - 64 : hubXY[0];
    const endY = sx < hubXY[0] - 80 ? hubXY[1] : (sy < hubXY[1] ? hubXY[1] - 64 : hubXY[1] + 64);
    drawBeam(startX, startY, endX, endY, running ? 'is-live' : '', { seat: actor.id, pulse: running, dur: '2.6s' });
  });
  topicSlots.forEach(([tx, ty], idx) => {
    const t = topics[idx];
    drawBeam(hubXY[0] + 64, hubXY[1], tx - 104, ty, t.running ? 'is-live' : 'is-topic', { actors: t.actors.join('|'), pulse: t.running, dur: '3.1s' });
    downSlots.forEach(([dx, dy]) => drawBeam(tx + 104, ty, dx - 54, dy, 'is-portal', { actors: t.actors.join('|'), role: 'portal' }));
  });
  if (!topics.length) downSlots.forEach(([dx, dy]) => drawBeam(hubXY[0] + 64, hubXY[1], dx - 54, dy, 'is-portal', { role: 'portal' }));

  const renderPortals = (container, ids, slots, dir) => {
    container.replaceChildren();
    ids.forEach((targetId, idx) => {
      const target = department(targetId);
      if (!target) return;
      const [px, py] = slots[idx];
      const count = handoffs.filter(h => dir === 'in' ? (h.from === targetId && h.to === d.id) : (h.from === d.id && h.to === targetId)).length;
      const btn = element('button', '', 'map-portal-node');
      btn.type = 'button';
      btn.style.setProperty('--px', `${(px / 12).toFixed(2)}%`);
      btn.style.setProperty('--py', `${(py / 5.8).toFixed(2)}%`);
      btn.append(
        element('span', dir === 'in' ? '← IN' : 'OUT →', 'map-portal-dir'),
        element('strong', target.label),
        element('span', count ? `${count} refs` : 'Open map', 'map-portal-count')
      );
      btn.addEventListener('click', () => selectDepartment(targetId, true, true));
      container.append(btn);
    });
  };
  renderPortals($('#lens-upstream'), upIds, upSlots, 'in');
  renderPortals($('#lens-downstream'), downIds, downSlots, 'out');

  const buildSeatCard = (actor, pos) => {
    const tasks = actorTasks(d, actor);
    const running = !isStale() ? tasks.filter(active) : [];
    const card = element('article', '', 'lens-agent' + (running.length ? ' is-busy' : ''));
    card.dataset.seatId = actor.id;
    if (pos) {
      card.style.setProperty('--sx', `${(pos[0] / 12).toFixed(2)}%`);
      card.style.setProperty('--sy', `${(pos[1] / 5.8).toFixed(2)}%`);
    }
    const head = element('div', '', 'lens-agent-head');
    const identity = element('div', '', 'lens-agent-identity');
    identity.append(person(actor));
    head.append(identity, element('span', actor.kind === 'agent' ? 'Agent' : 'Account', 'agent-kind'));
    const metaRow = element('div', '', 'lens-agent-meta-row');
    const stEl = element('span', '', 'lens-agent-status' + (running.length ? ' is-running' : ''));
    stEl.append(element('i'), document.createTextNode(running.length ? `${running.length} active` : tasks.length ? relative(tasks[0].at) : 'Registered'));
    metaRow.append(stEl);
    card.append(head, metaRow);

    const lane = element('div', '', 'lens-task-lane');
    if (tasks.length) {
      const seen = new Set();
      let shown = 0;
      for (const a of tasks) {
        const title = actorTaskTitle(a);
        if (seen.has(title)) continue;
        seen.add(title);
        const row = a.task ? element('button', '', 'lens-task') : external('', a.url || '#', 'lens-task');
        if (a.task) row.type = 'button';
        row.append(element('i', '', 'lens-task-dot' + (active(a) ? ' is-running' : '')), element('strong', title));
        if (a.task) row.addEventListener('click', e => { e.stopPropagation(); selectTopic(a); });
        lane.append(row);
        if (++shown >= 2) break;
      }
    } else {
      lane.append(element('p', 'Standby · waiting for work', 'lens-empty-seat'));
    }
    card.append(lane);
    card.addEventListener('pointerenter', () => { highlightZoomSeat(actor.id); updateLensSpotlight(d, actor); });
    card.addEventListener('pointerleave', () => highlightZoomSeat(state.hoveredSeat));
    card.addEventListener('click', () => {
      state.hoveredSeat = state.hoveredSeat === actor.id ? null : actor.id;
      highlightZoomSeat(state.hoveredSeat);
      updateLensSpotlight(d, state.hoveredSeat ? actor : null);
    });
    return card;
  };

  const seatContainer = $('#lens-agents');
  const extraContainer = $('#lens-extra-seats');
  seatContainer.replaceChildren();
  extraContainer.replaceChildren();
  extraContainer.hidden = extraSeats.length === 0;
  if (!primarySeats.length) {
    seatContainer.append(element('div', d.execution === 'human' ? 'Human steering layer: defines strategic problems and reviews outcomes from the 24/7 loop below.' : 'No public seats active in the current observation window.', 'lens-empty-map'));
  } else {
    primarySeats.forEach((actor, idx) => seatContainer.append(buildSeatCard(actor, seatSlots[idx])));
    for (const actor of extraSeats) extraContainer.append(buildSeatCard(actor, null));
  }

  const topicLayer = $('#lens-topics');
  topicLayer.replaceChildren();
  topics.forEach((t, idx) => {
    const [tx, ty] = topicSlots[idx];
    const hasTask = Boolean(t.activity?.task);
    const node = hasTask ? element('button', '', 'map-topic-node') : external('', t.activity?.url || '#', 'map-topic-node');
    if (hasTask) node.type = 'button';
    node.style.setProperty('--tx', `${(tx / 12).toFixed(2)}%`);
    node.style.setProperty('--ty', `${(ty / 5.8).toFixed(2)}%`);
    const top = element('div', '', 'map-topic-top');
    top.append(element('span', t.tag), element('span', t.status));
    const foot = element('div', '', 'map-topic-foot');
    foot.append(element('span', t.actors.length ? `${t.actors.length} seat${t.actors.length > 1 ? 's' : ''}` : 'Active flow'), element('span', hasTask ? 'Trace relay →' : 'Open ↗'));
    node.append(top, element('strong', t.title), foot);
    if (hasTask) node.addEventListener('click', () => selectTopic(t.activity));
    topicLayer.append(node);
  });

  state.hoveredSeat = null;
  updateLensSpotlight(d, null);
}

function selectDepartment(id, manual = true, openLens = true) {
  if (!department(id)) return;
  state.selected = id;
  if (manual) state.follow = false;
  if (manual && openLens && state.mode === 'organization') state.focused = id;
  else if (!openLens) state.focused = null;
  updateControls();
  renderMetrics();
  renderHive();
  renderDepartment();
  renderDepartmentLens(department(state.focused));
}

function closeDepartmentLens() {
  state.focused = null;
  state.hoveredSeat = null;
  $('#research-room')?.classList.remove('is-department-focused');
  $('#department-lens').hidden = true;
  renderMetrics();
  renderHive();
  renderDepartment();
}

function relatedTo(topic) {
  const keys = new Set([key(topic.task), ...(topic.references || []).map(key)].filter(Boolean));
  const rows = activities();
  for (let i = 0; i < 2; i++) {
    const next = new Set(keys);
    for (const a of rows) {
      const refs = [key(a.task), ...(a.references || []).map(key)].filter(Boolean);
      if (refs.some(ref => keys.has(ref))) for (const ref of refs) if (next.size < 60) next.add(ref);
    }
    if (next.size === keys.size) break;
    for (const ref of next) keys.add(ref);
  }
  return rows.filter(a => keys.has(key(a.task)) || (a.references || []).some(ref => keys.has(key(ref)))).sort((a, b) => timestamp(b.at) - timestamp(a.at));
}

function selectTopic(a) {
  const work = activities().find(item => ['task', 'contribution'].includes(item.kind) && key(item.task) === key(a.task));
  a = work || a;
  state.topic = a;
  state.follow = false;
  setMode('journey');
}

function renderJourney() {
  let topic = state.topic || activities().find(a => a.task && ['task', 'contribution'].includes(a.kind));
  const stages = $('#journey-stages');
  const events = $('#journey-events');
  const people = $('#journey-people');
  const links = $('#journey-links');
  stages.replaceChildren(); events.replaceChildren(); people.replaceChildren(); links.replaceChildren();
  if (!topic) {
    events.append(element('p', 'No linked tasks observed yet.', 'loading'));
    return;
  }
  const related = relatedTo(topic);
  $('#journey-title').textContent = cleanTitle(topic.label) || sourceLabel(topic);
  $('#journey-description').textContent = `Tracking ${related.length} observed event${related.length === 1 ? '' : 's'} linked by explicit cross-repository references.`;

  const touched = departments().map(d => ({ d, items: related.filter(a => a.department === d.id) })).filter(x => x.items.length);
  touched.forEach(({ d, items }, i) => {
    const btn = element('button', '', 'journey-stage');
    btn.type = 'button';
    btn.classList.toggle('is-active', items.some(active));
    const running = items.filter(active).length;
    btn.append(element('span', String(i + 1).padStart(2, '0')), element('strong', d.label), element('p', running ? `${running} running` : phase(items[0])));
    btn.addEventListener('click', () => { setMode('organization'); selectDepartment(d.id, true, true); });
    stages.append(btn);
  });

  const actorMap = new Map();
  for (const a of related) if (a.actor) actorMap.set(`${a.actor.kind}:${a.actor.id}`, a.actor);
  people.append(...[...actorMap.values()].slice(0, 8).map(person));

  for (const a of related.slice(0, 6)) {
    const item = element('article', '', 'journey-event');
    const d = department(a.department);
    item.append(
      element('time', relative(a.at)),
      element('strong', `${d?.label || a.department} · ${phase(a)}`),
      element('p', a.actor ? actorLabel(a.actor) : executionLabels[d?.execution] || '', 'journey-byline'),
      element('p', actorTaskTitle(a)),
      external('View source on GitHub ↗', a.url || '#')
    );
    events.append(item);
  }
  if (topic.url) links.append(external('Open source thread ↗', topic.url, 'text-link'));
}

function renderActivity() {
  const unique = [];
  const seen = new Set();
  for (const a of view()?.recent || []) {
    const sig = `${a.source}:${a.id}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    unique.push(a);
    if (unique.length === 4) break;
  }
  const container = $('#activity-strip');
  container.replaceChildren();
  for (const a of unique) {
    const d = department(a.department);
    const card = element('button', '', 'activity-card');
    card.type = 'button';
    const top = element('div', '', 'activity-card-top');
    top.append(element('span', d?.label || a.department, 'activity-role'), element('time', relative(a.at)));
    card.append(top, element('strong', phase(a)), element('p', actorTaskTitle(a)), element('span', a.actor ? actorLabel(a.actor) : executionLabels[d?.execution] || '', 'activity-byline'));
    card.addEventListener('click', () => { if (a.task) selectTopic(a); else { setMode('organization'); selectDepartment(a.department, true, true); } });
    container.append(card);
  }
  if (!unique.length) container.append(element('p', 'Waiting for observed activity.', 'loading'));
}

function renderLiveOps() {
  // Left: Live Pulse
  const container = $('#live-feed');
  const rows = (view()?.recent || []).filter(a => {
    if (state.feedFilter === 'all') return a.kind !== 'automation';
    if (state.feedFilter === 'work') return ['task', 'contribution', 'session'].includes(a.kind);
    if (state.feedFilter === 'discussion') return ['discussion', 'review'].includes(a.kind);
    if (state.feedFilter === 'automation') return a.kind === 'automation';
    return true;
  });
  $('#live-feed-meta').textContent = `${rows.length} events`;
  container.replaceChildren();
  if (!rows.length) container.append(element('p', 'No events match this filter yet.', 'loading'));
  for (const a of rows.slice(0, 12)) {
    const d = department(a.department);
    const entry = element('article', '', 'feed-entry');
    const head = element('div', '', 'feed-entry-head');
    const who = element('div', '', 'feed-who');
    const dot = element('i', '', 'feed-dept-dot');
    dot.style.background = deptColor(a.department);
    who.append(dot, element('span', a.actor ? actorLabel(a.actor) : executionLabels[d?.execution] || 'System', 'feed-actor'), element('span', d?.label || a.department, 'feed-dept-tag'));
    head.append(who, element('time', relative(a.at), 'feed-time'));
    entry.append(head, element('div', `${phase(a)} · ${actorTaskTitle(a)}`, 'feed-title'), element('p', sourceLabel(a), 'feed-excerpt'));
    const foot = element('div', '', 'feed-footer');
    const actions = element('div', '', 'feed-actions');
    if (a.task) {
      const btn = element('button', 'Trace relay →');
      btn.type = 'button';
      btn.addEventListener('click', () => { selectTopic(a); $('#institute').scrollIntoView({ behavior: reduced ? 'instant' : 'smooth' }); });
      actions.append(btn);
    }
    if (a.url) actions.append(external('GitHub ↗', a.url));
    foot.append(element('span'), actions);
    entry.append(foot);
    container.append(entry);
  }

  // Right Top: 48-LED Checker Lights + Runs
  const runs = activities().filter(a => a.kind === 'automation').sort((a, b) => Number(active(b)) - Number(active(a)) || timestamp(b.at) - timestamp(a.at));
  const workingCount = isStale() ? 0 : departments().reduce((n, d) => n + (d.running_automations || 0), 0);
  const passedCount = runs.filter(a => a.status === 'succeeded').length;
  $('#checker-summary').textContent = isStale() ? 'Stale' : `${workingCount} running · ${passedCount} passed`;

  const lights = $('#checker-lights');
  lights.replaceChildren();
  for (const a of runs.slice(0, 48)) {
    const st = fresh(a) ? a.status : (a.status === 'working' || a.status === 'waiting' ? 'unknown' : a.status);
    const cell = external('', a.url || '#', `checker-light is-${st}`);
    cell.title = `${department(a.department)?.label || a.department} · ${sourceLabel(a)} · ${phase(a)}`;
    lights.append(cell);
  }

  const runBox = $('#checker-runs');
  runBox.replaceChildren();
  if (!runs.length) runBox.append(element('p', 'No automated workflow runs observed yet.', 'loading'));
  for (const a of runs.slice(0, 8)) {
    const d = department(a.department);
    const st = fresh(a) ? a.status : (a.status === 'working' || a.status === 'waiting' ? 'unknown' : a.status);
    const row = external('', a.url || '#', 'checker-row');
    const main = element('span', '', 'checker-main');
    main.append(element('strong', `${d?.label || a.department} · ${sourceLabel(a)}`), element('small', actorTaskTitle(a)));
    row.append(element('span', phase(a), `checker-badge is-${st}`), main, element('span', a.actor?.label || 'Actions', 'checker-actor'), element('span', relative(a.at), 'checker-time'));
    runBox.append(row);
  }

  // Right Bottom: Cross-Department Relay Bridges
  const bridges = handoffSummary();
  const total = bridges.reduce((n, b) => n + b.count, 0);
  $('#relay-summary').textContent = total ? `${total} total references` : 'Explicit references';
  const bridgeBox = $('#relay-bridges');
  bridgeBox.replaceChildren();
  if (!bridges.length) bridgeBox.append(element('p', 'Cross-department references appear here when tasks link across repositories.', 'loading'));
  const maxCount = bridges[0]?.count || 1;
  for (const b of bridges.slice(0, 6)) {
    const row = element('button', '', 'bridge-row');
    row.type = 'button';
    const top = element('div', '', 'bridge-top');
    const lbl = element('span', '', 'bridge-label');
    lbl.append(document.createTextNode(department(b.from)?.label || b.from), element('em', '→'), document.createTextNode(department(b.to)?.label || b.to));
    top.append(lbl, element('span', String(b.count), 'bridge-count'));
    const track = element('div', '', 'bridge-bar-track');
    const fill = element('div', '', 'bridge-bar-fill');
    fill.style.width = `${Math.max(8, Math.round((b.count / maxCount) * 100))}%`;
    track.append(fill);
    row.append(top, track);
    row.addEventListener('click', () => { setMode('organization'); selectDepartment(b.from, true, true); $('#institute').scrollIntoView({ behavior: reduced ? 'instant' : 'smooth' }); });
    bridgeBox.append(row);
  }
}

function updateControls() {
  for (const button of document.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
  $('#follow-live').setAttribute('aria-pressed', String(state.follow));
  $('#follow-live span').textContent = state.follow ? 'Follow live' : 'Pinned view';
  $('#research-room').dataset.mode = state.mode;
  $('#journey-panel').hidden = state.mode !== 'journey';
}

function setMode(mode) {
  state.mode = mode;
  if (mode !== 'organization') {
    state.focused = null;
    $('#research-room')?.classList.remove('is-department-focused');
    $('#department-lens').hidden = true;
  }
  updateControls();
  if (mode === 'journey') renderJourney();
  else { renderHive(); renderDepartment(); renderDepartmentLens(department(state.focused)); }
}

function renderAll() {
  renderBrand();
  renderHealth();
  renderTicker();
  renderMetrics();
  renderHive();
  renderDepartment();
  renderDepartmentLens(department(state.focused));
  renderActivity();
  renderLiveOps();
  if (state.mode === 'journey') renderJourney();
  updateControls();
}

function extractView(raw) {
  const candidate = raw?.schema === 'ai-org.live.v1' ? raw : raw?.organization;
  if (
    candidate?.schema === 'ai-org.live.v1'
    && Number.isFinite(timestamp(candidate.observed_at))
    && Array.isArray(candidate.departments)
    && Array.isArray(candidate.sources)
    && Array.isArray(candidate.recent)
  ) return candidate;
  return null;
}

function rebaseDemoTimestamps(org) {
  const base = timestamp(org.observed_at);
  if (!Number.isFinite(base)) return org;
  const shift = Date.now() - base - 25000;
  const shiftIso = iso => Number.isFinite(timestamp(iso)) ? new Date(timestamp(iso) + shift).toISOString() : iso;
  org.observed_at = shiftIso(org.observed_at);
  for (const s of org.sources || []) if (s.observed_at) s.observed_at = shiftIso(s.observed_at);
  for (const d of org.departments || []) for (const a of d.activities || []) a.at = shiftIso(a.at);
  for (const a of org.recent || []) a.at = shiftIso(a.at);
  return org;
}

function resolveDataURL() {
  const params = new URLSearchParams(location.search);
  const fromQuery = safeDataURL(params.get('data'));
  if (fromQuery) return fromQuery;
  const meta = document.querySelector('meta[name="live-data"]')?.getAttribute('content');
  const fromMeta = safeDataURL(meta);
  if (fromMeta) return fromMeta;
  return new URL('organization.json', document.baseURI).href;
}

async function refreshLive() {
  if (state.busy) return;
  state.busy = true;
  try {
    let raw = null;
    let demo = false;
    const primary = resolveDataURL();
    try {
      const res = await fetch(primary, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (res.ok) raw = await res.json();
    } catch {}
    if (!raw && !state.view) {
      const res = await fetch(new URL('demo-organization.json', document.baseURI), { cache: 'no-store' });
      if (res.ok) {
        raw = await res.json();
        demo = true;
      }
    }
    let org = extractView(raw);
    if (!org) throw new Error('no valid ai-org.live.v1 payload');
    if (demo) org = rebaseDemoTimestamps(org);
    if (state.view && !demo && timestamp(org.observed_at) < timestamp(state.view.observed_at)) return;
    const first = !state.view;
    const arrivals = first ? [] : org.recent.filter(a => !state.seen.has(eventKey(a)));
    state.view = org;
    state.isDemo = demo;
    state.arrivals = arrivals.slice(0, 8);
    for (const a of org.recent) state.seen.add(eventKey(a));
    if (state.follow && state.mode === 'organization' && arrivals.length) state.selected = arrivals[0].department;
    renderAll();
  } catch {
    renderHealth();
    if (!state.view) {
      $('#connection-note').hidden = false;
      $('#connection-note').textContent = 'Run `live-harness collect --config organization.json --state .live-state/checkpoint.json --output ui/organization.json` to connect your organization.';
    }
  } finally {
    state.busy = false;
  }
}

function applyTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.dataset.theme = 'dark';
    $('#theme-toggle').textContent = '☀';
  } else {
    delete document.documentElement.dataset.theme;
    $('#theme-toggle').textContent = '☾';
  }
}

for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => { if (b.dataset.mode === 'journey') state.follow = false; setMode(b.dataset.mode); });
for (const b of document.querySelectorAll('[data-feed-filter]')) b.addEventListener('click', () => {
  state.feedFilter = b.dataset.feedFilter;
  for (const s of document.querySelectorAll('[data-feed-filter]')) s.setAttribute('aria-pressed', String(s === b));
  renderLiveOps();
});
$('#ticker-action')?.addEventListener('click', () => {
  const item = state.tickerTarget;
  if (!item) return;
  if (item.task) selectTopic(item);
  else { setMode('organization'); selectDepartment(item.department, true, true); }
  $('#institute').scrollIntoView({ behavior: reduced ? 'instant' : 'smooth' });
});
$('#open-lens-button')?.addEventListener('click', () => { setMode('organization'); selectDepartment(state.selected, true, true); });
$('#journey-back')?.addEventListener('click', () => setMode('organization'));
$('#lens-back')?.addEventListener('click', () => closeDepartmentLens());
$('#follow-live')?.addEventListener('click', () => {
  state.follow = !state.follow;
  if (state.follow) { state.focused = null; state.selected = view()?.recent?.[0]?.department || departments()[0]?.id; setMode('organization'); }
  updateControls(); renderAll();
});
$('#motion-toggle')?.addEventListener('click', () => {
  state.quiet = !state.quiet;
  document.body.classList.toggle('quiet', state.quiet);
  $('#motion-toggle').setAttribute('aria-pressed', String(state.quiet));
  renderRoutes();
  if (state.focused) renderDepartmentLens(department(state.focused));
});
$('#theme-toggle')?.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(themeKey, next); } catch {}
});
$('#expand-room')?.addEventListener('click', async () => {
  const room = $('#research-room');
  if (document.fullscreenElement) { await document.exitFullscreen(); return; }
  if (room.classList.contains('is-expanded')) { room.classList.remove('is-expanded'); document.body.style.overflow = ''; return; }
  if (room.requestFullscreen) { try { await room.requestFullscreen(); return; } catch {} }
  room.classList.add('is-expanded'); document.body.style.overflow = 'hidden';
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (state.focused) closeDepartmentLens(); $('#research-room').classList.remove('is-expanded'); document.body.style.overflow = ''; }
});
if (reduced) { document.body.classList.add('quiet'); $('#motion-toggle').hidden = true; }
try { if (localStorage.getItem(themeKey) === 'dark') applyTheme('dark'); } catch {}

updateControls();
refreshLive();
setInterval(() => { if (!document.hidden && !state.isDemo) refreshLive(); }, 15000);
setInterval(() => { if (!document.hidden) renderHealth(); }, 30000);
