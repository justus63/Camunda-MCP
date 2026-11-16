// Checks a diagram against the modeling conventions (layout, naming, structure) and – depending on the level –
// against the rules for strategic, operational or technical (executable) models on Camunda 7 or 8.
// opts.level: 'strategic' | 'operational' | 'technical' | undefined (= general rules + technical requirements of executable processes)
// Input: graph with geometry { nodes:[{id,type,name,x,y,width,height,host,label,...}], edges:[{id,type,source,target,name,waypoints,label,...}] }
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

export const LEVELS = ['strategic', 'operational', 'technical'];
// German level names from earlier versions are still accepted.
export const LEVEL_ALIASES = { strategisch: 'strategic', operativ: 'operational', technisch: 'technical' };
export const normalizeLevel = (l) => (LEVELS.includes(l) ? l : LEVEL_ALIASES[l]);

// Mini step: short segment (≤ STEP px) between two parallel segments of the same direction (looks like a kink).
export const STEP = 10;
export function miniSteps(w = []) {
  const found = [];
  for (let i = 1; i < w.length - 2; i++) {
    const [a, b, c, d] = [w[i - 1], w[i], w[i + 1], w[i + 2]];
    const h = a.y === b.y && b.x === c.x && c.y === d.y && Math.abs(c.y - b.y) > 0 && Math.abs(c.y - b.y) <= STEP && (b.x - a.x) * (d.x - c.x) > 0;
    const v = a.x === b.x && b.y === c.y && c.x === d.x && Math.abs(c.x - b.x) > 0 && Math.abs(c.x - b.x) <= STEP && (b.y - a.y) * (d.y - c.y) > 0;
    if (h || v) found.push({ i, axis: h ? 'y' : 'x', off: h ? c.y - b.y : c.x - b.x });
  }
  return found;
}

// Checks the main level and all drill-down planes (collapsed subprocesses) and merges the results.
export function checkAll(graphs, opts = {}) {
  const res = graphs.map((g) => ({ g, r: checkDiagram(g, opts) }));
  const problems = res.flatMap(({ g, r }) => g.root?.plane ? r.problems.map((p) => ({ ...p, message: `[Plane ${g.root.planeName ? `"${g.root.planeName}"` : g.root.plane}] ${p.message}` })) : r.problems);
  const order = { error: 0, warning: 1, hint: 2 };
  problems.sort((a, b) => order[a.severity] - order[b.severity]);
  const inv = res.map(({ r }) => r.inventory).reduce((a, b) => {
    const o = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (typeof v === 'number') o[k] = (o[k] ?? 0) + v;
      else { o[k] = { ...(o[k] ?? {}) }; for (const [kk, vv] of Object.entries(v)) o[k][kk] = (o[k][kk] ?? 0) + vv; }
    }
    return o;
  });
  return { problems, crossings: res.reduce((s, { r }) => s + r.crossings, 0), inventory: { ...inv, planes: graphs.length - 1 } };
}

