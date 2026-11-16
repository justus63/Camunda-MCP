#!/usr/bin/env node
// MCP-Server zum Zeichnen/Bearbeiten von BPMN-Diagrammen (Camunda 8 / Zeebe und Camunda 7) sowie UML-Klassen- und Zustandsdiagrammen.
// Live-Modus: bearbeitet das im Camunda Modeler geöffnete Diagramm über das Plugin (plugin/client.js).
// Datei-Modus: bearbeitet .bpmn-Dateien mit demselben Plugin-Code in einem unsichtbaren bpmn-js (headless.js).
// Beide Modi haben dieselben Befehle; Layout (layout.js) und Prüfung (check.js) laufen hier im Server.
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WebSocketServer } from 'ws';
import { computeLayout } from './layout.js';
import { checkAll, formatCheck, formatInventory, LEVELS } from './check.js';
import { withFile, undoFile, emptyDiagram, closeHeadless, renderSvg, PLATFORMS, DEFAULT_PLATFORM } from './headless.js';
import { classDiagram, stateDiagram } from './uml.js';
import { lintXml, formatLint } from './lint.js';
import * as engine from './engine.js';

// ---------- Live-Brücke zum Camunda Modeler (Plugin verbindet sich hierher) ----------
const BRIDGE_PORT = Number(process.env.BPMN_MCP_PORT ?? 17877);
const PLUGIN_VERSION = 6;
let modelerSocket = null;
let nextId = 1;
const pending = new Map();

const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: BRIDGE_PORT,
  // Webseiten im Browser dürfen sich nicht verbinden (sie senden einen http(s)-Origin).
  verifyClient: ({ origin }) => !origin || !/^https?:/i.test(origin),
});
wss.on('error', (e) => console.error(`[bpmn-mcp] Live-Brücke nicht verfügbar (Port ${BRIDGE_PORT}): ${e.message}`));
wss.on('connection', (ws) => {
  modelerSocket = ws;
  console.error('[bpmn-mcp] Modeler verbunden');
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    msg.error !== undefined ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
  });
  ws.on('close', () => {
    if (modelerSocket === ws) modelerSocket = null;
    console.error('[bpmn-mcp] Modeler getrennt');
  });
});

function callModeler(method, params = {}, timeout = method === 'batch' ? 60000 : method === 'screenshot' ? 30000 : 15000) {
  if (!modelerSocket || modelerSocket.readyState !== 1) {
    return Promise.reject(
      new Error('Der Camunda Modeler ist nicht verbunden. Ist das Plugin "bpmn-mcp-bridge" installiert und der Modeler gestartet?'),
    );
  }
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Zeitüberschreitung: der Modeler hat nicht geantwortet.'));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    modelerSocket.send(JSON.stringify({ id, method, params }));
  });
}

// ---------- Gemeinsame Parameter beider Modi ----------
const TYPES = [
  'startEvent', 'endEvent', 'intermediateCatchEvent', 'intermediateThrowEvent', 'boundaryEvent',
  'task', 'userTask', 'serviceTask', 'scriptTask', 'businessRuleTask', 'sendTask', 'receiveTask', 'manualTask', 'callActivity',
  'subProcess', 'eventSubProcess', 'transaction', 'adHocSubProcess',
  'exclusiveGateway', 'parallelGateway', 'inclusiveGateway', 'eventBasedGateway', 'complexGateway',
  'dataObject', 'dataStore', 'textAnnotation', 'group', 'participant', 'lane',
];
const EVENT_DEFINITION = z
  .object({
    type: z
      .enum(['none', 'timer', 'message', 'signal', 'error', 'escalation', 'conditional', 'terminate', 'link', 'compensate'])
      .describe('"none" entfernt eine vorhandene Definition'),
    timerType: z
      .enum(['date', 'duration', 'cycle'])
      .optional()
      .describe('Nur Timer: date = Zeitpunkt, duration = Dauer (z. B. P7D), cycle = Wiederholung (z. B. R/P1M)'),
    value: z
      .string()
      .optional()
      .describe('Timer: Ausdruck (ISO 8601 oder FEEL, z. B. "P7D" oder "= startDatum"); conditional: FEEL-Bedingung'),
    name: z.string().optional().describe('Message-/Signal-/Error-/Escalation-/Link-Name'),
    correlationKey: z.string().optional().describe('Nur Message (Catch): FEEL, z. B. "= mitarbeiterId"'),
    code: z.string().optional().describe('Nur Error/Escalation: Code'),
  })
  .describe('Macht aus dem Event ein Timer-/Message-/...-Event (nur für Events)');
const MAPPING = z
  .array(z.object({ source: z.string().optional(), target: z.string().optional(), name: z.string().optional(), value: z.string().optional() }))
  .describe('Camunda 8: { source, target }; Camunda 7: { name, value }');
const LISTENER = z.array(
  z.object({
    event: z.string().optional().describe('Task Listener: create | assignment | complete | delete | update | timeout; Execution Listener: start | end | take'),
    class: z.string().optional(),
    delegateExpression: z.string().optional(),
    expression: z.string().optional(),
    script: z.string().optional().describe('Inline-Skript statt Klasse'),
    scriptFormat: z.string().optional(),
  }),
);
const FORM_FIELDS = z
  .array(
    z.object({
      id: z.string().describe('Name der Prozessvariable'),
      label: z.string().optional(),
      type: z.enum(['string', 'long', 'boolean', 'date', 'enum']).optional(),
      defaultValue: z.any().optional(),
      required: z.boolean().optional(),
      readonly: z.boolean().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      minlength: z.number().optional(),
      maxlength: z.number().optional(),
      values: z.any().optional().describe('enum: { wert: "Anzeige" } oder ["a", "b"]'),
    }),
  )
  .describe('Camunda 7: Generated Task Form (Felder = Prozessvariablen)');
