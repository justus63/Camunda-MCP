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
// Als Generator, damit mehrere Pools gemeinsam ausgerichtet werden können:
//  1. yield { stage: 'layers', ... }  -> der Aufrufer darf die Spalten (w.layer) der Knoten verschieben
//  2. yield { stage: 'grid', lw, gap } -> der Aufrufer gibt das (gemeinsame) Spaltenraster zurück
function layoutFlow(ctx, cid, lanes) {
  const g = flowGen(ctx, cid, lanes);
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

function* flowGen(ctx, cid, lanes) {
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
    // Ereignis mit Nachrichtenfluss nach unten: Beschriftung nach oben (bzw. seitlich), damit die Linie frei bleibt
    const ms = ctx.msg?.get(w.id);
    if (lb && isEvent(w.n)) {
      if (ms?.down && ms?.up) { w.lab = 'side'; w.up = Math.max(w.up, w.h / 2 + lb.height); }
      else if (ms?.down) { w.lab = 'top'; w.up += lb.height + 8; }
      else w.down += lb.height + 8;
    }
    if (lb && isGateway(w.n)) w.up += lb.height + 8;
    if (w.be.length) w.down += 22 + Math.max(0, ...w.be.map((b) => b.label?.height ?? 0));
    // Anmerkungen über dem Element, aber auch über den Aufgaben daneben (gleiche Mittellinie, halbe Höhe 40):
    // breite Anmerkungen an kleinen Ereignissen ragen sonst in die Nachbaraufgabe.
    w.artBase = w.arts.length ? Math.max(w.up, 48) : w.up;
    // Platz auch für die schmalere, höhere Variante (siehe Platzierung der Anmerkungen unten).
    const artH = (a) => (a.type === 'TextAnnotation' && a.width > 130 ? Math.max(a.height, Math.ceil((a.width * a.height) / 130 / 10) * 10 + 10) : a.height);
    if (w.arts.length) w.up = w.artBase + 30 + Math.max(...w.arts.map(artH));
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

  yield { stage: 'layers', N, E, fwd };

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
  // Nachrichtenflüsse verlassen den Pool senkrecht nach oben bzw. unten: alles, was in derselben Spalte darüber
  // bzw. darunter liegt (Elemente, durchlaufende Sequenzflüsse), wird gekreuzt. Solche Elemente daher an den Rand ihrer Lane ziehen.
  const msgDir = (x) => (x.real && ctx.msg ? ctx.msg.get(x.id) ?? x.be?.reduce((m, b) => ({ ...m, ...ctx.msg.get(b.id) }), undefined) : undefined);
  const msgNodes = [...N.values()].filter((x) => { const m = msgDir(x); return m && (m.up || m.down) && !(m.up && m.down); });
  const msgCost = () => {
    let c = 0;
    for (const x of msgNodes) {
      const m = msgDir(x), l = layers[x.layer];
      for (const o of l) if (o !== x && o.sep === undefined && !o.strut && (m.up ? o.ord < x.ord : o.ord > x.ord)) c += o.real ? 2 : 1;
    }
    return c;
  };
  const crossings = () => {
    let c = 0;
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
      const p = segs[i], q = segs[j];
      if (p.a.layer === q.a.layer && (p.a.ord - q.a.ord) * (p.b.ord - q.b.ord) < 0) c++;
    }
    return c + msgCost();
  };
  let best = layers.map((l) => [...l]), bestC = crossings();
  for (let it = 0; it < 24 && bestC > 0; it++) {
    const fw = it % 2 === 0;
    for (let k = 1; k < layers.length; k++) {
      const l = layers[fw ? k : layers.length - 1 - k];
      for (const x of l) {
        const ns = fw ? x.left : x.right;
        x.bc = ns.length ? ns.reduce((s, o) => s + o.ord, 0) / ns.length : x.ord;
        const m = msgDir(x);
        if (m && m.up !== m.down) x.bc += m.up ? -0.6 : 0.6; // Richtung Partner-Pool
      }
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
  const lw0 = layers.map((l) => Math.max(20, ...l.filter((x) => x.real).map((x) => x.w)));
  const gap0 = [];
  const extra = [];
  for (const w of N.values()) {
    // Platz für die Gateway-Beschriftung neben der senkrechten Linie an der oberen Ecke
    const lb = w.n.label, tu = topUse.get(w.id);
    if (!lb || !isGateway(w.n) || !tu) continue;
    const need = lb.width + 26 - lw0[w.layer] / 2, i = tu === 'exit' ? w.layer - 1 : w.layer;
    if (i >= 0) extra[i] = Math.max(extra[i] ?? 0, need);
  }
  for (const w of N.values()) if (w.lab === 'side') extra[w.layer] = Math.max(extra[w.layer] ?? 0, w.n.label.width + 16);
  for (let i = 0; i < layers.length; i++) {
    const lab = Math.max(0, ...E.filter((e) => fwd(e) && e.label && N.get(e.s).layer === i).map((e) => Math.min(e.label.width, 120) + 24));
    gap0[i] = Math.max(GAP_X, 36 + tracks[i] * TRACK, lab, extra[i] ?? 0);
  }
  const grid = (yield { stage: 'grid', lw: lw0, gap: gap0 }) ?? { lw: lw0, gap: gap0 };
  const lw = grid.lw, gap = grid.gap, xl = [0];
  for (let i = 0; i < lw.length; i++) xl[i + 1] = xl[i] + lw[i] + gap[i];
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
    const blocked = (x) => (side > 0 ? (isEvent(x.n) && x.n.label && !x.lab) || x.be.length : x.arts.length || x.lab);
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
    if (lb && isEvent(w.n)) {
      res.labels[w.id] = w.lab === 'top' ? { x: xc(w) - lb.width / 2, y: w.y - w.h / 2 - 5 - lb.height, width: lb.width, height: lb.height }
        : w.lab === 'side' ? { x: xc(w) + w.w / 2 + 4, y: w.y - w.h / 2 - lb.height + 4, width: lb.width, height: lb.height }
        : { x: xc(w) - lb.width / 2, y: w.y + w.h / 2 + 5, width: lb.width, height: lb.height };
    }
    if (lb && isGateway(w.n)) {
      res.labels[w.id] = { x: corner.get(w.id)?.top ? (topUse.get(w.id) === 'entry' ? xc(w) + 10 : xc(w) - lb.width - 10) : w.arts.length ? xc(w) - lb.width - 10 : xc(w) - lb.width / 2, y: w.y - w.h / 2 - 6 - lb.height, width: lb.width, height: lb.height };
    }
  }
  for (const { cx, cy, b } of bePos.values()) {
    res.shapes[b.id] = { x: cx - 18, y: cy - 18, width: 36, height: 36 };
    if (b.label) res.labels[b.id] = { x: cx - 8 - b.label.width, y: cy + 21, width: b.label.width, height: b.label.height };
  }
  // Anmerkungen/Datenobjekte über ihrem Element; erst wenn alles andere steht, damit sie keiner Linie und keinem Element im Weg sind.
  const segHits = (p, q, r) => {
    const n = Math.max(2, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 6));
    for (let i = 0; i <= n; i++) { const x = p.x + ((q.x - p.x) * i) / n, y = p.y + ((q.y - p.y) * i) / n; if (x > r.x && x < r.x + r.width && y > r.y && y < r.y + r.height) return true; }
    return false;
  };
  const boxHits = (r, o) => r.x < o.x + o.width && o.x < r.x + r.width && r.y < o.y + o.height && o.y < r.y + r.height;
  const clashes = (r) => {
    const g = { x: r.x - 6, y: r.y - 6, width: r.width + 12, height: r.height + 12 };
    return Object.values(res.shapes).filter((o) => boxHits(g, o)).length * 3 + Object.values(res.labels).filter((o) => boxHits(g, o)).length
      + Object.values(res.edges).filter((w) => w.some((p, i) => i < w.length - 1 && segHits(p, w[i + 1], g))).length * 2;
  };
  const free = (r) => !clashes(r);
  for (const w of N.values()) {
    const lb = w.n.label;
    w.arts.forEach((a, k) => {
      const gl = lb && isGateway(w.n) ? (corner.get(w.id)?.top && topUse.get(w.id) === 'entry' ? -1 : 1) : 0; // neben die Gateway-Beschriftung, nicht darüber
      const def = gl ? (gl > 0 ? xc(w) + 14 + k * (a.width + 20) : xc(w) - 14 - a.width - k * (a.width + 20)) : xc(w) - a.width / 2 + (k - (w.arts.length - 1) / 2) * (a.width + 50);
      const ay = w.y - w.artBase - 20 - a.height;
      // Erst in voller Breite, sonst schmaler und entsprechend höher (Text bricht dann öfter um).
      const sizes = [[a.width, a.height]];
      if (a.type === 'TextAnnotation' && a.width > 130) sizes.push([130, Math.ceil((a.width * a.height) / 130 / 10) * 10 + 10]);
      let pick = null, best = null;
      for (const [aw, ah] of sizes) {
        const y = w.y - w.artBase - 20 - ah;
        for (const x of [def, xc(w) - aw / 2, xc(w) - w.w / 2, xc(w) + w.w / 2 - aw, xc(w) + w.w / 2 + 12, xc(w) - w.w / 2 - 12 - aw]) {
          const r = { x, y, width: aw, height: ah }, c = clashes(r);
          if (!c) { pick = r; break; }
          if (!best || c < best.c) best = { r, c };
        }
        if (pick) break;
      }
      pick ??= best?.r ?? { x: def, y: ay, width: a.width, height: a.height };
      const ax = pick.x;
      res.shapes[a.id] = pick;
      if (a.label) res.labels[a.id] = { x: ax + pick.width + 6, y: pick.y + pick.height / 2 - a.label.height / 2, width: a.label.width, height: a.label.height };
    });
  }
  for (const e of E) if (e.label && res.edges[e.id]) res.labels[e.id] = edgeLabelBox(res.edges[e.id], e.label);
  // Teilen sich mehrere Ausgänge eines Elements den Anfang der Linie, lägen die Beschriftungen übereinander:
  // dann jede Beschriftung an die letzte Ecke vor ihrem Ziel setzen.
  const hits = (a, b) => a.x < b.x + b.width + 2 && b.x < a.x + a.width + 2 && a.y < b.y + b.height + 2 && b.y < a.y + a.height + 2;
  for (const v of ids) {
    const sib = out.get(v).filter((e) => res.labels[e.id]);
    if (!sib.some((a) => sib.some((b) => a !== b && hits(res.labels[a.id], res.labels[b.id])))) continue;
    for (const e of sib) {
      const pts = res.edges[e.id], n = pts.length, lb = e.label;
      if (n < 3 || pts[n - 1].y !== pts[n - 2].y || pts[n - 2].x !== pts[n - 3].x) continue;
      const c = pts[n - 2], fromAbove = pts[n - 3].y < c.y;
      res.labels[e.id] = { x: c.x - 6 - lb.width, y: fromAbove ? c.y - lb.height - 4 : c.y + 4, width: lb.width, height: lb.height };
    }
  }
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
  // Im gemeinsamen Raster bleibt x unverändert, damit die Spalten aller Pools übereinander liegen.
  shift(res, grid.shared ? 0 : -b.x, -b.y);
  res.x0 = grid.shared ? b.x : 0;
  res.width = b.width;
  res.height = b.height;
  return res;
}