export function checkDiagram(graph, opts = {}) {
  const level = normalizeLevel(opts.level);
  // Drill-down plane of a collapsed subprocess: only element rules, not the rules for the whole model (pools, lanes, size).
  const subPlane = !!graph.root?.plane;
  const c7 = graph.root?.platform === 'camunda7', C = c7 ? 'Camunda 7' : 'Camunda 8';
  const P = [];
  const add = (severity, rule, message, ids = []) => P.push({ severity, rule, message, ids });
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const q = (n) => (n.name ? `"${n.name}"` : n.id);
  const seq = graph.edges.filter((e) => e.type === 'SequenceFlow');
  const out = (id) => seq.filter((e) => e.source === id), inn = (id) => seq.filter((e) => e.target === id);
  const msg = graph.edges.filter((e) => e.type === 'MessageFlow');
  const poolOf = (n) => { for (let x = n; x; x = byId.get(x.parent)) if (x.type === 'Participant') return x; return null; };
  // Technical requirements only apply to executable processes (in a collaboration diagram: the process engine's pool).
  const executable = (n) => { const p = poolOf(n); return (p ? p.process?.isExecutable : graph.root?.process?.isExecutable) ?? true; };
  const technical = (n) => level !== 'strategic' && level !== 'operational' && executable(n);
  const solid = graph.nodes.filter((n) => !isContainer(n) && n.type !== 'Group' && n.x !== undefined);
  const hasGeo = solid.length > 0;

  // ---------- Layout ----------
  let crossings = 0;
  if (hasGeo) {
    for (const e of graph.edges) {
      const w = e.waypoints ?? [];
      for (const n of solid) {
        if (n.id === e.source || n.id === e.target || byId.get(e.source)?.host === n.id) continue;
        if (w.some((p, i) => i < w.length - 1 && segHitsBox(p, w[i + 1], n))) add('error', 'line-through-element', `Connection ${e.id} (${e.source} → ${e.target}) runs through ${q(n)}.`, [e.id, n.id]);
      }
      if (e.type === 'SequenceFlow' && w.some((p, i) => i < w.length - 1 && p.x !== w[i + 1].x && p.y !== w[i + 1].y)) add('hint', 'diagonal-line', `Connection ${e.id} runs diagonally instead of at right angles.`, [e.id]);
      if (miniSteps(w).length) add('warning', 'mini-step', `Connection ${e.id} (${e.source} → ${e.target}) has a small kink (step ≤ ${STEP} px) – relayout straightens it.`, [e.id]);
    }
    for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i], b = solid[j];
      if (a.host === b.id || b.host === a.id) continue;
      if (overlap(a, b)) add('error', 'overlap', `${q(a)} and ${q(b)} overlap.`, [a.id, b.id]);
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
      if (x) add('warning', 'crossing', `Connections ${E[i].id} and ${E[j].id} cross.`, [E[i].id, E[j].id]);
      if (ov) add('warning', 'lines-overlap', `Connections ${E[i].id} and ${E[j].id} run on top of each other.`, [E[i].id, E[j].id]);
    }
    const labels = [...graph.nodes, ...graph.edges].filter((x) => x.label?.x !== undefined && (x.name || x.label.width));
    for (const l of labels) {
      for (const n of solid) if (n.id !== l.id && overlap(l.label, n, 2)) add('warning', 'label-covered', `The label of ${q(l)} overlaps ${q(n)}.`, [l.id, n.id]);
    }
    for (const l of labels) for (const e of graph.edges) {
      const w = e.waypoints ?? [];
      if (e.id !== l.id && w.some((p, i) => i < w.length - 1 && segHitsBox(p, w[i + 1], l.label))) add('warning', 'label-on-line', `Connection ${e.id} runs through the label of ${q(l)}.`, [e.id, l.id]);
    }
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      if (overlap(labels[i].label, labels[j].label, 2)) add('warning', 'labels-overlap', `The labels of ${q(labels[i])} and ${q(labels[j])} overlap.`, [labels[i].id, labels[j].id]);
    }
    const odd = solid.filter((n) => isTask(n) && (n.width !== 100 || n.height !== 80));
    if (odd.length) add('hint', 'task-size', `Tasks should all have the same size (100×80): ${odd.map(q).join(', ')}.`, odd.map((n) => n.id));
  }

  // ---------- Naming ----------
  for (const n of graph.nodes) {
    if (isContainer(n) || isArtifact(n)) continue;
    const o = out(n.id), i = inn(n.id);
    if (isTask(n) && !n.name) add('warning', 'name-missing', `Task ${n.id} has no name (pattern: verb + object, e.g. "Check application").`, [n.id]);
    else if (isTask(n) && !/\s/.test(n.name.trim()) && !(/SubProcess$/.test(n.type) && n.expanded === false)) add('hint', 'name-pattern', `Task ${q(n)}: use the pattern "verb + object" (e.g. "Check order").`, [n.id]);
    // bpmn-js breaks overly long words in the middle ("Applicationappr|oval"): insert a soft hyphen (U+00AD) or a hyphen.
    const longWords = (n.name ?? '').split(/[\s/]+/).filter((w) => w.length > 13 && !/[\u00AD-]/.test(w));
    if (longWords.length) add('hint', 'hyphenation', `${q(n)}: ${longWords.map((w) => `"${w}"`).join(', ')} is broken in the middle of the word – insert a soft hyphen \\u00AD (e.g. "Pre\\u00ADauthorization", only visible at the line break).`, [n.id]);
    if (isEvent(n) && !n.name) add('warning', 'name-missing', `Event ${n.id} has no name (pattern: object + past participle, e.g. "Order received").`, [n.id]);
    if (/^(Exclusive|Inclusive)Gateway$/.test(n.type) && o.length > 1) {
      if (!n.name) add('warning', 'gateway-question', `Name the splitting gateway ${n.id} as a question (e.g. "Data correct?").`, [n.id]);
      else if (!n.name.trim().endsWith('?')) add('hint', 'gateway-question', `Gateway ${q(n)} should be phrased as a question.`, [n.id]);
      const unnamed = o.filter((e) => !e.name);
      if (unnamed.length) add('warning', 'answer-missing', `Outgoing flows of gateway ${q(n)} without an answer label: ${unnamed.map((e) => e.id).join(', ')}.`, unnamed.map((e) => e.id));
      const nocond = o.filter((e) => !e.condition && !e.isDefault);
      if (nocond.length && technical(n)) add('warning', 'condition-missing', `${C}: outgoing flows of ${q(n)} without a condition and not marked as default flow: ${nocond.map((e) => e.id).join(', ')}.`, nocond.map((e) => e.id));
      const wrong = o.filter((e) => e.condition && (c7 ? /^\s*=/.test(e.condition) : /^\s*[$#]\{/.test(e.condition)));
      if (wrong.length && technical(n)) add('warning', 'condition-syntax', c7 ? `Camunda 7 expects conditions as expressions \${...}, not as FEEL (=...): ${wrong.map((e) => e.id).join(', ')}.` : `Camunda 8 expects FEEL conditions (= ...), not \${...}: ${wrong.map((e) => e.id).join(', ')}.`, wrong.map((e) => e.id));
    }
    // ---------- Structure ----------
    if (isGateway(n) && i.length > 1 && o.length > 1) add('hint', 'gateway-mixed', `Gateway ${q(n)} both merges and splits – better use two gateways (model symmetrically).`, [n.id]);
    if (!isGateway(n) && n.type !== 'BoundaryEvent' && o.length > 1) add('hint', 'explicit-gateway', `${q(n)} has several outgoing flows – model the split with an explicit gateway.`, [n.id]);
    if (isTask(n) && i.length > 1) add('hint', 'explicit-gateway', `${q(n)} has several incoming flows – model the merge with an explicit gateway.`, [n.id]);
    const sub = byId.get(n.parent), eventSub = /SubProcess$/.test(n.type) && n.triggeredByEvent;
    if (!i.length && n.type !== 'StartEvent' && n.type !== 'BoundaryEvent' && !eventSub && !(sub && /AdHoc/.test(sub.type))) add('warning', 'no-incoming', `${q(n)} has no incoming sequence flow.`, [n.id]);
    if (!o.length && n.type !== 'EndEvent' && !eventSub && !(sub && /AdHoc/.test(sub.type)) && !(n.type === 'BoundaryEvent' && n.eventDefinition?.type === 'compensate')) add('warning', 'no-outgoing', `${q(n)} has no outgoing sequence flow.`, [n.id]);
    // ---------- Camunda 8 ----------
    if (n.type === 'IntermediateCatchEvent' && !n.eventDefinition) add('error', 'event-type-missing', `Intermediate event ${q(n)} has no type (timer, message, …).`, [n.id]);
    if (n.type === 'BoundaryEvent' && !n.eventDefinition) add('error', 'event-type-missing', `Boundary event ${q(n)} has no type.`, [n.id]);
    if (n.eventDefinition?.type === 'conditional' && !n.eventDefinition.value && technical(n)) add('error', 'condition-missing', `Conditional event ${q(n)} has no condition (${c7 ? '${…}' : '= …'}).`, [n.id]);
    if (technical(n)) technicalRules(n);
    if (n.type === 'EventBasedGateway') {
      if (o.length < 2) add('error', 'event-gateway', `Event-based gateway ${q(n)} needs at least two outgoing flows.`, [n.id]);
      for (const e of o) {
        const t = byId.get(e.target);
        if (t && t.type !== 'IntermediateCatchEvent' && t.type !== 'ReceiveTask') add('error', 'event-gateway', `Only catching events may follow the event-based gateway ${q(n)}, not ${q(t)}.`, [n.id, t.id]);
        if (e.condition) add('error', 'event-gateway', `Outgoing flow ${e.id} of the event-based gateway must not have a condition.`, [e.id]);
        if (t && inn(t.id).length > 1) add('error', 'event-gateway', `${q(t)} follows the event-based gateway ${q(n)} and must not have any other incoming sequence flow.`, [t.id]);
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
    if (!ns.some((n) => n.type === 'StartEvent')) add('warning', 'start-missing', `No start event${where}.`);
    if (!ns.some((n) => n.type === 'EndEvent')) add('warning', 'end-missing', `No end event${where}.`);
    const splits = ns.filter((n) => n.type === 'ParallelGateway' && out(n.id).length > 1).length;
    const joins = ns.filter((n) => n.type === 'ParallelGateway' && inn(n.id).length > 1).length;
    if (splits !== joins) add('hint', 'symmetry', `Model symmetrically${where}: ${splits} parallel split(s), but ${joins} parallel join(s).`);
  }

  // ---------- Technical requirements per platform ----------
  function technicalRules(n) {
    const pr = n.props ?? {}, msgThrow = /^(EndEvent|IntermediateThrowEvent)$/.test(n.type) && n.eventDefinition?.type === 'message';
    if (!c7) {
      if (/^(Service|Send)Task$/.test(n.type) && !n.jobType) add('warning', 'job-type-missing', `Camunda 8: ${q(n)} has no job type.`, [n.id]);
      return;
    }
    const impl = pr.class || pr.delegateExpression || pr.expression || pr.topic;
    if (/^(Service|Send)Task$/.test(n.type) && !impl) add('error', 'implementation-missing', `Camunda 7: ${q(n)} needs class, delegateExpression, expression or topic (otherwise the deployment fails).`, [n.id]);
    if (msgThrow && !impl) add('error', 'implementation-missing', `Camunda 7: throwing message event ${q(n)} needs class, delegateExpression, expression or topic.`, [n.id]);
    if (n.type === 'BusinessRuleTask' && !pr.decisionRef && !impl) add('error', 'implementation-missing', `Camunda 7: ${q(n)} needs decisionRef (DMN table).`, [n.id]);
    if (n.type === 'ScriptTask' && !(pr.scriptFormat && pr.script)) add('error', 'implementation-missing', `Camunda 7: ${q(n)} needs scriptFormat and script (or resource).`, [n.id]);
    if (n.type === 'CallActivity' && !pr.calledElement) add('error', 'implementation-missing', `Camunda 7: ${q(n)} needs calledElement.`, [n.id]);
    if (n.type === 'UserTask') {
      if (!pr.assignee && !pr.candidateGroups && !pr.candidateUsers) add('warning', 'assignment-missing', `Camunda 7: ${q(n)} is not assigned to anyone (assignee, candidateGroups or candidateUsers).`, [n.id]);
      if (!pr.formKey && !pr.formRef && !pr.formFields) add('hint', 'form-missing', `Camunda 7: ${q(n)} has no form (formKey, formRef or formFields) – the Tasklist only shows the generic form.`, [n.id]);
    }
    if (n.type === 'ManualTask' || n.type === 'Task') add('hint', 'task-type', `${q(n)} is ${n.type === 'Task' ? 'untyped' : 'a manual task'} – the process engine does not execute it (give tasks a type).`, [n.id]);
  }
  if (c7 && level !== 'strategic' && level !== 'operational' && !subPlane) {
    const procs = [graph.root?.process, ...graph.nodes.filter((n) => n.type === 'Participant').map((n) => n.process)].filter((p) => p?.isExecutable);
    for (const p of procs) if (!p.historyTimeToLive) add('warning', 'history-ttl', `Camunda 7: process ${p.processId} has no historyTimeToLive (since 7.20 the engine rejects the deployment otherwise).`);
    if (level === 'technical' && !procs.length) add('error', 'not-executable', 'No process is marked as executable (isExecutable).');
  }

  // ---------- Collaboration: message flows ----------
  if (level !== 'strategic') {
    const mOut = (id) => msg.filter((e) => e.source === id), mIn = (id) => msg.filter((e) => e.target === id);
    const expanded = graph.nodes.filter((n) => n.type === 'Participant' && n.expanded !== false);
    for (const e of msg) {
      for (const [id, role] of [[e.source, 'starts'], [e.target, 'ends']]) {
        const n = byId.get(id);
        if (n && isEvent(n) && n.eventDefinition?.type !== 'message') add('error', 'message-flow-event', `Message flow ${e.id} ${role} at ${q(n)}, which is not a message event.`, [e.id, n.id]);
      }
      const s = byId.get(e.source);
      if (s && s.type === 'ReceiveTask') add('warning', 'message-flow-direction', `A message flow leaves the receive task ${q(s)}.`, [e.id]);
      const t = byId.get(e.target);
      if (t && t.type === 'SendTask') add('warning', 'message-flow-direction', `A message flow enters the send task ${q(t)}.`, [e.id]);
    }
    for (const n of graph.nodes) {
      if (isContainer(n) || isArtifact(n)) continue;
      const many = (list, word) => {
        if (list.length > 1 && n.type !== 'StartEvent' && n.type !== 'EndEvent') add('hint', 'multiple-message-flows', `${q(n)} has ${list.length} ${word} message flows – only start and end events may have several (otherwise use one event/task per message).`, [n.id]);
      };
      many(mIn(n.id), 'incoming');
      many(mOut(n.id), 'outgoing');
      if (expanded.length > 1 && poolOf(n)?.expanded !== false) {
        const def = n.eventDefinition?.type === 'message';
        const sends = n.type === 'SendTask' || (def && /^(EndEvent|IntermediateThrowEvent)$/.test(n.type));
        const receives = n.type === 'ReceiveTask' || (def && /^(StartEvent|IntermediateCatchEvent|BoundaryEvent)$/.test(n.type));
        if (sends && !mOut(n.id).length) add('hint', 'message-flow-missing', `${q(n)} sends a message but has no outgoing message flow.`, [n.id]);
        if (receives && !mIn(n.id).length) add('hint', 'message-flow-missing', `${q(n)} receives a message but has no incoming message flow.`, [n.id]);
      }
    }
  }

  // ---------- Semantics: deadlocks and missing synchronization (heuristic via the nearest common split point) ----------
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
        add('warning', 'deadlock', `Possible deadlock: the parallel gateway ${q(j)} waits for all incoming flows, but ${q(n)} only activates the branches alternatively.`, [j.id, n.id]);
      } else if (!and && parallel) {
        seen.add(`${j.id}|${n.id}`);
        add('hint', 'missing-synchronization', `Missing synchronization: the parallel branches from ${q(n)} merge at ${q(j)} without a parallel gateway – everything after it runs several times.`, [j.id, n.id]);
      }
    }
  }

  // ---------- Level: strategic or operational model ----------
  const flowNodes = graph.nodes.filter((n) => !isContainer(n) && !isArtifact(n));
  const expandedPools = graph.nodes.filter((n) => n.type === 'Participant' && n.expanded !== false);
  if (level === 'strategic' && !subPlane) {
    const steps = graph.nodes.filter((n) => isTask(n) || (/SubProcess$/.test(n.type) && !n.triggeredByEvent));
    if (steps.length > 10) add('warning', 'strategic-size', `Strategic model: ${steps.length} steps – stay coarse-grained (at most 10 steps, one A4 page).`);
    const typed = steps.filter((n) => /^(User|Service|Script|BusinessRule|Send|Receive|Manual)Task$/.test(n.type));
    if (typed.length) add('hint', 'strategic-abstract', `Strategic model: use abstract tasks without type and markers (${typed.map(q).join(', ')}).`, typed.map((n) => n.id));
    const marked = graph.nodes.filter((n) => n.loop);
    if (marked.length) add('hint', 'strategic-abstract', `Strategic model: no loop/multi-instance markers (${marked.map(q).join(', ')}).`, marked.map((n) => n.id));
    const gws = flowNodes.filter(isGateway), bad = gws.filter((n) => /^(Inclusive|Complex|EventBased)Gateway$/.test(n.type));
    if (bad.length) add('warning', 'strategic-gateway', `Strategic model: no inclusive, complex or event-based gateways (${bad.map(q).join(', ')}).`, bad.map((n) => n.id));
    if (gws.length > 2) add('hint', 'strategic-gateway', `Strategic model: ${gws.length} gateways – avoid gateways and stick to the standard flow ("happy path").`);
    const special = graph.nodes.filter((n) => n.type === 'BoundaryEvent' || n.triggeredByEvent || (/SubProcess|Transaction/.test(n.type) && n.expanded !== false));
    if (special.length) add('hint', 'strategic-symbols', `Strategic model: keep the symbol set minimal – no boundary events, event subprocesses or expanded subprocesses (${special.map(q).join(', ')}).`, special.map((n) => n.id));
    const events = flowNodes.filter((n) => /^Intermediate/.test(n.type));
    if (events.length > 3) add('hint', 'strategic-symbols', `Strategic model: ${events.length} intermediate events – only for important milestones, use sparingly.`);
    if (expandedPools.length > 1 || msg.length) add('hint', 'strategic-pool', 'Strategic model: one pool with a lane per role; show communication with data objects instead of message flows.');
    if (!graph.nodes.some((n) => n.type === 'Lane')) add('hint', 'strategic-pool', 'Strategic model: assign responsibilities with lanes.');
  }
  if (level === 'operational' && !subPlane) {
    if (expandedPools.length < 2) add('warning', 'operational-pools', 'Operational model: model it as a collaboration diagram with several expanded pools (human flows and process engine separated).');
    if (expandedPools.length > 1 && !msg.length) add('warning', 'operational-pools', 'Operational model: the pools do not exchange any messages.');
    if (!graph.nodes.some((n) => /^Data/.test(n.type))) add('hint', 'operational-data-flow', 'Operational model: data flow is missing (data objects/stores with read and write access).');
    const abstract = flowNodes.filter((n) => n.type === 'Task' && poolOf(n)?.process?.isExecutable);
    if (abstract.length) add('hint', 'task-type', `Give the tasks in the process engine's pool a type (${abstract.map(q).join(', ')}).`, abstract.map((n) => n.id));
  }

  const order = { error: 0, warning: 1, hint: 2 };
  P.sort((a, b) => order[a.severity] - order[b.severity]);
  return { problems: P, crossings, inventory: inventory(graph, byId) };
}

// Which constructs are used? (basic and advanced constructs)
function inventory(graph, byId) {
  const N = graph.nodes, count = (f) => N.filter(f).length;
  const host = (n) => byId.get(n.host);
  const isSubP = (n) => /SubProcess|Transaction/.test(n?.type ?? '');
  const gw = {};
  for (const n of N.filter(isGateway)) gw[n.type.replace('Gateway', '')] = (gw[n.type.replace('Gateway', '')] ?? 0) + 1;
  const ev = {};
  for (const n of N.filter((n) => isEvent(n) && n.eventDefinition)) ev[n.eventDefinition.type] = (ev[n.eventDefinition.type] ?? 0) + 1;
  return {
    pools: count((n) => n.type === 'Participant' && n.expanded !== false), collapsedPools: count((n) => n.type === 'Participant' && n.expanded === false),
    lanes: count((n) => n.type === 'Lane'), messageFlows: graph.edges.filter((e) => e.type === 'MessageFlow').length,
    dataObjects: count((n) => /^Data/.test(n.type)), dataAssociations: graph.edges.filter((e) => /^Data/.test(e.type)).length,
    gateways: gw, eventTypes: ev,
    boundaryOnTasks: count((n) => n.type === 'BoundaryEvent' && !isSubP(host(n))), boundaryOnSubProcesses: count((n) => n.type === 'BoundaryEvent' && isSubP(host(n))),
    multiInstances: count((n) => n.loop === 'parallel' || n.loop === 'sequential'), loops: count((n) => n.loop === 'loop'),
    eventSubProcesses: count((n) => n.triggeredByEvent), subProcesses: count((n) => isSubP(n) && !n.triggeredByEvent), callActivities: count((n) => n.type === 'CallActivity'),
    tasks: count((n) => /Task$/.test(n.type)),
  };
}

export function formatInventory(inv) {
  const obj = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') || '–';
  return [
    `Size: ${inv.pools} expanded pools, ${inv.collapsedPools} collapsed, ${inv.lanes} lanes, ${inv.tasks} tasks${inv.planes ? `, ${inv.planes} drill-down plane(s) of collapsed subprocesses` : ''}.`,
    `Basic constructs: ${inv.messageFlows} message flows, ${inv.dataObjects} data objects/stores (${inv.dataAssociations} data associations), gateways: ${obj(inv.gateways)}, ${inv.boundaryOnTasks} boundary events on tasks.`,
    `Advanced constructs: ${inv.multiInstances} multi-instances, ${inv.eventSubProcesses} event subprocesses, ${inv.subProcesses} subprocesses (${inv.boundaryOnSubProcesses} boundary events on subprocesses), ${inv.callActivities} call activities; event types: ${obj(inv.eventTypes)}.`,
  ].join('\n');
}

export function formatCheck({ problems, crossings }) {
  if (!problems.length) return 'No issues: layout, naming and structure follow the conventions.';
  const label = { error: 'ERROR', warning: 'WARNING', hint: 'HINT' };
  const count = (s) => problems.filter((p) => p.severity === s).length;
  return [
    `${count('error')} errors, ${count('warning')} warnings, ${count('hint')} hints (line crossings: ${crossings})`,
    ...group(problems).map((p) => `[${label[p.severity]}] ${p.rule}: ${p.message}`),
  ].join('\n');
}

// Collapse many messages of the same kind (e.g. crossings) into one line: saves tokens on large diagrams.
function group(problems, limit = 6) {
  const byRule = new Map();
  for (const p of problems) { if (!byRule.has(p.rule + p.severity)) byRule.set(p.rule + p.severity, []); byRule.get(p.rule + p.severity).push(p); }
  const out = [];
  for (const list of byRule.values()) {
    if (list.length <= limit) { out.push(...list); continue; }
    out.push(...list.slice(0, limit - 1), { ...list[0], message: `… and ${list.length - limit + 1} more messages of this kind (${[...new Set(list.slice(limit - 1).flatMap((p) => p.ids))].slice(0, 12).join(', ')}${list.length > limit + 5 ? ', …' : ''}).` });
  }
  const order = { error: 0, warning: 1, hint: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}