const PROPS = {
  eventDefinition: EVENT_DEFINITION.optional(),
  jobType: z.string().optional().describe('Job-Typ (Service/Send/Business-Rule/Script-Task)'),
  documentation: z.string().optional(),
  interrupting: z.boolean().optional().describe('Boundary-/Start-Event: false = nicht unterbrechend'),
  loop: z
    .object({
      type: z.enum(['none', 'loop', 'parallel', 'sequential']),
      inputCollection: z.string().optional(),
      inputElement: z.string().optional(),
      outputCollection: z.string().optional(),
      outputElement: z.string().optional(),
      collection: z.string().optional().describe('Camunda 7: Prozessvariable mit der Collection'),
      elementVariable: z.string().optional().describe('Camunda 7: Variable für das einzelne Element'),
      cardinality: z.union([z.string(), z.number()]).optional().describe('Camunda 7: Anzahl der Instanzen (Zahl oder Expression)'),
      completionCondition: z.string().optional(),
    })
    .optional()
    .describe('Schleifen-/Mehrfach-Markierung (parallel/sequential = Multi-Instanz)'),
  state: z.string().optional().describe('Datenobjekt/-speicher: Zustand, z. B. "genehmigt" (erscheint als "Name [genehmigt]"; "" entfernt ihn)'),
  collection: z.boolean().optional().describe('Datenobjekt: Collection (Liste) von Objekten'),
  color: z.object({ fill: z.string().optional(), stroke: z.string().optional() }).optional().describe('z. B. { fill: "#e1f5fe", stroke: "#0277bd" }'),
  properties: z
    .object({
      retries: z.string().optional(),
      assignee: z.string().optional(),
      candidateGroups: z.string().optional(),
      candidateUsers: z.string().optional(),
      dueDate: z.string().optional(),
      formId: z.string().optional(),
      calledProcessId: z.string().optional().describe('Call Activity: aufgerufener Prozess'),
      decisionId: z.string().optional().describe('Business Rule Task: DMN-Entscheidung'),
      resultVariable: z.string().optional(),
      script: z.string().optional().describe('Script Task: Camunda 8 FEEL-Ausdruck, Camunda 7 Skripttext (z. B. Groovy)'),
      inputs: MAPPING.optional(),
      outputs: MAPPING.optional(),
      headers: z.record(z.string(), z.string()).optional().describe('nur Camunda 8'),
      // ----- nur Camunda 7 -----
      followUpDate: z.string().optional(),
      priority: z.string().optional(),
      formKey: z.string().optional().describe('C7 Embedded Form, z. B. "embedded:app:forms/antrag.html"'),
      formRef: z.string().optional().describe('C7 Camunda Form (ID der .form-Datei); formId ist ein Alias'),
      formFields: FORM_FIELDS.optional(),
      initiator: z.string().optional().describe('C7 Startereignis: Variable, in der die User-ID des Starters landet'),
      class: z.string().optional().describe('C7 Service/Send/Business-Rule-Task oder auslösendes Nachrichtenereignis: Java-Klasse (JavaDelegate)'),
      delegateExpression: z.string().optional().describe('C7: Spring Bean, z. B. "${loggingBean}"'),
      expression: z.string().optional().describe('C7: Methodenaufruf, z. B. "${bean.rechne(execution)}"'),
      topic: z.string().optional().describe('C7: External Task mit diesem Topic'),
      decisionRef: z.string().optional().describe('C7 Business Rule Task: ID der DMN-Entscheidung (decisionId ist ein Alias)'),
      mapDecisionResult: z.enum(['singleEntry', 'singleResult', 'collectEntries', 'resultList']).optional(),
      scriptFormat: z.string().optional().describe('C7 Script Task: groovy (Standard), javascript, …'),
      resource: z.string().optional().describe('C7 Script Task: externes Skript, z. B. "classpath://scripts/export.groovy"'),
      calledElement: z.string().optional().describe('C7 Call Activity (calledProcessId ist ein Alias)'),
      asyncBefore: z.boolean().optional(),
      asyncAfter: z.boolean().optional(),
      taskListeners: LISTENER.optional().describe('C7 User Task'),
      executionListeners: LISTENER.optional().describe('C7: beliebiges Element oder Prozess'),
      historyTimeToLive: z.union([z.string(), z.number()]).optional().describe('C7 Prozess (ID des Pools oder Prozesses angeben)'),
      candidateStarterGroups: z.string().optional().describe('C7 Prozess'),
      candidateStarterUsers: z.string().optional().describe('C7 Prozess'),
      versionTag: z.string().optional().describe('C7 Prozess'),
      isExecutable: z.boolean().optional().describe('Prozess (ID des Pools oder Prozesses angeben)'),
    })
    .optional()
    .describe('Technische Eigenschaften der Ausführungsplattform (Camunda 8 oder Camunda 7, je nach Diagramm)'),
};
const ADD = {
  type: z.enum(TYPES),
  name: z.string().optional().describe('Name; bei textAnnotation der Text'),
  id: z.string().optional(),
  after: z.string().optional().describe('ID des Elements, hinter dem eingefügt und verbunden wird'),
  flowName: z.string().optional().describe('Beschriftung der neuen Verbindung'),
  parent: z.string().optional().describe('Pool, Lane oder aufgeklappter Teilprozess, in dem das Element liegen soll (ID oder eindeutiger Name)'),
  attachTo: z.string().optional().describe('boundaryEvent: Aktivität, an die angeheftet wird; textAnnotation/dataObject/dataStore: verknüpftes Element'),
  direction: z.enum(['input', 'output']).optional().describe('dataObject/dataStore: wird gelesen (input) oder geschrieben (output, Standard)'),
  expanded: z.boolean().optional().describe('Teilprozess/Pool zugeklappt anlegen: false'),
  lanes: z
    .array(z.union([z.string(), z.object({ id: z.string().optional(), name: z.string() })]))
    .optional()
    .describe('participant: Lanes von oben nach unten, als Namen oder { id, name }'),
  processId: z.string().optional().describe('participant: ID des Prozesses in diesem Pool'),
  executable: z.boolean().optional().describe('participant: Prozess des Pools ausführbar (true für den Pool der Process Engine, sonst false)'),
  around: z.array(z.string()).optional().describe('group: Elemente, die umrahmt werden'),
  position: z.any().optional().describe('{x,y} Mittelpunkt (nur wenn nötig – sonst Layout); bei lane: "top"/"bottom"'),
  ...PROPS,
};
const CONNECT = {
  source: z.string(),
  target: z.string(),
  name: z.string().optional(),
  condition: z.string().optional().describe('Bedingung: Camunda 8 FEEL ("= amount > 100"), Camunda 7 Expression ("${amount > 100}")'),
  isDefault: z.boolean().optional().describe('Standardfluss des Gateways'),
  type: z.enum(['sequence', 'message', 'association']).optional().describe('Standard: automatisch (Sequenzfluss, Nachrichtenfluss zwischen Pools, Datenassoziation)'),
};
const UPDATE = {
  id: z.string(),
  name: z.string().optional(),
  type: z.enum(TYPES).optional().describe('Neuer Elementtyp; ID und Verbindungen bleiben'),
  condition: z.string().optional().describe('Sequenzfluss: Bedingung (C8 FEEL "= …", C7 "${…}"; "" entfernt sie)'),
  isDefault: z.boolean().optional().describe('Sequenzfluss als Standardfluss markieren'),
  newId: z.string().optional(),
  ...PROPS,
};
const REMOVE = { id: z.string().optional(), ids: z.array(z.string()).optional() };
const ARRANGE = {
  action: z.enum(['move', 'resize', 'waypoints', 'label', 'align', 'distribute']),
  id: z.string().optional(),
  ids: z.array(z.string()).optional(),
  dx: z.number().optional(),
  dy: z.number().optional(),
  x: z.number().optional().describe('move/resize/label: neue linke obere Ecke'),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  parent: z.string().optional().describe('move: in diesen Pool/Teilprozess/Lane verschieben'),
  waypoints: z.array(z.object({ x: z.number(), y: z.number() })).optional().describe('waypoints: leer = Linie neu berechnen'),
  to: z.enum(['left', 'center', 'right', 'top', 'middle', 'bottom']).optional(),
  axis: z.enum(['horizontal', 'vertical']).optional(),
};
const OP = (op, shape) => z.object({ op: z.literal(op), ...shape });
const OPERATIONS = z
  .array(z.discriminatedUnion('op', [OP('add', ADD), OP('connect', CONNECT), OP('update', UPDATE), OP('remove', REMOVE), OP('arrange', ARRANGE)]))
  .describe('Jeder Eintrag hat "op" (add | connect | update | remove | arrange) und die Parameter des gleichnamigen Tools');