// ---------- Pools: Reihenfolge und gemeinsame Spalten entlang der Nachrichtenflüsse ----------

// Pools so stapeln, dass Nachrichtenflüsse möglichst zwischen benachbarten Pools laufen.
function orderPools(pools, weight, explicit) {
  if (explicit?.length) {
    const pos = (p) => { const i = explicit.findIndex((x) => x === p.id || x === p.name); return i < 0 ? explicit.length + pools.indexOf(p) : i; };
    return [...pools].sort((a, b) => pos(a) - pos(b));
  }
  const n = pools.length;
  if (n < 3 || !weight.size) return pools;
  const w = (a, b) => weight.get(`${Math.min(a, b)}|${Math.max(a, b)}`) ?? 0;
  // Ein Nachrichtenfluss kreuzt die Sequenzflüsse jedes ausmodellierten Pools, durch den er läuft.
  // Zugeklappte Pools (schmale Black Box ohne Inhalt) kosten beim Durchqueren fast nichts.
  const pass = pools.map((p) => (p.expanded === false ? 0.05 : 1));
  const costOf = (acc) => {
    let cost = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const ww = w(acc[i], acc[j]);
      if (ww) { let between = 0; for (let k = i + 1; k < j; k++) between += pass[acc[k]]; cost += ww * (1 + between) * 1000; }
      if (acc[i] > acc[j]) cost += 1; // bei Gleichstand die ursprüngliche Reihenfolge behalten
    }
    return cost;
  };
  let best = pools.map((_, i) => i), bestCost = costOf(best);
  if (n <= 8) {
    const perm = (rest, acc) => {
      if (!rest.length) { const c = costOf(acc); if (c < bestCost) { bestCost = c; best = [...acc]; } return; }
      rest.forEach((x, i) => perm([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, x]));
    };
    perm(pools.map((_, i) => i), []);
  } else {
    // Viele Pools: Element herausnehmen und an der besten Stelle wieder einsetzen, bis sich nichts mehr verbessert.
    for (let improved = true; improved; ) {
      improved = false;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const cand = [...best]; const [x] = cand.splice(i, 1); cand.splice(j, 0, x);
        const c = costOf(cand);
        if (c < bestCost) { bestCost = c; best = cand; improved = true; }
      }
    }
  }
  return best.map((i) => pools[i]);
}

