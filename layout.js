// BPMN-Layout nach den Modellierungskonventionen (Camunda Best Practices):
//  - von links nach rechts, Hauptpfad ("Happy Path") auf einer geraden Linie
//  - Verzweigungen symmetrisch ober-/unterhalb, Gateways an den Ecken verlassen/betreten
//  - keine Linie durch ein Element; Rückschleifen laufen außen herum (innere Schleifen innen)
//  - Lanes, Pools, aufgeklappte Teilprozesse, Boundary-Events, Artefakte
//
// Eingabe:  { nodes:[{id,type,width,height,parent,lane,host,expanded,label:{width,height},members}],
//             edges:[{id,type,source,target,label:{width,height}}] }
// Ausgabe:  { shapes:{id:{x,y,width,height}}, labels:{id:{...}}, edges:{id:[{x,y}]} }

const GAP_Y = 24;
const GAP_X = 50;
const TRACK = 14;

export const isGateway = (n) => /Gateway$/.test(n.type);
export const isEvent = (n) => /Event$/.test(n.type);
export const isArtifact = (n) => /^(DataObjectReference|DataStoreReference|TextAnnotation|Group)$/.test(n.type);
export const isContainer = (n) =>
  n.type === 'Participant' || n.type === 'Lane' || (/^(SubProcess|Transaction|AdHocSubProcess)$/.test(n.type) && n.expanded !== false);
const isSub = (n) => n.type !== 'Participant' && n.type !== 'Lane' && isContainer(n);

function simplify(pts) {
  const out = [];
  for (const p of pts) {
    const q = { x: Math.round(p.x), y: Math.round(p.y) };
    const l = out[out.length - 1];
    if (l && l.x === q.x && l.y === q.y) continue;
    const k = out[out.length - 2];
    if (k && ((k.x === l.x && l.x === q.x) || (k.y === l.y && l.y === q.y))) out[out.length - 1] = q;
    else out.push(q);
  }
  return out;
}

function edgeLabelBox(pts, lb) {
  const w = lb.width, h = lb.height;
  // Kurzer Stummel und dann senkrecht: Beschriftung neben den Beginn der senkrechten Strecke
  if (pts.length > 2 && pts[0].y === pts[1].y && Math.abs(pts[0].x - pts[1].x) < 60 && pts[1].x === pts[2].x) {
    const d = pts[2].y > pts[1].y ? 1 : -1;
    return { x: pts[1].x + 6, y: d > 0 ? pts[1].y + 6 : pts[1].y - 6 - h, width: w, height: h };
  }
  // Gateway über die Ecke verlassen: Beschriftung auf die Außenseite der waagerechten Strecke
  if (pts.length > 2 && pts[0].x === pts[1].x && pts[1].y === pts[2].y && Math.abs(pts[2].x - pts[1].x) >= w + 14) {
    const d = pts[1].y > pts[0].y ? 1 : -1, r = pts[2].x > pts[1].x;
    return { x: r ? pts[1].x + 8 : pts[1].x - 8 - w, y: d > 0 ? pts[1].y + 4 : pts[1].y - h - 4, width: w, height: h };
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (a.y === b.y && Math.abs(a.x - b.x) >= w + 14) return { x: b.x > a.x ? a.x + 8 : a.x - 8 - w, y: a.y - h - 4, width: w, height: h };
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (a.x === b.x && Math.abs(a.y - b.y) >= h + 8) return { x: a.x + 6, y: (a.y + b.y) / 2 - h / 2, width: w, height: h };
  }
  const a = pts[0], b = pts[1] ?? pts[0];
  return { x: (a.x + b.x) / 2 - w / 2, y: (a.y + b.y) / 2 - h - 4, width: w, height: h };
}