const GEOMETRY = z.boolean().optional().describe('true: auch Positionen und Wegpunkte ausgeben');
const DESCRIBE = {
  geometry: GEOMETRY,
  ids: z.array(z.string()).optional().describe('Nur diese Elemente/Verbindungen ausgeben (spart bei großen Diagrammen Tokens)'),
  region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional().describe('Nur Elemente/Verbindungen, die diesen Bereich berühren (Koordinaten wie bei geometry)'),
};
const MAX_SIZE = z.number().optional().describe('Maximale Kantenlänge in Pixeln (Standard 2000)');
const VIEW = {
  maxSize: MAX_SIZE,
  plane: z.string().optional().describe('ID eines zugeklappten Teilprozesses: dessen Drill-down-Ebene zeigen'),
  ids: z.array(z.string()).optional().describe('Ausschnitt: nur der Bereich um diese Elemente (Zoom, für große Diagramme)'),
  region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional().describe('Ausschnitt in Diagrammkoordinaten'),
};

// ---------- Gemeinsame Logik; exec(method, params) führt einen Plugin-Befehl aus (live oder headless) ----------
const LAYOUT_RULES = /^(mini-stufe|linie-durch-element|ueberlappung|kreuzung|linien-uebereinander|beschriftung-verdeckt|beschriftung-auf-linie|beschriftungen-ueberlappen|schraege-linie)$/;
const layoutOnly = (res) => ({ ...res, problems: res.problems.filter((p) => LAYOUT_RULES.test(p.rule)) });

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });
const json = (v) => JSON.stringify(v, null, 2);

// Kompakte Ausgabe: gültiges JSON, aber nur eine Zeile je Element (spart bei großen Diagrammen viele Tokens).
// Hauptebene + Drill-down-Ebenen der zugeklappten Teilprozesse (deren Elemente haben eigene Koordinaten).
async function allGraphs(exec) {
  const main = await exec('graph');
  const subs = [];
  for (const plane of main.planes ?? []) subs.push(await exec('graph', { plane }));
  return [main, ...subs];
}
const touches = (o, r) => {
  const pts = o.waypoints ?? (o.x !== undefined ? [{ x: o.x, y: o.y }, { x: o.x + o.width, y: o.y + o.height }] : []);
  if (!pts.length) return false;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return Math.min(...xs) <= r.x + r.width && Math.max(...xs) >= r.x && Math.min(...ys) <= r.y + r.height && Math.max(...ys) >= r.y;
};
async function describe(exec, { geometry, ids, region } = {}) {
  const [main, ...subs] = await allGraphs(exec);
  const g = { root: main.root, nodes: [...main.nodes], edges: [...main.edges] };
  for (const s of subs) {
    const plane = s.root.plane;
    g.nodes.push(...s.nodes.map((n) => ({ ...n, parent: n.parent ?? plane, plane })));
    g.edges.push(...s.edges.map((e) => ({ ...e, plane })));
  }
  if (ids?.length) { const set = new Set(ids); g.nodes = g.nodes.filter((n) => set.has(n.id)); g.edges = g.edges.filter((e) => set.has(e.id)); }
  if (region) { g.nodes = g.nodes.filter((n) => !n.plane && touches(n, region)); g.edges = g.edges.filter((e) => !e.plane && touches(e, region)); geometry = true; }
  const strip = ({ x, y, width, height, label, waypoints, members, ...rest }) => (geometry ? { ...rest, x, y, width, height, waypoints } : rest);
  const lines = (list) => (list.length ? `[\n${list.map((e) => JSON.stringify(e)).join(',\n')}\n]` : '[]');
  return `{"root":${JSON.stringify(g.root)},\n"elements":${lines(g.nodes.map(strip))},\n"flows":${lines(g.edges.map(({ source, target, ...e }) => strip({ ...e, from: source, to: target })))}}`;
}

const LAYOUT_OPTS = {
  only: z.enum(['all', 'messageFlows']).optional().describe('messageFlows: nur die Nachrichtenflüsse neu verlegen – Elemente, Sequenzflüsse und manuelle Korrekturen bleiben unverändert'),
  poolOrder: z.array(z.string()).optional().describe('Reihenfolge der Pools von oben nach unten (IDs oder Namen). Standard: automatisch so, dass Nachrichtenflüsse möglichst zwischen Nachbarn laufen'),
  align: z.boolean().optional().describe('false: Pools nicht entlang der Nachrichtenflüsse ausrichten (Standard: true)'),
};
const layoutOpts = ({ only, poolOrder, align }) => ({ only: only === 'messageFlows' ? only : undefined, poolOrder, align });

async function runLayout(exec, undoHint = '(ein Undo-Schritt)', opts = {}) {
  const [main, ...subs] = await allGraphs(exec);
  const layout = computeLayout(main, opts);
  // Drill-down-Ebenen zugeklappter Teilprozesse eigenständig anordnen (eigene Koordinaten), im selben Undo-Schritt.
  if (opts.only !== 'messageFlows') for (const s of subs) {
    const l = computeLayout(s);
    for (const k of ['shapes', 'labels', 'edges']) Object.assign(layout[k], l[k]);
  }
  const result = await exec('applyLayout', layout);
  const res = layoutOnly(checkAll(await allGraphs(exec)));
  const what = opts.only === 'messageFlows' ? `Nachrichtenflüsse neu verlegt: ${result.edges}` : `Layout angewendet: ${result.shapes} Elemente, ${result.edges} Verbindungen${subs.length ? ` (inkl. ${subs.length} Drill-down-Ebene(n))` : ''}`;
  return `${what} ${undoHint}.\n${formatCheck(res)}`;
}

const LEVEL = z
  .enum(LEVELS)
  .optional()
  .describe('Modellebene: strategisch (grob, Happy Case, max. 10 Schritte), operativ (Kollaboration, Nachrichten- und Datenfluss, keine Deadlocks), technisch (ausführbar auf der Plattform). Ohne Angabe: allgemeine Konventionen + technische Pflichtangaben der ausführbaren Prozesse');
const LINT = z
  .boolean()
  .optional()
  .describe('bpmnlint mit den Regeln des Camunda Modelers (camunda-compat für Plattform/Version aus dem Dateikopf + bpmnlint:recommended). Standard: an, außer bei level strategisch/operativ');
async function check(exec, level, lint) {
  const res = checkAll(await allGraphs(exec), { level });
  let text = `${level ? `Ebene: ${level}\n` : ''}${formatCheck(res)}\n${formatInventory(res.inventory)}`;
  if (lint ?? !/^(strategisch|operativ)$/.test(level ?? '')) {
    try {
      text += `\n${formatLint(await lintXml((await exec('xml')).xml))}`;
    } catch (e) {
      text += `\nbpmnlint nicht ausgeführt: ${e.message}`;
    }
  }
  return text;
}