// Spalten aller Pools gemeinsam vergeben: Sequenzfluss = nächste Spalte, Nachrichtenfluss = gleiche Spalte (oder später).
function alignLayers(stages, msg) {
  const W = new Map();
  for (const st of stages) for (const [id, w] of st.N) W.set(id, w);
  const outE = new Map([...W.keys()].map((id) => [id, []])), inE = new Map([...W.keys()].map((id) => [id, []]));
  const add = (e) => { outE.get(e.s).push(e); inE.get(e.t).push(e); };
  for (const st of stages) for (const e of st.E) if (st.fwd(e)) add({ s: e.s, t: e.t, w: 1 });
  const reach = (a, b) => {
    const seen = new Set([a]), stack = [a];
    while (stack.length) {
      const v = stack.pop();
      if (v === b) return true;
      for (const e of outE.get(v)) if (!seen.has(e.t)) { seen.add(e.t); stack.push(e.t); }
    }
    return false;
  };
  const M = [];
  for (const m of [...msg].sort((p, q) => W.get(p.s).layer - W.get(q.s).layer)) {
    if (m.s === m.t || reach(m.t, m.s)) continue; // würde einen Kreis bilden: nicht ausrichten
    const e = { s: m.s, t: m.t, w: 0 };
    add(e);
    M.push(e);
  }
  if (!M.length) return;
  const indeg = new Map([...W.keys()].map((id) => [id, inE.get(id).length]));
  const queue = [...W.keys()].filter((id) => !indeg.get(id)), topo = [];
  while (queue.length) {
    const v = queue.shift();
    topo.push(v);
    for (const e of outE.get(v)) { indeg.set(e.t, indeg.get(e.t) - 1); if (!indeg.get(e.t)) queue.push(e.t); }
  }
  const L = (id) => W.get(id).layer;
  const push = () => { for (const v of topo) for (const e of outE.get(v)) if (L(e.t) < L(v) + e.w) W.get(e.t).layer = L(v) + e.w; };
  for (const w of W.values()) w.layer = 0;
  push();
  for (const v of [...topo].reverse()) {
    if (!inE.get(v).length && outE.get(v).length) W.get(v).layer = Math.max(0, Math.min(...outE.get(v).map((e) => L(e.t) - e.w)));
  }
  // Sender nach rechts schieben, wenn der Empfänger später liegt: der Nachrichtenfluss wird senkrecht
  const seq = [...W.keys()].flatMap((id) => outE.get(id).filter((e) => e.w));
  const cost = () => {
    let c = 2 * Math.max(...[...W.values()].map((w) => w.layer));
    for (const e of M) c += 4 * Math.abs(L(e.t) - L(e.s));
    for (const e of seq) c += L(e.t) - L(e.s) - 1;
    return c;
  };
  let cur = cost();
  for (let it = 0; it < 4; it++) {
    let improved = false;
    for (const e of [...M].sort((p, q) => L(p.s) - L(q.s))) {
      if (L(e.t) <= L(e.s)) continue;
      const save = new Map([...W].map(([id, w]) => [id, w.layer]));
      W.get(e.s).layer = L(e.t);
      push();
      const c = cost();
      if (c < cur) { cur = c; improved = true; } else for (const [id, l] of save) W.get(id).layer = l;
    }
    if (!improved) break;
  }
}

// ---------- Nachrichtenflüsse: senkrecht, wo es geht; sonst rechtwinklig durch den Zwischenraum, an Elementen vorbei ----------
const GAP_POOL = 70;

