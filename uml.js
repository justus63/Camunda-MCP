// UML-Diagramme aus einer Beschreibung: Klassendiagramm (Domänenmodell) und Zustandsdiagramm (Objektlebenszyklus).
// Ergebnis jeweils { svg, drawio, problems }: SVG zum Ansehen/Exportieren (PDF/PNG macht headless.js), draw.io-XML zum Weiterbearbeiten.
// Die Anordnung ist deterministisch (fester Zufallsstartwert), d. h. dieselbe Beschreibung ergibt immer dasselbe Bild.
import { computeLayout } from './layout.js';

const INK = '#1f2d3d', HEAD = '#dbe9f4', MUTED = '#4a5563', NOTE = '#fff8dc';
const FONT = 'Helvetica, Arial, sans-serif';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function textWidth(str, size = 13, bold = false) {
  let w = 0;
  for (const ch of String(str)) {
    if ("iljtfrI.,:;|!'()[] ".includes(ch)) w += 0.31;
    else if ('mwMW@%'.includes(ch)) w += 0.87;
    else if ((ch >= 'A' && ch <= 'Z') || 'ÄÖÜ'.includes(ch)) w += 0.68;
    else w += 0.55;
  }
  return w * size * (bold ? 1.07 : 1);
}
function wrap(text, max) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let cur = '';
    for (const word of para.split(/\s+/)) {
      if (cur && (cur + ' ' + word).length > max) { lines.push(cur); cur = word; } else cur = cur ? cur + ' ' + word : word;
    }
    lines.push(cur);
  }
  return lines;
}
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// ---------- Geometrie ----------
const hitsBox = (a, b, o, pad = 6) => Math.min(a.x, b.x) < o.x + o.w + pad && Math.max(a.x, b.x) > o.x - pad && Math.min(a.y, b.y) < o.y + o.h + pad && Math.max(a.y, b.y) > o.y - pad;
function crosses(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
function overlaps(a, b, c, d) {
  for (const [u, v] of [['x', 'y'], ['y', 'x']]) {
    if (a[u] === b[u] && c[u] === d[u] && Math.abs(a[u] - c[u]) < 8) {
      if (Math.min(Math.max(a[v], b[v]), Math.max(c[v], d[v])) - Math.max(Math.min(a[v], b[v]), Math.min(c[v], d[v])) > 6) return true;
    }
  }
  return false;
}
const segs = (pts) => pts.slice(1).map((p, i) => [pts[i], p]);
const clean = (pts) => pts.filter((p, i) => !i || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y);

// ---------- Klassendiagramm: Anordnung im Raster ----------
function placeClasses(classes, rels) {
  const n = classes.length;
  const fixed = classes.filter((c) => Number.isInteger(c.col) && Number.isInteger(c.row));
  const cols = Math.max(Math.ceil(Math.sqrt(n) * 1.3), 2, ...fixed.map((c) => c.col + 1));
  const rows = Math.max(Math.ceil(n / cols) + 1, 2, ...fixed.map((c) => c.row + 1));
  const R = rels.map((r) => ({ a: r.a.i, b: r.b.i, type: r.type }));
  const deg = classes.map((c) => R.filter((r) => r.a === c.i || r.b === c.i).length);
  const cost = (pos) => {
    const cell = new Map(pos.map((p, i) => [`${p.c},${p.r}`, i]));
    const used = (c, r) => cell.has(`${c},${r}`);
    let k = 0, c1 = Infinity, c2 = -Infinity, r1 = Infinity, r2 = -Infinity;
    for (const p of pos) { c1 = Math.min(c1, p.c); c2 = Math.max(c2, p.c); r1 = Math.min(r1, p.r); r2 = Math.max(r2, p.r); }
    k += (c2 - c1 + 1) * (r2 - r1 + 1) * 0.1 + (r2 - r1 > c2 - c1 ? 1.5 : 0);
    for (const e of R) {
      const p = pos[e.a], q = pos[e.b], dc = Math.abs(p.c - q.c), dr = Math.abs(p.r - q.r);
      k += dc + dr + (dc && dr ? 0.7 : 0);
      if (!dc) for (let r = Math.min(p.r, q.r) + 1; r < Math.max(p.r, q.r); r++) if (used(p.c, r)) k += 8;
      if (!dr) for (let c = Math.min(p.c, q.c) + 1; c < Math.max(p.c, q.c); c++) if (used(c, p.r)) k += 8;
      if (dc && dr && used(p.c, q.r) && used(q.c, p.r)) k += 2;
      if (e.type === 'generalization') k += p.r <= q.r ? 10 : (p.r - q.r - 1) * 0.6 + dc * 0.3; // Unterklasse unter die Oberklasse
      if ((e.type === 'composition' || e.type === 'aggregation') && q.r < p.r) k += 1.5; // Teile nicht über das Ganze
    }
    for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) {
      const a = pos[R[i].a], b = pos[R[i].b], c = pos[R[j].a], d = pos[R[j].b];
      if (crosses({ x: a.c, y: a.r }, { x: b.c, y: b.r }, { x: c.c, y: c.r }, { x: d.c, y: d.r })) k += 3;
    }
    return k;
  };
  let best = null, bestCost = Infinity;
  for (let run = 0; run < 5; run++) {
    const rand = rng(12345 + run * 977);
    const pos = classes.map(() => null), taken = new Set();
    for (const c of fixed) { pos[c.i] = { c: c.col, r: c.row }; taken.add(`${c.col},${c.row}`); }
    // Start: stark vernetzte Klassen zuerst, reihenweise
    const order = classes.filter((c) => !pos[c.i]).sort((a, b) => deg[b.i] - deg[a.i] || a.i - b.i);
    const free = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (!taken.has(`${c},${r}`)) free.push({ c, r });
    if (run) free.sort(() => rand() - 0.5);
    order.forEach((c, k) => { pos[c.i] = free[k]; });
    let cur = cost(pos);
    const movable = classes.filter((c) => !fixed.includes(c)).map((c) => c.i);
    for (let it = 0; movable.length && it < 2500 + 500 * n; it++) {
      const i = movable[Math.floor(rand() * movable.length)];
      const t = { c: Math.floor(rand() * cols), r: Math.floor(rand() * rows) };
      const j = pos.findIndex((p) => p.c === t.c && p.r === t.r);
      if (j === i || (j >= 0 && !movable.includes(j))) continue;
      const old = pos[i];
      pos[i] = t;
      if (j >= 0) pos[j] = old;
      const c = cost(pos);
      if (c < cur - 1e-9 || (c < cur + 1e-9 && rand() < 0.3)) cur = c;
      else { pos[i] = old; if (j >= 0) pos[j] = t; }
    }
    if (cur < bestCost - 1e-9) { bestCost = cur; best = pos.map((p) => ({ ...p })); }
  }
  const c0 = Math.min(...best.map((p) => p.c)), r0 = Math.min(...best.map((p) => p.r));
  return best.map((p) => ({ c: p.c - c0, r: p.r - r0 }));
}