async function screenshot(exec, { maxSize, plane, ids, region } = {}) {
  const r = await exec('screenshot', { maxSize, plane, ids, region });
  return { content: [{ type: 'image', data: r.png, mimeType: 'image/png' }, { type: 'text', text: `${r.width}×${r.height} px` }] };
}

const FORMAT = z.enum(['pdf', 'svg', 'png']).default('pdf').describe('Ausgabeformat (PDF: eine Seite in Diagrammgröße, Vektorgrafik)');
// svg zuerst holen, dann umwandeln: renderSvg benutzt denselben Browser und darf nicht innerhalb von withFile laufen.
async function exportDiagram(svg, format, output) {
  if (!path.isAbsolute(output)) throw new Error(`"output" muss ein absoluter Pfad sein: ${output}`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  if (format === 'svg') await fs.writeFile(output, svg, 'utf8');
  else await fs.writeFile(output, (await renderSvg(svg, format)).data);
  return `Exportiert: ${output}`;
}
const INCLUDE_PLANES = z.boolean().optional().describe('true: zusätzlich jede Drill-down-Ebene zugeklappter Teilprozesse als eigene Datei <Ausgabe>_<Teilprozess-ID>.<Format>');
async function collectSvgs(exec, { plane, includePlanes }) {
  const list = [{ plane, svg: (await exec('svg', { plane })).svg }];
  if (includePlanes && !plane) for (const p of await exec('planes')) list.push({ plane: p, svg: (await exec('svg', { plane: p })).svg });
  return list;
}
async function writeSvgs(svgs, format, output) {
  const lines = [];
  for (const [i, s] of svgs.entries()) lines.push(await exportDiagram(s.svg, format, i ? output.replace(/(\.[^./\\]+)$/, `_${s.plane}$1`) : output));
  return lines.join('\n');
}
const exportAll = async (exec, format, output, opts) => writeSvgs(await collectSvgs(exec, opts), format, output);
const withExt = (file, ext) => file.replace(/\.[^./\\]+$/, '') + '.' + ext;

const INSTRUCTIONS = `BPMN-Modellierung für den Camunda Modeler (Camunda 8 und Camunda 7) und UML-Diagramme. Zwei BPMN-Modi mit denselben Möglichkeiten:
- Live-Modus (live_*): bearbeitet das im Modeler geöffnete Diagramm. Ablauf: live_status -> live_describe -> Änderungen (gebündelt mit live_batch, layout: true) -> live_check -> live_screenshot ansehen -> live_save.
- Datei-Modus (Parameter file = absoluter Pfad): bearbeitet .bpmn-Dateien direkt, ohne Modeler. Ablauf: create_diagram (am besten gleich mit operations) bzw. describe_diagram -> batch (ordnet automatisch an) -> check_diagram -> screenshot_diagram ansehen -> export_diagram (PDF). Jede Änderung wird sofort gespeichert; undo/redo gehen zurück.
Wenige große Aufrufe statt vieler kleiner: ein ganzes Diagramm passt in einen create_diagram- oder batch-Aufruf. IDs selbst vergeben; "parent" nimmt auch den Namen eines Pools oder einer Lane.
Plattform: steht im Dateikopf (create_diagram platform: camunda8 | camunda7) und bestimmt, welche "properties" gelten.
- Camunda 8: jobType, FEEL-Bedingungen ("= x > 5"), properties.formId/assignee/decisionId.
- Camunda 7: properties.class | delegateExpression | expression | topic statt jobType; Bedingungen als "\${x > 5}"; User Tasks mit candidateGroups/assignee und formKey | formRef | formFields; Script Task mit scriptFormat + script; Business Rule Task mit decisionRef + resultVariable + mapDecisionResult; Multi-Instanz mit loop.collection/elementVariable; taskListeners/executionListeners.
Modellebenen (check_diagram level):
- strategisch: ein Pool mit Lanes, höchstens 10 Schritte, abstrakte Tasks, zugeklappte Teilprozesse (substantiviert benannt), nur der Standardablauf, kaum Gateways, Datenobjekte statt Nachrichtenflüssen.
- operativ: Kollaborationsdiagramm; jeder Beteiligte und die Process Engine in einem eigenen ausmodellierten Pool (create/add participant mit executable: true nur für die Process Engine), Nachrichtenflüsse nur zwischen Pools und nur an Tasks oder Nachrichtenereignissen, Datenobjekte mit Zustand, keine Deadlocks.
- technisch: der ausführbare Pool mit allen Pflichtangaben der Plattform.
Layout: Pools werden automatisch so gestapelt und spaltenweise ausgerichtet, dass Nachrichtenflüsse kurz und möglichst senkrecht verlaufen. Nach manuellen Korrekturen (arrange) weitere Änderungen mit layout: false ausführen; relayout/live_layout mit only: "messageFlows" verlegt nur die Nachrichtenflüsse neu.
Modellierungskonventionen (verbindlich):
- Von links nach rechts modellieren; der Normalablauf ("Happy Path") liegt auf einer geraden Linie.
- Überschneidungen vermeiden: keine Linie durch ein Element, möglichst keine Kreuzungen (das Layout erledigt das; nicht von Hand Wegpunkte setzen, außer die Prüfung meldet etwas).
- Namensgebung: Startereignis = Prozessauslöser ("Auftrag erhalten"), Aufgabe = Objekt + Verb ("Auftrag prüfen"), Zwischenereignis = Objekt + Partizip ("Auftrag geprüft"), verzweigendes XOR/OR-Gateway = Frage ("Auftragsdaten korrekt?"), dessen Ausgänge = Antworten ("ja"/"nein"), Endereignis = Endzustand ("Auftrag abgelehnt"). Kurze Namen; lange Wörter mit Bindestrich trennen ("Stellen-beschreibung"), sonst bricht der Modeler sie mitten im Wort um.
- Symmetrisch modellieren: jede Verzweigung bekommt ein eigenes zusammenführendes Gateway gleichen Typs; ein Gateway nie gleichzeitig zusammenführen und verzweigen lassen; explizite Gateways statt mehrerer Ein-/Ausgänge an Aufgaben.
- Gleiche Aufgabengröße (Standard 100x80 nicht verändern).
- Zwischenereignisse brauchen einen Typ (eventDefinition); nach einem ereignisbasierten Gateway folgen nur eintretende Ereignisse, ohne Bedingungen und ohne weitere Eingänge.
Zugeklappte Teilprozesse (expanded: false) haben eine eigene Drill-down-Ebene wie im Modeler: Elemente mit parent = Teilprozess landen dort, Layout und Prüfung behandeln jede Ebene einzeln; screenshot/export mit plane = Teilprozess-ID zeigen sie, export mit includePlanes: true schreibt alle Ebenen. Große Diagramme: screenshot mit ids/region für einen vergrößerten Ausschnitt, describe mit ids/region statt alles.
Prozess-Eigenschaften (historyTimeToLive, versionTag, candidateStarterGroups, isExecutable): update mit id = Prozess-ID oder Pool-ID. create_diagram platformVersion legt die Ziel-Engine fest (z. B. "7.20.0"); check_diagram führt zusätzlich bpmnlint mit den Regeln des Camunda Modelers aus.
Camunda 7 Engine (engine_*, REST, Standard http://localhost:8080/engine-rest): engine_status -> engine_deploy -> engine_start_instance -> engine_tasks / engine_complete_task (mit user) -> engine_execute_jobs (Timer sofort auslösen) / engine_correlate_message -> engine_instance (Zustand, Variablen, Verlauf) und engine_incidents (mit retry). engine_rest für alles andere.
UML: uml_class_diagram (Domänenmodell: Klassen mit fachlichen Attributen, benannte Assoziationen mit Kardinalitäten, keine Methoden) und uml_state_diagram (Objektlebenszyklus) erzeugen aus einer Beschreibung .drawio (XML), .svg, .pdf und .png in einem Aufruf.`;

const server = new McpServer({ name: 'bpmn-modeler-mcp', version: '0.6.0' }, { instructions: INSTRUCTIONS });

// ---------- Live-Tools: bearbeiten das im Modeler geöffnete Diagramm (mit Undo/Redo) ----------
const liveTool = (name, description, inputSchema, run) =>
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      const r = await run(args);
      return typeof r === 'string' ? ok(r) : r;
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  });
const plain = (method) => async (args) => json(await callModeler(method, args));

