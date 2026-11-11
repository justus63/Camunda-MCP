// Brücke zwischen bpmn-moddle (Datei-Modus) und dem Graphen für layout.js / check.js.
const SIZES = {
  StartEvent: [36, 36], EndEvent: [36, 36], IntermediateCatchEvent: [36, 36], IntermediateThrowEvent: [36, 36], BoundaryEvent: [36, 36],
  DataObjectReference: [36, 50], DataStoreReference: [50, 50], TextAnnotation: [100, 30], Group: [300, 300], Participant: [600, 250], Lane: [570, 125],
};
const short = (t) => t.replace('bpmn:', '');
const TIMER = { date: 'timeDate', duration: 'timeDuration', cycle: 'timeCycle' };

export function estimateLabel(text) {
  const lines = [''];
  for (const w of String(text).split(/\s+/)) {
    const l = lines[lines.length - 1];
    if (l && (l + ' ' + w).length > 16) lines.push(w); else lines[lines.length - 1] = l ? l + ' ' + w : w;
  }
  return { width: Math.min(90, Math.round(Math.max(...lines.map((l) => l.length)) * 5.8 + 4)), height: lines.length * 13 + 1 };
}

export function summarizeEventDefinition(el) {
  const def = el.eventDefinitions?.[0];
  if (!def) return undefined;
  const out = { type: short(def.$type).replace('EventDefinition', '').toLowerCase() };
  for (const [t, p] of Object.entries(TIMER)) if (def[p]) { out.timerType = t; out.value = def[p].body; }
  const ref = def.messageRef ?? def.signalRef ?? def.errorRef ?? def.escalationRef;
  if (ref) {
    out.name = ref.name;
    const ck = ref.extensionElements?.values?.find((v) => v.$type === 'zeebe:Subscription')?.correlationKey;
    if (ck) out.correlationKey = ck;
  }
  if (def.condition) out.value = def.condition.body;
  return out;
}

function mainDiagram(definitions) {
  return (definitions.diagrams ?? []).find((d) => /bpmn:(Process|Collaboration)$/.test(d.plane?.bpmnElement?.$type ?? ''));
}

// Liefert { nodes, edges, refs } – refs: id -> moddle-Element
export function graphFromDefinitions(definitions) {
  const di = new Map();
  for (const e of mainDiagram(definitions)?.plane?.planeElement ?? []) if (e.bpmnElement) di.set(e.bpmnElement.id, e);
  const nodes = [], edges = [], refs = new Map();
  const hasLabel = (t) => /Event$|Gateway$|^Data|Flow$/.test(t);

  const geo = (el, o) => {
    const d = di.get(el.id);
    if (d?.bounds) Object.assign(o, { x: d.bounds.x, y: d.bounds.y });
    if (d?.waypoint) o.waypoints = d.waypoint.map((p) => ({ x: p.x, y: p.y }));
    if (o.name && hasLabel(o.type)) {
      const lb = d?.label?.bounds;
      o.label = lb ? { x: lb.x, y: lb.y, width: lb.width, height: lb.height } : estimateLabel(o.name);
    }
    refs.set(el.id, el);
    return o;
  };
  const node = (el, parent, extra = {}) => {
    const type = short(el.$type), d = di.get(el.id);
    const [w, h] = SIZES[type] ?? (/Gateway$/.test(type) ? [50, 50] : [100, 80]);
    const n = geo(el, { id: el.id, type, name: el.name ?? el.text ?? el.categoryValueRef?.value, parent, width: d?.bounds?.width ?? w, height: d?.bounds?.height ?? h, ...extra });
    if (type === 'TextAnnotation' && !d && n.name) n.height = Math.max(30, estimateLabel(n.name).height + 16);
    nodes.push(n);
    return n;
  };
  const walk = (container, parent, laneOf) => {
    for (const el of container.flowElements ?? []) {
      if (el.$type === 'bpmn:SequenceFlow') {
        edges.push(geo(el, { id: el.id, type: 'SequenceFlow', source: el.sourceRef?.id, target: el.targetRef?.id, name: el.name, condition: el.conditionExpression?.body, isDefault: el.sourceRef?.default === el }));
        continue;
      }
      if (el.$type === 'bpmn:DataObject') continue;
      const sub = /^bpmn:(SubProcess|Transaction|AdHocSubProcess)$/.test(el.$type);
      const expanded = sub ? (di.has(el.id) ? !!di.get(el.id).isExpanded : true) : undefined;
      node(el, parent, {
        host: el.attachedToRef?.id, lane: laneOf?.get(el.id), expanded, triggeredByEvent: el.triggeredByEvent || undefined,
        eventDefinition: summarizeEventDefinition(el), jobType: el.extensionElements?.values?.find((v) => v.$type === 'zeebe:TaskDefinition')?.type,
      });
      for (const a of el.dataInputAssociations ?? []) if (a.sourceRef?.[0]) edges.push(geo(a, { id: a.id, type: 'DataInputAssociation', source: a.sourceRef[0].id, target: el.id }));
      for (const a of el.dataOutputAssociations ?? []) if (a.targetRef) edges.push(geo(a, { id: a.id, type: 'DataOutputAssociation', source: el.id, target: a.targetRef.id }));
      if (sub && expanded) walk(el, el.id);
    }
    for (const a of container.artifacts ?? []) {
      if (a.$type === 'bpmn:Association') edges.push(geo(a, { id: a.id, type: 'Association', source: a.sourceRef?.id, target: a.targetRef?.id }));
      else node(a, parent);
    }
  };
  const lanesOf = (process, pid) => {
    const map = new Map();
    const mark = (lane, top) => {
      for (const f of lane.flowNodeRef ?? []) map.set(f.id, top);
      for (const c of lane.childLaneSet?.lanes ?? []) mark(c, top);
    };
    for (const ls of process.laneSets ?? []) for (const l of ls.lanes ?? []) { node(l, pid); mark(l, l.id); }
    return map;
  };

  const roots = definitions.rootElements ?? [];
  const collab = roots.find((r) => r.$type === 'bpmn:Collaboration');
  const done = new Set();
  if (collab) {
    for (const p of collab.participants ?? []) {
      const n = node(p, null, { expanded: !!p.processRef });
      if (!di.has(p.id) && !p.processRef) n.height = 60;
      if (p.processRef) { done.add(p.processRef); walk(p.processRef, p.id, lanesOf(p.processRef, p.id)); }
    }
    for (const m of collab.messageFlows ?? []) edges.push(geo(m, { id: m.id, type: 'MessageFlow', source: m.sourceRef?.id, target: m.targetRef?.id, name: m.name }));
    for (const a of collab.artifacts ?? []) if (a.$type !== 'bpmn:Association') node(a, null); else edges.push(geo(a, { id: a.id, type: 'Association', source: a.sourceRef?.id, target: a.targetRef?.id }));
  }
  for (const p of roots) if (p.$type === 'bpmn:Process' && !done.has(p) && !collab) walk(p, null, lanesOf(p, null));

  for (const g of nodes.filter((n) => n.type === 'Group' && n.x !== undefined)) {
    g.members = nodes.filter((n) => n !== g && n.x !== undefined && n.type !== 'Participant' && n.type !== 'Lane' &&
      n.x + n.width / 2 > g.x && n.x + n.width / 2 < g.x + g.width && n.y + n.height / 2 > g.y && n.y + n.height / 2 < g.y + g.height).map((n) => n.id);
  }
  return { nodes, edges, refs };
}

