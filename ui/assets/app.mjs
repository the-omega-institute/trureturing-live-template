const $ = selector => document.querySelector(selector);
const ns = 'http://www.w3.org/2000/svg';
const themeKey = 'ai-org-live.look';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  view: null,
  isDemo: false,
  selected: null,
  focused: null,
  hovered: null,
  mode: 'organization',
  follow: true,
  quiet: reduced,
  feedFilter: 'all',
  topic: null,
  dockTab: null,
  cells: new Map(),
  world: new Map(),
  seen: new Set(),
  arrivals: [],
  busy: false,
  tickerTarget: null
};

const executionLabels = {
  human: 'Human in the Loop',
  sessions: 'AI Sessions',
  actions: 'GitHub Actions',
  mixed: 'Sessions & Automation'
};

const shortRoleLabels = {
  human: 'Human',
  sessions: 'AI',
  actions: 'CI',
  mixed: 'Hybrid'
};

const glyphPaths = {
  human: ['M12 3v18M3 12h18', 'm7 7 5-4 5 4M7 17l5 4 5-4'],
  research: ['M17 4H6l7 8-7 8h11'],
  review: ['M3 8h17m-4-4 4 4-4 4M21 16H4m4-4-4 4 4 4'],
  verification: ['m5 12 4 4L19 6', 'M20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9'],
  books: ['M12 6C8 3 4 4 3 5v14c3-2 6-1 9 1 3-2 6-3 9-1V5c-3-2-6-1-9 1Z', 'M12 6v14'],
  publication: ['M6 3h9l4 4v14H6Z', 'M14 3v5h5M9 12h7M9 16h5'],
  outreach: ['M4 5h16v12H9l-5 4V5Z', 'M8 9h8M8 13h5'],
  studio: ['M5 4v16M12 4v16M19 4v16', 'M2 8h6M9 16h6M16 10h6']
};

const sectorPalette = [
  { css: 'var(--c-research)', hex: [29, 255, 130], shape: 'brain', tag: 'CORE' },
  { css: 'var(--c-review)', hex: [184, 148, 255], shape: 'scales', tag: 'AUDIT' },
  { css: 'var(--c-publication)', hex: [61, 242, 180], shape: 'tree', tag: 'DOCS' },
  { css: 'var(--c-outreach)', hex: [245, 161, 86], shape: 'dish', tag: 'OUTREACH' },
  { css: 'var(--c-books)', hex: [217, 150, 245], shape: 'codex', tag: 'CODEX' },
  { css: 'var(--c-studio)', hex: [108, 214, 255], shape: 'gears', tag: 'FORGE' }
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

const rgba = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;

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
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    if (url.protocol === 'http:' && url.origin !== location.origin) return null;
    return url.href;
  } catch {
    return null;
  }
}