function routeMessages({ byId, shapes, labels, edges, pools, poolOf, msg, fixed }) {
  const res = { edges: {}, labels: {}, shifts: pools.map(() => 0) };
  if (!msg.length) return res;
  const box = (k) => shapes[pools[k].id];
  const stacked = pools.every((p, k) => !k || box(k - 1).y + box(k - 1).height <= box(k).y + 1);
  const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  if (!stacked) {
    for (const e of msg) if (shapes[e.source] && shapes[e.target]) res.edges[e.id] = [center(shapes[e.source]), center(shapes[e.target])];
    return res;
  }
  // Hindernisse: Elemente und Beschriftungen; Linien nur, wenn sie deckungsgleich verlaufen würden
  const solids = [];
  for (const [id, b] of Object.entries(shapes)) {
    const n = byId.get(id);
    if (!n || n.type === 'Group' || n.type === 'Lane') continue;
    if (n.type === 'Participant') {
      // Name eines zugeklappten Pools steht in der Mitte
      if (n.expanded === false) { const w = Math.min(b.width - 40, (n.name?.length ?? 0) * 7 + 30); solids.push({ id: `name:${id}`, x: b.x + b.width / 2 - w / 2, y: b.y, width: w, height: b.height }); }
      else solids.push({ id: `name:${id}`, x: b.x, y: b.y, width: 30, height: b.height });
      continue;
    }
    if (isContainer(n)) continue;
    solids.push({ id, ...b });
  }
  for (const [id, b] of Object.entries(labels)) solids.push({ id: `label:${id}`, owner: id, ...b });
  const vsegs = [], hsegs = [];
  const addSegs = (pts) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (a.x === b.x) vsegs.push({ x: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
      else if (a.y === b.y) hsegs.push({ y: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) });
    }
  };
  for (const pts of Object.values(edges)) addSegs(pts);
  const vFree = (x, y1, y2, skip) => {
    const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
    return !solids.some((o) => !skip?.has(o.id) && o.x - 4 < x && o.x + o.width + 4 > x && o.y < hi && o.y + o.height > lo)
      && !vsegs.some((v) => Math.abs(v.x - x) < 6 && v.lo < hi - 1 && v.hi > lo + 1);
  };
  const hFree = (y, x1, x2, skip) => {
    const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
    return !solids.some((o) => !skip?.has(o.id) && o.y - 4 < y && o.y + o.height + 4 > y && o.x < hi && o.x + o.width > lo)
      && !hsegs.some((h) => Math.abs(h.y - y) < 6 && h.lo < hi - 1 && h.hi > lo + 1);
  };
  const xMin = Math.min(...pools.map((_, k) => box(k).x)) + 40, xMax = Math.max(...pools.map((_, k) => box(k).x + box(k).width)) - 10;
  // nächstgelegene freie Stelle links/rechts von c
  const nearest = (c, test, exclude = () => false) => {
    for (let k = 1; k < 90; k++) for (const x of [c + k * 8, c - k * 8]) if (x > xMin && x < xMax && !exclude(x) && test(x)) return x;
    return null;
  };
  const isPool = (id) => byId.get(id)?.type === 'Participant';
  const border = (k, dir) => (dir > 0 ? box(k).y + box(k).height : box(k).y);
  const OFFS = [0, -10, 10, -20, 20, -30, 30, -40, 40];

  // Mögliche direkte Anschlüsse eines Elements in Richtung dir (senkrecht bis zum Poolrand frei)
  const direct = (id, dir, yb, others) => {
    const b = shapes[id], c = b.x + b.width / 2, skip = new Set([id, `label:${id}`]), yEdge = dir > 0 ? b.y + b.height : b.y;
    const xs = [...new Set([...others, ...OFFS.map((d) => c + d)])].filter((x) => Math.abs(x - c) <= b.width / 2 - 8 || x === c);
    return xs.filter((x) => vFree(x, yEdge + dir, yb, skip)).map((x) => ({ x, pts: [{ x, y: yEdge }], cost: Math.abs(x - c) / 10 }));
  };
  // Umweg: kurz heraus, seitlich in eine freie Gasse, dann zum Poolrand
  const detour = (id, dir, yb) => {
    const b = shapes[id], c = b.x + b.width / 2, skip = new Set([id, `label:${id}`]);
    for (const side of [dir, -dir]) {
      const y0 = side > 0 ? b.y + b.height : b.y;
      for (const dj of [14, 8, 20]) {
        const yJ = y0 + side * dj;
        for (const d of OFFS) {
          const xo = c + d;
          if (Math.abs(d) > b.width / 2 - 8 || !vFree(xo, y0 + side, yJ, skip)) continue;
          const x = nearest(xo, (x) => hFree(yJ, xo, x, skip) && vFree(x, yJ, yb, skip), (x) => Math.abs(x - c) < b.width / 2 + 6);
          if (x !== null) return { x, pts: [{ x: xo, y: y0 }, { x: xo, y: yJ }, { x, y: yJ }], cost: 5 + Math.abs(x - c) / 50 };
        }
      }
    }
    return null;
  };

  const horiz = []; // waagerechte Stücke in den Zwischenräumen: { gap, xTop, xBot, a, b }
  const order = (e) => Math.abs(poolOf(e.source) - poolOf(e.target)) * 1e6 + (shapes[e.source]?.x ?? 0);
  for (const e of [...msg].sort((p, q) => order(p) - order(q))) {
    const i = poolOf(e.source), j = poolOf(e.target);
    if (i === undefined || j === undefined || i === j || !shapes[e.source] || !shapes[e.target]) continue;
    const dir = j > i ? 1 : -1, ybS = border(i, dir), ybT = border(j, -dir);
    const cS = center(shapes[e.source]).x, cT = center(shapes[e.target]).x;
    let S, T;
    if (isPool(e.source) && isPool(e.target)) {
      const x = nearest(Math.max(box(i).x, box(j).x) + 100, (x) => vFree(x, ybS, ybT)) ?? box(i).x + 100;
      S = { x, pts: [{ x, y: ybS }] }; T = { x, pts: [{ x, y: ybT }] };
    } else {
      const candS = isPool(e.source) ? null : direct(e.source, dir, ybS, [cT, ...OFFS.map((d) => cT + d)]);
      const candT = isPool(e.target) ? null : direct(e.target, -dir, ybT, [cS, ...OFFS.map((d) => cS + d)]);
      const through = (x) => { for (let k = i + dir; k !== j; k += dir) if (!vFree(x, box(k).y - 1, box(k).y + box(k).height + 1)) return false; return vFree(x, ybS, ybT); };
      if (!candS) { T = candT.find((t) => through(t.x)) ?? candT[0] ?? detour(e.target, -dir, ybT) ?? { x: cT, pts: [{ x: cT, y: dir > 0 ? shapes[e.target].y : shapes[e.target].y + shapes[e.target].height }] }; S = { x: T.x, pts: [{ x: T.x, y: ybS }] }; }
      else if (!candT) { S = candS.find((t) => through(t.x)) ?? candS[0] ?? detour(e.source, dir, ybS) ?? { x: cS, pts: [{ x: cS, y: dir > 0 ? shapes[e.source].y + shapes[e.source].height : shapes[e.source].y }] }; T = { x: S.x, pts: [{ x: S.x, y: ybT }] }; }
      else {
        let best = null;
        for (const a of candS) for (const b of candT) {
          const c = a.cost + b.cost + (a.x === b.x ? (through(a.x) ? 0 : 3) : 2 + Math.abs(a.x - b.x) / 100);
          if (!best || c < best.c) best = { c, a, b };
        }
        S = best?.a ?? candS[0] ?? detour(e.source, dir, ybS) ?? { x: cS, pts: [{ x: cS, y: dir > 0 ? shapes[e.source].y + shapes[e.source].height : shapes[e.source].y }] };
        T = best?.b ?? candT[0] ?? detour(e.target, -dir, ybT) ?? { x: cT, pts: [{ x: cT, y: dir > 0 ? shapes[e.target].y : shapes[e.target].y + shapes[e.target].height }] };
      }
    }
    // Pools dazwischen an einer freien Stelle durchqueren
    const g1 = dir > 0 ? i : i - 1, g2 = dir > 0 ? j - 1 : j;
    const between = (x) => { for (let k = i + dir; k !== j; k += dir) if (!vFree(x, box(k).y - 1, box(k).y + box(k).height + 1)) return false; return true; };
    let xm = S.x;
    if (g1 !== g2 && !between(xm)) xm = between(T.x) ? T.x : nearest((S.x + T.x) / 2, between) ?? S.x;
    if (g1 === g2) xm = T.x;
    // Poolrand als Ziel/Quelle: dort anschließen, wo die Linie ohnehin ankommt
    if (isPool(e.target) && g1 !== g2) T = { x: xm, pts: [{ x: xm, y: ybT }] };
    if (isPool(e.source) && g1 !== g2) S = { x: xm, pts: [{ x: xm, y: ybS }] };
    const mid = [];
    const jog = (gap, xa, xb) => {
      if (xa === xb) return;
      const h = { gap, xTop: dir > 0 ? xa : xb, xBot: dir > 0 ? xb : xa, a: { x: xa, gap }, b: { x: xb, gap } };
      horiz.push(h);
      mid.push(h.a, h.b);
    };
    jog(g1, S.x, xm);
    if (g1 !== g2) jog(g2, xm, T.x);
    const pts = [...S.pts.map((p) => ({ ...p, pool: i })), ...mid, ...[...T.pts].reverse().map((p) => ({ ...p, pool: j }))];
    res.edges[e.id] = pts;
    // vorläufig eintragen, damit spätere Flüsse nicht deckungsgleich verlaufen
    const yGap = (g) => (box(g).y + box(g).height + box(g + 1).y) / 2;
    addSegs(simplify(pts.map((p) => ({ x: p.x, y: p.gap !== undefined ? yGap(p.gap) : p.y }))));
  }

  // Waagerechte Stücke je Zwischenraum auf Spuren verteilen (so, dass sie sich möglichst nicht kreuzen)
  const need = pools.map(() => GAP_POOL);
  const trackY = new Map();
  for (let g = 0; g < pools.length - 1; g++) {
    const hs = horiz.filter((h) => h.gap === g);
    const key = (h) => (h.xTop < h.xBot ? [0, -h.xTop] : [1, h.xTop]);
    hs.sort((p, q) => key(p)[0] - key(q)[0] || key(p)[1] - key(q)[1]);
    const used = [];
    for (const h of hs) {
      const lo = Math.min(h.xTop, h.xBot) - 10, hi = Math.max(h.xTop, h.xBot) + 10;
      let t = 0;
      while (used[t]?.some((o) => o.lo < hi && o.hi > lo)) t++;
      (used[t] ??= []).push({ lo, hi });
      h.track = t;
    }
    const n = used.length, have = box(g + 1).y - (box(g).y + box(g).height);
    const step = fixed ? Math.min(12, Math.max(4, (have - 24) / Math.max(1, n - 1))) : 12;
    if (!fixed) need[g] = Math.max(GAP_POOL, 44 + 12 * Math.max(0, n - 1));
    for (const h of hs) trackY.set(h, { step, n });
  }
  if (!fixed) for (let k = 1; k < pools.length; k++) res.shifts[k] = res.shifts[k - 1] + need[k - 1] - (box(k).y - (box(k - 1).y + box(k - 1).height));
  const top = (g) => box(g).y + box(g).height + res.shifts[g], bottom = (g) => box(g + 1).y + res.shifts[g + 1];
  for (const h of horiz) {
    const { step, n } = trackY.get(h);
    const y = Math.round((top(h.gap) + bottom(h.gap)) / 2 - ((n - 1) * step) / 2 + h.track * step);
    h.a.y = y; h.b.y = y;
  }
  const placed = [];
  const hit = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  for (const e of msg) {
    const raw = res.edges[e.id];
    if (!raw || raw[0].y === undefined) continue;
    const pts = simplify(raw.map((p) => ({ x: p.x, y: p.pool !== undefined ? p.y + res.shifts[p.pool] : p.y })));
    res.edges[e.id] = pts;
    if (!e.label?.width || !raw.some((p) => p.pool !== undefined)) continue;
    // Beschriftung in den Zwischenraum direkt hinter dem Sender
    const i = poolOf(e.source), dir = poolOf(e.target) > i ? 1 : -1, g = dir > 0 ? i : i - 1;
    const w = e.label.width, h = e.label.height, y1 = top(g) + 3, y2 = bottom(g) - 3 - h;
    const hz = horiz.find((s) => s.gap === g && (s.a === raw.find((p) => p.gap === g)));
    const x0 = raw.filter((p) => p.pool === i).pop()?.x ?? raw[0].x, cands = [];
    if (hz && Math.abs(hz.xTop - hz.xBot) >= w + 14) cands.push({ x: Math.min(hz.a.x, hz.b.x) + 8, y: hz.a.y - h - 3 });
    for (let y = y1; y <= y2; y += 8) cands.push({ x: x0 + 6, y }, { x: x0 - 6 - w, y });
    const others = Object.entries(res.edges).filter(([id]) => id !== e.id).map(([, p]) => p);
    const ok = (c) => !placed.some((o) => hit({ ...c, width: w, height: h }, o))
      && !others.some((p) => p.some((a, k) => k < p.length - 1 && a.y !== undefined && hit({ ...c, width: w, height: h }, { x: Math.min(a.x, p[k + 1].x) - 2, y: Math.min(a.y, p[k + 1].y) - 2, width: Math.abs(a.x - p[k + 1].x) + 4, height: Math.abs(a.y - p[k + 1].y) + 4 })));
    const c = cands.find(ok) ?? cands[0];
    if (c) { res.labels[e.id] = { x: c.x, y: c.y, width: w, height: h }; placed.push(res.labels[e.id]); }
  }
  return res;
}