function shift(res, dx, dy) {
  for (const m of [res.shapes, res.labels]) for (const b of Object.values(m)) { b.x += dx; b.y += dy; }
  for (const pts of Object.values(res.edges)) for (const p of pts) { p.x += dx; p.y += dy; }
  res.laneY = (res.laneY ?? []).map((y) => y + dy);
}
function merge(into, res, dx, dy) {
  shift(res, dx, dy);
  Object.assign(into.shapes, res.shapes);
  Object.assign(into.labels, res.labels);
  Object.assign(into.edges, res.edges);
}
function bounds(res) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const add = (x, y) => { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); };
  for (const m of [res.shapes, res.labels]) for (const b of Object.values(m)) { add(b.x, b.y); add(b.x + b.width, b.y + b.height); }
  for (const pts of Object.values(res.edges)) for (const p of pts) add(p.x, p.y);
  return x1 === Infinity ? { x: 0, y: 0, width: 0, height: 0 } : { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

// ---------- Ablauf innerhalb eines Containers (Prozess, Teilprozess, Pool) ----------
function layoutFlow(ctx, cid, lanes) {
  const all = ctx.kids.get(cid) ?? [];
  const res = { shapes: {}, labels: {}, edges: {}, laneY: [], width: 0, height: 0 };
  const flow = all.filter((n) => !isArtifact(n) && n.type !== 'BoundaryEvent' && n.type !== 'Lane' && n.type !== 'Participant');
  const sub = new Map();
  for (const n of flow) {
    if (!isSub(n)) continue;
    const r = layoutFlow(ctx, n.id, []);
    sub.set(n.id, r);
    n.width = Math.max(r.width + 60, 200);
    n.height = Math.max(r.height + 70, 120);
  }

  const N = new Map();
  for (const n of flow) {
    N.set(n.id, {
      id: n.id, n, real: true, w: n.width, h: n.height, up: n.height / 2, down: n.height / 2,
      lane: lanes.length ? Math.max(0, lanes.indexOf(n.lane)) : 0, layer: 0, y: 0, be: [], arts: [], left: [], right: [],
    });
  }
  const hostOf = new Map();
  for (const b of all) if (b.type === 'BoundaryEvent' && N.has(b.host)) { N.get(b.host).be.push(b); hostOf.set(b.id, b.host); }
  const loose = [];
  for (const a of all.filter(isArtifact)) {
    if (a.type === 'Group') continue;
    const e = ctx.edges.find((e) => e.type !== 'SequenceFlow' && e.type !== 'MessageFlow' && ((e.source === a.id && N.has(e.target)) || (e.target === a.id && N.has(e.source))));
    if (e) N.get(e.source === a.id ? e.target : e.source).arts.push(a); else loose.push(a);
  }
  for (const w of N.values()) {
    const lb = w.n.label;
    if (lb && isEvent(w.n)) w.down += lb.height + 8;
    if (lb && isGateway(w.n)) w.up += lb.height + 8;
    if (w.be.length) w.down += 22 + Math.max(0, ...w.be.map((b) => b.label?.height ?? 0));
    w.artBase = w.up;
    if (w.arts.length) w.up += 30 + Math.max(...w.arts.map((a) => a.height));
  }

  const E = [];
  for (const e of ctx.edges) {
    if (e.type !== 'SequenceFlow') continue;
    const s = hostOf.get(e.source) ?? e.source;
    if (N.has(s) && N.has(e.target) && s !== e.target) E.push({ id: e.id, s, t: e.target, via: hostOf.has(e.source) ? e.source : null, label: e.label });
  }
  const ids = [...N.keys()];
  const out = new Map(ids.map((i) => [i, []])), inn = new Map(ids.map((i) => [i, []]));
  for (const e of E) { out.get(e.s).push(e); inn.get(e.t).push(e); }

  // Rückwärtskanten (Schleifen) finden
  const back = new Set(), state = new Map();
  const dfs = (root) => {
    const stack = [[root, 0]];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1], oe = out.get(top[0]);
      if (top[1] < oe.length) {
        const e = oe[top[1]++], st = state.get(e.t) ?? 0;
        if (st === 1) back.add(e);
        else if (st === 0) { state.set(e.t, 1); stack.push([e.t, 0]); }
      } else { state.set(top[0], 2); stack.pop(); }
    }
  };
  const roots = [...ids.filter((i) => N.get(i).n.type === 'StartEvent' && !inn.get(i).length), ...ids.filter((i) => !inn.get(i).length), ...ids];
  for (const r of roots) if (!state.get(r)) dfs(r);
  const fwd = (e) => !back.has(e);

  // Spalten (längster Pfad)
  const indeg = new Map(ids.map((i) => [i, inn.get(i).filter(fwd).length]));
  const queue = ids.filter((i) => !indeg.get(i)), topo = [];
  while (queue.length) {
    const v = queue.shift();
    topo.push(v);
    for (const e of out.get(v)) {
      if (!fwd(e)) continue;
      N.get(e.t).layer = Math.max(N.get(e.t).layer, N.get(v).layer + 1);
      indeg.set(e.t, indeg.get(e.t) - 1);
      if (!indeg.get(e.t)) queue.push(e.t);
    }
  }
  for (const v of topo) {
    const fo = out.get(v).filter(fwd);
    if (!inn.get(v).filter(fwd).length && fo.length) N.get(v).layer = Math.max(0, Math.min(...fo.map((e) => N.get(e.t).layer)) - 1);
  }

  // Hauptpfad bestimmen: längster Weg, der ein echtes Ende erreicht
  const down = new Map(), up = new Map();
  for (const v of [...topo].reverse()) {
    const fo = out.get(v).filter(fwd);
    down.set(v, fo.length ? Math.max(...fo.map((e) => down.get(e.t) + 1)) : out.get(v).length ? 0 : 1000);
  }
  for (const v of topo) {
    const fi = inn.get(v).filter(fwd);
    up.set(v, fi.length ? Math.max(...fi.map((e) => up.get(e.s) + 1)) : 0);
  }
  const pick = (list, score) => {
    const c = list.filter((e) => fwd(e) && !e.via);
    if (!c.length) return { main: null, center: [] };
    const max = Math.max(...c.map(score)), tied = c.filter((e) => score(e) === max);
    const main = tied.length % 2 ? tied[(tied.length - 1) / 2] : null;
    return { main, center: main ? [main] : tied, tied };
  };
  const pOut = new Map(ids.map((v) => [v, pick(out.get(v), (e) => down.get(e.t))]));
  const pIn = new Map(ids.map((v) => [v, pick(inn.get(v), (e) => up.get(e.s))]));
  // Zusammenführung folgt demselben Zweig, den die Verzweigung als Hauptpfad gewählt hat
  const straightBack = (e) => {
    for (let cur = e, n = 0; n < 500; n++) {
      if (pOut.get(cur.s).main !== cur) return false;
      const fi = inn.get(cur.s).filter(fwd);
      if (out.get(cur.s).filter(fwd).length > 1 || fi.length !== 1) return true;
      cur = fi[0];
    }
    return false;
  };
  for (const p of pIn.values()) {
    if ((p.tied?.length ?? 0) < 2) continue;
    const st = p.tied.filter(straightBack);
    if (st.length === 1) { p.main = st[0]; p.center = st; }
  }
  const heavy = (e) => pOut.get(e.s).main === e && pIn.get(e.t).main === e;

  // Reihenfolge in den Spalten: Nebenzweige abwechselnd unter/über dem Hauptpfad
  const layers = [];
  const L = (i) => (layers[i] ??= []);
  const placed = new Set();
  const visit = (v) => {
    if (placed.has(v)) return;
    placed.add(v);
    const w = N.get(v);
    L(w.layer).push(w);
    const fo = out.get(v).filter(fwd), { center } = pOut.get(v);
    const above = [], below = [];
    fo.filter((e) => !e.via && !center.includes(e)).forEach((e, i) => (i % 2 ? above : below).push(e));
    for (const e of [...above.reverse(), ...fo.filter((e) => center.includes(e)), ...below, ...fo.filter((e) => e.via)]) {
      const t = N.get(e.t);
      e.seq = [w];
      for (let l = w.layer + 1; l < t.layer; l++) {
        const d = { id: `${e.id}#${l}`, real: false, w: 0, h: 0, up: 7, down: 7, lane: w.lane, layer: l, y: 0, left: [], right: [] };
        L(l).push(d);
        e.seq.push(d);
      }
      e.seq.push(t);
      visit(e.t);
    }
  };
  for (const r of roots) visit(r);
  for (let i = 0; i < layers.length; i++) L(i);
  if (!layers.length) layers.push([]);

  // Leere Lanes bekommen eine Mindesthöhe
  const struts = [];
  lanes.forEach((_, k) => {
    if ([...N.values()].some((w) => w.lane === k)) return;
    const st = { id: `strut${k}`, real: false, strut: true, w: 0, h: 0, up: 45, down: 45, lane: k, layer: 0, y: 0, left: [], right: [] };
    layers[0].push(st);
    struts.push(st);
  });
  const seps = [];
  for (let k = 0; k < lanes.length - 1; k++) {
    seps.push(layers.map((l, i) => {
      const s = { id: `sep${k}@${i}`, sep: k, real: false, w: 0, h: 0, up: 0, down: 0, lane: k, layer: i, y: 0, left: [], right: [] };
      l.push(s);
      return s;
    }));
  }
  const segs = [];
  for (const e of E) {
    if (!fwd(e)) continue;
    for (let i = 0; i < e.seq.length - 1; i++) {
      const a = e.seq[i], b = e.seq[i + 1];
      const tie = (!pOut.get(e.s).main && pOut.get(e.s).center.includes(e)) || (!pIn.get(e.t).main && pIn.get(e.t).center.includes(e));
      segs.push({ a, b, e, w: !a.real && !b.real ? 100 : heavy(e) ? 8 : 1, lw: tie ? 20 : heavy(e) ? 4 : 1 });
      a.right.push(b);
      b.left.push(a);
    }
  }

  // Kreuzungen minimieren (Barycenter), Lanes bleiben getrennt
  const key = (x) => x.lane * 2 + (x.sep !== undefined ? 1 : 0);
  const index = (l) => l.forEach((x, j) => (x.ord = j));
  layers.forEach((l) => { l.sort((a, b) => key(a) - key(b)); index(l); });
  const crossings = () => {
    let c = 0;
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
      const p = segs[i], q = segs[j];
      if (p.a.layer === q.a.layer && (p.a.ord - q.a.ord) * (p.b.ord - q.b.ord) < 0) c++;
    }
    return c;
  };
  let best = layers.map((l) => [...l]), bestC = crossings();
  for (let it = 0; it < 24 && bestC > 0; it++) {
    const fw = it % 2 === 0;
    for (let k = 1; k < layers.length; k++) {
      const l = layers[fw ? k : layers.length - 1 - k];
      for (const x of l) { const ns = fw ? x.left : x.right; x.bc = ns.length ? ns.reduce((s, o) => s + o.ord, 0) / ns.length : x.ord; }
      l.sort((a, b) => key(a) - key(b) || a.bc - b.bc);
      index(l);
    }
    const c = crossings();
    if (c < bestC) { bestC = c; best = layers.map((l) => [...l]); }
  }
  best.forEach((l, i) => { layers[i] = l; index(l); });

  // Gerade Ketten bilden (Hauptpfad, lange Kanten, Lane-Grenzen)
  const right = new Map(), left = new Map(), acc = layers.map(() => []);
  const align = (a, b) => {
    if (right.has(a) || left.has(b)) return;
    const g = acc[a.layer];
    if (g.some(([p, q]) => (a.ord - p.ord) * (b.ord - q.ord) < 0)) return;
    g.push([a, b]); right.set(a, b); left.set(b, a);
  };
  for (const s of seps) for (let i = 0; i < s.length - 1; i++) align(s[i], s[i + 1]);
  for (const s of segs.filter((s) => s.w > 1).sort((p, q) => q.w - p.w)) align(s.a, s.b);
  const blocks = [];
  for (const l of layers) for (const x of l) {
    if (left.has(x)) continue;
    const b = { y: 0, links: [], above: [], below: [] };
    for (let c = x; c; c = right.get(c)) c.block = b;
    blocks.push(b);
  }
  // Abstände: innerhalb einer Spalte und zwischen benachbarten Zweigen (Zweige bilden getrennte Bänder)
  const mk = (p, q) => ({ p, q, d: p.down + q.up + (p.sep !== undefined || q.sep !== undefined ? 30 : !p.real || !q.real ? 12 : GAP_Y) });
  const base = [], cross = [];
  for (const l of layers) for (let i = 0; i < l.length - 1; i++) base.push(mk(l[i], l[i + 1]));
  const byGap = layers.map(() => []);
  for (const s of segs) byGap[s.a.layer].push(s);
  for (const g of byGap) for (const p of g) for (const q of g) {
    if (p.a.ord < q.a.ord && p.b.ord < q.b.ord) {
      if (p.b.block !== q.a.block) cross.push(mk(p.b, q.a));
      if (p.a.block !== q.b.block) cross.push(mk(p.a, q.b));
    }
  }
  let cons;
  const compact = (list) => {
    cons = list;
    for (const b of blocks) { b.y = 0; b.above = []; b.below = []; }
    for (const c of cons) if (c.p.block !== c.q.block) { c.q.block.above.push(c); c.p.block.below.push(c); }
    for (let g = 0; g < 400; g++) {
      let ch = false;
      for (const c of cons) if (c.q.block.y < c.p.block.y + c.d - 1e-6) { c.q.block.y = c.p.block.y + c.d; ch = true; }
      if (!ch) return true;
    }
    return false;
  };
  if (!compact([...base, ...cross])) compact(base);
  for (const s of segs) if (s.a.block !== s.b.block) {
    const w = s.lw;
    s.a.block.links.push([s.b.block, w]);
    s.b.block.links.push([s.a.block, w]);
  }
  for (let it = 0; it < 80; it++) {
    for (const b of it % 2 ? blocks : [...blocks].reverse()) {
      if (!b.links.length) continue;
      let sw = 0, sy = 0;
      for (const [o, w] of b.links) { sw += w; sy += w * o.y; }
      const lo = Math.max(-Infinity, ...b.above.map((c) => c.p.block.y + c.d));
      const hi = Math.min(Infinity, ...b.below.map((c) => c.q.block.y - c.d));
      b.y = Math.max(lo, Math.min(hi, sy / sw));
    }
  }
  // Kleine Versätze begradigen: fast gerade Verbindungen werden exakt gerade, wenn Platz ist
  const room = (b) => [Math.max(-Infinity, ...b.above.map((c) => c.p.block.y + c.d)), Math.min(Infinity, ...b.below.map((c) => c.q.block.y - c.d))];
  for (let it = 0; it < 3; it++) {
    for (const s of [...segs].sort((p, q) => Math.abs(p.a.block.y - p.b.block.y) - Math.abs(q.a.block.y - q.b.block.y))) {
      const d = Math.abs(s.a.block.y - s.b.block.y);
      if (d < 0.5 || d > 45) continue;
      for (const [mv, to] of [[s.b.block, s.a.block.y], [s.a.block, s.b.block.y]]) {
        const [lo, hi] = room(mv);
        if (to >= lo - 1e-6 && to <= hi + 1e-6) { mv.y = to; break; }
      }
    }
  }
  for (const l of layers) for (const x of l) x.y = Math.round(x.block.y);

  // Verlauf der Vorwärtskanten planen
  const colFree = (li, self, y1, y2) => {
    const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
    return !layers[li].some((x) => x.real && x !== self && x.y - x.up - 4 < hi && x.y + x.down + 4 > lo);
  };
  const chan = layers.map(() => []);
  const topUse = new Map(); // Gateway -> obere Ecke wird verlassen ('exit') oder betreten ('entry')
  for (const e of E) {
    if (!fwd(e)) continue;
    e.plan = [];
    const k = e.seq.length - 1;
    for (let i = 0; i < k; i++) {
      const a = e.seq[i], b = e.seq[i + 1];
      let mode = 'straight';
      if (i === 0 && e.via) mode = b.y > a.y + a.h / 2 + 30 && colFree(a.layer, a, a.y + a.down + 5, b.y) ? 'beDrop' : 'beChan';
      else if (Math.abs(a.y - b.y) >= 1) {
        const far = (g) => Math.abs(a.y - b.y) >= g.h / 2 + 12;
        if (i === 0 && isGateway(a.n) && far(a) && colFree(a.layer, a, a.y, b.y)) mode = 'exit';
        else if (i === k - 1 && isGateway(b.n) && far(b) && colFree(b.layer, b, a.y, b.y)) mode = 'entry';
        else mode = 'chan';
      }
      if (mode === 'exit' && b.y < a.y) topUse.set(a.id, 'exit');
      if (mode === 'entry' && a.y < b.y && !topUse.has(b.id)) topUse.set(b.id, 'entry');
      e.plan.push(mode);
      if (mode === 'chan' || mode === 'beChan') chan[a.layer].push({ e, i, a, b, y1: mode === 'beChan' ? a.y + a.h / 2 + 32 : a.y, y2: b.y });
    }
  }
  const tracks = chan.map((items) => {
    const cnt = new Map();
    for (const it of items) if (it.b.real) cnt.set(it.b.id, (cnt.get(it.b.id) ?? 0) + 1);
    const nets = new Map();
    for (const it of items) {
      const k = it.b.real && cnt.get(it.b.id) > 1 ? `T${it.b.id}` : it.a.real && !it.e.via ? `S${it.a.id}` : it.b.real ? `T${it.b.id}` : `E${it.e.id}${it.i}`;
      const n = nets.get(k) ?? { lo: Infinity, hi: -Infinity, items: [] };
      n.lo = Math.min(n.lo, it.y1, it.y2); n.hi = Math.max(n.hi, it.y1, it.y2); n.items.push(it);
      nets.set(k, n);
    }
    const used = [];
    for (const n of [...nets.values()].sort((p, q) => p.lo - q.lo)) {
      let t = 0;
      while (used[t]?.some((o) => o.lo - 8 < n.hi && o.hi + 8 > n.lo)) t++;
      (used[t] ??= []).push(n);
      for (const it of n.items) it.track = t;
    }
    return used.length;
  });

  // X-Koordinaten
  const lw = layers.map((l) => Math.max(20, ...l.filter((x) => x.real).map((x) => x.w)));
  const xl = [0], gap = [];
  const extra = [];
  for (const w of N.values()) {
    // Platz für die Gateway-Beschriftung neben der senkrechten Linie an der oberen Ecke
    const lb = w.n.label, tu = topUse.get(w.id);
    if (!lb || !isGateway(w.n) || !tu) continue;
    const need = lb.width + 26 - lw[w.layer] / 2, i = tu === 'exit' ? w.layer - 1 : w.layer;
    if (i >= 0) extra[i] = Math.max(extra[i] ?? 0, need);
  }
  for (let i = 0; i < layers.length; i++) {
    const lab = Math.max(0, ...E.filter((e) => fwd(e) && e.label && N.get(e.s).layer === i).map((e) => Math.min(e.label.width, 120) + 24));
    gap[i] = Math.max(GAP_X, 36 + tracks[i] * TRACK, lab, extra[i] ?? 0);
    xl[i + 1] = xl[i] + lw[i] + gap[i];
  }
  const xc = (x) => xl[x.layer] + lw[x.layer] / 2;
  const tx = (i, t) => xl[i] + lw[i] + (gap[i] - (tracks[i] - 1) * TRACK) / 2 + t * TRACK;
  const corner = new Map(); // Gateway -> benutzte Ecken
  const use = (x, side) => isGateway(x.n) && corner.set(x.id, { ...(corner.get(x.id) ?? {}), [side < 0 ? 'top' : 'bottom']: true });
  const bePos = new Map();
  for (const w of N.values()) w.be.forEach((b, k) => bePos.set(b.id, { cx: xc(w) + w.w / 2 - 25 - k * 46, cy: w.y + w.h / 2, b }));

  for (const e of E) {
    if (!fwd(e)) continue;
    const pts = [], k = e.seq.length - 1, be = e.via && bePos.get(e.via);
    for (let i = 0; i < k; i++) {
      const a = e.seq[i], b = e.seq[i + 1], mode = e.plan[i], dir = b.y > a.y ? 1 : -1;
      const t = chan[a.layer].find((c) => c.e === e && c.i === i)?.track ?? 0;
      if (i === 0) {
        if (be) pts.push({ x: be.cx, y: be.cy + 18 });
        else if (mode === 'exit') { pts.push({ x: xc(a), y: a.y + (dir * a.h) / 2 }); use(a, dir); }
        else pts.push({ x: xc(a) + a.w / 2, y: a.y });
      }
      if (mode === 'exit') pts.push({ x: xc(a), y: b.y });
      else if (mode === 'beDrop') pts.push({ x: be.cx, y: b.y });
      else if (mode === 'beChan') pts.push({ x: be.cx, y: be.cy + 32 }, { x: tx(a.layer, t), y: be.cy + 32 }, { x: tx(a.layer, t), y: b.y });
      else if (mode === 'chan') pts.push({ x: tx(a.layer, t), y: a.y }, { x: tx(a.layer, t), y: b.y });
      else if (mode === 'entry') pts.push({ x: xc(b), y: a.y });
      if (i < k - 1) pts.push({ x: xc(b), y: b.y });
      else if (mode === 'entry') { pts.push({ x: xc(b), y: b.y - (dir * b.h) / 2 }); use(b, -dir); }
      else pts.push({ x: xc(b) - b.w / 2, y: b.y });
    }
    res.edges[e.id] = simplify(pts);
  }

  // Rückschleifen: außen herum, kurze Schleifen innen
  const half = (x) => (isEvent(x.n) && x.n.label ? x.n.label.width / 2 : 0); // Ereignis-Beschriftung ragt seitlich über
  const bt = { 1: [], [-1]: [] };
  const backs = E.filter((e) => !fwd(e)).map((e) => ({ e, s: N.get(e.s), t: N.get(e.t) })).sort((p, q) => p.s.layer - p.t.layer - (q.s.layer - q.t.layer));
  for (const { e, s, t } of backs) {
    let top = Infinity, bot = -Infinity;
    for (let l = t.layer; l <= s.layer; l++) for (const x of layers[l]) if (x.sep === undefined) { top = Math.min(top, x.y - x.up); bot = Math.max(bot, x.y + x.down); }
    const be = e.via && bePos.get(e.via);
    // Seite wählen: erst Kreuzungen mit anderen Schleifen vermeiden, dann der kürzere Weg
    const partial = (sd) => bt[sd].filter((k) => k.l1 <= s.layer && k.l2 >= t.layer && !(k.l1 >= t.layer && k.l2 <= s.layer) && !(t.layer >= k.l1 && s.layer <= k.l2)).length;
    const near = bot - s.y + (bot - t.y) <= s.y - top + (t.y - top) ? 1 : -1;
    const side = be ? 1 : partial(near) > partial(-near) ? -near : near;
    const x1 = xl[t.layer] - 30, x2 = xl[s.layer] + lw[s.layer] + 30;
    let y = side > 0 ? bot + 26 : top - 26;
    for (let hit; (hit = bt[side].find((k) => k.x1 < x2 && k.x2 > x1 && Math.abs(k.y - y) < 16)); ) y = hit.y + side * 16;
    bt[side].push({ x1, x2, y, l1: t.layer, l2: s.layer });
    const blocked = (x) => (side > 0 ? (isEvent(x.n) && x.n.label) || x.be.length : x.arts.length);
    const pts = [];
    if (be) pts.push({ x: be.cx, y: be.cy + 18 }, { x: be.cx, y });
    else if (!blocked(s) && colFree(s.layer, s, s.y, y)) { pts.push({ x: xc(s), y: s.y + (side * s.h) / 2 }, { x: xc(s), y }); use(s, side); }
    else { const x = Math.max(xl[s.layer] + lw[s.layer], xc(s) + half(s)) + 14; pts.push({ x: xc(s) + s.w / 2, y: s.y }, { x, y: s.y }, { x, y }); }
    if (!blocked(t) && colFree(t.layer, t, t.y, y)) { pts.push({ x: xc(t), y }, { x: xc(t), y: t.y + (side * t.h) / 2 }); use(t, side); }
    else { const x = Math.min(xl[t.layer], xc(t) - half(t)) - 14; pts.push({ x, y }, { x, y: t.y }, { x: xc(t) - t.w / 2, y: t.y }); }
    res.edges[e.id] = simplify(pts);
  }

  // Formen, Beschriftungen, Anhängsel
  for (const w of N.values()) {
    const x = xc(w) - w.w / 2, y = w.y - w.h / 2, lb = w.n.label;
    res.shapes[w.id] = { x, y, width: w.w, height: w.h };
    if (sub.has(w.id)) { const r = sub.get(w.id); merge(res, r, x + (w.w - r.width) / 2, y + 40 + (w.h - 70 - r.height) / 2); }
    if (lb && isEvent(w.n)) res.labels[w.id] = { x: xc(w) - lb.width / 2, y: w.y + w.h / 2 + 5, width: lb.width, height: lb.height };
    if (lb && isGateway(w.n)) {
      res.labels[w.id] = { x: corner.get(w.id)?.top ? (topUse.get(w.id) === 'entry' ? xc(w) + 10 : xc(w) - lb.width - 10) : w.arts.length ? xc(w) - lb.width - 10 : xc(w) - lb.width / 2, y: w.y - w.h / 2 - 6 - lb.height, width: lb.width, height: lb.height };
    }
    w.arts.forEach((a, k) => {
      const gl = lb && isGateway(w.n) ? (corner.get(w.id)?.top && topUse.get(w.id) === 'entry' ? -1 : 1) : 0; // neben die Gateway-Beschriftung, nicht darüber
      const ax = gl ? (gl > 0 ? xc(w) + 14 + k * (a.width + 20) : xc(w) - 14 - a.width - k * (a.width + 20)) : xc(w) - a.width / 2 + (k - (w.arts.length - 1) / 2) * (a.width + 50);
      const ay = w.y - w.artBase - 20 - a.height;
      res.shapes[a.id] = { x: ax, y: ay, width: a.width, height: a.height };
      if (a.label) res.labels[a.id] = { x: ax + a.width + 6, y: ay + a.height / 2 - a.label.height / 2, width: a.label.width, height: a.label.height };
    });
  }
  for (const { cx, cy, b } of bePos.values()) {
    res.shapes[b.id] = { x: cx - 18, y: cy - 18, width: 36, height: 36 };
    if (b.label) res.labels[b.id] = { x: cx - 8 - b.label.width, y: cy + 21, width: b.label.width, height: b.label.height };
  }
  for (const e of E) if (e.label && res.edges[e.id]) res.labels[e.id] = edgeLabelBox(res.edges[e.id], e.label);
  let b = bounds(res), lx = b.x;
  for (const a of loose) {
    res.shapes[a.id] = { x: lx, y: b.y - 40 - a.height, width: a.width, height: a.height };
    if (a.label) res.labels[a.id] = { x: lx + a.width + 6, y: b.y - 40 - a.height / 2 - a.label.height / 2, width: a.label.width, height: a.label.height };
    lx += a.width + 60 + (a.label?.width ?? 0);
  }
  res.laneY = seps.map((s) => s[0].y);
  for (const st of struts) res.shapes[st.id] = { x: xl[0], y: st.y - 45, width: 10, height: 90 };
  b = bounds(res);
  for (const st of struts) delete res.shapes[st.id];
  shift(res, -b.x, -b.y);
  res.width = b.width;
  res.height = b.height;
  return res;
}