// ---------- Klassendiagramm: Beziehungen rechtwinklig verlegen ----------
const GX = 130, GY = 110;
function routeRelations(boxes, rels, colX, colW, rowY, rowH) {
  const mid = (b, side) => (side === 'top' ? { x: b.cx, y: b.y } : side === 'bottom' ? { x: b.cx, y: b.y + b.h } : side === 'left' ? { x: b.x, y: b.cy } : { x: b.x + b.w, y: b.cy });
  const build = (rt, pa, pb) => clean(
    rt.kind === 'V' || rt.kind === 'H' ? [pa, pb]
      : rt.kind === 'VHV' ? [pa, { x: pa.x, y: rt.at }, { x: pb.x, y: rt.at }, pb]
      : rt.kind === 'HVH' ? [pa, { x: rt.at, y: pa.y }, { x: rt.at, y: pb.y }, pb]
      : rt.kind === 'VH' ? [pa, { x: pa.x, y: pb.y }, pb]
      : rt.kind === 'self' ? [pa, { x: pa.x, y: pa.y - 34 }, { x: pb.x, y: pb.y - 34 }, pb]
      : [pa, { x: pb.x, y: pa.y }, pb],
  );
  const done = [];
  const score = (pts, r) => {
    let s = pts.length * 2 + segs(pts).reduce((t, [a, b]) => t + Math.abs(a.x - b.x) + Math.abs(a.y - b.y), 0) / 150;
    for (const [a, b] of segs(pts)) {
      for (const o of boxes) if (o !== r.a.box && o !== r.b.box && hitsBox(a, b, o)) s += 1000;
      for (const d of done) for (const [c, e] of segs(d.pts)) {
        if (crosses(a, b, c, e)) s += 6;
        if (overlaps(a, b, c, e) && !(d.r.type === 'generalization' && r.type === 'generalization' && d.r.b === r.b)) s += 40;
      }
    }
    return s;
  };
  const sorted = [...rels].sort((p, q) => (q.type === 'generalization') - (p.type === 'generalization') || Math.abs(p.a.box.cx - p.b.box.cx) + Math.abs(p.a.box.cy - p.b.box.cy) - Math.abs(q.a.box.cx - q.b.box.cx) - Math.abs(q.a.box.cy - q.b.box.cy));
  for (const r of sorted) {
    const A = r.a.box, B = r.b.box, cands = [];
    const xo = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x), yo = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
    const below = B.y >= A.y + A.h, above = A.y >= B.y + B.h, right = B.x >= A.x + A.w, left = A.x >= B.x + B.w;
    const sv = below ? ['bottom', 'top'] : ['top', 'bottom'], sh = right ? ['right', 'left'] : ['left', 'right'];
    if (r.a === r.b) { r.rt = { kind: 'self', sides: ['top', 'top'] }; continue; } // reflexive Assoziation: Schleife über der Klasse
    if (xo >= 50 && (below || above)) cands.push({ kind: 'V', sides: sv, fix: Math.max(A.x, B.x) + xo / 2 });
    if (yo >= 30 && (right || left)) cands.push({ kind: 'H', sides: sh, fix: Math.max(A.y, B.y) + yo / 2 });
    if (below || above) {
      const ra = A.row, rb = B.row;
      for (const g of new Set(below ? [ra, rb - 1] : [ra - 1, rb])) cands.push({ kind: 'VHV', sides: sv, gap: g, at: rowY[g] + rowH[g] + GY / 2 });
      cands.push({ kind: 'VH', sides: [sv[0], right || B.cx > A.cx ? 'left' : 'right'] }, { kind: 'HV', sides: [right || B.cx > A.cx ? 'right' : 'left', sv[1]] });
    }
    if (right || left) {
      const ca = A.col, cb = B.col;
      for (const g of new Set(right ? [ca, cb - 1] : [ca - 1, cb])) cands.push({ kind: 'HVH', sides: sh, gap: g, at: colX[g] + colW[g] + GX / 2 });
    }
    // Ausweichrouten um dazwischenliegende Klassen herum (U-Form durch den Zwischenraum darunter/darüber bzw. daneben)
    if (!below && !above) {
      cands.push({ kind: 'VHV', sides: ['bottom', 'bottom'], gap: Math.max(A.row, B.row), at: Math.max(A.y + A.h, B.y + B.h, rowY[A.row] + rowH[A.row]) + GY / 2, detour: 1 });
      if (Math.min(A.row, B.row) > 0) cands.push({ kind: 'VHV', sides: ['top', 'top'], gap: Math.min(A.row, B.row) - 1, at: rowY[Math.min(A.row, B.row)] - GY / 2, detour: 1 });
    }
    if (!right && !left) {
      cands.push({ kind: 'HVH', sides: ['right', 'right'], gap: Math.max(A.col, B.col), at: colX[Math.max(A.col, B.col)] + colW[Math.max(A.col, B.col)] + GX / 2, detour: 1 });
      if (Math.min(A.col, B.col) > 0) cands.push({ kind: 'HVH', sides: ['left', 'left'], gap: Math.min(A.col, B.col) - 1, at: colX[Math.min(A.col, B.col)] - GX / 2, detour: 1 });
    }
    let best = null;
    for (const rt of cands) {
      let pa = mid(A, rt.sides[0]), pb = mid(B, rt.sides[1]);
      if (rt.kind === 'V') pa = { ...pa, x: rt.fix }, pb = { ...pb, x: rt.fix };
      if (rt.kind === 'H') pa = { ...pa, y: rt.fix }, pb = { ...pb, y: rt.fix };
      const pts = build(rt, pa, pb);
      // Vererbung als Baum: Unterklasse unter der Oberklasse bevorzugt über den gemeinsamen Zwischenraum
      const s = score(pts, r) - (r.type === 'generalization' && (rt.kind === 'VHV' || rt.kind === 'V') ? 3 : 0) + (rt.detour ? 8 : 0);
      if (!best || s < best.s) best = { s, rt, pts };
    }
    if (!best) best = { rt: { kind: 'direct', sides: ['bottom', 'top'] }, pts: [mid(A, 'bottom'), mid(B, 'top')] };
    r.rt = best.rt;
    done.push({ r, pts: best.pts });
  }
  // Anschlusspunkte je Seite verteilen
  const ends = new Map(); // box|side -> [{ r, end, fixed, key }]
  for (const r of rels) {
    if (!r.rt) continue;
    [r.a, r.b].forEach((c, k) => {
      const side = r.rt.sides[k], other = (k ? r.a : r.b).box, key = `${c.i}|${side}`;
      const tree = r.type === 'generalization' && r.rt.kind !== 'H';
      const fixed = r.rt.kind === 'V' || r.rt.kind === 'H' ? r.rt.fix : tree ? (side === 'top' || side === 'bottom' ? c.box.cx : c.box.cy) : undefined;
      if (!ends.has(key)) ends.set(key, []);
      ends.get(key).push({ r, k, fixed, tree: tree && k === 1 ? r.b.i : null, sort: side === 'top' || side === 'bottom' ? other.cx : other.cy });
    });
  }
  for (const [key, list] of ends) {
    const [i, side] = key.split('|'), b = boxes[Number(i)], horiz = side === 'top' || side === 'bottom';
    const lo = (horiz ? b.x : b.y) + 14, hi = (horiz ? b.x + b.w : b.y + b.h) - 14;
    const taken = [];
    for (const e of list) if (e.fixed !== undefined) {
      let v = Math.max(lo, Math.min(hi, e.fixed));
      if (e.tree === null && e.r.rt.kind.length === 1) {
        // parallele gerade Beziehungen nebeneinander; zwischen denselben zwei Klassen mit Platz für die Beschriftungen
        const pair = list.some((o) => o !== e && o.pos !== undefined && o.r.a === e.r.a && o.r.b === e.r.b);
        while (taken.some((t) => Math.abs(t - v) < (pair ? 60 : 16))) v += pair ? 64 : 18;
      }
      e.pos = v;
      e.r.rt.fix2 = v;
      taken.push(v);
    }
    const free = list.filter((e) => e.fixed === undefined).sort((p, q) => p.sort - q.sort);
    free.forEach((e, k) => {
      // Gleichmäßig verteilen, aber nicht über einen festen (geraden) Anschluss hinweg auf die der Gegenklasse abgewandte Seite:
      // sonst kreuzt die Linie die gerade Beziehung.
      let v = lo + ((k + 1) * (hi - lo)) / (free.length + 1);
      const fixedPos = list.filter((o) => o.fixed !== undefined).map((o) => o.pos);
      const toward = Math.sign(e.sort - v) || 1;
      for (const fp of fixedPos) if ((e.sort - fp) * (v - fp) < 0 || Math.abs(v - fp) < 28) v = fp + (e.sort < fp ? -1 : 1) * 30;
      v = Math.max(lo, Math.min(hi, v));
      const dir = e.sort < v ? -1 : 1;
      for (let n = 0; n < 12 && taken.some((t) => Math.abs(t - v) < 26); n++) v = Math.max(lo, Math.min(hi, v + dir * 16));
      e.pos = Math.round(v);
      taken.push(e.pos);
    });
    for (const e of list) {
      const p = mid(b, side);
      if (horiz) p.x = e.pos; else p.y = e.pos;
      e.r[e.k ? 'pb' : 'pa'] = p;
    }
  }
  // gerade Beziehungen: beide Enden auf dieselbe Koordinate
  for (const r of rels) {
    if (r.rt?.kind === 'V') r.pa.x = r.pb.x = r.rt.fix2 ?? r.pa.x;
    if (r.rt?.kind === 'H') r.pa.y = r.pb.y = r.rt.fix2 ?? r.pa.y;
  }
  // Spuren in den Zwischenräumen
  for (const kind of ['VHV', 'HVH']) {
    const byGap = new Map();
    for (const r of rels) if (r.rt?.kind === kind) { if (!byGap.has(r.rt.gap)) byGap.set(r.rt.gap, []); byGap.get(r.rt.gap).push(r); }
    for (const list of byGap.values()) {
      const nets = new Map();
      for (const r of list) {
        const k = r.type === 'generalization' ? `g${r.b.i}` : `r${rels.indexOf(r)}`;
        const [u, v] = kind === 'VHV' ? [r.pa.x, r.pb.x] : [r.pa.y, r.pb.y];
        const net = nets.get(k) ?? { lo: Infinity, hi: -Infinity, rs: [] };
        net.lo = Math.min(net.lo, u, v) - 10; net.hi = Math.max(net.hi, u, v) + 10; net.rs.push(r);
        nets.set(k, net);
      }
      const used = [];
      for (const net of [...nets.values()].sort((p, q) => p.lo - q.lo)) {
        let t = 0;
        while (used[t]?.some((o) => o.lo < net.hi && o.hi > net.lo)) t++;
        (used[t] ??= []).push(net);
        net.t = t;
      }
      for (const net of nets.values()) for (const r of net.rs) r.rt.at += (net.t - (used.length - 1) / 2) * 16;
    }
  }
  for (const r of rels) r.pts = r.rt ? build(r.rt, r.pa, r.pb).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })) : [];
  // Zwei Beziehungen, deren Endstücke auf derselben Senkrechten fast aneinanderstoßen, sähen wie eine durchgehende Linie aus:
  // das Ende der zweiten etwas zur Seite rücken.
  const endSeg = (r, k) => (k ? [r.pts[r.pts.length - 1], r.pts[r.pts.length - 2]] : [r.pts[0], r.pts[1]]);
  for (const r of rels) {
    if (!r.rt || r.pts.length < 3 || r.rt.kind === 'V' || r.rt.kind === 'self') continue;
    for (const k of [0, 1]) {
      const [p, q] = endSeg(r, k);
      if (p.x !== q.x) continue;
      const clash = rels.some((o) => o !== r && o.pts.length >= 2 && segs(o.pts).some(([a, b]) => a.x === b.x && a.x === p.x
        && Math.max(Math.min(a.y, b.y), Math.min(p.y, q.y)) - Math.min(Math.max(a.y, b.y), Math.max(p.y, q.y)) < 30));
      if (!clash) continue;
      const box = (k ? r.b : r.a).box, key = k ? 'pb' : 'pa';
      const nx = p.x + 26 <= box.x + box.w - 14 ? p.x + 26 : p.x - 26;
      r[key] = { ...r[key], x: nx };
      r.pts = build(r.rt, r.pa, r.pb).map((v) => ({ x: Math.round(v.x), y: Math.round(v.y) }));
    }
  }
}