// Nur die Nachrichtenflüsse neu verlegen; alle Elemente und übrigen Linien bleiben, wo sie sind.
function rerouteMessages(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const shapes = {}, labels = {}, edges = {};
  for (const n of graph.nodes) {
    if (n.x === undefined) continue;
    shapes[n.id] = { x: n.x, y: n.y, width: n.width, height: n.height };
    if (n.label?.x !== undefined && n.name) labels[n.id] = n.label;
  }
  const msg = graph.edges.filter((e) => e.type === 'MessageFlow');
  for (const e of graph.edges) {
    if (e.type === 'MessageFlow') continue;
    if (e.waypoints?.length > 1) edges[e.id] = e.waypoints;
    if (e.label?.x !== undefined && e.name) labels[e.id] = e.label;
  }
  const pools = graph.nodes.filter((n) => n.type === 'Participant' && shapes[n.id]).sort((a, b) => a.y - b.y);
  const idx = new Map(pools.map((p, k) => [p.id, k]));
  const poolOf = (id) => { for (let n = byId.get(id); n; n = byId.get(n.parent)) if (idx.has(n.id)) return idx.get(n.id); return undefined; };
  const r = routeMessages({ byId, shapes, labels, edges, pools, poolOf, msg, fixed: true });
  const out = { shapes: {}, labels: r.labels, edges: r.edges };
  const round = (o) => { for (const k of Object.keys(o)) o[k] = Math.round(o[k]); };
  Object.values(out.labels).forEach(round);
  Object.values(out.edges).forEach((pts) => pts.forEach(round));
  return out;
}