function external(label, url, className = '') {
  const a = element('a', label, className);
  a.href = safeURL(url);
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function svgIcon(paths) {
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const view = () => state.view;
const departments = () => view()?.departments || [];
const department = id => departments().find(d => d.id === id);
const isStale = () => {
  const observed = timestamp(view()?.observed_at);
  return !Number.isFinite(observed) || (Date.now() - observed) / 1000 > Math.max(600, (view()?.freshness_seconds || 180) * 4);
};
const active = a => a && ['working', 'queued'].includes(a.status) && a.fresh !== false && !isStale();
const taskKey = t => t ? `${t.repository}#${t.number}` : '';
const eventKey = a => `${a.source}:${a.id}:${a.status}:${a.at}`;

function countRunning(d) {
  if (isStale()) return 0;
  return (d.running_automations || 0) + (d.running_sessions || 0);
}

function isBridgeDept(d) {
  return d.execution === 'actions' || /verif|check|ci|lean/i.test(d.id);
}

function isHumanDept(d) {
  return d.execution === 'human' || /direction|human|steer/i.test(d.id);
}

function iconFor(d) {
  if (isHumanDept(d)) return glyphPaths.human;
  if (isBridgeDept(d)) return glyphPaths.verification;
  if (/review|audit|qa/i.test(d.id)) return glyphPaths.review;
  if (/book|doc/i.test(d.id)) return glyphPaths.books;
  if (/pub|paper/i.test(d.id)) return glyphPaths.publication;
  if (/outreach|comm|collab/i.test(d.id)) return glyphPaths.outreach;
  if (/studio|tool|plat|infra/i.test(d.id)) return glyphPaths.studio;
  return glyphPaths.research;
}

function shapeFor(d, idx) {
  if (isHumanDept(d)) return 'eye';
  if (isBridgeDept(d)) return 'helix';
  if (/review|audit|qa/i.test(d.id)) return 'scales';
  if (/book/i.test(d.id)) return 'codex';
  if (/pub|paper/i.test(d.id)) return 'tree';
  if (/outreach|collab/i.test(d.id)) return 'dish';
  if (/studio|tool|plat|infra/i.test(d.id)) return 'gears';
  return sectorPalette[idx % sectorPalette.length].shape;
}

function deptMissions(d) {
  const list = [];
  const seen = new Set();
  const push = txt => {
    const clean = String(txt || '').trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    list.push(clean);
  };
  const sorted = [...(d.activities || [])].sort((a, b) => Number(active(b)) - Number(active(a)) || timestamp(b.at) - timestamp(a.at));
  for (const a of sorted) push(a.label);
  if (!list.length && isHumanDept(d)) {
    for (const a of (view()?.recent || []).slice(0, 4)) push(`Steering: ${a.label}`);
  }
  if (!list.length) push(d.responsibility || '24/7 autonomous standby');
  return list.slice(0, 5);
}

// ============================================================================
// DYNAMIC 3D MULTI-SECTOR CAMPUS LAYOUT (works for ANY ai-org.live.v1 config!)
// Places Human Steering as floating Akasha Eye above, Verification as elevated
// Central Bridge, and remaining departments across spacious sovereign wings.
// ============================================================================
function buildDynamicWorld() {
  state.world.clear();
  const list = departments();
  if (!list.length) return;

  const humanDept = list.find(isHumanDept);
  const bridgeDept = list.find(d => d !== humanDept && isBridgeDept(d));
  const others = list.filter(d => d !== humanDept && d !== bridgeDept);

  if (humanDept) {
    state.world.set(humanDept.id, {
      x: 0.0, y: 3.65, z: -3.75, r: 0.72, baseH: 0.90,
      apex: true, eye: true, shape: 'eye', order: 0,
      hex: [244, 197, 83], css: 'var(--c-direction)', sector: 'apex', role: 'Architect Eye'
    });
  }
  if (bridgeDept) {
    state.world.set(bridgeDept.id, {
      x: 0.0, y: 0.22, z: -0.45, r: 0.84, baseH: 1.44,
      apex: false, eye: false, shape: 'helix', order: 1,
      hex: [0, 255, 208], css: 'var(--c-verification)', sector: 'bridge', role: 'Central Bridge'
    });
  }

  // Spacious 6-slot sovereign campus coordinates (Left Wing, Right Wing, Front-Left, Front-Right)
  const slots = [
    { x: -5.30, z: -2.95, sector: 'left' },
    { x: -6.05, z:  1.95, sector: 'left' },
    { x:  5.30, z: -2.95, sector: 'right' },
    { x:  6.05, z:  1.95, sector: 'right' },
    { x: -3.35, z:  5.35, sector: 'frontL' },
    { x:  3.35, z:  5.35, sector: 'frontR' }
  ];

  // For 4 remaining departments, balance 2 on Left Wing + 2 on Right Wing cleanly
  const fourSlots = [slots[0], slots[1], slots[2], slots[3]];
  const chosenSlots = others.length <= 4 ? fourSlots : slots;

  others.forEach((d, i) => {
    const pal = sectorPalette[i % sectorPalette.length];
    let slot = chosenSlots[i];
    if (!slot) {
      const ang = (i / others.length) * Math.PI * 2;
      slot = { x: Math.cos(ang) * 5.6, z: Math.sin(ang) * 3.8, sector: 'outer' };
    }
    state.world.set(d.id, {
      x: slot.x, y: 0.0, z: slot.z, r: 0.70, baseH: 1.24,
      apex: false, eye: false, shape: shapeFor(d, i), order: i + 2,
      hex: pal.hex, css: pal.css, sector: slot.sector,
      role: shortRoleLabels[d.execution] || pal.tag
    });
  });
}

// ============================================================================
// REAL-TIME 60FPS 3D MATRIX CONSTRUCT + EXPANDING OUTER COSMIC NEBULA
// ============================================================================
const holoCam = {
  yaw: -0.18,
  pitch: 0.65,
  dist: 21.8,
  targetYaw: 0.0,
  targetPitch: 0.55,
  targetDist: 18.8,
  gazeX: -5.2,
  gazeZ: -2.8,
  dragging: false,
  dragMoved: false,
  lastX: 0,
  lastY: 0,
  time: 0,
  bootAge: 0,
  raf: 0,
  matrixCols: [],
  nebula: null,
  pulses: [],
  flares: [],
  nebulaRipples: [],
  projectedTowers: new Map()
};

function initMatrixAndNebula() {
  if (!holoCam.matrixCols.length) {
    let seed = 4242;
    const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    for (let i = 0; i < 46; i++) {
      holoCam.matrixCols.push({
        u: (i + 0.35 + (rand() - 0.5) * 0.4) / 46,
        speed: 2.1 + rand() * 3.6,
        phase: rand() * 40,
        len: 8 + Math.floor(rand() * 10),
        size: rand() > 0.72 ? 12 : 10,
        seed: Math.floor(rand() * 997),
        depth: 0.45 + rand() * 0.55
      });
    }
  }
  if (!holoCam.nebula && view()) {
    // Synthesize a spacious outer-ring cosmic knowledge nebula from the org's own departments & activities
    const depts = departments().filter(d => !isHumanDept(d));
    const ringAnchors = [
      [-475, 935, -150], [475, 935, -150], [-825, 615, -120],
      [825, 615, -120], [-795, -755, -110], [795, -755, -110], [0, -830, -140]
    ];
    let seed = 9187;
    const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const clusters = [];
    const stars = [];
    const edges = [];
    const frontier = [];
    depts.slice(0, ringAnchors.length).forEach((d, cid) => {
      const [ax, ay, az] = ringAnchors[cid];
      const count = Math.max(12, d.observed_activities || (d.activities || []).length || 12);
      clusters.push({ id: cid, name: d.label, en: d.id.toUpperCase(), count, center: [ax, ay, az] });
      const baseIdx = stars.length;
      const nStars = 48;
      for (let k = 0; k < nStars; k++) {
        const ang = rand() * Math.PI * 2;
        const r = Math.pow(rand(), 0.58) * 165;
        const sx = Math.round(ax + Math.cos(ang) * r);
        const sy = Math.round(ay + Math.sin(ang) * r * 0.78);
        const sz = Math.round(az + (rand() - 0.5) * 90);
        const gen = Math.round(Math.min(100, (r / 165) * 100));
        const deg = k < 5 ? 8 : Math.floor(rand() * 7);
        stars.push([sx, sy, sz, cid, gen, deg]);
        if (k > 0) {
          const parent = baseIdx + Math.floor(rand() * Math.min(k, 8));
          edges.push([parent, baseIdx + k]);
        }
        if (gen > 58 && k % 3 === 0) {
          frontier.push({
            parentIdx: baseIdx + k, cid,
            vx: Math.cos(ang) * (0.22 + rand() * 0.18),
            vy: Math.sin(ang) * (0.22 + rand() * 0.18),
            vz: (rand() - 0.5) * 0.14,
            phase: rand(), speed: 0.065 + rand() * 0.05, size: 1.15 + rand() * 0.9
          });
        }
      }
    });
    const clusterLinks = [];
    for (let i = 0; i < clusters.length; i++) {
      clusterLinks.push([i, (i + 1) % clusters.length, 48 + i * 12]);
    }
    holoCam.nebula = {
      clusters, clusterLinks, stars, edges, frontier,
      projX: new Float32Array(stars.length),
      projY: new Float32Array(stars.length),
      projLit: new Float32Array(stars.length)
    };
  }
}

function spawnHoloPulse(deptId, strength = 0.85) {
  if (!state.world.has(deptId) || state.quiet || reduced) return;
  holoCam.pulses.push({ id: deptId, age: 0, strength });
  if (holoCam.pulses.length > 16) holoCam.pulses.shift();
  const cfg = state.world.get(deptId);
  if (cfg?.sector === 'bridge' && holoCam.nebulaRipples.length < 3) {
    holoCam.nebulaRipples.push({ age: 0 });
  }
}

function spawnSpokeFlare(fromId, toId) {
  if (!state.world.has(fromId) || !state.world.has(toId) || fromId === toId || state.quiet || reduced) return;
  const col = state.world.get(fromId)?.hex || [0, 255, 208];
  holoCam.flares.push({ fromId, toId, age: 0, rgb: col });
  if (holoCam.flares.length > 12) holoCam.flares.shift();
}

function triggerScanSweep() {
  if (state.quiet || reduced || /jsdom/i.test(navigator.userAgent || '')) return;
  const el = $('#fui-scan-sweep');
  if (!el) return;
  el.classList.remove('is-sweeping');
  void el.offsetWidth;
  el.classList.add('is-sweeping');
}

function drawOuterNebula(ctx, w, h, t, isLight, isBlueprint) {
  const neb = holoCam.nebula;
  if (!neb || !neb.stars.length) return;
  const quiet = state.quiet || reduced;
  const tEff = quiet ? 4.2 : t;
  const pal = isBlueprint
    ? [[120, 210, 255], [148, 228, 255], [108, 182, 255], [176, 198, 255], [126, 222, 248], [136, 192, 255], [214, 236, 255]]
    : isLight
      ? [[12, 136, 108], [16, 122, 166], [182, 104, 18], [114, 64, 188], [16, 138, 98], [46, 108, 192], [176, 112, 20]]
      : [[0, 242, 152], [0, 222, 240], [246, 198, 86], [178, 126, 255], [56, 240, 184], [112, 196, 255], [252, 218, 124]];

  const nebYaw = (quiet ? 0 : Math.sin(tEff * 0.14) * 0.04) + holoCam.yaw * 0.25;
  const nebPitch = 0.05 + (holoCam.pitch - 0.55) * 0.16;
  const cY = Math.cos(nebYaw), sY = Math.sin(nebYaw), cP = Math.cos(nebPitch), sP = Math.sin(nebPitch);
  const front0 = quiet ? 0.52 : (tEff * 0.14) % 1.30;
  const breath = 1.0 + (quiet ? 0.02 : 0.036 * Math.sin(tEff * 0.30));
  const cx = w * 0.5, cy = h * 0.50;
  const scaleX = w * 0.425 * breath, scaleY = h * 0.455 * breath, camZ = 2.65;

  const projectNeb = (nx, ny, nz) => {
    const x1 = nx * cY - nz * sY, z1 = nx * sY + nz * cY;
    const y2 = ny * cP - z1 * sP, z2 = ny * sP + z1 * cP + camZ;
    const inv = 1.85 / Math.max(0.65, z2);
    return [cx + x1 * scaleX * inv, cy - y2 * scaleY * inv, z2, inv];
  };

  const coreClear = (px, py) => {
    const d = Math.hypot((px - w * 0.5) / (w * 0.235), (py - h * 0.49) / (h * 0.255));
    if (d <= 0.72) return 0.05;
    if (d >= 1.18) return 1.0;
    const u = (d - 0.72) / 0.46;
    return 0.05 + 0.95 * (u * u * (3 - 2 * u));
  };

  const clProj = new Map();
  for (const cl of neb.clusters) {
    const [px, py, pz, inv] = projectNeb(cl.center[0] / 1000, cl.center[1] / 1000, cl.center[2] / 1000);
    clProj.set(cl.id, { cl, x: px, y: py, z: pz, inv, col: pal[cl.id % pal.length] });
  }

  ctx.save();
  if (!isLight) ctx.globalCompositeOperation = 'lighter';

  for (const { cl, x: px, y: py, inv, col } of clProj.values()) {
    const rad = Math.min(w, h) * 0.20 * inv;
    const g = ctx.createRadialGradient(px, py, 6, px, py, rad);
    const a = (isLight ? 0.048 : isBlueprint ? 0.075 : 0.09) * coreClear(px, py);
    g.addColorStop(0, rgba(col, a));
    g.addColorStop(0.5, rgba(col, a * 0.4));
    g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(px, py, rad, 0, Math.PI * 2); ctx.fill();
  }

  const waveCol = isBlueprint ? [150, 215, 255] : isLight ? [15, 118, 110] : [0, 255, 168];
  const drawWave = (u, peak) => {
    if (u <= 0.58 || u >= 1.28) return;
    const fade = Math.sin(Math.min(1, (u - 0.58) / 0.70) * Math.PI);
    ctx.strokeStyle = rgba(waveCol, fade * peak);
    ctx.lineWidth = 0.95;
    ctx.setLineDash([6, 16]);
    ctx.beginPath(); ctx.ellipse(cx, cy, w * 0.45 * u, h * 0.45 * u, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  };
  drawWave(0.58 + (front0 / 1.30) * 0.70, isLight ? 0.09 : 0.13);
  for (const rp of holoCam.nebulaRipples) drawWave(0.58 + rp.age * 0.70, isLight ? 0.12 : 0.22);

  // Outer perimeter curved constellation links
  const ringRx = w * 0.34, ringRy = h * 0.385;
  for (let i = 0; i < neb.clusterLinks.length; i++) {
    const [uId, vId] = neb.clusterLinks[i];
    const a = clProj.get(uId), b = clProj.get(vId);
    if (!a || !b) continue;
    const angA = Math.atan2((a.y - cy) / ringRy, (a.x - cx) / ringRx);
    const angB = Math.atan2((b.y - cy) / ringRy, (b.x - cx) / ringRx);
    let diff = angB - angA;
    if (diff > Math.PI) diff -= Math.PI * 2;
    if (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) > 2.55) continue;
    const segs = 16, pts = [];
    for (let s = 0; s <= segs; s++) {
      const u = s / segs, ang = angA + diff * u, arch = Math.sin(u * Math.PI);
      pts.push([
        (a.x * (1 - u) + b.x * u) * (1 - arch * 0.72) + (cx + Math.cos(ang) * ringRx * 1.06) * (arch * 0.72),
        (a.y * (1 - u) + b.y * u) * (1 - arch * 0.72) + (cy + Math.sin(ang) * ringRy * 1.06) * (arch * 0.72)
      ]);
    }
    const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    grad.addColorStop(0, rgba(a.col, isLight ? 0.24 : 0.26));
    grad.addColorStop(1, rgba(b.col, isLight ? 0.28 : 0.32));
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    pts.forEach(([px, py], idx) => idx === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py));
    ctx.stroke();
  }

  // Stars & branching DAG trees
  for (let i = 0; i < neb.stars.length; i++) {
    const s = neb.stars[i], gen = s[4] / 100;
    const lit = Math.max(0, 1 - Math.abs(gen - front0) / 0.16);
    const [px, py] = projectNeb(s[0] / 1000, s[1] / 1000, s[2] / 1000);
    neb.projX[i] = px; neb.projY[i] = py; neb.projLit[i] = lit;
  }
  ctx.strokeStyle = rgba(waveCol, isLight ? 0.20 : 0.24);
  ctx.lineWidth = 0.72;
  ctx.beginPath();
  for (const [u, v] of neb.edges) {
    if (coreClear((neb.projX[u] + neb.projX[v]) * 0.5, (neb.projY[u] + neb.projY[v]) * 0.5) < 0.35) continue;
    ctx.moveTo(neb.projX[u], neb.projY[u]); ctx.lineTo(neb.projX[v], neb.projY[v]);
  }
  ctx.stroke();

  for (let i = 0; i < neb.stars.length; i++) {
    const s = neb.stars[i], px = neb.projX[i], py = neb.projY[i];
    const mask = coreClear(px, py);
    if (mask < 0.1) continue;
    const col = pal[s[3] % pal.length];
    const sz = s[5] >= 7 ? 2.2 : 1.35;
    ctx.fillStyle = rgba(col, ((isLight ? 0.42 : 0.48) + neb.projLit[i] * 0.35) * mask);
    ctx.fillRect(px - sz * 0.5, py - sz * 0.5, sz, sz);
  }

  for (const f of neb.frontier) {
    const pStar = neb.stars[f.parentIdx];
    const u = quiet ? ((f.phase * 0.7 + 0.18) % 1) : ((tEff * f.speed + f.phase) % 1);
    const dist = Math.pow(u, 0.82) * 0.52;
    const [px, py] = projectNeb(pStar[0] / 1000 + f.vx * dist, pStar[1] / 1000 + f.vy * dist, pStar[2] / 1000 + f.vz * dist);
    const mask = coreClear(px, py);
    if (mask < 0.25) continue;
    const col = pal[f.cid % pal.length], fade = Math.sin(u * Math.PI) * mask;
    if (u < 0.75) {
      ctx.strokeStyle = rgba(col, (1 - u / 0.75) * fade * 0.42);
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(neb.projX[f.parentIdx], neb.projY[f.parentIdx]); ctx.lineTo(px, py); ctx.stroke();
    }
    ctx.fillStyle = isLight ? rgba(col, fade * 0.78) : rgba([235, 255, 245], fade * 0.86);
    ctx.beginPath(); ctx.arc(px, py, f.size * 0.85, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();

  // Subtle constellation labels in open outer sky pockets
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  const strokeHalo = isLight ? 'rgba(247, 244, 236, 0.94)' : 'rgba(2, 10, 5, 0.94)';
  for (const { cl, x: px, y: py, col } of clProj.values()) {
    const isBottom = cl.center[1] < 0;
    const lx = Math.max(305, Math.min(w - 305, px));
    const ly = isBottom ? Math.min(h - 104, py + 34) : Math.max(84, py - 32);
    if (lx < 276 || lx > w - 276) continue;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 8.8px "Geist Mono", ui-monospace, monospace';
    ctx.lineWidth = 3;
    ctx.strokeStyle = strokeHalo;
    const lbl = `${cl.en} · ${cl.count}`;
    ctx.strokeText(lbl, lx, ly);
    ctx.fillStyle = rgba(col, isLight ? 0.88 : 0.82);
    ctx.fillText(lbl, lx, ly);
  }
  ctx.restore();
}

function drawHolo3DFrame(dt = 0.016) {
  const canvas = $('#holo-3d');
  if (!canvas || /jsdom/i.test(navigator.userAgent || '')) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const rect = canvas.getBoundingClientRect();
  const w = Math.max(320, Math.round(rect.width || window.innerWidth || 1440));
  const h = Math.max(280, Math.round(rect.height || window.innerHeight || 900));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const stepDt = Math.min(0.05, dt);
  if (!state.quiet && !reduced) {
    holoCam.time += stepDt;
    holoCam.bootAge += stepDt;
  } else {
    holoCam.bootAge = 5;
  }
  const t = holoCam.time;
  const idleDrift = (!holoCam.dragging && !state.quiet && !reduced) ? Math.sin(t * 0.22) * 0.04 : 0;
  holoCam.yaw += (holoCam.targetYaw + idleDrift - holoCam.yaw) * 0.085;
  holoCam.pitch += (holoCam.targetPitch - holoCam.pitch) * 0.085;
  holoCam.dist += (holoCam.targetDist - holoCam.dist) * 0.085;

  for (let i = holoCam.pulses.length - 1; i >= 0; i--) {
    holoCam.pulses[i].age += stepDt * 1.35;
    if (holoCam.pulses[i].age >= 1) holoCam.pulses.splice(i, 1);
  }
  for (let i = holoCam.flares.length - 1; i >= 0; i--) {
    holoCam.flares[i].age += stepDt * 1.15;
    if (holoCam.flares[i].age >= 1) holoCam.flares.splice(i, 1);
  }
  for (let i = holoCam.nebulaRipples.length - 1; i >= 0; i--) {
    holoCam.nebulaRipples[i].age += stepDt * 0.28;
    if (holoCam.nebulaRipples[i].age >= 1) holoCam.nebulaRipples.splice(i, 1);
  }

  const isLight = document.documentElement.dataset.theme === 'light';
  const isBlueprint = document.documentElement.dataset.look === 'blueprint';
  const isHolo = !isLight && !isBlueprint;

  // 1. Background Atmosphere + Matrix Code Rain + Expanding Outer Constellation Nebula
  const bg = ctx.createRadialGradient(w * 0.5, h * 0.36, 30, w * 0.5, h * 0.5, Math.max(w, h) * 0.85);
  if (isLight) {
    bg.addColorStop(0, '#f7f4ec'); bg.addColorStop(0.6, '#eeeae0'); bg.addColorStop(1, '#dfd9cc');
  } else if (isBlueprint) {
    bg.addColorStop(0, '#102644'); bg.addColorStop(0.55, '#0a182d'); bg.addColorStop(1, '#061020');
  } else {
    bg.addColorStop(0, '#072213'); bg.addColorStop(0.42, '#020d06'); bg.addColorStop(1, '#010402');
  }
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  initMatrixAndNebula();
  if (isHolo) {
    const glyphs = ['∀', '∃', '⊢', '∎', 'λ', 'Σ', 'π', '∫', '∈', '⊂', '≤', '≥', '0', '1', 'A', 'I', '→', '↔', '≡'];
    const tRain = (state.quiet || reduced) ? 3.5 : t;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const col of holoCam.matrixCols) {
      const px = col.u * w;
      const zoneFade = 0.42 + Math.abs(col.u - 0.5) * 1.15;
      const stepY = col.size + 4;
      const rows = Math.ceil(h / stepY) + col.len + 6;
      const headRow = Math.floor((tRain * col.speed + col.phase) % rows);
      ctx.font = `600 ${col.size}px "Geist Mono", ui-monospace, Menlo, monospace`;
      for (let k = 0; k < col.len; k++) {
        const r = headRow - k, py = r * stepY;
        if (py < -stepY || py > h) continue;
        const ch = glyphs[Math.abs((col.seed + r * 7) % glyphs.length)];
        ctx.fillStyle = k === 0
          ? `rgba(218, 255, 232, ${(0.32 * col.depth * zoneFade).toFixed(3)})`
          : `rgba(0, 238, 122, ${(0.18 * Math.pow(1 - k / col.len, 1.4) * col.depth * zoneFade).toFixed(3)})`;
        ctx.fillText(ch, px, py);
      }
    }
    ctx.restore();
  }

  drawOuterNebula(ctx, w, h, t, isLight, isBlueprint);

  const cx = w * 0.5, cy = state.focused ? h * 0.52 : h * 0.535;
  const fov = Math.min(w, h) * (w > 1360 ? 1.08 : w > 980 ? 0.98 : 0.92);
  const cosY = Math.cos(holoCam.yaw), sinY = Math.sin(holoCam.yaw);
  const cosP = Math.cos(holoCam.pitch), sinP = Math.sin(holoCam.pitch);
  const project = (wx, wy, wz) => {
    const x0 = wx, y0 = wy - 0.55, z0 = wz - 0.45;
    const x1 = x0 * cosY - z0 * sinY, z1 = x0 * sinY + z0 * cosY;
    const y2 = y0 * cosP - z1 * sinP, z2 = y0 * sinP + z1 * cosP + holoCam.dist;
    if (z2 < 0.8) return null;
    const s = fov / z2;
    return { x: cx + x1 * s, y: cy - y2 * s, z: z2, s };
  };

  const draw3DSeg = (p1, p2, stroke, lw = 1.1) => {
    if (!p1 || !p2) return;
    ctx.strokeStyle = stroke; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
  };

  const draw3DRing = (rx, ry, rz, radX, radZ, segs, stroke, lw = 1, dash = null, rot = 0) => {
    ctx.save();
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2 + rot;
      const pt = project(rx + Math.cos(a) * radX, ry, rz + Math.sin(a) * radZ);
      if (!pt) continue;
      if (!started) { ctx.moveTo(pt.x, pt.y); started = true; } else ctx.lineTo(pt.x, pt.y);
    }
    ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke();
    ctx.restore();
  };

  if (state.focused) {
    const fCfg = state.world.get(state.focused) || { hex: [0, 255, 208] };
    const rgb = isBlueprint ? [150, 215, 255] : fCfg.hex;
    for (let ringIdx = 0; ringIdx < 5; ringIdx++) {
      draw3DRing(0, -0.9 + ringIdx * 1.0, 0, 5.2 - Math.abs(ringIdx - 2) * 0.65, 5.2 - Math.abs(ringIdx - 2) * 0.65, 6, rgba(rgb, 0.16), 1, null, t * 0.08 * (ringIdx % 2 === 0 ? 1 : -1));
    }
    return;
  }

  // 2. Receding Matrix Perspective Floor Grid
  const matrixRGB = isBlueprint ? [125, 185, 245] : [0, 235, 120];
  const hubRGB = isBlueprint ? [150, 215, 255] : [0, 255, 208];
  const tier1RGB = [244, 197, 83];
  for (let gx = -9; gx <= 9; gx += 1.5) {
    const ef = 1 - Math.abs(gx) / 11;
    draw3DSeg(project(gx, -0.04, -5.0), project(gx, -0.04, 6.8), rgba(matrixRGB, (isLight ? 0.07 : 0.095) * ef), 0.8);
  }
  for (let gz = -4.5; gz <= 6.5; gz += 1.5) {
    const zf = Math.max(0.25, 1 - Math.abs(gz - 0.8) / 7.2);
    draw3DSeg(project(-9.2, -0.04, gz), project(9.2, -0.04, gz), rgba(matrixRGB, (isLight ? 0.07 : 0.095) * zf), 0.8);
  }

  // 3. Symmetric Oversight Field between Independent Eye of Akasha & Entire Campus
  const activeId = state.hovered || state.selected;
  const humanEntry = [...state.world.entries()].find(([, cfg]) => cfg.eye);
  const bridgeEntry = [...state.world.entries()].find(([, cfg]) => cfg.sector === 'bridge');
  if (humanEntry) {
    const [eyeId, eyeCfg] = humanEntry;
    const gazeT = (activeId && activeId !== eyeId && state.world.get(activeId)) || (bridgeEntry ? bridgeEntry[1] : { x: 0, z: 0 });
    holoCam.gazeX += (gazeT.x - holoCam.gazeX) * 0.09;
    holoCam.gazeZ += (gazeT.z - holoCam.gazeZ) * 0.09;
    const eyeOrigin = project(eyeCfg.x, eyeCfg.y, eyeCfg.z);
    const rimL = project(-6.8, 0.05, -0.4), rimR = project(6.8, 0.05, -0.4);
    if (eyeOrigin && rimL && rimR) {
      ctx.save();
      if (!isLight) ctx.globalCompositeOperation = 'lighter';
      const veil = ctx.createLinearGradient(eyeOrigin.x, eyeOrigin.y, eyeOrigin.x, Math.max(rimL.y, rimR.y));
      veil.addColorStop(0, rgba(tier1RGB, isLight ? 0.11 : 0.14));
      veil.addColorStop(0.5, rgba(tier1RGB, 0.036));
      veil.addColorStop(1, rgba(tier1RGB, 0));
      ctx.fillStyle = veil;
      ctx.beginPath(); ctx.moveTo(eyeOrigin.x, eyeOrigin.y); ctx.lineTo(rimL.x, rimL.y); ctx.lineTo(rimR.x, rimR.y); ctx.closePath(); ctx.fill();
      if (!state.quiet && !reduced) {
        let idx = 0;
        for (const [, src] of state.world) {
          if (src.eye) continue;
          const u = (t * 0.24 + idx * 0.17) % 1;
          const ease = 1 - Math.pow(1 - u, 1.35);
          const pt = project(src.x * (1 - ease), (src.y + 0.55) * (1 - u) + (eyeCfg.y - 0.1) * u, src.z * (1 - ease) + eyeCfg.z * ease);
          if (pt) {
            ctx.fillStyle = rgba(isLight ? tier1RGB : [255, 248, 224], Math.sin(u * Math.PI) * 0.85);
            ctx.beginPath(); ctx.arc(pt.x, pt.y, 1.8, 0, Math.PI * 2); ctx.fill();
          }
          idx++;
        }
      }
      ctx.restore();
    }
  }

  // 4. Sculpted Sovereign Sector Terraces + Elevated Central Verification Bridge
  const drawTerrace = (sx, sz, hx, hz, rgb) => {
    const ch = 0.36;
    const poly = [
      [sx - hx + ch, sz - hz], [sx + hx - ch, sz - hz], [sx + hx, sz - hz + ch], [sx + hx, sz + hz - ch],
      [sx + hx - ch, sz + hz], [sx - hx + ch, sz + hz], [sx - hx, sz + hz - ch], [sx - hx, sz - hz + ch]
    ].map(([px, pz]) => project(px, 0.0, pz));
    if (poly.some(p => !p)) return;
    ctx.beginPath();
    poly.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.fillStyle = isLight ? 'rgba(249, 247, 240, 0.78)' : rgba(rgb, 0.055);
    ctx.fill();
    ctx.strokeStyle = rgba(rgb, isLight ? 0.42 : 0.44);
    ctx.lineWidth = 1.35;
    ctx.stroke();
  };
  drawTerrace(-5.65, -0.50, 1.92, 3.65, isBlueprint ? [150, 215, 255] : [29, 255, 130]);
  drawTerrace( 5.65, -0.50, 1.92, 3.65, isBlueprint ? [150, 215, 255] : [245, 168, 92]);
  if ([...state.world.values()].some(c => c.sector === 'frontL')) drawTerrace(-3.35, 5.35, 1.65, 1.05, isBlueprint ? [150, 215, 255] : [217, 150, 245]);
  if ([...state.world.values()].some(c => c.sector === 'frontR')) drawTerrace( 3.35, 5.35, 1.65, 1.05, isBlueprint ? [150, 215, 255] : [108, 214, 255]);

  if (bridgeEntry) {
    const [, bCfg] = bridgeEntry;
    const drawSpan = (x0, x1) => {
      const zc = bCfg.z, yd = bCfg.y * 0.72, hw = 0.42;
      draw3DSeg(project(x0, yd, zc - hw), project(x1, yd, zc - hw), rgba(hubRGB, 0.56), 1.4);
      draw3DSeg(project(x0, yd, zc + hw), project(x1, yd, zc + hw), rgba(hubRGB, 0.56), 1.4);
      for (let i = 0; i < 4; i++) {
        const xa = x0 + (x1 - x0) * (i / 4), xb = x0 + (x1 - x0) * ((i + 1) / 4);
        draw3DSeg(project(xa, yd, zc - hw), project(xb, yd, zc + hw), rgba(hubRGB, 0.25), 0.9);
        draw3DSeg(project(xa, yd, zc + hw), project(xb, yd, zc - hw), rgba(hubRGB, 0.25), 0.9);
      }
    };
    drawSpan(-3.70, -1.45);
    drawSpan(1.45, 3.70);
    draw3DRing(bCfg.x, bCfg.y, bCfg.z, 1.50, 1.20, 8, rgba(hubRGB, 0.90), 2.0, null, Math.PI / 8);
    draw3DRing(bCfg.x, 0.02, bCfg.z, 1.75, 1.40, 32, rgba(hubRGB, 0.42), 1.2, [8, 6], t * 0.22);
  }

  // 5. Organization Routes + Live Comet Flares
  ctx.save();
  if (!isLight) ctx.globalCompositeOperation = 'lighter';
  for (const r of view()?.routes || []) {
    const a = state.world.get(r.from), b = state.world.get(r.to);
    if (!a || !b || a.eye || b.eye) continue;
    const hot = activeId === r.from || activeId === r.to;
    const col = isBlueprint ? [150, 215, 255] : a.hex;
    const p1 = project(a.x, a.y + 0.10, a.z), p2 = project(b.x, b.y + 0.10, b.z);
    draw3DSeg(p1, p2, rgba(col, hot ? 0.90 : 0.48), hot ? 2.4 : 1.5);
    if (!state.quiet && !reduced && p1 && p2) {
      const u = (t * 0.36 + (a.order * 0.17)) % 1;
      const px = p1.x + (p2.x - p1.x) * u, py = p1.y + (p2.y - p1.y) * u;
      ctx.fillStyle = rgba([235, 255, 250], 0.92);
      ctx.beginPath(); ctx.arc(px, py, 2.2, 0, Math.PI * 2); ctx.fill();
    }
  }
  for (const fl of holoCam.flares) {
    const a = state.world.get(fl.fromId), b = state.world.get(fl.toId);
    if (!a || !b) continue;
    const u = fl.age, tu = Math.max(0, u - 0.18);
    const at = frac => project(a.x + (b.x - a.x) * frac, (a.y + 0.1) * (1 - frac) + (b.y + 0.16) * frac + Math.sin(frac * Math.PI) * 0.4, a.z + (b.z - a.z) * frac);
    const pH = at(u), pT = at(tu);
    if (pH && pT) {
      const fade = Math.sin(u * Math.PI);
      draw3DSeg(pT, pH, rgba([240, 255, 252], fade * 0.92), 2.4);
    }
  }
  ctx.restore();

  // 6. Bespoke 3D Biomimetic Sculptures & Projected Department Mission Cards
  holoCam.projectedTowers.clear();
  const sorted = departments()
    .map(d => {
      const cfg = state.world.get(d.id);
      if (!cfg) return null;
      const p = project(cfg.x, cfg.y + 0.6, cfg.z);
      return { d, cfg, depth: p ? p.z : 999 };
    })
    .filter(Boolean)
    .sort((a, b) => b.depth - a.depth);

  for (const { d, cfg } of sorted) {
    const rgb = isBlueprint ? [150, 215, 255] : cfg.hex;
    const isSel = d.id === activeId;
    const running = Boolean(countRunning(d));
    const glowA = isSel ? 0.95 : running ? 0.82 : 0.60;

    ctx.save();
    if (!isLight) ctx.globalCompositeOperation = 'lighter';
    if (!cfg.eye) {
      draw3DRing(cfg.x, cfg.y + 0.02, cfg.z, cfg.r, cfg.r, 6, rgba(rgb, glowA * 0.72), isSel ? 1.9 : 1.2, null, Math.PI / 6);
    }

    if (cfg.shape === 'eye') {
      const ePt = project(cfg.x, cfg.y + Math.sin(t * 1.4) * 0.05, cfg.z);
      if (ePt) {
        const sc = Math.max(0.65, ePt.s / 62), wE = 54 * sc, hE = 23 * sc;
        ctx.save(); ctx.translate(ePt.x, ePt.y);
        ctx.strokeStyle = rgba(rgb, 0.88); ctx.lineWidth = 1.9;
        ctx.beginPath(); ctx.moveTo(-wE, 0); ctx.quadraticCurveTo(0, -hE * 1.35, wE, 0); ctx.quadraticCurveTo(0, hE * 1.35, -wE, 0); ctx.closePath();
        ctx.fillStyle = isLight ? 'rgba(255,250,238,0.92)' : 'rgba(6, 18, 12, 0.78)'; ctx.fill(); ctx.stroke();
        const gx = Math.max(-1, Math.min(1, holoCam.gazeX / 6.2)) * wE * 0.16;
        const gy = Math.max(-0.6, Math.min(1, (holoCam.gazeZ + 2.5) / 8.0)) * hE * 0.18;
        ctx.fillStyle = rgba(rgb, 0.85); ctx.beginPath(); ctx.arc(gx, gy, hE * 0.52, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#031008'; ctx.beginPath(); ctx.arc(gx, gy, hE * 0.24, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    } else if (cfg.shape === 'helix') {
      for (let s = 0; s < 20; s++) {
        const u0 = s / 20, u1 = (s + 1) / 20;
        const a0 = u0 * Math.PI * 4.2 + t * 0.9, a1 = u1 * Math.PI * 4.2 + t * 0.9;
        const y0 = cfg.y + 0.12 + u0 * 1.35, y1 = cfg.y + 0.12 + u1 * 1.35;
        draw3DSeg(project(cfg.x + Math.cos(a0) * 0.44, y0, cfg.z + Math.sin(a0) * 0.44), project(cfg.x + Math.cos(a1) * 0.44, y1, cfg.z + Math.sin(a1) * 0.44), rgba(rgb, glowA), 1.9);
        draw3DSeg(project(cfg.x + Math.cos(a0 + Math.PI) * 0.44, y0, cfg.z + Math.sin(a0 + Math.PI) * 0.44), project(cfg.x + Math.cos(a1 + Math.PI) * 0.44, y1, cfg.z + Math.sin(a1 + Math.PI) * 0.44), rgba([180, 255, 238], glowA * 0.85), 1.7);
        if (s % 2 === 0) draw3DSeg(project(cfg.x + Math.cos(a0) * 0.44, y0, cfg.z + Math.sin(a0) * 0.44), project(cfg.x + Math.cos(a0 + Math.PI) * 0.44, y0, cfg.z + Math.sin(a0 + Math.PI) * 0.44), rgba(rgb, 0.48), 1.0);
      }
    } else if (cfg.shape === 'scales') {
      const topY = 1.08, tilt = Math.sin(t * 1.4) * 0.12;
      draw3DSeg(project(cfg.x, 0.04, cfg.z), project(cfg.x, topY, cfg.z), rgba(rgb, glowA), 2.2);
      const pL = project(cfg.x - 0.62, topY + tilt, cfg.z), pR = project(cfg.x + 0.62, topY - tilt, cfg.z);
      draw3DSeg(pL, pR, rgba([230, 220, 255], glowA), 2.0);
      draw3DSeg(pL, project(cfg.x - 0.62, topY + tilt - 0.46, cfg.z), rgba(rgb, 0.7), 1.1);
      draw3DSeg(pR, project(cfg.x + 0.62, topY - tilt - 0.46, cfg.z), rgba(rgb, 0.7), 1.1);
      draw3DRing(cfg.x - 0.62, topY + tilt - 0.48, cfg.z, 0.28, 0.28, 12, rgba(rgb, glowA), 1.5);
      draw3DRing(cfg.x + 0.62, topY - tilt - 0.48, cfg.z, 0.28, 0.28, 12, rgba(rgb, glowA), 1.5);
    } else if (cfg.shape === 'codex') {
      const by = 0.56 + Math.sin(t * 1.6) * 0.04;
      for (const side of [-1, 1]) {
        const p0 = project(cfg.x, by, cfg.z - 0.34), p1 = project(cfg.x, by, cfg.z + 0.34);
        const p2 = project(cfg.x + side * 0.68, by + 0.28, cfg.z + 0.34), p3 = project(cfg.x + side * 0.68, by + 0.28, cfg.z - 0.34);
        if (p0 && p1 && p2 && p3) {
          ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.closePath();
          ctx.fillStyle = rgba(rgb, 0.22); ctx.fill(); ctx.strokeStyle = rgba(rgb, glowA); ctx.lineWidth = 1.6; ctx.stroke();
        }
      }
    } else if (cfg.shape === 'dish') {
      draw3DSeg(project(cfg.x, 0.04, cfg.z), project(cfg.x, 0.68, cfg.z), rgba(rgb, glowA), 2.3);
      draw3DRing(cfg.x, 0.94, cfg.z, 0.68, 0.68, 20, rgba([255, 220, 180], glowA), 2.0);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + t * 0.25;
        draw3DSeg(project(cfg.x, 0.68, cfg.z), project(cfg.x + Math.cos(a) * 0.68, 0.94, cfg.z + Math.sin(a) * 0.68), rgba(rgb, 0.55), 1.0);
      }
    } else if (cfg.shape === 'gears') {
      draw3DRing(cfg.x - 0.16, 0.52, cfg.z, 0.52, 0.52, 16, rgba(rgb, glowA), 2.0, [5, 3], t * 0.6);
      draw3DRing(cfg.x + 0.32, 0.88, cfg.z, 0.34, 0.34, 12, rgba([210, 238, 255], glowA), 1.8, [4, 3], -t * 0.9);
    } else {
      // Crystal lattice / neural cluster
      const pts = [];
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2 + t * 0.35;
        const r = k === 0 ? 0 : 0.54;
        const y = 0.72 + (k === 0 ? 0.34 : Math.sin(k * 1.9 + t) * 0.24);
        pts.push(project(cfg.x + Math.cos(a) * r, y, cfg.z + Math.sin(a) * r));
      }
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          if (i === 0 || (j - i) <= 2) draw3DSeg(pts[i], pts[j], rgba(rgb, 0.56), 1.1);
        }
        if (pts[i]) { ctx.fillStyle = rgba([230, 255, 245], 0.92); ctx.beginPath(); ctx.arc(pts[i].x, pts[i].y, 2.4, 0, Math.PI * 2); ctx.fill(); }
      }
    }
    ctx.restore();

    const anchorPt = cfg.apex
      ? project(cfg.x, cfg.y + 0.72, cfg.z)
      : project(cfg.x, cfg.y - 0.06, cfg.z + cfg.r * 0.82);
    const bodyCenter = project(cfg.x, cfg.y + (cfg.eye ? 0 : 0.62), cfg.z);
    if (anchorPt && bodyCenter) {
      holoCam.projectedTowers.set(d.id, { x: bodyCenter.x, y: bodyCenter.y, r: Math.max(46, cfg.r * bodyCenter.s * 1.45) });
      const cell = state.cells.get(d.id);
      if (cell) {
        const depthScale = Math.max(0.84, Math.min(1.04, 14.5 / anchorPt.z));
        cell.button.style.left = `${anchorPt.x.toFixed(1)}px`;
        cell.button.style.top = `${anchorPt.y.toFixed(1)}px`;
        cell.button.style.zIndex = String(isSel ? 40 : Math.round(30 - anchorPt.z));
        cell.button.style.setProperty('--depth-scale', depthScale.toFixed(3));
        cell.button.classList.toggle('is-apex-label', Boolean(cfg.apex));
        cell.button.classList.add('is-projected');
      }
    }
  }
}

