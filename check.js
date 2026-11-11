// Prüft ein Diagramm gegen die Modellierungskonventionen (Darstellung, Benennung, Struktur, Camunda 8).
// Eingabe: Graph mit Geometrie { nodes:[{id,type,name,x,y,width,height,host,label,...}], edges:[{id,type,source,target,name,waypoints,label,...}] }
import { isGateway, isEvent, isContainer, isArtifact } from './layout.js';

const isTask = (n) => /Task$/.test(n.type) || n.type === 'CallActivity' || (/SubProcess$/.test(n.type) && n.expanded === false);
const inside = (b, p, pad = 2) => p.x > b.x + pad && p.x < b.x + b.width - pad && p.y > b.y + pad && p.y < b.y + b.height - pad;
const overlap = (a, b, pad = 0) => a.x + pad < b.x + b.width && b.x + pad < a.x + a.width && a.y + pad < b.y + b.height && b.y + pad < a.y + a.height;

function segHitsBox(a, b, box) {
  const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
  for (let i = 0; i <= n; i++) if (inside(box, { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n })) return true;
  return false;
}
function segsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
function segsOverlap(a, b, c, d) {
  for (const [u, v] of [['x', 'y'], ['y', 'x']]) {
    if (a[u] === b[u] && c[u] === d[u] && a[u] === c[u]) {
      const lo = Math.max(Math.min(a[v], b[v]), Math.min(c[v], d[v])), hi = Math.min(Math.max(a[v], b[v]), Math.max(c[v], d[v]));
      if (hi - lo > 6) return true;
    }
  }
  return false;
}

