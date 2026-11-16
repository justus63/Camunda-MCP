// Prüft ein Diagramm gegen die Modellierungskonventionen (Darstellung, Benennung, Struktur) und – je nach Ebene –
// gegen die Regeln für strategische, operative oder technische (ausführbare) Modelle auf Camunda 7 bzw. 8.
// opts.level: 'strategisch' | 'operativ' | 'technisch' | undefined (= allgemeine Regeln + technische Pflichtangaben ausführbarer Prozesse)
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

export const LEVELS = ['strategisch', 'operativ', 'technisch'];

export function checkDiagram(graph, opts = {}) {
  const level = LEVELS.includes(opts.level) ? opts.level : undefined;
  const c7 = graph.root?.platform === 'camunda7', C = c7 ? 'Camunda 7' : 'Camunda 8';
  const P = [];
  const add = (severity, rule, message, ids = []) => P.push({ severity, rule, message, ids });
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const q = (n) => (n.name ? `„${n.name}“` : n.id);
  const seq = graph.edges.filter((e) => e.type === 'SequenceFlow');
  const out = (id) => seq.filter((e) => e.source === id), inn = (id) => seq.filter((e) => e.target === id);
  const msg = graph.edges.filter((e) => e.type === 'MessageFlow');
  const poolOf = (n) => { for (let x = n; x; x = byId.get(x.parent)) if (x.type === 'Participant') return x; return null; };
  // Technische Pflichtangaben gelten nur für ausführbare Prozesse (im Kollaborationsdiagramm: der Pool der Process Engine).
  const executable = (n) => { const p = poolOf(n); return (p ? p.process?.isExecutable : graph.root?.process?.isExecutable) ?? true; };
  const technical = (n) => level !== 'strategisch' && level !== 'operativ' && executable(n);
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
      if (nocond.length && technical(n)) add('warning', 'bedingung-fehlt', `${C}: Ausgänge von ${q(n)} ohne Bedingung und nicht als Standardfluss markiert: ${nocond.map((e) => e.id).join(', ')}.`, nocond.map((e) => e.id));
      const wrong = o.filter((e) => e.condition && (c7 ? /^\s*=/.test(e.condition) : /^\s*[$#]\{/.test(e.condition)));
      if (wrong.length && technical(n)) add('warning', 'bedingung-syntax', c7 ? `Camunda 7 erwartet Bedingungen als Expression \${...}, nicht als FEEL (=...): ${wrong.map((e) => e.id).join(', ')}.` : `Camunda 8 erwartet FEEL-Bedingungen (= ...), nicht \${...}: ${wrong.map((e) => e.id).join(', ')}.`, wrong.map((e) => e.id));
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
    if (technical(n)) technicalRules(n);
    if (n.type === 'EventBasedGateway') {
      if (o.length < 2) add('error', 'ereignis-gateway', `Ereignisbasiertes Gateway ${q(n)} braucht mindestens zwei Ausgänge.`, [n.id]);
      for (const e of o) {
        const t = byId.get(e.target);
        if (t && t.type !== 'IntermediateCatchEvent' && t.type !== 'ReceiveTask') add('error', 'ereignis-gateway', `Nach dem ereignisbasierten Gateway ${q(n)} dürfen nur eintretende Ereignisse folgen, nicht ${q(t)}.`, [n.id, t.id]);
        if (e.condition) add('error', 'ereignis-gateway', `Ausgang ${e.id} des ereignisbasierten Gateways darf keine Bedingung haben.`, [e.id]);
        if (t && inn(t.id).length > 1) add('error', 'ereignis-gateway', `${q(t)} folgt auf das ereignisbasierte Gateway ${q(n)} und darf keinen weiteren eingehenden Sequenzfluss haben.`, [t.id]);
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

  // ---------- Technische Pflichtangaben je Plattform ----------
  function technicalRules(n) {
    const pr = n.props ?? {}, msgThrow = /^(EndEvent|IntermediateThrowEvent)$/.test(n.type) && n.eventDefinition?.type === 'message';
    if (!c7) {
      if (/^(Service|Send)Task$/.test(n.type) && !n.jobType) add('warning', 'jobtyp-fehlt', `Camunda 8: ${q(n)} hat keinen Job-Typ.`, [n.id]);
      return;
    }
    const impl = pr.class || pr.delegateExpression || pr.expression || pr.topic;
    if (/^(Service|Send)Task$/.test(n.type) && !impl) add('error', 'implementierung-fehlt', `Camunda 7: ${q(n)} braucht class, delegateExpression, expression oder topic (sonst scheitert das Deployment).`, [n.id]);
    if (msgThrow && !impl) add('error', 'implementierung-fehlt', `Camunda 7: auslösendes Nachrichtenereignis ${q(n)} braucht class, delegateExpression, expression oder topic.`, [n.id]);
    if (n.type === 'BusinessRuleTask' && !pr.decisionRef && !impl) add('error', 'implementierung-fehlt', `Camunda 7: ${q(n)} braucht decisionRef (DMN-Tabelle).`, [n.id]);
    if (n.type === 'ScriptTask' && !(pr.scriptFormat && pr.script)) add('error', 'implementierung-fehlt', `Camunda 7: ${q(n)} braucht scriptFormat und script (oder resource).`, [n.id]);
    if (n.type === 'CallActivity' && !pr.calledElement) add('error', 'implementierung-fehlt', `Camunda 7: ${q(n)} braucht calledElement.`, [n.id]);
    if (n.type === 'UserTask') {
      if (!pr.assignee && !pr.candidateGroups && !pr.candidateUsers) add('warning', 'zuweisung-fehlt', `Camunda 7: ${q(n)} ist niemandem zugewiesen (assignee, candidateGroups oder candidateUsers).`, [n.id]);
      if (!pr.formKey && !pr.formRef && !pr.formFields) add('hint', 'formular-fehlt', `Camunda 7: ${q(n)} hat kein Formular (formKey, formRef oder formFields) – die Tasklist zeigt nur das generische Formular.`, [n.id]);
    }
    if (n.type === 'ManualTask' || n.type === 'Task') add('hint', 'task-typ', `${q(n)} ist ${n.type === 'Task' ? 'untypisiert' : 'ein Manual Task'} – die Process Engine führt ihn nicht aus (Tasks typisieren).`, [n.id]);
  }
  if (c7 && level !== 'strategisch' && level !== 'operativ') {
    const procs = [graph.root?.process, ...graph.nodes.filter((n) => n.type === 'Participant').map((n) => n.process)].filter((p) => p?.isExecutable);
    for (const p of procs) if (!p.historyTimeToLive) add('warning', 'history-ttl', `Camunda 7: Prozess ${p.processId} hat kein historyTimeToLive (ab 7.20 lehnt die Engine das Deployment sonst ab).`);
    if (level === 'technisch' && !procs.length) add('error', 'nicht-ausfuehrbar', 'Kein Prozess ist als ausführbar markiert (isExecutable).');
  }

  // ---------- Kollaboration: Nachrichtenflüsse ----------
  if (level !== 'strategisch') {
    const mOut = (id) => msg.filter((e) => e.source === id), mIn = (id) => msg.filter((e) => e.target === id);
    const expanded = graph.nodes.filter((n) => n.type === 'Participant' && n.expanded !== false);
    for (const e of msg) {
      for (const [id, role] of [[e.source, 'beginnt'], [e.target, 'endet']]) {
        const n = byId.get(id);
        if (n && isEvent(n) && n.eventDefinition?.type !== 'message') add('error', 'nachrichtenfluss-ereignis', `Nachrichtenfluss ${e.id} ${role} an ${q(n)}, das kein Nachrichtenereignis ist.`, [e.id, n.id]);
      }
      const s = byId.get(e.source);
      if (s && s.type === 'ReceiveTask') add('warning', 'nachrichtenfluss-richtung', `Aus dem Receive Task ${q(s)} läuft ein Nachrichtenfluss heraus.`, [e.id]);
      const t = byId.get(e.target);
      if (t && t.type === 'SendTask') add('warning', 'nachrichtenfluss-richtung', `In den Send Task ${q(t)} läuft ein Nachrichtenfluss hinein.`, [e.id]);
    }
    for (const n of graph.nodes) {
      if (isContainer(n) || isArtifact(n)) continue;
      const many = (list, word) => {
        if (list.length > 1 && n.type !== 'StartEvent' && n.type !== 'EndEvent') add('hint', 'mehrere-nachrichtenfluesse', `${q(n)} hat ${list.length} ${word} Nachrichtenflüsse – nur Start- und Endereignisse dürfen mehrere haben (sonst je Nachricht ein eigenes Ereignis/Task).`, [n.id]);
      };
      many(mIn(n.id), 'eingehende');
      many(mOut(n.id), 'ausgehende');
      if (expanded.length > 1 && poolOf(n)?.expanded !== false) {
        const def = n.eventDefinition?.type === 'message';
        const sends = n.type === 'SendTask' || (def && /^(EndEvent|IntermediateThrowEvent)$/.test(n.type));
        const receives = n.type === 'ReceiveTask' || (def && /^(StartEvent|IntermediateCatchEvent|BoundaryEvent)$/.test(n.type));
        if (sends && !mOut(n.id).length) add('hint', 'nachrichtenfluss-fehlt', `${q(n)} sendet eine Nachricht, hat aber keinen ausgehenden Nachrichtenfluss.`, [n.id]);
        if (receives && !mIn(n.id).length) add('hint', 'nachrichtenfluss-fehlt', `${q(n)} empfängt eine Nachricht, hat aber keinen eingehenden Nachrichtenfluss.`, [n.id]);
      }
    }
  }

  // ---------- Semantik: Deadlocks und fehlende Synchronisation (Heuristik über den nächsten gemeinsamen Verzweigungspunkt) ----------
  const preds = (id) => {
    const n = byId.get(id);
    const list = inn(id).map((e) => ({ id: e.source, via: null }));
    if (n?.type === 'BoundaryEvent' && n.host) list.push({ id: n.host, via: n });
    return list;
  };
  const ancestors = (start, stop) => {
    const dist = new Map([[start, { d: 0, via: null }]]), queue = [start];
    while (queue.length) {
      const v = queue.shift();
      for (const p of preds(v)) {
        if (p.id === stop || dist.has(p.id)) continue;
        dist.set(p.id, { d: dist.get(v).d + 1, via: p.via });
        queue.push(p.id);
      }
    }
    return dist;
  };
  const seen = new Set();
  for (const j of graph.nodes) {
    const i = inn(j.id);
    if (i.length < 2 || isContainer(j) || /^(Inclusive|Complex|EventBased)Gateway$/.test(j.type)) continue;
    const and = j.type === 'ParallelGateway';
    const sets = i.map((e) => ancestors(e.source, j.id));
    for (let a = 0; a < sets.length; a++) for (let b = a + 1; b < sets.length; b++) {
      let best = null;
      for (const [id, x] of sets[a]) {
        const y = sets[b].get(id), n = byId.get(id);
        if (!y || !n) continue;
        const viaBoundary = x.via ?? y.via;
        if (out(id).length < 2 && !viaBoundary) continue;
        if (!best || x.d + y.d < best.d) best = { d: x.d + y.d, n, viaBoundary };
      }
      if (!best || seen.has(`${j.id}|${best.n.id}`)) continue;
      const { n, viaBoundary } = best;
      const exclusive = viaBoundary ? !viaBoundary.nonInterrupting : /^(Exclusive|EventBased)Gateway$/.test(n.type) || !isGateway(n);
      const parallel = viaBoundary ? !!viaBoundary.nonInterrupting : n.type === 'ParallelGateway';
      if (and && exclusive) {
        seen.add(`${j.id}|${n.id}`);
        add('warning', 'deadlock', `Möglicher Deadlock: das parallele Gateway ${q(j)} wartet auf alle Eingänge, aber ${q(n)} aktiviert die Zweige nur alternativ.`, [j.id, n.id]);
      } else if (!and && parallel) {
        seen.add(`${j.id}|${n.id}`);
        add('hint', 'fehlende-synchronisation', `Fehlende Synchronisation: die parallelen Zweige ab ${q(n)} laufen bei ${q(j)} ohne paralleles Gateway zusammen – alles danach wird mehrfach ausgeführt.`, [j.id, n.id]);
      }
    }
  }

  // ---------- Ebene: strategisches bzw. operatives Modell (Empfehlungen aus der Vorlesung) ----------
  const flowNodes = graph.nodes.filter((n) => !isContainer(n) && !isArtifact(n));
  const expandedPools = graph.nodes.filter((n) => n.type === 'Participant' && n.expanded !== false);
  if (level === 'strategisch') {
    const steps = graph.nodes.filter((n) => isTask(n) || (/SubProcess$/.test(n.type) && !n.triggeredByEvent));
    if (steps.length > 10) add('warning', 'strategisch-umfang', `Strategisches Modell: ${steps.length} Schritte – grob granular bleiben (höchstens 10 Schritte, eine A4-Seite).`);
    const typed = steps.filter((n) => /^(User|Service|Script|BusinessRule|Send|Receive|Manual)Task$/.test(n.type));
    if (typed.length) add('hint', 'strategisch-abstrakt', `Strategisches Modell: abstrakte Tasks ohne Typ und Marker verwenden (${typed.map(q).join(', ')}).`, typed.map((n) => n.id));
    const marked = graph.nodes.filter((n) => n.loop);
    if (marked.length) add('hint', 'strategisch-abstrakt', `Strategisches Modell: keine Schleifen-/Mehrfach-Marker (${marked.map(q).join(', ')}).`, marked.map((n) => n.id));
    const gws = flowNodes.filter(isGateway), bad = gws.filter((n) => /^(Inclusive|Complex|EventBased)Gateway$/.test(n.type));
    if (bad.length) add('warning', 'strategisch-gateway', `Strategisches Modell: keine inklusiven, komplexen oder ereignisbasierten Gateways (${bad.map(q).join(', ')}).`, bad.map((n) => n.id));
    if (gws.length > 2) add('hint', 'strategisch-gateway', `Strategisches Modell: ${gws.length} Gateways – Gateways vermeiden und auf den Standardablauf („Happy Case“) beschränken.`);
    const special = graph.nodes.filter((n) => n.type === 'BoundaryEvent' || n.triggeredByEvent || (/SubProcess|Transaction/.test(n.type) && n.expanded !== false));
    if (special.length) add('hint', 'strategisch-symbole', `Strategisches Modell: Symbolumfang minimieren – keine angehefteten Ereignisse, Ereignis-Teilprozesse oder ausmodellierten Teilprozesse (${special.map(q).join(', ')}).`, special.map((n) => n.id));
    const events = flowNodes.filter((n) => /^Intermediate/.test(n.type));
    if (events.length > 3) add('hint', 'strategisch-symbole', `Strategisches Modell: ${events.length} Zwischenereignisse – nur wichtige Meilensteine, sparsam einsetzen.`);
    if (expandedPools.length > 1 || msg.length) add('hint', 'strategisch-pool', 'Strategisches Modell: ein Pool mit Lanes je Aufgabenträger; Kommunikation über Datenobjekte statt Nachrichtenflüsse darstellen.');
    if (!graph.nodes.some((n) => n.type === 'Lane')) add('hint', 'strategisch-pool', 'Strategisches Modell: Verantwortlichkeiten über Lanes zuordnen.');
  }
  if (level === 'operativ') {
    if (expandedPools.length < 2) add('warning', 'operativ-pools', 'Operatives Modell: als Kollaborationsdiagramm mit mehreren ausmodellierten Pools modellieren (menschliche Flüsse und Process Engine getrennt).');
    if (expandedPools.length > 1 && !msg.length) add('warning', 'operativ-pools', 'Operatives Modell: die Pools tauschen keine Nachrichten aus.');
    if (!graph.nodes.some((n) => /^Data/.test(n.type))) add('hint', 'operativ-datenfluss', 'Operatives Modell: Datenfluss fehlt (Datenobjekte/-speicher mit Lese- und Schreibzugriff).');
    const abstract = flowNodes.filter((n) => n.type === 'Task' && poolOf(n)?.process?.isExecutable);
    if (abstract.length) add('hint', 'task-typ', `Im Pool der Process Engine die Tasks typisieren (${abstract.map(q).join(', ')}).`, abstract.map((n) => n.id));
  }

  const order = { error: 0, warning: 1, hint: 2 };
  P.sort((a, b) => order[a.severity] - order[b.severity]);
  return { problems: P, crossings, inventory: inventory(graph, byId) };
}

// Welche Konstrukte kommen vor? (Basis- und fortgeschrittene Konstrukte laut Bewertungsbogen)
function inventory(graph, byId) {
  const N = graph.nodes, count = (f) => N.filter(f).length;
  const host = (n) => byId.get(n.host);
  const isSubP = (n) => /SubProcess|Transaction/.test(n?.type ?? '');
  const gw = {};
  for (const n of N.filter(isGateway)) gw[n.type.replace('Gateway', '')] = (gw[n.type.replace('Gateway', '')] ?? 0) + 1;
  const ev = {};
  for (const n of N.filter((n) => isEvent(n) && n.eventDefinition)) ev[n.eventDefinition.type] = (ev[n.eventDefinition.type] ?? 0) + 1;
  return {
    pools: count((n) => n.type === 'Participant' && n.expanded !== false), zugeklapptePools: count((n) => n.type === 'Participant' && n.expanded === false),
    lanes: count((n) => n.type === 'Lane'), nachrichtenfluesse: graph.edges.filter((e) => e.type === 'MessageFlow').length,
    datenobjekte: count((n) => /^Data/.test(n.type)), datenassoziationen: graph.edges.filter((e) => /^Data/.test(e.type)).length,
    gateways: gw, ereignistypen: ev,
    boundaryAnTasks: count((n) => n.type === 'BoundaryEvent' && !isSubP(host(n))), boundaryAnTeilprozessen: count((n) => n.type === 'BoundaryEvent' && isSubP(host(n))),
    mehrfachinstanzen: count((n) => n.loop === 'parallel' || n.loop === 'sequential'), schleifen: count((n) => n.loop === 'loop'),
    ereignisTeilprozesse: count((n) => n.triggeredByEvent), teilprozesse: count((n) => isSubP(n) && !n.triggeredByEvent), callActivities: count((n) => n.type === 'CallActivity'),
    tasks: count((n) => /Task$/.test(n.type)),
  };
}

export function formatInventory(inv) {
  const obj = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') || '–';
  return [
    `Umfang: ${inv.pools} ausmodellierte Pools, ${inv.zugeklapptePools} zugeklappte, ${inv.lanes} Lanes, ${inv.tasks} Tasks.`,
    `Basiskonstrukte: ${inv.nachrichtenfluesse} Nachrichtenflüsse, ${inv.datenobjekte} Datenobjekte/-speicher (${inv.datenassoziationen} Datenassoziationen), Gateways: ${obj(inv.gateways)}, ${inv.boundaryAnTasks} angeheftete Ereignisse an Tasks.`,
    `Fortgeschrittene Konstrukte: ${inv.mehrfachinstanzen} Mehrfachinstanzen, ${inv.ereignisTeilprozesse} Ereignis-Teilprozesse, ${inv.teilprozesse} Teilprozesse (${inv.boundaryAnTeilprozessen} angeheftete Ereignisse an Teilprozessen), ${inv.callActivities} Call Activities; Ereignistypen: ${obj(inv.ereignistypen)}.`,
  ].join('\n');
}

export function formatCheck({ problems, crossings }) {
  if (!problems.length) return 'Keine Auffälligkeiten: Darstellung, Benennung und Struktur entsprechen den Konventionen.';
  const label = { error: 'FEHLER', warning: 'WARNUNG', hint: 'HINWEIS' };
  const count = (s) => problems.filter((p) => p.severity === s).length;
  return [
    `${count('error')} Fehler, ${count('warning')} Warnungen, ${count('hint')} Hinweise (Linienkreuzungen: ${crossings})`,
    ...group(problems).map((p) => `[${label[p.severity]}] ${p.rule}: ${p.message}`),
  ].join('\n');
}

// Viele gleichartige Meldungen (z. B. Kreuzungen) zu einer Zeile zusammenfassen: spart Tokens bei großen Diagrammen.
function group(problems, limit = 6) {
  const byRule = new Map();
  for (const p of problems) { if (!byRule.has(p.rule + p.severity)) byRule.set(p.rule + p.severity, []); byRule.get(p.rule + p.severity).push(p); }
  const out = [];
  for (const list of byRule.values()) {
    if (list.length <= limit) { out.push(...list); continue; }
    out.push(...list.slice(0, limit - 1), { ...list[0], message: `… und ${list.length - limit + 1} weitere Meldungen dieser Art (${[...new Set(list.slice(limit - 1).flatMap((p) => p.ids))].slice(0, 12).join(', ')}${list.length > limit + 5 ? ', …' : ''}).` });
  }
  const order = { error: 0, warning: 1, hint: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}