liveTool('live_status', 'Prüft, ob der Camunda Modeler verbunden ist und welcher Tab aktiv ist.', {}, async () => {
  const r = await callModeler('status');
  return json(r.plugin === PLUGIN_VERSION ? r : { ...r, warnung: 'Plugin im Modeler ist veraltet: ./install-plugin.sh ausführen und den Modeler komplett neu starten.' });
});
liveTool(
  'live_describe',
  'Listet alle Elemente und Verbindungen des im Modeler aktiven Diagramms mit IDs, Typ, Pool/Lane, Event-Typ usw. (auch den Inhalt zugeklappter Teilprozesse, markiert mit "plane"). Vor Änderungen aufrufen.',
  DESCRIBE,
  (args) => describe(callModeler, args),
);
liveTool(
  'live_add_element',
  'Fügt dem aktiven Diagramm ein Element hinzu: Ereignisse (auch angeheftet), alle Aufgabentypen, Gateways, Teilprozesse, Pools/Lanes, Datenobjekte, Anmerkungen, Gruppen. Mit "after" wird es verbunden. Für mehrere Elemente live_batch nutzen, danach live_layout.',
  ADD,
  plain('addElement'),
);
liveTool('live_connect', 'Verbindet zwei Elemente: Sequenzfluss, Nachrichtenfluss (zwischen Pools) oder Assoziation – der Typ ergibt sich aus den BPMN-Regeln.', CONNECT, plain('connect'));
liveTool(
  'live_update_element',
  'Ändert ein Element im aktiven Diagramm: Name, Typ, Event-Definition, Job-Typ, Bedingung/Standardfluss, Schleifen-Markierung, Farbe, Dokumentation, technische Eigenschaften (Camunda 8 bzw. 7).',
  UPDATE,
  plain('update'),
);
liveTool('live_remove_element', 'Löscht ein oder mehrere Elemente (samt Verbindungen) im aktiven Diagramm.', REMOVE, plain('remove'));
liveTool(
  'live_arrange',
  'Manuelle Anordnung wie mit der Maus: verschieben (auch in andere Lane/Pool), Größe ändern, Wegpunkte einer Linie setzen, Beschriftung verschieben, ausrichten, verteilen. Normalerweise reicht live_layout.',
  ARRANGE,
  plain('arrange'),
);
liveTool(
  'live_layout',
  'Ordnet das aktive Diagramm nach den Modellierungskonventionen neu an: Hauptpfad gerade, Verzweigungen symmetrisch, keine Linie durch Elemente, Rückschleifen außen, Pools entlang der Nachrichtenflüsse gestapelt und ausgerichtet. Ein Undo-Schritt. only: "messageFlows" lässt alles außer den Nachrichtenflüssen unverändert.',
  LAYOUT_OPTS,
  (args) => runLayout(callModeler, undefined, layoutOpts(args)),
);
liveTool(
  'live_check',
  'Prüft das aktive Diagramm: Darstellung (Linien durch Elemente, Kreuzungen, Überlappungen), Benennung, symmetrische Struktur, Nachrichtenflüsse, mögliche Deadlocks, Pflichtangaben der Plattform; mit level zusätzlich die Regeln der Modellebene. Listet die verwendeten Konstrukte auf.',
  { level: LEVEL, lint: LINT },
  ({ level, lint }) => check(callModeler, level, lint),
);
liveTool(
  'live_export',
  'Exportiert das aktive Diagramm als PDF, SVG oder PNG (für die Abgabe).',
  { format: FORMAT, output: z.string().describe('Absoluter Pfad der Ausgabedatei'), plane: VIEW.plane, includePlanes: INCLUDE_PLANES },
  async ({ format, output, plane, includePlanes }) => exportAll(callModeler, format, output, { plane, includePlanes }),
);
liveTool(
  'live_screenshot',
  'Liefert ein Bild des aktiven Diagramms, um die Darstellung selbst zu beurteilen. Bei großen Diagrammen mit ids/region einen Ausschnitt vergrößert ansehen; plane zeigt die Ebene eines zugeklappten Teilprozesses.',
  VIEW,
  (args) => screenshot(callModeler, args),
);
liveTool(
  'live_batch',
  'Führt mehrere Änderungen in einem Aufruf aus (der schnellste Weg, einen ganzen Prozess zu bauen). Bricht beim ersten Fehler ab. Mit layout: true wird danach automatisch angeordnet und geprüft.',
  { operations: OPERATIONS, layout: z.boolean().optional().describe('Danach live_layout ausführen (empfohlen)'), poolOrder: LAYOUT_OPTS.poolOrder },
  async ({ operations, layout, poolOrder }) => {
    const r = await callModeler('batch', { operations });
    const text = `${r.results.length} Operationen ausgeführt: ${JSON.stringify(r.results)}`;
    return layout ? `${text}\n${await runLayout(callModeler, undefined, { poolOrder })}` : text;
  },
);
liveTool('live_undo', 'Macht die letzte Änderung im aktiven Diagramm rückgängig.', {}, plain('undo'));
liveTool('live_redo', 'Stellt die zuletzt rückgängig gemachte Änderung wieder her.', {}, plain('redo'));
liveTool('live_save', 'Speichert das aktive Diagramm im Modeler (Cmd+S).', {}, plain('save'));

// ---------- Datei-Tools: dieselben Befehle auf einer .bpmn-Datei (headless bpmn-js) ----------
const FILE = z.string().describe('Absoluter Pfad der .bpmn-Datei');
const AUTO_LAYOUT = z
  .boolean()
  .optional()
  .describe('Danach automatisch anordnen und Darstellung prüfen (Standard: true). false behält die bisherige Anordnung, z. B. nach arrange.');