// ---------- Gesamtes Diagramm ----------
export function computeLayout(graph) {
  const nodes = graph.nodes.map((n) => ({ ...n }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map();
  for (const n of nodes) {
    const p = n.parent && byId.has(n.parent) ? n.parent : '';
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(n);
  }
  const ctx = { kids, edges: graph.edges };
  const out = { shapes: {}, labels: {}, edges: {} };
  const pools = (kids.get('') ?? []).filter((n) => n.type === 'Participant');
  const poolOf = new Map();

  if (pools.length) {
    const parts = pools.map((p) => {
      const lanes = (kids.get(p.id) ?? []).filter((n) => n.type === 'Lane');
      const r = layoutFlow(ctx, p.id, lanes.map((l) => l.id));
      const empty = !Object.keys(r.shapes).length;
      const ox = 60 + (lanes.length ? 30 : 0);
      return { p, lanes, r, empty, ox, w: empty ? p.width : r.width + ox + 40, h: empty ? p.height : Math.max(r.height + 60, 120) };
    });
    const W = Math.max(...parts.map((q) => q.w));
    let y = 0;
    for (const q of parts) {
      for (const id of Object.keys(q.r.shapes)) poolOf.set(id, q.p.id);
      const ly = q.r.laneY.map((v) => v + y + 30);
      merge(out, q.r, q.ox, y + 30);
      out.shapes[q.p.id] = { x: 0, y, width: W, height: q.h };
      q.lanes.forEach((l, k) => {
        const y1 = k ? ly[k - 1] : y, y2 = k < q.lanes.length - 1 ? ly[k] : y + q.h;
        out.shapes[l.id] = { x: 30, y: y1, width: W - 30, height: y2 - y1 };
      });
      y += q.h + 70;
    }
  } else {
    merge(out, layoutFlow(ctx, '', []), 0, 0);
  }

  // Nachrichtenflüsse zwischen Pools
  const obstacles = () => Object.entries(out.shapes).filter(([id]) => byId.get(id) && !isContainer(byId.get(id)) && byId.get(id).type !== 'Group');
  let mi = 0;
  for (const e of graph.edges) {
    if (e.type !== 'MessageFlow') continue;
    const s = out.shapes[e.source], t = out.shapes[e.target];
    if (!s || !t) continue;
    const isPool = (id) => byId.get(id)?.type === 'Participant';
    const down = s.y + s.height <= t.y + 1, upw = t.y + t.height <= s.y + 1;
    if (!down && !upw) { out.edges[e.id] = [{ x: s.x + s.width / 2, y: s.y + s.height / 2 }, { x: t.x + t.width / 2, y: t.y + t.height / 2 }]; continue; }
    const dodge = (id, box, y1, y2) => {
      const lo = Math.min(y1, y2), hi = Math.max(y1, y2), c = box.x + box.width / 2;
      for (const d of [0, -30, 30, -42, 42]) {
        if (Math.abs(d) > box.width / 2 - 6) continue;
        if (!obstacles().some(([o, b]) => o !== id && b.x - 4 < c + d && b.x + b.width + 4 > c + d && b.y < hi && b.y + b.height > lo)) return c + d;
      }
      return c;
    };
    const sp = out.shapes[poolOf.get(e.source) ?? e.source], tp = out.shapes[poolOf.get(e.target) ?? e.target];
    const ys = down ? s.y + s.height : s.y, yt = down ? t.y : t.y + t.height;
    const ym = (down ? (sp.y + sp.height + tp.y) / 2 : (tp.y + tp.height + sp.y) / 2) + ((mi++ % 5) - 2) * 8;
    let xs = isPool(e.source) ? null : dodge(e.source, s, ys, ym), xt = isPool(e.target) ? null : dodge(e.target, t, yt, ym);
    xs ??= xt ?? s.x + s.width / 2 + mi * 20;
    xt ??= xs;
    out.edges[e.id] = simplify([{ x: xs, y: ys }, { x: xs, y: ym }, { x: xt, y: ym }, { x: xt, y: yt }]);
    if (e.label) out.labels[e.id] = edgeLabelBox(out.edges[e.id], e.label);
  }

  // Assoziationen / Datenassoziationen: direkte Linie zwischen den Rändern
  const clip = (b, to) => {
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2, dx = to.x - cx, dy = to.y - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const s = Math.min(dx ? b.width / 2 / Math.abs(dx) : Infinity, dy ? b.height / 2 / Math.abs(dy) : Infinity);
    return { x: Math.round(cx + dx * s), y: Math.round(cy + dy * s) };
  };
  for (const e of graph.edges) {
    if (e.type === 'SequenceFlow' || e.type === 'MessageFlow') continue;
    const s = out.shapes[e.source], t = out.shapes[e.target];
    if (!s || !t) continue;
    const cs = { x: s.x + s.width / 2, y: s.y + s.height / 2 }, ct = { x: t.x + t.width / 2, y: t.y + t.height / 2 };
    out.edges[e.id] = [clip(s, ct), clip(t, cs)];
  }
  for (const g of nodes.filter((n) => n.type === 'Group' && n.members?.length)) {
    const r = { shapes: {}, labels: {}, edges: {} };
    for (const m of g.members) { if (out.shapes[m]) r.shapes[m] = out.shapes[m]; if (out.labels[m]) r.labels[m] = out.labels[m]; }
    const b = bounds(r);
    if (b.width) out.shapes[g.id] = { x: b.x - 20, y: b.y - 30, width: b.width + 40, height: b.height + 50 };
  }

  const b = bounds(out);
  shift(out, 160 - b.x, 80 - b.y);
  const round = (o) => { for (const k of Object.keys(o)) o[k] = Math.round(o[k]); };
  Object.values(out.shapes).forEach(round);
  Object.values(out.labels).forEach(round);
  Object.values(out.edges).forEach((pts) => pts.forEach(round));
  delete out.laneY;
  return out;
}