// ---------- Gesamtes Diagramm ----------
// opts.only = 'messageFlows': nur Nachrichtenflüsse neu verlegen (manuelle Anordnung bleibt erhalten)
// opts.poolOrder = [IDs oder Namen]: Reihenfolge der Pools von oben nach unten (sonst automatisch nach Nachrichtenflüssen)
// opts.align = false: Pools nicht aneinander ausrichten (jeder Pool für sich, wie früher)
export function computeLayout(graph, opts = {}) {
  if (opts.only === 'messageFlows') return rerouteMessages(graph);
  const nodes = graph.nodes.map((n) => ({ ...n }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Anmerkungen/Datenobjekte gehören in einer Kollaboration oft zur Kollaboration selbst (kein parent):
  // für das Layout dem Container des verknüpften Elements zuordnen, sonst bleiben sie liegen, wo sie waren.
  for (const a of nodes) {
    if (a.parent || !isArtifact(a) || a.type === 'Group') continue;
    const e = graph.edges.find((e) => e.type !== 'SequenceFlow' && e.type !== 'MessageFlow' && (e.source === a.id || e.target === a.id));
    const other = e && byId.get(e.source === a.id ? e.target : e.source);
    if (other?.parent) a.parent = other.parent;
  }
  const kids = new Map();
  for (const n of nodes) {
    const p = n.parent && byId.has(n.parent) ? n.parent : '';
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(n);
  }
  const ctx = { kids, edges: graph.edges, msg: new Map() };
  const out = { shapes: {}, labels: {}, edges: {} };
  let pools = (kids.get('') ?? []).filter((n) => n.type === 'Participant');
  const msg = graph.edges.filter((e) => e.type === 'MessageFlow');

  if (pools.length) {
    const poolIdOf = (id) => { for (let n = byId.get(id); n; n = byId.get(n.parent)) if (n.type === 'Participant') return n.id; return undefined; };
    const weight = new Map();
    const orig = new Map(pools.map((p, i) => [p.id, i]));
    for (const e of msg) {
      const a = orig.get(poolIdOf(e.source)), b = orig.get(poolIdOf(e.target));
      if (a === undefined || b === undefined || a === b) continue;
      const k = `${Math.min(a, b)}|${Math.max(a, b)}`;
      weight.set(k, (weight.get(k) ?? 0) + 1);
    }
    pools = orderPools(pools, weight, opts.poolOrder);
    const idx = new Map(pools.map((p, k) => [p.id, k]));
    const poolOf = (id) => idx.get(poolIdOf(id));
    // Wohin laufen die Nachrichtenflüsse eines Elements (für die Lage der Ereignis-Beschriftungen)?
    for (const e of msg) {
      const a = poolOf(e.source), b = poolOf(e.target);
      if (a === undefined || b === undefined || a === b) continue;
      for (const [id, down] of [[e.source, b > a], [e.target, a > b]]) {
        const m = ctx.msg.get(id) ?? {};
        m[down ? 'down' : 'up'] = true;
        ctx.msg.set(id, m);
      }
    }
    const parts = pools.map((p) => {
      const lanes = (kids.get(p.id) ?? []).filter((n) => n.type === 'Lane');
      return { p, lanes, gen: flowGen(ctx, p.id, lanes.map((l) => l.id)), ox: 60 + (lanes.length ? 30 : 0) };
    });
    const stages = parts.map((q) => q.gen.next().value);
    if (opts.align !== false) {
      const top = (id, k) => {
        let n = byId.get(id);
        if (n?.type === 'BoundaryEvent') n = byId.get(n.host) ?? n;
        while (n && !stages[k].N.has(n.id)) n = byId.get(n.parent);
        return n?.id;
      };
      const M = [];
      for (const e of msg) {
        const a = poolOf(e.source), b = poolOf(e.target);
        if (a === undefined || b === undefined || a === b) continue;
        const s = top(e.source, a), t = top(e.target, b);
        if (s && t) M.push({ s, t });
      }
      alignLayers(stages, M);
    }
    const grids = parts.map((q) => q.gen.next().value);
    const len = Math.max(...grids.map((g) => g.lw.length));
    const shared = { shared: true, lw: [], gap: [] };
    for (let i = 0; i < len; i++) {
      shared.lw[i] = Math.max(...grids.map((g) => g.lw[i] ?? 20));
      shared.gap[i] = Math.max(...grids.map((g) => g.gap[i] ?? GAP_X));
    }
    for (const q of parts) {
      q.r = q.gen.next(opts.align !== false ? shared : { ...grids[parts.indexOf(q)], shared: true }).value;
      q.empty = !Object.keys(q.r.shapes).length;
      q.h = q.empty ? q.p.height : Math.max(q.r.height + 60, 120);
    }
    const full = parts.filter((q) => !q.empty);
    const OX = Math.max(60, ...full.map((q) => q.ox));
    const x1 = full.length ? Math.min(...full.map((q) => q.r.x0)) : 0, x2 = full.length ? Math.max(...full.map((q) => q.r.x0 + q.r.width)) : 0;
    const X = x1 - OX, W = Math.max(x2 - x1 + OX + 40, ...parts.filter((q) => q.empty).map((q) => (full.length ? 0 : q.p.width)), 300);
    const owner = new Map(); // Element/Verbindung -> Pool-Index
    let y = 0;
    parts.forEach((q, k) => {
      for (const id of [...Object.keys(q.r.shapes), ...Object.keys(q.r.edges), ...Object.keys(q.r.labels)]) owner.set(id, k);
      const ly = q.r.laneY.map((v) => v + y + 30);
      merge(out, q.r, 0, y + 30);
      out.shapes[q.p.id] = { x: X, y, width: W, height: q.h };
      owner.set(q.p.id, k);
      q.lanes.forEach((l, n) => {
        const y1 = n ? ly[n - 1] : y, y2 = n < q.lanes.length - 1 ? ly[n] : y + q.h;
        out.shapes[l.id] = { x: X + 30, y: y1, width: W - 30, height: y2 - y1 };
        owner.set(l.id, k);
      });
      y += q.h + GAP_POOL;
    });
    const r = routeMessages({ byId, shapes: out.shapes, labels: out.labels, edges: out.edges, pools, poolOf, msg });
    for (const [id, k] of owner) {
      const dy = r.shifts[k];
      if (!dy) continue;
      if (out.shapes[id]) out.shapes[id].y += dy;
      if (out.labels[id]) out.labels[id].y += dy;
      if (out.edges[id]) for (const p of out.edges[id]) p.y += dy;
    }
    Object.assign(out.edges, r.edges);
    Object.assign(out.labels, r.labels);
  } else {
    merge(out, layoutFlow(ctx, '', []), 0, 0);
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

  straighten(out, graph);
  separateOverlaps(out, graph);
  const b = bounds(out);
  shift(out, 160 - b.x, 80 - b.y);
  const round = (o) => { for (const k of Object.keys(o)) o[k] = Math.round(o[k]); };
  Object.values(out.shapes).forEach(round);
  Object.values(out.labels).forEach(round);
  Object.values(out.edges).forEach((pts) => pts.forEach(round));
  delete out.laneY;
  return out;
}

// Kleine Stufen (≤ STEP px zwischen zwei parallelen Segmenten) begradigen: die Punkte hinter (bzw. vor) der Stufe
// werden um den Versatz verschoben, solange der End- bzw. Anfangspunkt auf dem Rand des Ziel- bzw. Quellelements bleibt.
const STEP = 10;
function straighten(out, graph) {
  const box = (id) => out.shapes[id] ?? graph.nodes.find((n) => n.id === id);
  const within = (p, b, axis) => b && (axis === 'y' ? p.y >= b.y - 0.5 && p.y <= b.y + b.height + 0.5 : p.x >= b.x - 0.5 && p.x <= b.x + b.width + 0.5);
  for (const e of graph.edges) {
    let w = out.edges[e.id];
    if (!w || w.length < 4) continue;
    for (let guard = 0, changed = true; changed && guard < 10; guard++) {
      changed = false;
      for (let i = 1; i < w.length - 2; i++) {
        const [a, p, c, d] = [w[i - 1], w[i], w[i + 1], w[i + 2]];
        let axis, off;
        if (a.y === p.y && p.x === c.x && c.y === d.y && c.y !== p.y && Math.abs(c.y - p.y) <= STEP && (p.x - a.x) * (d.x - c.x) > 0) [axis, off] = ['y', c.y - p.y];
        else if (a.x === p.x && p.y === c.y && c.x === d.x && c.x !== p.x && Math.abs(c.x - p.x) <= STEP && (p.y - a.y) * (d.y - c.y) > 0) [axis, off] = ['x', c.x - p.x];
        else continue;
        const back = w.map((q, j) => (j > i ? { ...q, [axis]: q[axis] - off } : { ...q }));
        const front = w.map((q, j) => (j <= i ? { ...q, [axis]: q[axis] + off } : { ...q }));
        const next = within(back.at(-1), box(e.target), axis) ? back : within(front[0], box(e.source), axis) ? front : null;
        if (!next) continue;
        const dedup = next.filter((q, j) => !j || q.x !== next[j - 1].x || q.y !== next[j - 1].y);
        w = dedup.filter((q, j) => j === 0 || j === dedup.length - 1 || !((dedup[j - 1].x === q.x && q.x === dedup[j + 1].x) || (dedup[j - 1].y === q.y && q.y === dedup[j + 1].y)));
        changed = true;
        break;
      }
    }
    out.edges[e.id] = w;
  }
}

// Liegen zwei Verbindungen ein Stück übereinander (gleicher Kanal), ist nicht mehr zu erkennen, welche wohin führt.
// Dann einen inneren Abschnitt einer der beiden seitlich verschieben – Anfang und Ende bleiben, der Verlauf bleibt rechtwinklig.
// Gewählt wird die Verschiebung mit den wenigsten neuen Kreuzungen, die durch kein Element läuft.
function separateOverlaps(out, graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const E = graph.edges.filter((e) => (e.type === 'SequenceFlow' || e.type === 'MessageFlow') && out.edges[e.id]?.length > 1);
  const solid = Object.entries(out.shapes).filter(([id]) => { const n = byId.get(id); return n && !isContainer(n) && n.type !== 'Group'; });
  const inside = (r, p) => p.x > r.x + 2 && p.x < r.x + r.width - 2 && p.y > r.y + 2 && p.y < r.y + r.height - 2;
  const hitsBox = (a, b, r) => { const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4)); for (let i = 0; i <= n; i++) if (inside(r, { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n })) return true; return false; };
  const cross = (a, b, c, d) => { const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)); return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0; };
  const over = (a, b, c, d) => {
    for (const [u, v] of [['x', 'y'], ['y', 'x']]) {
      if (a[u] === b[u] && c[u] === d[u] && Math.abs(a[u] - c[u]) < 1) {
        const lo = Math.max(Math.min(a[v], b[v]), Math.min(c[v], d[v])), hi = Math.min(Math.max(a[v], b[v]), Math.max(c[v], d[v]));
        if (hi - lo > 6) return true;
      }
    }
    return false;
  };
  const shared = (p, q) => p.source === q.source || p.target === q.target || p.source === q.target || p.target === q.source;
  // Kosten einer Linienführung w für Verbindung e gegenüber allen anderen
  const cost = (e, w) => {
    let c = 0;
    for (const [id, r] of solid) if (id !== e.source && id !== e.target && byId.get(e.source)?.host !== id && w.some((p, i) => i < w.length - 1 && hitsBox(p, w[i + 1], r))) c += 1000;
    for (const [id, r] of Object.entries(out.labels)) if (id !== e.id && w.some((p, i) => i < w.length - 1 && hitsBox(p, w[i + 1], r))) c += 20;
    for (let i = 0; i < w.length - 1; i++) { const len = Math.abs(w[i + 1].x - w[i].x) + Math.abs(w[i + 1].y - w[i].y); if (len > 0 && len <= STEP) c += 30; } // kein neuer Knick
    for (const f of E) {
      if (f === e) continue;
      const v = out.edges[f.id], sh = shared(e, f);
      for (let i = 0; i < w.length - 1; i++) for (let j = 0; j < v.length - 1; j++) {
        if (cross(w[i], w[i + 1], v[j], v[j + 1])) c += 1;
        if (!sh && over(w[i], w[i + 1], v[j], v[j + 1])) c += 50;
      }
    }
    return c;
  };
  const overlapping = (e) => E.some((f) => f !== e && !shared(e, f) && out.edges[e.id].some((p, i, w) => i < w.length - 1 && out.edges[f.id].some((q, j, v) => j < v.length - 1 && over(p, w[i + 1], q, v[j + 1]))));
  const crossing = (e) => E.some((f) => f !== e && out.edges[e.id].some((p, i, w) => i < w.length - 1 && out.edges[f.id].some((q, j, v) => j < v.length - 1 && cross(p, w[i + 1], q, v[j + 1]))));
  const hitting = (e) => solid.some(([id, r]) => id !== e.source && id !== e.target && byId.get(e.source)?.host !== id && out.edges[e.id].some((p, i, w) => i < w.length - 1 && hitsBox(p, w[i + 1], r)));
  for (let round = 0; round < 3; round++) {
    let changed = false;
    for (const e of E) {
      if (!overlapping(e) && !crossing(e) && !hitting(e)) continue;
      const w = out.edges[e.id];
      let best = { c: cost(e, w), w: null };
      for (let i = 1; i < w.length - 2; i++) {
        const vert = w[i].x === w[i + 1].x, horiz = w[i].y === w[i + 1].y;
        if (!vert && !horiz) continue;
        const k = vert ? 'x' : 'y';
        // feste Schritte oder Einrasten auf den parallelen Nachbarabschnitt (entfernt eine Stufe ganz)
        const snaps = [w[i - 1][k] - w[i][k], w[i + 2][k] - w[i][k]].filter((d) => d && Math.abs(d) <= 60);
        for (const d of [...snaps, 10, -10, 20, -20, 30, -30, 45, -45]) {
          const moved = w.map((p, j) => (j === i || j === i + 1 ? { ...p, [k]: p[k] + d } : { ...p }));
          const dd = moved.filter((p, j) => !j || p.x !== moved[j - 1].x || p.y !== moved[j - 1].y);
          const cand = dd.filter((p, j) => j === 0 || j === dd.length - 1 || !((dd[j - 1].x === p.x && p.x === dd[j + 1].x) || (dd[j - 1].y === p.y && p.y === dd[j + 1].y)));
          if (cand.length < 2) continue;
          const c = cost(e, cand) + Math.abs(d) / 100; // bei Gleichstand die kleinere Verschiebung
          if (c < best.c) best = { c, w: cand };
        }
      }
      if (best.w) { out.edges[e.id] = best.w; changed = true; }
    }
    if (!changed) break;
  }
}