// ---------- Klassendiagramm ----------
export function classDiagram(spec) {
  const problems = [];
  const classes = (spec.classes ?? []).map((c, i) => ({ ...c, i, attrs: c.attributes ?? [] }));
  if (!classes.length) throw new Error('Mindestens eine Klasse angeben.');
  const byName = new Map();
  for (const c of classes) { if (byName.has(c.name)) throw new Error(`Klasse doppelt: ${c.name}`); byName.set(c.name, c); }
  const rels = (spec.relations ?? []).map((r) => {
    const a = byName.get(r.from), b = byName.get(r.to);
    if (!a || !b) throw new Error(`Beziehung ${r.from} → ${r.to}: Klasse "${a ? r.to : r.from}" gibt es nicht.`);
    return { ...r, type: r.type ?? 'association', a, b };
  });

  // Fachliche Prüfung (Folien "Das Domänenmodell")
  for (const c of classes) {
    const isEnum = /enum/i.test(c.stereotype ?? '');
    if (!c.attrs.length && !c.abstract && !isEnum) problems.push(`Klasse ${c.name} hat keine Attribute.`);
    for (const a of c.attrs) {
      if (/\(.*\)/.test(a)) problems.push(`${c.name}.${a}: Methoden gehören nicht ins Domänenmodell (fachliche Ebene, keine Implementierung).`);
      else if (!isEnum && !a.includes(':')) problems.push(`${c.name}.${a}: Attribut ohne Typ (Schema "name: Typ").`);
      const type = a.split(':')[1]?.trim().replace(/\[.*\]$/, '');
      if (type && byName.has(type) && !/enum/i.test(byName.get(type).stereotype ?? '')) problems.push(`${c.name}.${a}: Klasse als Attributtyp – besser eine Assoziation zu ${type}.`);
    }
    if (classes.length > 1 && !rels.some((r) => r.a === c || r.b === c)) problems.push(`Klasse ${c.name} hat keine Beziehung zu anderen Klassen.`);
  }
  for (const r of rels) {
    if (r.type === 'generalization' || r.type === 'dependency') continue;
    if (!r.name && r.type === 'association') problems.push(`Assoziation ${r.from} – ${r.to} hat keinen Namen.`);
    if (!r.fromMult || !r.toMult) problems.push(`${r.from} – ${r.to}: Kardinalität fehlt (${!r.fromMult ? 'fromMult' : ''}${!r.fromMult && !r.toMult ? ', ' : ''}${!r.toMult ? 'toMult' : ''}).`);
  }

  // Größen
  for (const c of classes) {
    const head = 34 + (c.stereotype ? 15 : 0);
    const w = Math.max(150, textWidth(c.name, 14, true) + 36, c.stereotype ? textWidth(`«${c.stereotype}»`, 11) + 30 : 0, ...c.attrs.map((a) => textWidth(a) + 30));
    c.head = head;
    c.box = { w: Math.ceil(w / 10) * 10, h: head + Math.max(1, c.attrs.length) * 20 + 12 };
  }
  const pos = placeClasses(classes, rels);
  const nc = Math.max(...pos.map((p) => p.c)) + 1, nr = Math.max(...pos.map((p) => p.r)) + 1;
  const colW = Array.from({ length: nc }, (_, c) => Math.max(0, ...classes.filter((k) => pos[k.i].c === c).map((k) => k.box.w)));
  const rowH = Array.from({ length: nr }, (_, r) => Math.max(0, ...classes.filter((k) => pos[k.i].r === r).map((k) => k.box.h)));
  const top = spec.title ? 50 : 20;
  const colX = [20], rowY = [top];
  for (let c = 1; c < nc; c++) colX[c] = colX[c - 1] + colW[c - 1] + (colW[c - 1] ? GX : 0);
  for (let r = 1; r < nr; r++) rowY[r] = rowY[r - 1] + rowH[r - 1] + (rowH[r - 1] ? GY : 0);
  for (const c of classes) {
    const p = pos[c.i], b = c.box;
    b.col = p.c; b.row = p.r;
    b.x = Math.round(colX[p.c] + (colW[p.c] - b.w) / 2);
    b.y = Math.round(rowY[p.r] + (rowH[p.r] - b.h) / 2);
    b.cx = b.x + b.w / 2; b.cy = b.y + b.h / 2;
  }
  const boxes = classes.map((c) => c.box);
  routeRelations(boxes, rels, colX, colW, rowY, rowH);
  for (const r of rels) for (const [a, b] of segs(r.pts)) for (const c of classes) {
    if (c !== r.a && c !== r.b && hitsBox(a, b, c.box, 0)) problems.push(`Beziehung ${r.from} – ${r.to} läuft durch Klasse ${c.name}: Anordnung mit col/row anpassen.`);
  }

  // Beschriftungen: Name in der Mitte, Kardinalitäten und Rollen an den Enden
  const texts = [];
  // Beschriftung frei: keine andere Beschriftung, keine Klasse und keine Linie darunter
  const lineHit = (t) => rels.some((r) => segs(r.pts ?? []).some(([a, b]) => Math.max(a.x, b.x) > t.x - 5 && Math.min(a.x, b.x) < t.x + t.w + 5 && Math.max(a.y, b.y) > t.y - 8 && Math.min(a.y, b.y) < t.y + t.h + 8));
  const free = (t) => !texts.some((o) => t.x < o.x + o.w + 3 && o.x < t.x + t.w + 3 && t.y < o.y + o.h + 2 && o.y < t.y + t.h + 2) && !boxes.some((o) => t.x < o.x + o.w && o.x < t.x + t.w && t.y < o.y + o.h && o.y < t.y + t.h) && !lineHit(t);
  const put = (cands) => { const t = cands.find(free) ?? cands[0]; texts.push(t); return t; };
  // mark = Länge der Raute/Pfeilspitze an diesem Ende: die Beschriftung rückt dahinter
  const endText = (text, p, next, flip, mark = 0) => {
    if (!text) return;
    const w = textWidth(text, 12) + 2, h = 14, vertical = p.x === next.x, d = vertical ? Math.sign(next.y - p.y) : Math.sign(next.x - p.x);
    const at = (side, off) => (vertical ? { x: side > 0 ? p.x + 8 : p.x - 8 - w, y: d > 0 ? p.y + 4 + off : p.y - 4 - h - off, w, h, text } : { x: d > 0 ? p.x + 6 + off : p.x - 6 - w - off, y: side > 0 ? p.y - h - 3 : p.y + 4, w, h, text });
    const s = flip ? -1 : 1;
    put([at(s, mark), at(-s, mark), at(s, mark + 16), at(-s, mark + 16)]).muted = false;
  };
  for (const r of rels) {
    if (r.pts.length < 2) continue;
    const n = r.pts.length;
    const m1 = r.type === 'composition' || r.type === 'aggregation' ? 18 : 0, m2 = r.navigable || r.type === 'dependency' ? 10 : 0;
    endText(r.fromMult, r.pts[0], r.pts[1], false, m1);
    endText(r.toMult, r.pts[n - 1], r.pts[n - 2], false, m2);
    endText(r.fromRole, r.pts[0], r.pts[1], true, m1);
    endText(r.toRole, r.pts[n - 1], r.pts[n - 2], true, m2);
  }
  for (const r of rels) {
    if (!r.name || r.pts.length < 2) continue;
    // Leserichtung (UML): ausgefülltes Dreieck am Namen, zeigt entlang der Linie von "from" nach "to"
    const h = 14, cands = [];
    for (const [a, b] of segs(r.pts).sort((p, q) => Math.hypot(q[0].x - q[1].x, q[0].y - q[1].y) - Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y))) {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const text = !['association', 'composition', 'aggregation'].includes(r.type) || r.readingDirection === false ? r.name
        : a.y === b.y ? (b.x > a.x ? `${r.name} ▶` : `◀ ${r.name}`) : (b.y > a.y ? `${r.name} ▼` : `${r.name} ▲`);
      const w = textWidth(text, 12) + 6;
      if (a.y === b.y) cands.push({ x: mx - w / 2, y: my - h - 4, w, text }, { x: mx - w / 2, y: my + 5, w, text });
      else for (const f of [0, -0.25, 0.25]) cands.push({ x: mx + 7, y: my - h / 2 + f * Math.abs(a.y - b.y), w, text }, { x: mx - 7 - w, y: my - h / 2 + f * Math.abs(a.y - b.y), w, text });
    }
    put(cands.map((c) => ({ ...c, h }))).muted = true;
  }

  // Notizen unter dem Diagramm
  let W = Math.max(...boxes.map((b) => b.x + b.w), ...texts.map((t) => t.x + t.w)) + 20;
  let H = Math.max(...boxes.map((b) => b.y + b.h), ...rels.flatMap((r) => r.pts.map((p) => p.y))) + 20;
  const notes = (spec.notes ?? []).map((n) => {
    const lines = wrap((n.attachTo ? `${n.attachTo}: ` : '') + n.text, 46);
    return { lines, w: Math.max(...lines.map((l) => textWidth(l, 12))) + 28, h: lines.length * 17 + 16 };
  });
  let nx = 20;
  for (const n of notes) { n.x = nx; n.y = H + 10; nx += n.w + 20; }
  if (notes.length) { H += 10 + Math.max(...notes.map((n) => n.h)) + 20; W = Math.max(W, nx); }
  const minX = Math.min(0, ...texts.map((t) => t.x - 6), ...rels.flatMap((r) => r.pts.map((p) => p.x - 10)));

  // ----- SVG -----
  const o = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(W - minX)}" height="${Math.ceil(H)}" viewBox="${Math.floor(minX)} 0 ${Math.ceil(W - minX)} ${Math.ceil(H)}" font-family="${FONT}">`);
  o.push(`<rect x="${Math.floor(minX)}" y="0" width="${Math.ceil(W - minX)}" height="${Math.ceil(H)}" fill="#fff"/>`);
  if (spec.title) o.push(`<text x="20" y="30" font-size="17" font-weight="bold" fill="${INK}">${esc(spec.title)}</text>`);
  for (const r of rels) {
    if (r.pts.length < 2) continue;
    const pts = r.pts.map((p) => ({ ...p })), n = pts.length;
    const marks = [];
    const dirAt = (p, q) => ({ x: Math.sign(q.x - p.x), y: Math.sign(q.y - p.y) });
    const cut = (i, j, len) => { const d = dirAt(pts[i], pts[j]); pts[i] = { x: pts[i].x + d.x * len, y: pts[i].y + d.y * len }; return d; };
    if (r.type === 'composition' || r.type === 'aggregation') {
      const p = pts[0], d = cut(0, 1, 18), nx2 = -d.y, ny2 = d.x;
      marks.push(`<polygon points="${p.x},${p.y} ${p.x + d.x * 9 + nx2 * 6},${p.y + d.y * 9 + ny2 * 6} ${p.x + d.x * 18},${p.y + d.y * 18} ${p.x + d.x * 9 - nx2 * 6},${p.y + d.y * 9 - ny2 * 6}" fill="${r.type === 'composition' ? INK : '#fff'}" stroke="${INK}" stroke-width="1.5"/>`);
    }
    if (r.type === 'generalization') {
      const p = pts[n - 1], d = cut(n - 1, n - 2, 15), nx2 = -d.y, ny2 = d.x;
      marks.push(`<polygon points="${p.x},${p.y} ${p.x + d.x * 15 + nx2 * 9},${p.y + d.y * 15 + ny2 * 9} ${p.x + d.x * 15 - nx2 * 9},${p.y + d.y * 15 - ny2 * 9}" fill="#fff" stroke="${INK}" stroke-width="1.5"/>`);
    } else if (r.navigable || r.type === 'dependency') {
      const p = pts[n - 1], d = dirAt(p, pts[n - 2]), nx2 = -d.y, ny2 = d.x;
      marks.push(`<polyline points="${p.x + d.x * 11 + nx2 * 6},${p.y + d.y * 11 + ny2 * 6} ${p.x},${p.y} ${p.x + d.x * 11 - nx2 * 6},${p.y + d.y * 11 - ny2 * 6}" fill="none" stroke="${INK}" stroke-width="1.5"/>`);
    }
    o.push(`<polyline points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${INK}" stroke-width="1.5"${r.type === 'dependency' ? ' stroke-dasharray="6 4"' : ''}/>`, ...marks);
  }
  for (const c of classes) {
    const b = c.box;
    o.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#fff" stroke="${INK}" stroke-width="1.5"/>`);
    o.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${c.head}" fill="${esc(c.color ?? HEAD)}" stroke="${INK}" stroke-width="1.5"/>`);
    if (c.stereotype) o.push(`<text x="${b.cx}" y="${b.y + 16}" font-size="11" text-anchor="middle" fill="${MUTED}">«${esc(c.stereotype)}»</text>`);
    o.push(`<text x="${b.cx}" y="${b.y + c.head - 12}" font-size="14" font-weight="bold" text-anchor="middle" fill="${INK}"${c.abstract ? ' font-style="italic"' : ''}>${esc(c.name)}</text>`);
    c.attrs.forEach((a, k) => o.push(`<text x="${b.x + 12}" y="${b.y + c.head + 21 + k * 20}" font-size="13" fill="${INK}">${esc(a)}</text>`));
  }
  for (const t of texts) o.push(`<text x="${Math.round(t.x)}" y="${Math.round(t.y + 11)}" font-size="12" fill="${t.muted ? MUTED : INK}">${esc(t.text)}</text>`);
  for (const n of notes) {
    o.push(`<path d="M${n.x},${n.y} h${n.w - 12} l12,12 v${n.h - 12} h${-n.w} z" fill="${NOTE}" stroke="#b8a76a"/>`);
    n.lines.forEach((l, k) => o.push(`<text x="${n.x + 12}" y="${n.y + 22 + k * 17}" font-size="12" fill="${INK}">${esc(l)}</text>`));
  }
  o.push('</svg>');

  // ----- draw.io -----
  const cells = [];
  const text = (id, t, x, y, w, h, style = '') => cells.push(`<mxCell id="${id}" value="${esc(t)}" style="text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=12;${style}" vertex="1" parent="1"><mxGeometry x="${Math.round(x)}" y="${Math.round(y)}" width="${Math.ceil(w)}" height="${h}" as="geometry"/></mxCell>`);
  if (spec.title) text('title', spec.title, 20, 10, textWidth(spec.title, 17, true) + 10, 30, 'fontSize=17;fontStyle=1;');
  for (const c of classes) {
    const b = c.box, label = (c.stereotype ? `«${c.stereotype}»\n` : '') + c.name;
    cells.push(`<mxCell id="c${c.i}" value="${esc(label)}" style="swimlane;fontStyle=${c.abstract ? 3 : 1};align=center;verticalAlign=middle;childLayout=stackLayout;horizontal=1;startSize=${c.head};horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=0;marginBottom=0;whiteSpace=wrap;fontSize=14;fillColor=${c.color ?? HEAD};strokeColor=${INK};fontColor=${INK};swimlaneFillColor=#ffffff;" vertex="1" parent="1"><mxGeometry x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" as="geometry"/></mxCell>`);
    (c.attrs.length ? c.attrs : ['']).forEach((a, k) => cells.push(`<mxCell id="c${c.i}a${k}" value="${esc(a)}" style="text;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;spacingLeft=10;spacingRight=4;overflow=hidden;rotatable=0;points=[[0,0.5],[1,0.5]];portConstraint=eastwest;fontSize=13;fontColor=${INK};" vertex="1" parent="c${c.i}"><mxGeometry y="${c.head + k * 20}" width="${b.w}" height="20" as="geometry"/></mxCell>`));
  }
  rels.forEach((r, k) => {
    if (r.pts.length < 2) return;
    const A = r.a.box, B = r.b.box, p = r.pts[0], q = r.pts[r.pts.length - 1];
    const arrows = r.type === 'composition' ? 'startArrow=diamondThin;startFill=1;startSize=18;endArrow=none;' : r.type === 'aggregation' ? 'startArrow=diamondThin;startFill=0;startSize=18;endArrow=none;'
      : r.type === 'generalization' ? 'startArrow=none;endArrow=block;endFill=0;endSize=14;' : r.type === 'dependency' ? 'dashed=1;startArrow=none;endArrow=open;endSize=10;' : `startArrow=none;endArrow=${r.navigable ? 'open;endSize=10' : 'none'};`;
    const rel = (v, lo, len) => Math.max(0, Math.min(1, (v - lo) / len)).toFixed(3);
    const style = `edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=${INK};strokeWidth=1.5;${arrows}exitX=${rel(p.x, A.x, A.w)};exitY=${rel(p.y, A.y, A.h)};exitDx=0;exitDy=0;entryX=${rel(q.x, B.x, B.w)};entryY=${rel(q.y, B.y, B.h)};entryDx=0;entryDy=0;`;
    const inner = r.pts.slice(1, -1).map((m) => `<mxPoint x="${m.x}" y="${m.y}"/>`).join('');
    cells.push(`<mxCell id="r${k}" style="${style}" edge="1" parent="1" source="c${r.a.i}" target="c${r.b.i}"><mxGeometry relative="1" as="geometry">${inner ? `<Array as="points">${inner}</Array>` : ''}</mxGeometry></mxCell>`);
  });
  texts.forEach((t, k) => text(`t${k}`, t.text, t.x - 2, t.y - 3, t.w + 6, 20, t.muted ? `fontColor=${MUTED};` : `fontColor=${INK};`));
  notes.forEach((n, k) => cells.push(`<mxCell id="n${k}" value="${esc(n.lines.join('\n'))}" style="shape=note;size=12;whiteSpace=wrap;html=1;align=left;verticalAlign=top;spacingLeft=8;spacingTop=4;fillColor=${NOTE};strokeColor=#b8a76a;fontSize=12;" vertex="1" parent="1"><mxGeometry x="${n.x}" y="${n.y}" width="${Math.ceil(n.w)}" height="${n.h}" as="geometry"/></mxCell>`));
  return { svg: o.join('\n'), drawio: drawioFile(spec.title ?? 'Klassendiagramm', cells, W, H), problems: [...new Set(problems)], geometry: { lines: rels.map((r) => r.pts), texts, width: W, height: H } };
}