const FILE_UNDO = '(rückgängig mit undo)';

const fileTool = (name, description, shape, run, { mutate = false } = {}) =>
  server.registerTool(name, { description, inputSchema: { file: FILE, ...shape } }, async ({ file, ...args }) => {
    try {
      if (!path.isAbsolute(file)) return fail(`"file" muss ein absoluter Pfad sein: ${file}`);
      const r = await withFile(file, (exec) => run(exec, args), { mutate });
      return typeof r === 'string' ? ok(r) : r;
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  });
// Ändernder Befehl, danach (Standard) Layout + Darstellungsprüfung.
const fileChange = (method) => async (exec, { layout, ...args }) => {
  const text = json(await exec(method, args));
  return layout === false ? text : `${text}\n${await runLayout(exec, FILE_UNDO)}`;
};

const batchText = (r) => `${r.results.length} Operationen ausgeführt: ${JSON.stringify(r.results)}`;
server.registerTool(
  'create_diagram',
  {
    description:
      'Legt eine neue BPMN-Datei an (Camunda 8 oder Camunda 7). Mit "operations" wird das ganze Diagramm im selben Aufruf gebaut, angeordnet und geprüft. Fehlschlag, wenn die Datei schon existiert.',
    inputSchema: {
      file: FILE,
      processId: z.string().regex(/^[A-Za-z_][\w.-]*$/, 'Gültige XML-ID, z. B. Process_Bestellung').default('Process_1').describe('ID des Prozesses'),
      name: z.string().optional().describe('Anzeigename des Prozesses'),
      platform: z.enum(PLATFORMS).default(DEFAULT_PLATFORM).describe('Ausführungsplattform: bestimmt Dateikopf und technische Eigenschaften'),
      executable: z.boolean().default(true).describe('false für rein fachliche Modelle (strategisch/operativ), die nicht deployt werden'),
      platformVersion: z.string().regex(/^\d+\.\d+(\.\d+)?$/).optional().describe('Version der Ziel-Engine, z. B. "7.20.0" (steuert die Prüfungen im Modeler; Standard 7.23.0 bzw. 8.8.0)'),
      operations: OPERATIONS.optional(),
      poolOrder: LAYOUT_OPTS.poolOrder,
    },
  },
  async ({ file, processId, name, platform, executable, platformVersion, operations, poolOrder }) => {
    try {
      if (!path.isAbsolute(file)) return fail(`"file" muss ein absoluter Pfad sein: ${file}`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, emptyDiagram(processId, name, { platform, executable, version: platformVersion }), { encoding: 'utf8', flag: 'wx' });
      if (!operations?.length) return ok(`Diagramm angelegt (${platform}): ${file}`);
      try {
        const text = await withFile(file, async (exec) => `${batchText(await exec('batch', { operations }))}\n${await runLayout(exec, FILE_UNDO, { poolOrder })}`, { mutate: true });
        return ok(`Diagramm angelegt (${platform}): ${file}\n${text}`);
      } catch (e) {
        await fs.rm(file, { force: true });
        return fail(String(e.message ?? e).replace(/ – \d+ Schritte davor wurden ausgeführt\.$/, '') + ' – nichts angelegt.');
      }
    } catch (e) {
      return fail(e.code === 'EEXIST' ? `Datei existiert schon: ${file}` : String(e.message ?? e));
    }
  },
);
fileTool(
  'describe_diagram',
  'Listet alle Elemente und Verbindungen einer BPMN-Datei mit IDs, Typ, Pool/Lane, Event-Typ usw. (auch den Inhalt zugeklappter Teilprozesse, markiert mit "plane"). Vor Änderungen aufrufen.',
  DESCRIBE,
  (exec, args) => describe(exec, args),
);
fileTool(
  'add_element',
  'Fügt ein Element hinzu: Ereignisse (auch angeheftet), alle Aufgabentypen, Gateways, Teilprozesse, Pools/Lanes, Datenobjekte, Anmerkungen, Gruppen. Mit "after" wird es verbunden. Für mehrere Elemente batch nutzen.',
  { ...ADD, layout: AUTO_LAYOUT },
  fileChange('addElement'),
  { mutate: true },
);
fileTool(
  'connect',
  'Verbindet zwei Elemente: Sequenzfluss, Nachrichtenfluss (zwischen Pools) oder Assoziation – der Typ ergibt sich aus den BPMN-Regeln.',
  { ...CONNECT, layout: AUTO_LAYOUT },
  fileChange('connect'),
  { mutate: true },
);
fileTool(
  'update_element',
  'Ändert ein Element: Name, Typ, Event-Definition, Job-Typ, Bedingung/Standardfluss, Schleifen-Markierung, Farbe, Dokumentation, technische Eigenschaften (Camunda 8 bzw. 7).',
  { ...UPDATE, layout: AUTO_LAYOUT },
  fileChange('update'),
  { mutate: true },
);
fileTool('remove_element', 'Löscht ein oder mehrere Elemente (samt Verbindungen).', { ...REMOVE, layout: AUTO_LAYOUT }, fileChange('remove'), { mutate: true });
fileTool(
  'arrange',
  'Manuelle Anordnung: verschieben (auch in andere Lane/Pool), Größe ändern, Wegpunkte setzen, Beschriftung verschieben, ausrichten, verteilen. Normalerweise reicht das automatische Layout. Spätere Änderungen mit layout: false aufrufen, sonst wird neu angeordnet.',
  ARRANGE,
  async (exec, args) => json(await exec('arrange', args)),
  { mutate: true },
);
fileTool(
  'batch',
  'Führt mehrere Änderungen in einem Aufruf aus (der schnellste Weg, einen ganzen Prozess zu bauen), danach automatisch Layout und Darstellungsprüfung. Alles oder nichts: bei einem Fehler bleibt die Datei unverändert.',
  { operations: OPERATIONS, layout: AUTO_LAYOUT, poolOrder: LAYOUT_OPTS.poolOrder },
  async (exec, { operations, layout, poolOrder }) => {
    let r;
    try {
      r = await exec('batch', { operations });
    } catch (e) {
      throw new Error(String(e.message).replace(/ – \d+ Schritte davor wurden ausgeführt\.$/, '') + ' – nichts gespeichert, die Datei ist unverändert.');
    }
    return layout === false ? batchText(r) : `${batchText(r)}\n${await runLayout(exec, FILE_UNDO, { poolOrder })}`;
  },
  { mutate: true },
);
fileTool(
  'relayout',
  'Ordnet eine BPMN-Datei nach den Modellierungskonventionen neu an (Pools entlang der Nachrichtenflüsse gestapelt und ausgerichtet, Lanes, Teilprozesse) und meldet verbleibende Auffälligkeiten. only: "messageFlows" lässt alles außer den Nachrichtenflüssen unverändert.',
  LAYOUT_OPTS,
  (exec, args) => runLayout(exec, FILE_UNDO, layoutOpts(args)),
  { mutate: true },
);
fileTool(
  'check_diagram',
  'Prüft eine BPMN-Datei: Darstellung (Linien durch Elemente, Kreuzungen, Überlappungen), Benennung, Struktur, Nachrichtenflüsse, mögliche Deadlocks, Pflichtangaben der Plattform; mit level zusätzlich die Regeln der Modellebene. Listet die verwendeten Konstrukte auf.',
  { level: LEVEL, lint: LINT },
  (exec, { level, lint }) => check(exec, level, lint),
);
server.registerTool(
  'export_diagram',
  {
    description: 'Exportiert eine BPMN-Datei als PDF, SVG oder PNG (für die Abgabe). Standard: gleiche Datei mit anderer Endung.',
    inputSchema: { file: FILE, format: FORMAT, output: z.string().optional().describe('Absoluter Pfad der Ausgabedatei'), plane: VIEW.plane, includePlanes: INCLUDE_PLANES },
  },
  async ({ file, format, output, plane, includePlanes }) => {
    try {
      if (!path.isAbsolute(file)) return fail(`"file" muss ein absoluter Pfad sein: ${file}`);
      const svgs = await withFile(file, (exec) => collectSvgs(exec, { plane, includePlanes }));
      return ok(await writeSvgs(svgs, format, output ?? withExt(file, format)));
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);
fileTool(
  'screenshot_diagram',
  'Liefert ein Bild der BPMN-Datei, um die Darstellung selbst zu beurteilen. Bei großen Diagrammen mit ids/region einen Ausschnitt vergrößert ansehen; plane zeigt die Ebene eines zugeklappten Teilprozesses.',
  VIEW,
  (exec, args) => screenshot(exec, args),
);
for (const redo of [false, true]) {
  server.registerTool(
    redo ? 'redo' : 'undo',
    {
      description: redo
        ? 'Stellt die zuletzt mit undo rückgängig gemachte Änderung an der Datei wieder her.'
        : 'Macht die letzte Änderung an der Datei rückgängig (Verlauf der aktuellen Sitzung, bis zu 50 Schritte).',
      inputSchema: { file: FILE },
    },
    async ({ file }) => {
      try {
        const r = await undoFile(file, redo);
        return ok(`${redo ? 'Wiederhergestellt' : 'Rückgängig gemacht'}. Noch ${r.undo} Schritt(e) rückgängig, ${r.redo} wiederherstellbar.`);
      } catch (e) {
        return fail(String(e.message ?? e));
      }
    },
  );
}

// ---------- UML: Klassen- und Zustandsdiagramme aus einer Beschreibung (draw.io-XML, SVG, PDF, PNG) ----------
const UML_FILE = z.string().describe('Absoluter Pfad ohne Endung (oder mit .drawio); daneben entstehen .drawio, .svg, .pdf, .png und .uml.json');
const MULT = z.string().optional();
async function writeUml(file, spec, built) {
  if (!path.isAbsolute(file)) return fail(`"file" muss ein absoluter Pfad sein: ${file}`);
  const base = file.replace(/\.(drawio|svg|pdf|png|uml\.json|json|xml)$/i, '');
  await fs.mkdir(path.dirname(base), { recursive: true });
  const [pdf, png] = [await renderSvg(built.svg, 'pdf'), await renderSvg(built.svg, 'png', { maxSize: 2400 })];
  await Promise.all([
    fs.writeFile(`${base}.uml.json`, JSON.stringify(spec, null, 2), 'utf8'),
    fs.writeFile(`${base}.drawio`, built.drawio, 'utf8'),
    fs.writeFile(`${base}.svg`, built.svg, 'utf8'),
    fs.writeFile(`${base}.pdf`, pdf.data),
    fs.writeFile(`${base}.png`, png.data),
  ]);
  const notes = built.problems.length ? `${built.problems.length} Hinweise:\n${built.problems.map((p) => `- ${p}`).join('\n')}` : 'Keine Auffälligkeiten.';
  return { content: [{ type: 'image', data: png.data.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: `Geschrieben: ${base}.{drawio,svg,pdf,png,uml.json}\n${notes}` }] };
}
const umlTool = (name, description, inputSchema, build) =>
  server.registerTool(name, { description, inputSchema: { file: UML_FILE, ...inputSchema } }, async ({ file, ...spec }) => {
    try {
      return await writeUml(file, { diagram: name, ...spec }, build(spec));
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  });
umlTool(
  'uml_class_diagram',
  'Erzeugt ein UML-Klassendiagramm (Domänenmodell) aus einer Beschreibung: ordnet die Klassen automatisch an, verlegt die Beziehungen rechtwinklig und schreibt draw.io-XML, SVG, PDF und PNG. Überschreibt vorhandene Ausgaben; zum Ändern die .uml.json lesen, anpassen und erneut aufrufen. Liefert ein Vorschaubild und Hinweise (unbenannte Assoziationen, fehlende Kardinalitäten, Methoden, …).',
  {
    title: z.string().optional(),
    classes: z.array(
      z.object({
        name: z.string(),
        stereotype: z.string().optional().describe('z. B. "enumeration" oder "Akteur"'),
        abstract: z.boolean().optional(),
        attributes: z.array(z.string()).optional().describe('fachliche Attribute als "name: Typ"; bei enumeration die Werte'),
        col: z.number().optional().describe('Spalte im Raster (0 = links); nur angeben, um die automatische Anordnung zu überstimmen'),
        row: z.number().optional().describe('Zeile im Raster (0 = oben)'),
        color: z.string().optional().describe('Füllfarbe des Kopfes, z. B. "#dbe9f4"'),
      }),
    ),
    relations: z.array(
      z.object({
        from: z.string().describe('Klassenname; bei composition/aggregation das Ganze, bei generalization die Unterklasse'),
        to: z.string().describe('Klassenname; bei generalization die Oberklasse'),
        type: z.enum(['association', 'aggregation', 'composition', 'generalization', 'dependency']).default('association'),
        name: z.string().optional().describe('Name der Assoziation (Verb), z. B. "stellt"'),
        fromMult: MULT.describe('Kardinalität am from-Ende, z. B. "1"'),
        toMult: MULT.describe('Kardinalität am to-Ende, z. B. "0..*"'),
        fromRole: z.string().optional(),
        toRole: z.string().optional(),
        navigable: z.boolean().optional().describe('true: Pfeilspitze am to-Ende (Navigationsrichtung)'),
      }),
    ),
    notes: z.array(z.object({ text: z.string(), attachTo: z.string().optional().describe('Klassenname') })).optional(),
  },
  classDiagram,
);
umlTool(
  'uml_state_diagram',
  'Erzeugt ein UML-Zustandsdiagramm (Objektlebenszyklus, z. B. die Zustände eines Antrags) aus einer Beschreibung und schreibt draw.io-XML, SVG, PDF und PNG. Die Zustände sollten zu den Zuständen der Datenobjekte im BPMN-Modell passen.',
  {
    title: z.string().optional(),
    states: z.array(z.union([z.string(), z.object({ name: z.string(), description: z.string().optional() })])).describe('Zustände in sinnvoller Reihenfolge'),
    initial: z.string().describe('Anfangszustand'),
    finals: z.array(z.string()).optional().describe('Zustände, nach denen der Lebenszyklus endet'),
    transitions: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional().describe('auslösende Aktivität/Ereignis [Bedingung]') })),
  },
  stateDiagram,
);

// ---------- Camunda 7 Process Engine (REST): deployen, starten, Aufgaben erledigen, Timer auslösen, Zustand ansehen ----------
const ENGINE_URL = z.string().optional().describe(`Basis-URL der REST-API (Standard: ${engine.DEFAULT_URL}, änderbar über CAMUNDA_URL)`);
const INSTANCE = {
  processInstanceId: z.string().optional(),
  businessKey: z.string().optional().describe('Statt der ID: Business Key der Instanz (die neueste mit diesem Key)'),
};
const VARIABLES = z
  .record(z.string(), z.any())
  .optional()
  .describe('Prozessvariablen als { name: wert }; Typ automatisch (true → Boolean, 5 → Long, 1.5 → Double, "x" → String, Objekt → Json) oder explizit { value, type: "Date" | "Integer" | … }');
const engineTool = (name, description, shape, run) =>
  server.registerTool(name, { description, inputSchema: { ...shape, engineUrl: ENGINE_URL } }, async ({ engineUrl, ...args }) => {
    try {
      return ok(await run(engine.client(engineUrl), args));
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  });
engineTool('engine_status', 'Camunda 7: prüft, ob die Engine erreichbar ist, und listet deployte Prozesse und DMN-Entscheidungen (neueste Version) sowie laufende Instanzen und Incidents.', {}, (c) => engine.status(c));
engineTool(
  'engine_deploy',
  'Camunda 7: deployt BPMN-, DMN- und Formular-Dateien (.bpmn, .dmn, .form, .html) über die REST-API. Standard: nur Geänderte (deploy-changed-only). Vorher check_diagram mit level "technisch" ausführen.',
  {
    files: z.array(z.string()).min(1).describe('Absolute Pfade der Dateien'),
    name: z.string().optional().describe('Name des Deployments (Standard: erster Dateiname)'),
    changedOnly: z.boolean().optional().describe('false: immer neue Versionen anlegen (Standard true)'),
    tenantId: z.string().optional(),
  },
  (c, a) => engine.deploy(c, a),
);
engineTool(
  'engine_start_instance',
  'Camunda 7: startet eine Prozessinstanz (neueste Version des Keys) mit Variablen und Business Key und zeigt, wo sie danach wartet.',
  { processDefinitionKey: z.string().describe('ID des Prozesses (process id im BPMN)'), businessKey: z.string().optional(), variables: VARIABLES, tenantId: z.string().optional() },
  (c, a) => engine.start(c, a),
);
engineTool(
  'engine_tasks',
  'Camunda 7: listet offene User Tasks – je Instanz (ID oder Business Key), Bearbeiter, Kandidatengruppe oder Name; mit formVariables auch die Formularfelder.',
  { ...INSTANCE, assignee: z.string().optional(), candidateGroup: z.string().optional(), candidateUser: z.string().optional(), name: z.string().optional().describe('Teil des Aufgabennamens'), formVariables: z.boolean().optional() },
  (c, a) => engine.tasks(c, a),
);
engineTool(
  'engine_complete_task',
  'Camunda 7: erledigt eine User Task mit Variablen – per taskId oder per Instanz (ID/Business Key) + Aufgabenname. Mit user wird sie vorher diesem Benutzer zugewiesen (claim), wie in der Tasklist. Zeigt danach, wo die Instanz wartet.',
  {
    taskId: z.string().optional(),
    ...INSTANCE,
    name: z.string().optional().describe('Aufgabenname (exakt oder Teil davon)'),
    taskDefinitionKey: z.string().optional().describe('ID der User Task im BPMN'),
    variables: VARIABLES,
    user: z.string().optional().describe('Benutzer, der die Aufgabe übernimmt (claim) und erledigt'),
    submitForm: z.boolean().optional().describe('true: wie das Formular in der Tasklist absenden (submit-form, prüft Generated-Form-Felder)'),
  },
  (c, a) => engine.complete(c, a),
);
engineTool(
  'engine_instance',
  'Camunda 7: Zustand einer Prozessinstanz (ID oder Business Key, auch beendet): wo sie wartet, offene Aufgaben, Timer/Jobs, External Tasks, Incidents, Variablen und Verlauf der durchlaufenen Aktivitäten.',
  { ...INSTANCE, history: z.boolean().optional().describe('Verlauf ausgeben (Standard true)'), variables: z.boolean().optional().describe('Variablen ausgeben (Standard true)') },
  (c, { history, variables, ...ref }) => engine.instanceState(c, ref, { history: history ?? true, variables: variables ?? true }),
);
engineTool(
  'engine_execute_jobs',
  'Camunda 7: führt fällige und noch nicht fällige Jobs einer Instanz sofort aus – z. B. Timer („3 Tage vergangen“) im Testlauf auslösen oder asynchrone Fortsetzungen anstoßen.',
  { ...INSTANCE, jobId: z.string().optional(), timersOnly: z.boolean().optional().describe('nur Timer-Jobs') },
  (c, a) => engine.executeJobs(c, a),
);
engineTool(
  'engine_correlate_message',
  'Camunda 7: sendet eine Nachricht an wartende Nachrichtenereignisse/Receive Tasks oder startet per Nachrichten-Startereignis eine Instanz.',
  {
    messageName: z.string(),
    ...INSTANCE,
    variables: VARIABLES.describe('Prozessvariablen, die mit der Nachricht gesetzt werden'),
    correlationKeys: z.record(z.string(), z.any()).optional().describe('Korrelation über Variablenwerte'),
    all: z.boolean().optional().describe('an alle passenden Empfänger'),
  },
  (c, a) => engine.correlate(c, a),
);
engineTool(
  'engine_incidents',
  'Camunda 7: listet Incidents (fehlgeschlagene Jobs/External Tasks) mit Fehlermeldung und Stacktrace-Anfang; mit retry: true werden die Retries auf 1 gesetzt (nach der Fehlerbehebung).',
  { ...INSTANCE, retry: z.boolean().optional() },
  (c, a) => engine.incidents(c, a),
);
engineTool(
  'engine_rest',
  'Camunda 7: beliebiger Aufruf der REST-API für alles, was die anderen engine_-Tools nicht abdecken (z. B. GET /history/detail?processInstanceId=…, DELETE /process-instance/{id}, POST /decision-definition/key/{key}/evaluate).',
  {
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('GET'),
    path: z.string().describe('Pfad relativ zur Basis-URL, z. B. "/history/process-instance?finished=true"'),
    body: z.any().optional().describe('JSON-Body bei POST/PUT'),
  },
  (c, a) => engine.rest(c, a),
);

// Beim Ende der Sitzung auch den Headless-Browser beenden.
const shutdown = () => closeHeadless().finally(() => process.exit(0));
process.stdin.on('end', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await server.connect(new StdioServerTransport());