export function checkDiagram(graph) {
  const P = [];
  const add = (severity, rule, message, ids = []) => P.push({ severity, rule, message, ids });
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const q = (n) => (n.name ? `„${n.name}“` : n.id);
  const seq = graph.edges.filter((e) => e.type === 'SequenceFlow');
  const out = (id) => seq.filter((e) => e.source === id), inn = (id) => seq.filter((e) => e.target === id);
  const solid = graph.nodes.filter((n) => !isContainer(n) && n.type !== 'Group' && n.x !== undefined);
  const hasGeo = solid.length > 0;

  // ---------- Darstellung ----------
  let crossings = 0;
  if (hasGeo) {
    for (const e of graph.edges) {
      const w = e.waypoints ?? [];
      for (const n of solid) {
        if (n.id === e.source || n.id === e.target || byId.get(e.source)?.host === n.id) continue;
        if (w.some((p, i) => i < w.length - 1 && segHitsBox(p, w[i + 1], n))) add('error', 'linie-durch-element', `Verbindung ${e.id} (${e.source} → ${e.target}) läuft durch ${q(n)}.`, [e.id, n.id]);
      }
      if (e.type === 'SequenceFlow' && w.some((p, i) => i < w.length - 1 && p.x !== w[i + 1].x && p.y !== w[i + 1].y)) add('hint', 'schraege-linie', `Verbindung ${e.id} verläuft schräg statt rechtwinklig.`, [e.id]);
    }
    for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i], b = solid[j];
      if (a.host === b.id || b.host === a.id) continue;
      if (overlap(a, b)) add('error', 'ueberlappung', `${q(a)} und ${q(b)} überlappen sich.`, [a.id, b.id]);
    }
    const E = graph.edges.filter((e) => e.waypoints?.length > 1 && e.type !== 'Association' && !/^Data/.test(e.type));
    for (let i = 0; i < E.length; i++) for (let j = i + 1; j < E.length; j++) {
      const a = E[i].waypoints, b = E[j].waypoints;
      const shared = E[i].source === E[j].source || E[i].target === E[j].target || E[i].source === E[j].target || E[i].target === E[j].source;
      let x = 0, ov = false;
      for (let k = 0; k < a.length - 1; k++) for (let l = 0; l < b.length - 1; l++) {
        if (segsCross(a[k], a[k + 1], b[l], b[l + 1])) x++;
        if (!shared && segsOverlap(a[k], a[k + 1], b[l], b[l + 1])) ov = true;
      }
      crossings += x;
      if (x) add('warning', 'kreuzung', `Verbindungen ${E[i].id} und ${E[j].id} kreuzen sich.`, [E[i].id, E[j].id]);
      if (ov) add('warning', 'linien-uebereinander', `Verbindungen ${E[i].id} und ${E[j].id} liegen übereinander.`, [E[i].id, E[j].id]);
    }
    const labels = [...graph.nodes, ...graph.edges].filter((x) => x.label?.x !== undefined && (x.name || x.label.width));
    for (const l of labels) {
      for (const n of solid) if (n.id !== l.id && overlap(l.label, n, 2)) add('warning', 'beschriftung-verdeckt', `Beschriftung von ${q(l)} überlappt ${q(n)}.`, [l.id, n.id]);
    }
    for (const l of labels) for (const e of graph.edges) {
      const w = e.waypoints ?? [];
      if (e.id !== l.id && w.some((p, i) => i < w.length - 1 && segHitsBox(p, w[i + 1], l.label))) add('warning', 'beschriftung-auf-linie', `Verbindung ${e.id} läuft durch die Beschriftung von ${q(l)}.`, [e.id, l.id]);
    }
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      if (overlap(labels[i].label, labels[j].label, 2)) add('warning', 'beschriftungen-ueberlappen', `Beschriftungen von ${q(labels[i])} und ${q(labels[j])} überlappen sich.`, [labels[i].id, labels[j].id]);
    }
    const odd = solid.filter((n) => isTask(n) && (n.width !== 100 || n.height !== 80));
    if (odd.length) add('hint', 'aufgabengroesse', `Aufgaben sollten gleich groß sein (100×80): ${odd.map(q).join(', ')}.`, odd.map((n) => n.id));
  }

  // ---------- Benennung ----------
  for (const n of graph.nodes) {
    if (isContainer(n) || isArtifact(n)) continue;
    const o = out(n.id), i = inn(n.id);
    if (isTask(n) && !n.name) add('warning', 'name-fehlt', `Aufgabe ${n.id} hat keinen Namen (Schema: Objekt + Verb, z. B. „Antrag prüfen“).`, [n.id]);
    else if (isTask(n) && !/\s/.test(n.name.trim())) add('hint', 'name-schema', `Aufgabe ${q(n)}: Schema „Objekt + Verb“ verwenden (z. B. „Auftrag prüfen“).`, [n.id]);
    if (isEvent(n) && !n.name) add('warning', 'name-fehlt', `Ereignis ${n.id} hat keinen Namen (Schema: Objekt + Partizip, z. B. „Auftrag erhalten“).`, [n.id]);
    if (/^(Exclusive|Inclusive)Gateway$/.test(n.type) && o.length > 1) {
      if (!n.name) add('warning', 'gateway-frage', `Verzweigendes Gateway ${n.id} als Frage benennen (z. B. „Daten korrekt?“).`, [n.id]);
      else if (!n.name.trim().endsWith('?')) add('hint', 'gateway-frage', `Gateway ${q(n)} sollte als Frage formuliert sein.`, [n.id]);
      const unnamed = o.filter((e) => !e.name);
      if (unnamed.length) add('warning', 'antwort-fehlt', `Ausgänge von Gateway ${q(n)} ohne Antwort-Beschriftung: ${unnamed.map((e) => e.id).join(', ')}.`, unnamed.map((e) => e.id));
      const nocond = o.filter((e) => !e.condition && !e.isDefault);
      if (nocond.length) add('warning', 'bedingung-fehlt', `Camunda 8: Ausgänge von ${q(n)} ohne Bedingung und nicht als Standardfluss markiert: ${nocond.map((e) => e.id).join(', ')}.`, nocond.map((e) => e.id));
    }
    // ---------- Struktur ----------
    if (isGateway(n) && i.length > 1 && o.length > 1) add('hint', 'gateway-gemischt', `Gateway ${q(n)} führt zusammen und verzweigt zugleich – besser zwei Gateways (symmetrisch modellieren).`, [n.id]);
    if (!isGateway(n) && n.type !== 'BoundaryEvent' && o.length > 1) add('hint', 'explizites-gateway', `${q(n)} hat mehrere Ausgänge – Verzweigung mit explizitem Gateway modellieren.`, [n.id]);
    if (isTask(n) && i.length > 1) add('hint', 'explizites-gateway', `${q(n)} hat mehrere Eingänge – Zusammenführung mit explizitem Gateway modellieren.`, [n.id]);
    const sub = byId.get(n.parent), eventSub = /SubProcess$/.test(n.type) && n.triggeredByEvent;
    if (!i.length && n.type !== 'StartEvent' && n.type !== 'BoundaryEvent' && !eventSub && !(sub && /AdHoc/.test(sub.type))) add('warning', 'kein-eingang', `${q(n)} hat keinen eingehenden Sequenzfluss.`, [n.id]);
    if (!o.length && n.type !== 'EndEvent' && !eventSub && !(sub && /AdHoc/.test(sub.type)) && !(n.type === 'BoundaryEvent' && n.eventDefinition?.type === 'compensate')) add('warning', 'kein-ausgang', `${q(n)} hat keinen ausgehenden Sequenzfluss.`, [n.id]);
    // ---------- Camunda 8 ----------
    if (n.type === 'IntermediateCatchEvent' && !n.eventDefinition) add('error', 'ereignistyp-fehlt', `Zwischenereignis ${q(n)} hat keinen Typ (Timer, Nachricht, …).`, [n.id]);
    if (n.type === 'BoundaryEvent' && !n.eventDefinition) add('error', 'ereignistyp-fehlt', `Angeheftetes Ereignis ${q(n)} hat keinen Typ.`, [n.id]);
    if (/^(Service|Send)Task$/.test(n.type) && !n.jobType) add('warning', 'jobtyp-fehlt', `Camunda 8: ${q(n)} hat keinen Job-Typ.`, [n.id]);
    if (n.type === 'EventBasedGateway') {
      if (o.length < 2) add('error', 'ereignis-gateway', `Ereignisbasiertes Gateway ${q(n)} braucht mindestens zwei Ausgänge.`, [n.id]);
      for (const e of o) {
        const t = byId.get(e.target);
        if (t && t.type !== 'IntermediateCatchEvent' && t.type !== 'ReceiveTask') add('error', 'ereignis-gateway', `Nach dem ereignisbasierten Gateway ${q(n)} dürfen nur eintretende Ereignisse folgen, nicht ${q(t)}.`, [n.id, t.id]);
        if (e.condition) add('error', 'ereignis-gateway', `Ausgang ${e.id} des ereignisbasierten Gateways darf keine Bedingung haben.`, [e.id]);
      }
    }
  }
  const scopes = new Map();
  for (const n of graph.nodes) if (!isContainer(n) && !isArtifact(n) && n.type !== 'BoundaryEvent') {
    const k = n.parent ?? '';
    if (!scopes.has(k)) scopes.set(k, []);
    scopes.get(k).push(n);
  }
  for (const [k, ns] of scopes) {
    const where = k ? ` in ${q(byId.get(k) ?? { id: k })}` : '';
    if (/AdHoc/.test(byId.get(k)?.type ?? '')) continue;
    if (!ns.some((n) => n.type === 'StartEvent')) add('warning', 'start-fehlt', `Kein Startereignis${where}.`);
    if (!ns.some((n) => n.type === 'EndEvent')) add('warning', 'ende-fehlt', `Kein Endereignis${where}.`);
    const splits = ns.filter((n) => n.type === 'ParallelGateway' && out(n.id).length > 1).length;
    const joins = ns.filter((n) => n.type === 'ParallelGateway' && inn(n.id).length > 1).length;
    if (splits !== joins) add('hint', 'symmetrie', `Symmetrisch modellieren${where}: ${splits} parallele Verzweigung(en), aber ${joins} parallele Zusammenführung(en).`);
  }

  const order = { error: 0, warning: 1, hint: 2 };
  P.sort((a, b) => order[a.severity] - order[b.severity]);
  return { problems: P, crossings };
}

export function formatCheck({ problems, crossings }) {
  if (!problems.length) return 'Keine Auffälligkeiten: Darstellung, Benennung und Struktur entsprechen den Konventionen.';
  const label = { error: 'FEHLER', warning: 'WARNUNG', hint: 'HINWEIS' };
  const count = (s) => problems.filter((p) => p.severity === s).length;
  return [
    `${count('error')} Fehler, ${count('warning')} Warnungen, ${count('hint')} Hinweise (Linienkreuzungen: ${crossings})`,
    ...problems.map((p) => `[${label[p.severity]}] ${p.rule}: ${p.message}`),
  ].join('\n');
}