// ============================================================================
// HIGH-DENSITY MATRIX OPERATOR INTEL WALL (#scifi-log-stream)
// ============================================================================
const intel = { acc: 0, missionAcc: 0, cursor: 0, pktCount: 0, paused: false, hoverPaused: false, seeded: false };

function fmtMs(offset = 0) {
  const d = new Date(Date.now() + offset);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function intelTagFor(d) {
  if (isHumanDept(d)) return 'ARCH';
  if (isBridgeDept(d)) return 'CHECK';
  if (/research|core/i.test(d.id)) return 'CORE';
  if (/review|audit|qa/i.test(d.id)) return 'AUDIT';
  if (/pub|doc|paper/i.test(d.id)) return 'DOCS';
  if (/outreach|comm/i.test(d.id)) return 'SYNC';
  if (/plat|tool|studio|infra/i.test(d.id)) return 'TOOL';
  return d.id.slice(0, 5).toUpperCase();
}

function buildIntelPool() {
  const pool = [];
  const list = departments();
  const routes = view()?.routes || [];
  for (const d of list) {
    const out = routes.find(r => r.from === d.id)?.to;
    const tone = isHumanDept(d) ? 'gold' : isBridgeDept(d) ? 'cyan' : d.execution === 'sessions' ? 'live' : 'violet';
    const tag = intelTagFor(d);
    for (const m of deptMissions(d).slice(0, 3)) {
      pool.push({ tag, tone, deptId: d.id, targetId: out, text: `${d.label} ▸ ${m}` });
    }
  }
  return pool.length ? pool : [{ tag: 'BOOT', tone: 'cyan', text: 'Connecting live organization feed…' }];
}

function pushIntelLine(entry, animate = true, offset = 0) {
  const box = $('#scifi-log-stream');
  if (!box) return;
  intel.pktCount += 1;
  const pkt = $('#log-pkt-count');
  if (pkt) pkt.textContent = `PKT #${String(intel.pktCount).padStart(4, '0')}`;
  const row = element('button', '', `scifi-log-line is-${entry.tone || 'cyan'}${animate ? ' is-fresh' : ''}`);
  row.type = 'button';
  row.append(element('span', fmtMs(offset), 'log-ts'), element('span', entry.tag, 'log-tag'), element('span', entry.text, 'log-msg'));
  if (entry.deptId) row.addEventListener('click', () => previewDepartment(entry.deptId));
  box.append(row);
  while (box.children.length > 28) box.firstElementChild?.remove();
  if (animate && entry.deptId) {
    spawnHoloPulse(entry.deptId, 0.8);
    if (entry.targetId) spawnSpokeFlare(entry.deptId, entry.targetId);
  }
}

function stepIntel(dt) {
  const box = $('#scifi-log-stream');
  if (!box || !view() || /jsdom/i.test(navigator.userAgent || '')) return;
  if (!intel.seeded) {
    intel.seeded = true;
    const pool = buildIntelPool();
    for (let i = 0; i < 18; i++) pushIntelLine(pool[i % pool.length], false, -(18 - i) * 350);
    intel.cursor = 18;
  }
  const activeRun = !state.quiet && !reduced && !intel.paused && !intel.hoverPaused;
  $('#log-spectrum')?.classList.toggle('is-paused', !activeRun);
  if (!activeRun) return;

  intel.missionAcc += dt;
  if (intel.missionAcc >= 4.2) {
    intel.missionAcc = 0;
    for (const [, cell] of state.cells) {
      if (!cell.missions || cell.missions.length <= 1) continue;
      cell.missionIdx = ((cell.missionIdx || 0) + 1) % cell.missions.length;
      cell.status.textContent = cell.missions[cell.missionIdx];
    }
  }
  intel.acc += dt;
  if (intel.acc >= 0.42) {
    intel.acc = 0;
    const pool = buildIntelPool();
    pushIntelLine(pool[intel.cursor % pool.length], true);
    intel.cursor += 1;
  }
}

// ============================================================================
// UI RENDERING (Zero usernames exposed visually!)
// ============================================================================
function renderHealth() {
  const org = view()?.organization;
  if (org?.label) {
    const shortName = org.label.length > 18 ? org.label.replace(/\bOrganization\b/i, 'Org') : org.label;
    $('#brand-org').textContent = shortName.toUpperCase();
    document.title = `${org.label} // LIVE · 3D Matrix Observatory`;
  }
  $('#demo-badge').hidden = !state.isDemo;
  const conn = $('#connection');
  if (conn) {
    conn.classList.toggle('is-stale', isStale());
    conn.querySelector('span').textContent = state.isDemo ? 'Demo' : isStale() ? 'Delayed' : `${relative(view()?.observed_at)}`;
  }
  const list = departments();
  const running = list.reduce((n, d) => n + countRunning(d), 0);
  const handoffs = (view()?.handoffs || []).length;
  const metrics = $('#institute-metrics');
  if (metrics) {
    metrics.replaceChildren(
      element('span', `${list.length} sectors`),
      element('span', `${isStale() ? '—' : running} live`, 'metric-active'),
      element('span', `${handoffs} relays`)
    );
  }
  const clock = $('#board-clock');
  if (clock) {
    clock.textContent = `MATRIX CONSTRUCT // ${list.length} SECTORS · ${isStale() ? '—' : running} ACTIVE · ${handoffs} RELAYS`;
  }
}

function renderCells() {
  const container = $('#hive-cells');
  container.replaceChildren();
  state.cells.clear();
  for (const d of departments()) {
    const cfg = state.world.get(d.id) || { css: 'var(--accent)', role: executionLabels[d.execution] || 'Sector' };
    const missions = deptMissions(d);
    const run = countRunning(d);
    const btn = element('button', '', 'hive-cell is-boot-flash' + (run ? ' is-running' : ''));
    btn.type = 'button';
    btn.dataset.department = d.id;
    btn.style.setProperty('--cell-color', cfg.css);
    btn.setAttribute('aria-pressed', String(d.id === state.selected));

    const card = element('div', '', 'cell-card');
    const head = element('div', '', 'cell-head');
    head.append(element('i', '', 'cell-live-dot'));
    const ic = element('span', '', 'cell-icon');
    ic.append(svgIcon(iconFor(d)));
    head.append(ic, element('span', d.label, 'cell-title'), element('span', cfg.role, 'cell-role-tag'));
    if (run > 0) {
      const lm = element('span', '', 'cell-landmark is-visible is-live');
      lm.append(element('span', `${run} live`, 'cell-landmark-cap'));
      head.append(lm);
    }
    const meta = element('div', '', 'cell-meta-row');
    const statusEl = element('span', missions[0], 'cell-status');
    meta.append(element('span', '▸', 'cell-mission-dot'), statusEl);
    card.append(head, meta);
    btn.append(card);

    btn.addEventListener('pointerenter', () => previewDepartment(d.id));
    btn.addEventListener('click', () => selectDepartment(d.id, true, true));
    container.append(btn);
    state.cells.set(d.id, { button: btn, status: statusEl, missions, missionIdx: 0 });
  }
}

function renderMethodStrip() {
  const strip = $('#method-steps');
  if (!strip) return;
  strip.replaceChildren();
  departments().slice(0, 5).forEach((d, idx) => {
    if (idx > 0) strip.append(element('i', '⇄', 'step-arrow'));
    const btn = element('button', '', '');
    btn.type = 'button';
    btn.dataset.methodDepartment = d.id;
    btn.setAttribute('aria-pressed', String(d.id === state.selected));
    const run = countRunning(d);
    btn.append(
      element('span', isBridgeDept(d) ? 'BRIDGE' : `0${idx + 1}`, 'step-num'),
      element('strong', d.label),
      element('span', run ? `${run} live` : isHumanDept(d) ? 'steer' : 'ready', 'step-badge')
    );
    btn.addEventListener('click', () => selectDepartment(d.id, true, true));
    strip.append(btn);
  });
}

function renderPanel() {
  const d = department(state.selected) || departments()[0];
  if (!d) return;
  state.selected = d.id;
  $('#department-mode').textContent = executionLabels[d.execution] || 'Autonomous';
  $('#department-mode').dataset.execution = d.execution;
  const run = countRunning(d);
  $('#department-state').textContent = run ? `${run} running now` : isHumanDept(d) ? 'Human steering' : '24/7 standby';
  $('#department-title').textContent = d.label;
  $('#department-responsibility').textContent = d.responsibility || '';

  const work = $('#department-work');
  work.replaceChildren();
  const items = [...(d.activities || [])].sort((a, b) => Number(active(b)) - Number(active(a)) || timestamp(b.at) - timestamp(a.at)).slice(0, 6);
  $('#department-work-count').textContent = items.length ? `${items.length} active` : '';
  for (const a of items) {
    const card = element('div', '', 'work-item' + (active(a) ? ' is-active' : ''));
    const top = element('div', '', 'work-meta');
    top.append(element('span', active(a) ? 'Running' : (a.status || 'Observed'), 'work-state'), element('span', relative(a.at), 'work-time'));
    card.append(top, element('strong', a.label));
    const foot = element('div', '', 'work-bottom');
    const kindText = a.kind ? a.kind.charAt(0).toUpperCase() + a.kind.slice(1) : 'Activity';
    foot.append(element('span', kindText));
    if (a.task) {
      const btn = element('button', 'Trace relay ↗', 'work-arrow');
      btn.type = 'button';
      btn.addEventListener('click', () => selectTopic(a));
      foot.append(btn);
    } else if (a.url) {
      foot.append(external('Open ↗', a.url, 'work-arrow'));
    }
    card.append(foot);
    work.append(card);
  }
  if (!items.length) work.append(element('p', 'Standing by for incoming relays from connected sectors.', 'loading'));

  const links = $('#department-connections');
  links.replaceChildren();
  const rel = new Set((view()?.routes || []).filter(r => r.from === d.id || r.to === d.id).map(r => r.from === d.id ? r.to : r.from));
  if (rel.size) {
    links.append(element('span', 'Connected sectors', 'people-label'));
    for (const id of rel) {
      const t = department(id);
      if (!t) continue;
      const b = element('button', `${t.label} ↗`, 'connection-chip');
      b.type = 'button';
      b.addEventListener('click', () => selectDepartment(id, true, false));
      links.append(b);
    }
  }
}

function renderLens() {
  const lens = $('#department-lens'), room = $('#research-room');
  const d = department(state.focused);
  if (!d || state.mode !== 'organization') {
    lens.hidden = true;
    room.classList.remove('is-department-focused');
    return;
  }
  lens.hidden = false;
  room.classList.add('is-department-focused');
  const sw = $('#lens-switcher');
  sw.replaceChildren();
  for (const dept of departments()) {
    const p = element('button', '', 'lens-switch-pill' + (countRunning(dept) ? ' has-running' : ''));
    p.type = 'button';
    p.setAttribute('aria-selected', String(dept.id === d.id));
    p.append(element('i', '', 'lens-switch-dot'), document.createTextNode(dept.label));
    p.addEventListener('click', () => selectDepartment(dept.id, true, true));
    sw.append(p);
  }
  $('#lens-title').textContent = d.label;
  $('#lens-responsibility').textContent = d.responsibility || '';
  $('#lens-exec-pill').textContent = executionLabels[d.execution] || 'Autonomous';
  $('#lens-freshness').textContent = view()?.observed_at ? `${relative(view().observed_at)} updated` : '';
  const m = (v, l) => { const el = element('div', '', 'lens-metric'); el.append(element('strong', String(v)), element('span', l)); return el; };
  $('#lens-metrics').replaceChildren(m(countRunning(d), 'Running'), m((d.activities || []).length, 'Visible items'), m(d.observed_activities || 0, 'Recent'));

  const hub = $('#lens-hub');
  hub.replaceChildren(element('span', d.id.toUpperCase(), 'map-hub-code'), element('strong', d.label, 'map-hub-title'), element('span', countRunning(d) ? `${countRunning(d)} active` : '24/7 ready', 'map-hub-stat'));

  const routes = view()?.routes || [];
  const up = [...new Set(routes.filter(r => r.to === d.id).map(r => r.from))];
  const down = [...new Set(routes.filter(r => r.from === d.id).map(r => r.to))];
  const fillPortals = (sel, ids, arrow) => {
    const box = $(sel);
    box.replaceChildren();
    for (const id of ids) {
      const target = department(id);
      if (!target) continue;
      const b = element('button', '', 'map-portal-btn');
      b.type = 'button';
      b.append(element('span', arrow, 'portal-dir'), element('strong', target.label));
      b.addEventListener('click', () => selectDepartment(id, true, true));
      box.append(b);
    }
  };
  fillPortals('#lens-upstream', up, '← Upstream');
  fillPortals('#lens-downstream', down, 'Downstream →');

  const topics = $('#lens-topics');
  topics.replaceChildren();
  for (const a of (d.activities || []).slice(0, 4)) {
    const btn = element('button', '', 'map-topic-node' + (active(a) ? ' is-running' : ''));
    btn.type = 'button';
    btn.append(element('span', active(a) ? 'Running' : 'Observed', 'map-topic-tag'), element('strong', a.label));
    btn.addEventListener('click', () => selectTopic(a));
    topics.append(btn);
  }
  $('#lens-agents').replaceChildren();
}

function renderJourney() {
  const panel = $('#journey-panel');
  if (state.mode !== 'journey') { panel.hidden = true; return; }
  panel.hidden = false;
  const topic = state.topic || view()?.recent?.find(a => a.task) || view()?.recent?.[0];
  $('#journey-title').textContent = topic?.label || 'Active organization relay';
  const stages = $('#journey-stages');
  stages.replaceChildren();
  const tk = taskKey(topic?.task);
  const events = (view()?.recent || []).filter(a => !tk || taskKey(a.task) === tk || (a.references || []).some(r => taskKey(r) === tk));
  const touched = new Set(events.map(e => e.department));
  for (const d of departments()) {
    const s = element('div', '', 'journey-stage' + (touched.has(d.id) ? ' is-reached' : ''));
    s.append(element('strong', d.label), element('span', touched.has(d.id) ? 'Observed' : 'Standby'));
    stages.append(s);
  }
  const evBox = $('#journey-events');
  evBox.replaceChildren();
  for (const e of events.slice(0, 10)) {
    const row = element('div', '', 'journey-event');
    row.append(element('strong', `${department(e.department)?.label || e.department} · ${e.label}`), element('span', relative(e.at)));
    evBox.append(row);
  }
  const lnk = $('#journey-links');
  lnk.replaceChildren();
  if (topic?.url) lnk.append(external('Open primary thread ↗', topic.url, 'connection-chip'));
}

function renderLiveOps() {
  const recent = view()?.recent || [];
  const tick = recent[0];
  state.tickerTarget = tick || null;
  if (tick) {
    $('#ticker-text').textContent = `${department(tick.department)?.label || tick.department} · ${tick.label}`;
    $('#ticker-time').textContent = relative(tick.at);
  }
  const feed = $('#live-feed');
  if (feed) {
    feed.replaceChildren();
    const filtered = recent.filter(a => state.feedFilter === 'all' || a.kind === state.feedFilter).slice(0, 14);
    for (const a of filtered) {
      const row = element('div', '', 'feed-entry' + (active(a) ? ' is-running' : ''));
      row.append(element('strong', `${department(a.department)?.label || a.department} · ${a.label}`), element('span', relative(a.at), 'work-time'));
      feed.append(row);
    }
  }
  const checks = recent.filter(a => a.kind === 'automation');
  const runningChecks = checks.filter(active).length;
  $('#checker-summary').textContent = `${runningChecks} running`;
  const cr = $('#checker-runs');
  if (cr) {
    cr.replaceChildren();
    for (const a of checks.slice(0, 8)) {
      const row = element('div', '', 'checker-row');
      row.append(element('strong', a.label), element('span', active(a) ? 'Running' : relative(a.at)));
      cr.append(row);
    }
    if (!checks.length) cr.append(element('p', 'No automated checks recorded yet.', 'loading'));
  }
  const rb = $('#relay-bridges');
  if (rb) {
    rb.replaceChildren();
    const counts = new Map();
    for (const h of view()?.handoffs || []) {
      const k = `${h.from}->${h.to}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    for (const [k, c] of [...counts.entries()].slice(0, 8)) {
      const [f, t] = k.split('->');
      const row = element('div', '', 'bridge-row');
      row.append(element('strong', `${department(f)?.label || f} ▸ ${department(t)?.label || t}`), element('span', `${c} relays`));
      rb.append(row);
    }
    if (!counts.size) rb.append(element('p', 'Cross-department references will appear here automatically.', 'loading'));
  }
}

function previewDepartment(id) {
  if (!department(id)) return;
  state.hovered = id;
  state.selected = id;
  renderPanel();
  for (const [deptId, cell] of state.cells) cell.button.setAttribute('aria-pressed', String(deptId === id));
}

function selectDepartment(id, manual = false, zoom = false) {
  if (!department(id)) return;
  if (manual) state.follow = false;
  state.selected = id;
  state.focused = zoom ? id : null;
  state.mode = 'organization';
  updateControls();
  renderPanel();
  renderLens();
  renderJourney();
  for (const [deptId, cell] of state.cells) cell.button.setAttribute('aria-pressed', String(deptId === id));
}

function selectTopic(activity) {
  state.topic = activity;
  state.follow = false;
  state.mode = 'journey';
  state.focused = null;
  updateControls();
  renderLens();
  renderJourney();
}

function setMode(mode) {
  state.mode = mode;
  if (mode === 'journey') state.focused = null;
  updateControls();
  renderLens();
  renderJourney();
}

function updateControls() {
  for (const b of document.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
  $('#follow-live')?.setAttribute('aria-pressed', String(state.follow));
  $('#motion-toggle')?.setAttribute('aria-pressed', String(state.quiet));
  document.body.classList.toggle('quiet', state.quiet);
}

function renderAll() {
  buildDynamicWorld();
  initMatrixAndNebula();
  renderHealth();
  renderCells();
  renderMethodStrip();
  renderPanel();
  renderLens();
  renderJourney();
  renderLiveOps();
  drawHolo3DFrame(0);
}

function extractView(raw) {
  const c = raw?.schema === 'ai-org.live.v1' ? raw : raw?.organization;
  return (c?.schema === 'ai-org.live.v1' && Array.isArray(c.departments) && Array.isArray(c.recent)) ? c : null;
}

function rebaseDemoTimestamps(org) {
  const base = timestamp(org.observed_at);
  if (!Number.isFinite(base)) return org;
  const shift = Date.now() - base - 25000;
  const shiftIso = iso => Number.isFinite(timestamp(iso)) ? new Date(timestamp(iso) + shift).toISOString() : iso;
  org.observed_at = shiftIso(org.observed_at);
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
    let raw = null, demo = false;
    try {
      const res = await fetch(resolveDataURL(), { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (res.ok) raw = await res.json();
    } catch {}
    if (!raw && !state.view) {
      const res = await fetch(new URL('demo-organization.json', document.baseURI), { cache: 'no-store' });
      if (res.ok) { raw = await res.json(); demo = true; }
    }
    let org = extractView(raw);
    if (!org) throw new Error('no valid ai-org.live.v1 payload');
    if (demo) org = rebaseDemoTimestamps(org);
    state.view = org;
    state.isDemo = demo;
    for (const a of org.recent) state.seen.add(eventKey(a));
    if (!state.selected) state.selected = org.recent?.[0]?.department || org.departments[0]?.id;
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

function applyLook(look) {
  const docEl = document.documentElement;
  const btn = $('#theme-toggle');
  if (look === 'light') {
    docEl.dataset.theme = 'light'; delete docEl.dataset.look;
    if (btn) btn.textContent = '☾';
  } else if (look === 'blueprint') {
    delete docEl.dataset.theme; docEl.dataset.look = 'blueprint';
    if (btn) btn.textContent = '☀';
  } else {
    delete docEl.dataset.theme; delete docEl.dataset.look;
    if (btn) btn.textContent = '☀';
  }
  const activeLook = docEl.dataset.theme === 'light' ? 'light' : (docEl.dataset.look || 'holo');
  for (const b of document.querySelectorAll('[data-look]')) b.setAttribute('aria-pressed', String(b.dataset.look === activeLook));
  drawHolo3DFrame(0);
  triggerScanSweep();
}

function openDock(tab) {
  const dock = $('#telemetry-dock');
  if (!dock) return;
  state.dockTab = state.dockTab === tab ? null : tab;
  dock.classList.toggle('is-open', Boolean(state.dockTab));
  for (const b of document.querySelectorAll('[data-dock-tab]')) b.setAttribute('aria-selected', String(b.dataset.dockTab === state.dockTab));
  for (const p of document.querySelectorAll('[data-dock-pane]')) p.hidden = p.dataset.dockPane !== state.dockTab;
  const title = $('#dock-drawer-title');
  if (title) title.textContent = state.dockTab === 'connect' ? 'SETUP // CONNECT YOUR GITHUB ORGANIZATION' : 'TELEMETRY // LIVE CHECKS & CROSS-DEPARTMENT RELAYS';
}

function startLoop() {
  if (holoCam.raf || /jsdom/i.test(navigator.userAgent || '')) return;
  let prev = performance.now();
  const tick = now => {
    const dt = (now - prev) / 1000;
    prev = now;
    if (!document.hidden) { drawHolo3DFrame(dt); stepIntel(dt); }
    holoCam.raf = requestAnimationFrame(tick);
  };
  holoCam.raf = requestAnimationFrame(tick);
}

// Wire controls & 3D orbit drag
for (const b of document.querySelectorAll('[data-look]')) b.addEventListener('click', () => {
  applyLook(b.dataset.look);
  try { localStorage.setItem(themeKey, b.dataset.look); } catch {}
});
for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
for (const b of document.querySelectorAll('[data-dock-tab]')) b.addEventListener('click', () => openDock(b.dataset.dockTab));
for (const b of document.querySelectorAll('[data-feed-filter]')) b.addEventListener('click', () => {
  state.feedFilter = b.dataset.feedFilter;
  for (const s of document.querySelectorAll('[data-feed-filter]')) s.setAttribute('aria-pressed', String(s === b));
  renderLiveOps();
});
$('#dock-close')?.addEventListener('click', () => openDock(state.dockTab));
$('#open-lens-button')?.addEventListener('click', () => selectDepartment(state.selected, true, true));
$('#lens-back')?.addEventListener('click', () => { state.focused = null; renderLens(); });
$('#journey-back')?.addEventListener('click', () => setMode('organization'));
$('#follow-live')?.addEventListener('click', () => { state.follow = !state.follow; updateControls(); });
$('#motion-toggle')?.addEventListener('click', () => { state.quiet = !state.quiet; updateControls(); drawHolo3DFrame(0); });
$('#theme-toggle')?.addEventListener('click', () => applyLook(document.documentElement.dataset.theme === 'light' ? 'holo' : 'light'));
$('#ticker-action')?.addEventListener('click', () => { if (state.tickerTarget) selectTopic(state.tickerTarget); });
$('#log-pause-btn')?.addEventListener('click', () => {
  intel.paused = !intel.paused;
  const b = $('#log-pause-btn');
  if (b) { b.textContent = intel.paused ? 'HOLD' : 'LIVE'; b.classList.toggle('is-paused', intel.paused); }
});
$('#scifi-log-wall')?.addEventListener('pointerenter', () => { intel.hoverPaused = true; });
$('#scifi-log-wall')?.addEventListener('pointerleave', () => { intel.hoverPaused = false; });

const boardEl = $('#hive-board');
if (boardEl && !/jsdom/i.test(navigator.userAgent || '')) {
  boardEl.addEventListener('pointerdown', e => {
    if (state.focused || e.target.closest('button, a, .department-lens, .scifi-log-wall, .department-panel')) return;
    holoCam.dragging = true; holoCam.lastX = e.clientX; holoCam.lastY = e.clientY;
  });
  window.addEventListener('pointermove', e => {
    if (!holoCam.dragging) return;
    holoCam.targetYaw = Math.max(-0.58, Math.min(0.58, holoCam.targetYaw + (e.clientX - holoCam.lastX) * 0.0055));
    holoCam.targetPitch = Math.max(0.28, Math.min(0.86, holoCam.targetPitch + (e.clientY - holoCam.lastY) * 0.0045));
    holoCam.lastX = e.clientX; holoCam.lastY = e.clientY;
  }, { passive: true });
  window.addEventListener('pointerup', () => { holoCam.dragging = false; });
}

try { const saved = localStorage.getItem(themeKey); if (saved) applyLook(saved); } catch {}
updateControls();
refreshLive();
startLoop();
setInterval(() => { if (!document.hidden && !state.isDemo) refreshLive(); }, 15000);
setInterval(() => { if (!document.hidden) renderHealth(); }, 30000);
