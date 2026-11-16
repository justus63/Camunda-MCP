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
import { checkDiagram, formatCheck, formatInventory, LEVELS } from './check.js';
import { withFile, undoFile, emptyDiagram, closeHeadless, renderSvg, PLATFORMS, DEFAULT_PLATFORM } from './headless.js';
import { classDiagram, stateDiagram } from './uml.js';

// ---------- Live-Brücke zum Camunda Modeler (Plugin verbindet sich hierher) ----------
const BRIDGE_PORT = Number(process.env.BPMN_MCP_PORT ?? 17877);
const PLUGIN_VERSION = 5;
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
const MAX_SIZE = z.number().optional().describe('Maximale Kantenlänge in Pixeln (Standard 2000)');

// ---------- Gemeinsame Logik; exec(method, params) führt einen Plugin-Befehl aus (live oder headless) ----------
const LAYOUT_RULES = /^(linie-durch-element|ueberlappung|kreuzung|linien-uebereinander|beschriftung-verdeckt|beschriftung-auf-linie|beschriftungen-ueberlappen|schraege-linie)$/;
const layoutOnly = (res) => ({ ...res, problems: res.problems.filter((p) => LAYOUT_RULES.test(p.rule)) });

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });
const json = (v) => JSON.stringify(v, null, 2);

// Kompakte Ausgabe: gültiges JSON, aber nur eine Zeile je Element (spart bei großen Diagrammen viele Tokens).
async function describe(exec, geometry) {
  const g = await exec('graph');
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
  const result = await exec('applyLayout', computeLayout(await exec('graph'), opts));
  const res = layoutOnly(checkDiagram(await exec('graph')));
  const what = opts.only === 'messageFlows' ? `Nachrichtenflüsse neu verlegt: ${result.edges}` : `Layout angewendet: ${result.shapes} Elemente, ${result.edges} Verbindungen`;
  return `${what} ${undoHint}.\n${formatCheck(res)}`;
}

const LEVEL = z
  .enum(LEVELS)
  .optional()
  .describe('Modellebene: strategisch (grob, Happy Case, max. 10 Schritte), operativ (Kollaboration, Nachrichten- und Datenfluss, keine Deadlocks), technisch (ausführbar auf der Plattform). Ohne Angabe: allgemeine Konventionen + technische Pflichtangaben der ausführbaren Prozesse');
async function check(exec, level) {
  const res = checkDiagram(await exec('graph'), { level });
  return `${level ? `Ebene: ${level}\n` : ''}${formatCheck(res)}\n${formatInventory(res.inventory)}`;
}

async function screenshot(exec, maxSize) {
  const r = await exec('screenshot', { maxSize });
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
UML: uml_class_diagram (Domänenmodell: Klassen mit fachlichen Attributen, benannte Assoziationen mit Kardinalitäten, keine Methoden) und uml_state_diagram (Objektlebenszyklus) erzeugen aus einer Beschreibung .drawio (XML), .svg, .pdf und .png in einem Aufruf.`;

const server = new McpServer({ name: 'bpmn-modeler-mcp', version: '0.5.0' }, { instructions: INSTRUCTIONS });

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
  'Listet alle Elemente und Verbindungen des im Modeler aktiven Diagramms mit IDs, Typ, Pool/Lane, Event-Typ usw. Vor Änderungen aufrufen.',
  { geometry: GEOMETRY },
  ({ geometry }) => describe(callModeler, geometry),
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
  { level: LEVEL },
  ({ level }) => check(callModeler, level),
);
liveTool(
  'live_export',
  'Exportiert das aktive Diagramm als PDF, SVG oder PNG (für die Abgabe).',
  { format: FORMAT, output: z.string().describe('Absoluter Pfad der Ausgabedatei') },
  async ({ format, output }) => exportDiagram((await callModeler('svg')).svg, format, output),
);
liveTool('live_screenshot', 'Liefert ein Bild des aktiven Diagramms, um die Darstellung selbst zu beurteilen.', { maxSize: MAX_SIZE }, ({ maxSize }) =>
  screenshot(callModeler, maxSize),
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
      operations: OPERATIONS.optional(),
      poolOrder: LAYOUT_OPTS.poolOrder,
    },
  },
  async ({ file, processId, name, platform, executable, operations, poolOrder }) => {
    try {
      if (!path.isAbsolute(file)) return fail(`"file" muss ein absoluter Pfad sein: ${file}`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, emptyDiagram(processId, name, { platform, executable }), { encoding: 'utf8', flag: 'wx' });
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
  'Listet alle Elemente und Verbindungen einer BPMN-Datei mit IDs, Typ, Pool/Lane, Event-Typ usw. Vor Änderungen aufrufen.',
  { geometry: GEOMETRY },
  (exec, { geometry }) => describe(exec, geometry),
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
  { level: LEVEL },
  (exec, { level }) => check(exec, level),
);
server.registerTool(
  'export_diagram',
  {
    description: 'Exportiert eine BPMN-Datei als PDF, SVG oder PNG (für die Abgabe). Standard: gleiche Datei mit anderer Endung.',
    inputSchema: { file: FILE, format: FORMAT, output: z.string().optional().describe('Absoluter Pfad der Ausgabedatei') },
  },
  async ({ file, format, output }) => {
    try {
      if (!path.isAbsolute(file)) return fail(`"file" muss ein absoluter Pfad sein: ${file}`);
      const { svg } = await withFile(file, (exec) => exec('svg'));
      return ok(await exportDiagram(svg, format, output ?? withExt(file, format)));
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);
fileTool('screenshot_diagram', 'Liefert ein Bild der BPMN-Datei, um die Darstellung selbst zu beurteilen.', { maxSize: MAX_SIZE }, (exec, { maxSize }) =>
  screenshot(exec, maxSize),
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

// Beim Ende der Sitzung auch den Headless-Browser beenden.
const shutdown = () => closeHeadless().finally(() => process.exit(0));
process.stdin.on('end', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await server.connect(new StdioServerTransport());