// Schreibt das Layout als BPMN-DI zurück (vorhandene DI-Objekte bleiben erhalten, z. B. Farben).
export function writeDi(moddle, definitions, graph, layout) {
  let diagram = mainDiagram(definitions);
  const root = definitions.rootElements.find((r) => r.$type === 'bpmn:Collaboration') ?? definitions.rootElements.find((r) => r.$type === 'bpmn:Process');
  if (!diagram) {
    diagram = moddle.create('bpmndi:BPMNDiagram', { id: 'BPMNDiagram_1', plane: moddle.create('bpmndi:BPMNPlane', { id: 'BPMNPlane_1', bpmnElement: root, planeElement: [] }) });
    definitions.diagrams = [diagram, ...(definitions.diagrams ?? [])];
  }
  const plane = diagram.plane;
  plane.bpmnElement = root;
  const old = new Map((plane.planeElement ?? []).filter((e) => e.bpmnElement).map((e) => [e.bpmnElement.id, e]));
  const next = [];
  const B = (b) => moddle.create('dc:Bounds', { x: b.x, y: b.y, width: b.width, height: b.height });
  const label = (d, id) => {
    const lb = layout.labels[id];
    if (lb) d.label = moddle.create('bpmndi:BPMNLabel', { bounds: B(lb) });
    else if (!graph.refs.get(id)?.name) delete d.label;
  };
  for (const n of graph.nodes) {
    const b = layout.shapes[n.id];
    let d = old.get(n.id);
    if (!b && !d) continue;
    d ??= moddle.create('bpmndi:BPMNShape', { id: `${n.id}_di`, bpmnElement: graph.refs.get(n.id) });
    if (b) d.bounds = B(b);
    if (n.type === 'ExclusiveGateway') d.isMarkerVisible = true;
    if (n.type === 'Participant' || n.type === 'Lane') d.isHorizontal = true;
    if (n.expanded) d.isExpanded = true;
    label(d, n.id);
    next.push(d);
  }
  for (const e of graph.edges) {
    const pts = layout.edges[e.id];
    let d = old.get(e.id);
    if (!pts && !d) continue;
    d ??= moddle.create('bpmndi:BPMNEdge', { id: `${e.id}_di`, bpmnElement: graph.refs.get(e.id) });
    if (pts) d.waypoint = pts.map((p) => moddle.create('dc:Point', { x: p.x, y: p.y }));
    label(d, e.id);
    next.push(d);
  }
  plane.planeElement = next;
}