function drawioFile(name, cells, w, h) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="bpmn-mcp" agent="bpmn-mcp" version="24.0.0">
  <diagram id="uml" name="${esc(name)}">
    <mxGraphModel dx="${Math.ceil(w)}" dy="${Math.ceil(h)}" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="${Math.ceil(w)}" pageHeight="${Math.ceil(h)}" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        ${cells.join('\n        ')}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;
}

// ---------- Zustandsdiagramm (Objektlebenszyklus): nutzt das BPMN-Layout (links nach rechts, Hauptpfad gerade) ----------
export function stateDiagram(spec) {
  const problems = [];
  const states = (spec.states ?? []).map((s, i) => (typeof s === 'string' ? { name: s, i } : { ...s, i }));
  const byName = new Map(states.map((s) => [s.name, s]));
  const need = (name, what) => { const s = byName.get(name); if (!s) throw new Error(`${what}: Zustand "${name}" gibt es nicht.`); return s; };
  const init = need(spec.initial, 'initial'), finals = (spec.finals ?? []).map((f) => need(f, 'finals'));
  const trans = (spec.transitions ?? []).map((t, k) => ({ ...t, k, a: need(t.from, 'transitions'), b: need(t.to, 'transitions') }));
  for (const s of states) {
    if (s !== init && !trans.some((t) => t.b === s)) problems.push(`Zustand ${s.name} wird nie erreicht.`);
    if (!finals.includes(s) && !trans.some((t) => t.a === s)) problems.push(`Zustand ${s.name} hat keinen Ausgang und ist kein Endzustand.`);
  }
  for (const t of trans) if (!t.label) problems.push(`Übergang ${t.from} → ${t.to} ohne Auslöser (Aktivität aus dem Prozess benennen).`);

  const lbl = (text) => { const lines = wrap(text, 22); return { lines, width: Math.max(...lines.map((l) => textWidth(l, 12))) + 6, height: lines.length * 15 + 2 }; };
  const nodes = [{ id: 'init', type: 'StartEvent', width: 24, height: 24, parent: null }];
  for (const s of states) {
    s.desc = s.description ? wrap(s.description, 24) : [];
    nodes.push({ id: `s${s.i}`, type: 'Task', width: Math.ceil(Math.max(120, textWidth(s.name, 14, true) + 36, ...s.desc.map((l) => textWidth(l, 11) + 24)) / 10) * 10, height: 50 + s.desc.length * 14, parent: null });
  }
  if (finals.length) nodes.push({ id: 'final', type: 'EndEvent', width: 28, height: 28, parent: null });
  const edges = [{ id: 'e_init', type: 'SequenceFlow', source: 'init', target: `s${init.i}` }];
  const loops = [];
  for (const t of trans) {
    t.lb = t.label ? lbl(t.label) : null;
    if (t.a === t.b) loops.push(t);
    else edges.push({ id: `t${t.k}`, type: 'SequenceFlow', source: `s${t.a.i}`, target: `s${t.b.i}`, label: t.lb ? { width: t.lb.width, height: t.lb.height } : undefined });
  }
  for (const f of finals) edges.push({ id: `e_fin${f.i}`, type: 'SequenceFlow', source: `s${f.i}`, target: 'final' });
  const L = computeLayout({ nodes, edges });
  const top = (spec.title ? 50 : 20) + (loops.length ? 40 : 0);
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const see = (x, y) => { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); };
  for (const b of [...Object.values(L.shapes), ...Object.values(L.labels)]) { see(b.x, b.y); see(b.x + b.width, b.y + b.height); }
  for (const pts of Object.values(L.edges)) for (const p of pts) see(p.x, p.y);
  const dx = 20 - x1, dy = top - y1, W = x2 - x1 + 40, H = y2 - y1 + top + 20;
  const S = (id) => { const b = L.shapes[id]; return { x: b.x + dx, y: b.y + dy, w: b.width, h: b.height }; };
  const o = [`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(W)}" height="${Math.ceil(H)}" viewBox="0 0 ${Math.ceil(W)} ${Math.ceil(H)}" font-family="${FONT}">`, `<rect width="${Math.ceil(W)}" height="${Math.ceil(H)}" fill="#fff"/>`];
  const cells = [];
  if (spec.title) {
    o.push(`<text x="20" y="30" font-size="17" font-weight="bold" fill="${INK}">${esc(spec.title)}</text>`);
    cells.push(`<mxCell id="title" value="${esc(spec.title)}" style="text;html=1;strokeColor=none;fillColor=none;align=left;fontSize=17;fontStyle=1;" vertex="1" parent="1"><mxGeometry x="20" y="10" width="${Math.ceil(textWidth(spec.title, 17, true) + 10)}" height="30" as="geometry"/></mxCell>`);
  }
  const arrow = (p, q) => { const d = { x: Math.sign(p.x - q.x), y: Math.sign(p.y - q.y) }, n = { x: -d.y, y: d.x }; return `<polygon points="${p.x},${p.y} ${p.x - d.x * 10 + n.x * 5},${p.y - d.y * 10 + n.y * 5} ${p.x - d.x * 10 - n.x * 5},${p.y - d.y * 10 - n.y * 5}" fill="${INK}"/>`; };
  const edge = (id, pts, label, box, src, dst) => {
    o.push(`<polyline points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${INK}" stroke-width="1.5"/>`, arrow(pts[pts.length - 1], pts[pts.length - 2]));
    const inner = pts.slice(1, -1).map((m) => `<mxPoint x="${m.x}" y="${m.y}"/>`).join('');
    cells.push(`<mxCell id="${id}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=${INK};strokeWidth=1.5;endArrow=block;endFill=1;" edge="1" parent="1" source="${src}" target="${dst}"><mxGeometry relative="1" as="geometry">${inner ? `<Array as="points">${inner}</Array>` : ''}</mxGeometry></mxCell>`);
    if (!label) return;
    label.lines.forEach((l, k) => o.push(`<text x="${Math.round(box.x + 3)}" y="${Math.round(box.y + 12 + k * 15)}" font-size="12" fill="${MUTED}">${esc(l)}</text>`));
    cells.push(`<mxCell id="${id}_l" value="${esc(label.lines.join('\n'))}" style="text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=top;fontSize=12;fontColor=${MUTED};whiteSpace=wrap;" vertex="1" parent="1"><mxGeometry x="${Math.round(box.x)}" y="${Math.round(box.y - 3)}" width="${Math.ceil(label.width + 8)}" height="${label.height + 6}" as="geometry"/></mxCell>`);
  };
  for (const e of edges) {
    const pts = (L.edges[e.id] ?? []).map((p) => ({ x: p.x + dx, y: p.y + dy }));
    if (pts.length < 2) continue;
    const t = trans.find((t) => `t${t.k}` === e.id), lb = L.labels[e.id];
    let box = lb ? { x: lb.x + dx, y: lb.y + dy } : null;
    // Beschriftung nie auf einen Zustand legen: sonst an die letzte Ecke vor dem Ziel
    const onState = (b) => states.some((s) => { const o = S(`s${s.i}`); return b.x < o.x + o.w && o.x < b.x + lb.width && b.y < o.y + o.h && o.y < b.y + lb.height; });
    if (box && onState(box) && pts.length > 2) {
      const c = pts[pts.length - 2], up = pts[pts.length - 3].y > c.y;
      box = [{ x: c.x - 6 - lb.width, y: up ? c.y + 4 : c.y - lb.height - 4 }, { x: c.x + 6, y: up ? c.y - lb.height - 4 : c.y + 4 }].find((b) => !onState(b)) ?? box;
    }
    edge(e.id, pts, t?.lb, box, e.source, e.target);
  }
  loops.forEach((t, k) => {
    const b = S(`s${t.a.i}`), xa = b.x + b.w * 0.35, xb = b.x + b.w * 0.65, y = b.y - 22 - k * 4;
    edge(`t${t.k}`, [{ x: xb, y: b.y }, { x: xb, y }, { x: xa, y }, { x: xa, y: b.y }], t.lb, t.lb ? { x: b.x + b.w / 2 - t.lb.width / 2, y: y - t.lb.height - 2 } : null, `s${t.a.i}`, `s${t.a.i}`);
  });
  for (const s of states) {
    const b = S(`s${s.i}`);
    o.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="14" fill="${HEAD}" stroke="${INK}" stroke-width="1.5"/>`);
    o.push(`<text x="${b.x + b.w / 2}" y="${b.y + (s.desc.length ? 22 : b.h / 2 + 5)}" font-size="14" font-weight="bold" text-anchor="middle" fill="${INK}">${esc(s.name)}</text>`);
    s.desc.forEach((l, k) => o.push(`<text x="${b.x + b.w / 2}" y="${b.y + 40 + k * 14}" font-size="11" text-anchor="middle" fill="${MUTED}">${esc(l)}</text>`));
    cells.push(`<mxCell id="s${s.i}" value="${esc(s.name + (s.desc.length ? '\n' + s.desc.join('\n') : ''))}" style="rounded=1;arcSize=30;whiteSpace=wrap;html=1;fillColor=${HEAD};strokeColor=${INK};fontColor=${INK};fontSize=14;fontStyle=1;strokeWidth=1.5;" vertex="1" parent="1"><mxGeometry x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" as="geometry"/></mxCell>`);
  }
  const i = S('init');
  o.push(`<circle cx="${i.x + 12}" cy="${i.y + 12}" r="11" fill="${INK}"/>`);
  cells.push(`<mxCell id="init" value="" style="ellipse;fillColor=${INK};strokeColor=${INK};" vertex="1" parent="1"><mxGeometry x="${i.x}" y="${i.y}" width="24" height="24" as="geometry"/></mxCell>`);
  if (finals.length) {
    const f = S('final');
    o.push(`<circle cx="${f.x + 14}" cy="${f.y + 14}" r="13" fill="#fff" stroke="${INK}" stroke-width="1.5"/><circle cx="${f.x + 14}" cy="${f.y + 14}" r="8" fill="${INK}"/>`);
    cells.push(`<mxCell id="final" value="" style="ellipse;html=1;shape=endState;fillColor=${INK};strokeColor=${INK};" vertex="1" parent="1"><mxGeometry x="${f.x}" y="${f.y}" width="28" height="28" as="geometry"/></mxCell>`);
  }
  o.push('</svg>');
  return { svg: o.join('\n'), drawio: drawioFile(spec.title ?? 'Zustandsdiagramm', cells, W, H), problems };
}
