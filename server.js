#!/usr/bin/env node
// MCP-Server zum Zeichnen/Bearbeiten von BPMN-Dateien (Camunda 8 / Zeebe).
// Datei-Modus: jede Änderung wird in die .bpmn-Datei geschrieben und das Layout neu berechnet (layout.js).
// Live-Modus: bearbeitet das im Camunda Modeler geöffnete Diagramm über das Plugin (plugin/client.js).
// Der Camunda Modeler erkennt die Änderung und bietet ein Neuladen an.
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WebSocketServer } from 'ws';
import { BpmnModdle } from 'bpmn-moddle';
import zeebeModdle from 'zeebe-bpmn-moddle/resources/zeebe.json' with { type: 'json' };
import { computeLayout } from './layout.js';
import { checkDiagram, formatCheck } from './check.js';
import { graphFromDefinitions, writeDi, summarizeEventDefinition as summarizeDef } from './model.js';

const moddle = new BpmnModdle({ zeebe: zeebeModdle });

// ---------- Live-Brücke zum Camunda Modeler (Plugin verbindet sich hierher) ----------
const BRIDGE_PORT = Number(process.env.BPMN_MCP_PORT ?? 17877);
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

function callModeler(method, params = {}, timeout = 15000) {
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

const ELEMENT_TYPES = {
  startEvent: 'bpmn:StartEvent',
  endEvent: 'bpmn:EndEvent',
  task: 'bpmn:Task',
  userTask: 'bpmn:UserTask',
  serviceTask: 'bpmn:ServiceTask',
  scriptTask: 'bpmn:ScriptTask',
  businessRuleTask: 'bpmn:BusinessRuleTask',
  sendTask: 'bpmn:SendTask',
  receiveTask: 'bpmn:ReceiveTask',
  callActivity: 'bpmn:CallActivity',
  exclusiveGateway: 'bpmn:ExclusiveGateway',
  parallelGateway: 'bpmn:ParallelGateway',
  inclusiveGateway: 'bpmn:InclusiveGateway',
  eventBasedGateway: 'bpmn:EventBasedGateway',
  intermediateCatchEvent: 'bpmn:IntermediateCatchEvent',
  intermediateThrowEvent: 'bpmn:IntermediateThrowEvent',
};

// ---------- Event-Definitionen (Timer, Message, ...) ----------
const EVENT_DEFINITION = z
  .object({
    type: z
      .enum(['none', 'timer', 'message', 'signal', 'error', 'escalation', 'conditional', 'terminate', 'link'])
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

const EVENT_DEF_TYPES = {
  timer: 'bpmn:TimerEventDefinition',
  message: 'bpmn:MessageEventDefinition',
  signal: 'bpmn:SignalEventDefinition',
  error: 'bpmn:ErrorEventDefinition',
  escalation: 'bpmn:EscalationEventDefinition',
  conditional: 'bpmn:ConditionalEventDefinition',
  terminate: 'bpmn:TerminateEventDefinition',
  link: 'bpmn:LinkEventDefinition',
};
const ROOT_FOR_DEF = {
  message: ['bpmn:Message', 'messageRef', 'Message'],
  signal: ['bpmn:Signal', 'signalRef', 'Signal'],
  error: ['bpmn:Error', 'errorRef', 'Error'],
  escalation: ['bpmn:Escalation', 'escalationRef', 'Escalation'],
};
const TIMER_PROP = { date: 'timeDate', duration: 'timeDuration', cycle: 'timeCycle' };

function slug(s) {
  return String(s).replace(/[^A-Za-z0-9_]/g, '_').replace(/^([^A-Za-z_])/, '_$1');
}

// Baut eine Event-Definition (moddle-Objekt) und legt ggf. Message/Signal/... als Root-Element an.
function buildEventDefinition(definitions, el, spec) {
  if (!/Event$/.test(el.$type)) throw new Error(`eventDefinition geht nur bei Events, nicht bei ${el.$type}.`);
  if (spec.type === 'none') return null;
  const def = moddle.create(EVENT_DEF_TYPES[spec.type]);
  if (spec.type === 'timer') {
    if (!spec.value) throw new Error('Timer braucht "value" (z. B. "P7D" oder "= startDatum").');
    const prop = TIMER_PROP[spec.timerType ?? 'duration'];
    def[prop] = moddle.create('bpmn:FormalExpression', { body: spec.value });
  } else if (spec.type === 'conditional') {
    if (!spec.value) throw new Error('Conditional braucht "value" (FEEL-Bedingung).');
    def.condition = moddle.create('bpmn:FormalExpression', { body: spec.value });
  } else if (spec.type === 'link') {
    def.name = spec.name ?? el.name ?? 'Link';
  } else if (ROOT_FOR_DEF[spec.type]) {
    const [rootType, refProp, prefix] = ROOT_FOR_DEF[spec.type];
    const name = spec.name ?? el.name ?? prefix;
    definitions.rootElements = definitions.rootElements ?? [];
    let root = definitions.rootElements.find((r) => r.$type === rootType && r.name === name);
    if (!root) {
      const used = new Set(definitions.rootElements.map((r) => r.id));
      let id = `${prefix}_${slug(name)}`;
      for (let i = 2; used.has(id); i++) id = `${prefix}_${slug(name)}_${i}`;
      root = moddle.create(rootType, { id, name });
      definitions.rootElements.push(root);
    }
    if (spec.code && spec.type === 'error') root.errorCode = spec.code;
    if (spec.code && spec.type === 'escalation') root.escalationCode = spec.code;
    if (spec.correlationKey && spec.type === 'message') {
      const ext = root.extensionElements ?? moddle.create('bpmn:ExtensionElements', { values: [] });
      ext.values = (ext.values ?? []).filter((v) => v.$type !== 'zeebe:Subscription');
      ext.values.push(moddle.create('zeebe:Subscription', { correlationKey: spec.correlationKey }));
      root.extensionElements = ext;
    }
    def[refProp] = root;
  }
  return def;
}

function applyEventDefinition(definitions, el, spec) {
  const def = buildEventDefinition(definitions, el, spec);
  el.eventDefinitions = def ? [def] : [];
}

function summarizeEventDefinition(el) {
  const d = summarizeDef(el);
  if (!d) return null;
  if (d.type === 'timer') return `timer(${d.timerType}: ${d.value})`;
  if (d.name) return `${d.type}(${d.name}${d.correlationKey ? `, correlationKey ${d.correlationKey}` : ''})`;
  return d.value ? `${d.type}(${d.value})` : d.type;
}

// Ersetzt ein Element durch einen anderen Typ (gleiche ID, Name, Verbindungen).
function changeType(process, el, type) {
  const bpmnType = ELEMENT_TYPES[type];
  if (el.$type === bpmnType) return el;
  const repl = moddle.create(bpmnType, { id: el.id, name: el.name });
  const isEvent = (t) => /Event$/.test(t);
  if (isEvent(el.$type) && isEvent(bpmnType) && el.eventDefinitions?.length) repl.eventDefinitions = el.eventDefinitions;
  if (el.extensionElements && !/Gateway$/.test(bpmnType)) repl.extensionElements = el.extensionElements;
  process.flowElements[process.flowElements.indexOf(el)] = repl;
  for (const f of process.flowElements.filter((e) => e.$type === 'bpmn:SequenceFlow')) {
    if (f.sourceRef === el) f.sourceRef = repl;
    if (f.targetRef === el) f.targetRef = repl;
    // Ereignisbasierte/parallele Gateways haben keine Bedingungen an ihren Ausgängen.
    if (f.sourceRef === repl && /EventBasedGateway|ParallelGateway/.test(bpmnType)) delete f.conditionExpression;
  }
  return repl;
}

const LAYOUT_RULES = /^(linie-durch-element|ueberlappung|kreuzung|linien-uebereinander|beschriftung-verdeckt|beschriftung-auf-linie|beschriftungen-ueberlappen|schraege-linie)$/;
const layoutOnly = (res) => ({ ...res, problems: res.problems.filter((p) => LAYOUT_RULES.test(p.rule)) });

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });

async function load(file) {
  const xml = await fs.readFile(file, 'utf8');
  const { rootElement, warnings } = await moddle.fromXML(xml);
  const process = rootElement.rootElements.find((e) => e.$type === 'bpmn:Process');
  if (!process) throw new Error('Kein bpmn:Process in der Datei gefunden.');
  process.flowElements = process.flowElements ?? [];
  return { definitions: rootElement, process, warnings };
}

async function save(file, definitions) {
  // incoming/outgoing pro Knoten neu aufbauen (gültiges BPMN braucht sie).
  const process = definitions.rootElements.find((e) => e.$type === 'bpmn:Process');
  const nodes = process.flowElements.filter((e) => e.$type !== 'bpmn:SequenceFlow' && e.$instanceOf('bpmn:FlowNode'));
  for (const n of nodes) {
    n.incoming = [];
    n.outgoing = [];
  }
  for (const f of process.flowElements.filter((e) => e.$type === 'bpmn:SequenceFlow')) {
    f.sourceRef.outgoing?.push(f);
    f.targetRef.incoming?.push(f);
  }
  const graph = graphFromDefinitions(definitions);
  writeDi(moddle, definitions, graph, computeLayout(graph));
  const { xml } = await moddle.toXML(definitions, { format: true });
  await fs.writeFile(file, xml, 'utf8');
}

function findFlowElement(process, id) {
  return process.flowElements.find((e) => e.id === id);
}

function uniqueId(process, prefix) {
  const used = new Set(process.flowElements.map((e) => e.id));
  let i = 1;
  while (used.has(`${prefix}_${i}`)) i++;
  return `${prefix}_${i}`;
}

function describe(process) {
  const nodes = process.flowElements.filter((e) => e.$type !== 'bpmn:SequenceFlow');
  const flows = process.flowElements.filter((e) => e.$type === 'bpmn:SequenceFlow');
  const lines = [`Prozess: ${process.id}${process.name ? ` ("${process.name}")` : ''}`, '', 'Elemente:'];
  for (const n of nodes) {
    const extra = [];
    const td = n.extensionElements?.values?.find((v) => v.$type === 'zeebe:TaskDefinition');
    if (td) extra.push(`jobType=${td.type}`);
    const ev = summarizeEventDefinition(n);
    if (ev) extra.push(ev);
    lines.push(`- ${n.id} [${n.$type.replace('bpmn:', '')}]${n.name ? ` "${n.name}"` : ''}${extra.length ? ` (${extra.join(', ')})` : ''}`);
  }
  lines.push('', 'Verbindungen:');
  for (const f of flows) {
    lines.push(
      `- ${f.id}: ${f.sourceRef.id} -> ${f.targetRef.id}${f.name ? ` "${f.name}"` : ''}${f.conditionExpression ? ` [${f.conditionExpression.body}]` : ''}`,
    );
  }
  return lines.join('\n');
}

const INSTRUCTIONS = `BPMN-Modellierung für den Camunda Modeler (Camunda 8).
Arbeitsweise im Live-Modus: live_status -> live_describe -> Änderungen (am besten gebündelt mit live_batch) -> live_layout -> live_check -> live_screenshot ansehen -> live_save.
Modellierungskonventionen (verbindlich):
- Von links nach rechts modellieren; der Normalablauf ("Happy Path") liegt auf einer geraden Linie.
- Überschneidungen vermeiden: keine Linie durch ein Element, möglichst keine Kreuzungen (live_layout erledigt das; nicht von Hand Wegpunkte setzen, außer live_check meldet etwas).
- Namensgebung: Startereignis = Prozessauslöser ("Auftrag erhalten"), Aufgabe = Objekt + Verb ("Auftrag prüfen"), Zwischenereignis = Objekt + Partizip ("Auftrag geprüft"), verzweigendes XOR/OR-Gateway = Frage ("Auftragsdaten korrekt?"), dessen Ausgänge = Antworten ("ja"/"nein"), Endereignis = Endzustand ("Auftrag abgelehnt").
- Symmetrisch modellieren: jede Verzweigung bekommt ein eigenes zusammenführendes Gateway gleichen Typs; ein Gateway nie gleichzeitig zusammenführen und verzweigen lassen; explizite Gateways statt mehrerer Ein-/Ausgänge an Aufgaben.
- Gleiche Aufgabengröße (Standard 100x80 nicht verändern), kurze Namen.
- Camunda 8: Zwischenereignisse brauchen einen Typ (eventDefinition), Service Tasks einen jobType, XOR-Ausgänge eine FEEL-Bedingung oder isDefault; nach einem ereignisbasierten Gateway folgen nur eintretende Ereignisse, ohne Bedingungen.`;

const server = new McpServer({ name: 'bpmn-modeler-mcp', version: '0.3.0' }, { instructions: INSTRUCTIONS });

server.registerTool(
  'create_diagram',
  {
    description: 'Legt eine neue, leere BPMN-Datei (Camunda 8) an. Fehlschlag, wenn die Datei schon existiert.',
    inputSchema: {
      file: z.string().describe('Absoluter Pfad der .bpmn-Datei'),
      processId: z.string().default('Process_1').describe('ID des Prozesses'),
      name: z.string().optional().describe('Anzeigename des Prozesses'),
    },
  },
  async ({ file, processId, name }) => {
    try {
      await fs.access(file);
      return fail(`Datei existiert schon: ${file}`);
    } catch {}
    const process = moddle.create('bpmn:Process', { id: processId, name, isExecutable: true, flowElements: [] });
    const definitions = moddle.create('bpmn:Definitions', {
      id: 'Definitions_1',
      targetNamespace: 'http://bpmn.io/schema/bpmn',
      rootElements: [process],
      'xmlns:zeebe': 'http://camunda.org/schema/zeebe/1.0',
      'xmlns:modeler': 'http://camunda.org/schema/modeler/1.0',
      'modeler:executionPlatform': 'Camunda Cloud',
      'modeler:executionPlatformVersion': '8.8.0',
    });
    await fs.mkdir(path.dirname(file), { recursive: true });
    const { xml } = await moddle.toXML(definitions, { format: true });
    await fs.writeFile(file, xml, 'utf8');
    return ok(`Diagramm angelegt: ${file}`);
  },
);

server.registerTool(
  'describe_diagram',
  {
    description: 'Listet alle Elemente und Verbindungen eines Diagramms mit ihren IDs. Vor Änderungen aufrufen.',
    inputSchema: { file: z.string() },
  },
  async ({ file }) => {
    try {
      const { process } = await load(file);
      return ok(describe(process));
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

server.registerTool(
  'add_element',
  {
    description:
      'Fügt ein Element hinzu (Start/End-Event, Tasks, Gateways, ...). Optional direkt mit "after" an ein bestehendes Element anhängen.',
    inputSchema: {
      file: z.string(),
      type: z.enum(Object.keys(ELEMENT_TYPES)),
      name: z.string().optional(),
      id: z.string().optional().describe('Eigene ID, sonst automatisch'),
      after: z.string().optional().describe('ID eines Elements, von dem aus eine Verbindung gezogen wird'),
      flowName: z.string().optional().describe('Beschriftung der Verbindung (z. B. bei Gateways)'),
      eventDefinition: EVENT_DEFINITION.optional(),
    },
  },
  async ({ file, type, name, id, after, flowName, eventDefinition }) => {
    try {
      const { definitions, process } = await load(file);
      const bpmnType = ELEMENT_TYPES[type];
      const elementId = id ?? uniqueId(process, bpmnType.replace('bpmn:', ''));
      if (findFlowElement(process, elementId)) return fail(`ID existiert schon: ${elementId}`);
      const el = moddle.create(bpmnType, { id: elementId, name });
      if (eventDefinition) applyEventDefinition(definitions, el, eventDefinition);
      process.flowElements.push(el);
      let msg = `Hinzugefügt: ${elementId}`;
      if (after) {
        const src = findFlowElement(process, after);
        if (!src) return fail(`Quelle nicht gefunden: ${after}`);
        const fid = uniqueId(process, 'Flow');
        process.flowElements.push(
          moddle.create('bpmn:SequenceFlow', { id: fid, name: flowName, sourceRef: src, targetRef: el }),
        );
        msg += ` (verbunden von ${after})`;
      }
      await save(file, definitions);
      return ok(msg);
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

server.registerTool(
  'connect',
  {
    description: 'Verbindet zwei vorhandene Elemente mit einem Sequenzfluss.',
    inputSchema: {
      file: z.string(),
      source: z.string(),
      target: z.string(),
      name: z.string().optional(),
      condition: z.string().optional().describe('FEEL-Bedingung, z. B. "= amount > 100" (für Gateway-Ausgänge)'),
    },
  },
  async ({ file, source, target, name, condition }) => {
    try {
      const { definitions, process } = await load(file);
      const s = findFlowElement(process, source);
      const t = findFlowElement(process, target);
      if (!s || !t) return fail(`Element nicht gefunden: ${!s ? source : target}`);
      if (condition && /EventBasedGateway|ParallelGateway/.test(s.$type)) {
        return fail(`${s.$type.replace('bpmn:', '')} hat keine Bedingungen an seinen Ausgängen.`);
      }
      const flow = moddle.create('bpmn:SequenceFlow', {
        id: uniqueId(process, 'Flow'),
        name,
        sourceRef: s,
        targetRef: t,
      });
      if (condition) {
        flow.conditionExpression = moddle.create('bpmn:FormalExpression', { body: condition });
      }
      process.flowElements.push(flow);
      await save(file, definitions);
      return ok(`Verbindung ${flow.id}: ${source} -> ${target}`);
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

server.registerTool(
  'update_element',
  {
    description:
      'Ändert Name, Typ (z. B. exclusiveGateway -> eventBasedGateway), Event-Definition (Timer/Message/...), Job-Typ (Service Task) eines Elements bzw. Name/Bedingung einer Verbindung.',
    inputSchema: {
      file: z.string(),
      id: z.string(),
      name: z.string().optional(),
      type: z.enum(Object.keys(ELEMENT_TYPES)).optional().describe('Neuer Elementtyp; ID und Verbindungen bleiben'),
      eventDefinition: EVENT_DEFINITION.optional(),
      jobType: z.string().optional().describe('zeebe:taskDefinition type, nur für Service Tasks'),
      condition: z.string().optional().describe('FEEL-Bedingung, nur für Sequenzflüsse'),
    },
  },
  async ({ file, id, name, type, eventDefinition, jobType, condition }) => {
    try {
      const { definitions, process } = await load(file);
      let el = findFlowElement(process, id);
      if (!el) return fail(`Element nicht gefunden: ${id}`);
      if (type !== undefined) {
        if (el.$type === 'bpmn:SequenceFlow') return fail('type geht nicht bei Verbindungen.');
        el = changeType(process, el, type);
      }
      if (eventDefinition !== undefined) applyEventDefinition(definitions, el, eventDefinition);
      if (name !== undefined) el.name = name;
      if (jobType !== undefined) {
        if (el.$type !== 'bpmn:ServiceTask') return fail('jobType geht nur bei serviceTask.');
        const ext = el.extensionElements ?? moddle.create('bpmn:ExtensionElements', { values: [] });
        ext.values = (ext.values ?? []).filter((v) => v.$type !== 'zeebe:TaskDefinition');
        ext.values.push(moddle.create('zeebe:TaskDefinition', { type: jobType }));
        el.extensionElements = ext;
      }
      if (condition !== undefined) {
        if (el.$type !== 'bpmn:SequenceFlow') return fail('condition geht nur bei Verbindungen.');
        el.conditionExpression = moddle.create('bpmn:FormalExpression', { body: condition });
      }
      await save(file, definitions);
      return ok(`Aktualisiert: ${id}`);
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

server.registerTool(
  'remove_element',
  {
    description: 'Löscht ein Element samt aller daran hängenden Verbindungen.',
    inputSchema: { file: z.string(), id: z.string() },
  },
  async ({ file, id }) => {
    try {
      const { definitions, process } = await load(file);
      const el = findFlowElement(process, id);
      if (!el) return fail(`Element nicht gefunden: ${id}`);
      process.flowElements = process.flowElements.filter(
        (e) => e !== el && !(e.$type === 'bpmn:SequenceFlow' && (e.sourceRef === el || e.targetRef === el)),
      );
      await save(file, definitions);
      return ok(`Gelöscht: ${id}`);
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

server.registerTool(
  'relayout',
  {
    description: 'Berechnet das Diagramm-Layout einer Datei neu (auch Pools, Lanes, Teilprozesse) und meldet verbleibende Auffälligkeiten.',
    inputSchema: { file: z.string() },
  },
  async ({ file }) => {
    try {
      const { definitions } = await load(file);
      await save(file, definitions);
      const res = checkDiagram(graphFromDefinitions((await load(file)).definitions));
      return ok(`Layout aktualisiert.\n${formatCheck(layoutOnly(res))}`);
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

server.registerTool(
  'check_diagram',
  {
    description: 'Prüft eine BPMN-Datei gegen die Modellierungskonventionen: Darstellung (Linien durch Elemente, Kreuzungen, Überlappungen), Benennung, Struktur, Camunda-8-Pflichtangaben.',
    inputSchema: { file: z.string() },
  },
  async ({ file }) => {
    try {
      return ok(formatCheck(checkDiagram(graphFromDefinitions((await load(file)).definitions))));
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

// ---------- Live-Tools: bearbeiten das im Modeler geöffnete Diagramm (mit Undo/Redo) ----------
const PLUGIN_VERSION = 3;
const LIVE_TYPES = [
  ...Object.keys(ELEMENT_TYPES), 'manualTask', 'complexGateway', 'boundaryEvent', 'subProcess', 'eventSubProcess', 'transaction',
  'adHocSubProcess', 'dataObject', 'dataStore', 'textAnnotation', 'group', 'participant', 'lane',
];
const LIVE_EVENT_DEFINITION = EVENT_DEFINITION.extend({
  type: z.enum(['none', 'timer', 'message', 'signal', 'error', 'escalation', 'conditional', 'terminate', 'link', 'compensate']),
});
const MAPPING = z.array(z.object({ source: z.string(), target: z.string() }));
const PROPS = {
  eventDefinition: LIVE_EVENT_DEFINITION.optional(),
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
    })
    .optional()
    .describe('Schleifen-/Mehrfach-Markierung (parallel/sequential = Multi-Instanz)'),
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
      script: z.string().optional().describe('Script Task: FEEL-Ausdruck'),
      inputs: MAPPING.optional(),
      outputs: MAPPING.optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .optional()
    .describe('Camunda-8-Eigenschaften'),
};
const ADD = {
  type: z.enum(LIVE_TYPES),
  name: z.string().optional().describe('Name; bei textAnnotation der Text'),
  id: z.string().optional(),
  after: z.string().optional().describe('ID des Elements, hinter dem eingefügt und verbunden wird'),
  flowName: z.string().optional().describe('Beschriftung der neuen Verbindung'),
  parent: z.string().optional().describe('Pool, Lane oder aufgeklappter Teilprozess, in dem das Element liegen soll'),
  attachTo: z.string().optional().describe('boundaryEvent: Aktivität, an die angeheftet wird; textAnnotation/dataObject/dataStore: verknüpftes Element'),
  direction: z.enum(['input', 'output']).optional().describe('dataObject/dataStore: wird gelesen (input) oder geschrieben (output, Standard)'),
  expanded: z.boolean().optional().describe('Teilprozess/Pool zugeklappt anlegen: false'),
  lanes: z.array(z.string()).optional().describe('participant: Namen der Lanes von oben nach unten'),
  around: z.array(z.string()).optional().describe('group: Elemente, die umrahmt werden'),
  position: z.any().optional().describe('{x,y} Mittelpunkt (nur wenn nötig – sonst live_layout); bei lane: "top"/"bottom"'),
  ...PROPS,
};
const CONNECT = {
  source: z.string(),
  target: z.string(),
  name: z.string().optional(),
  condition: z.string().optional().describe('FEEL-Bedingung, z. B. "= amount > 100"'),
  isDefault: z.boolean().optional().describe('Standardfluss des Gateways'),
  type: z.enum(['sequence', 'message', 'association']).optional().describe('Standard: automatisch (Sequenzfluss, Nachrichtenfluss zwischen Pools, Datenassoziation)'),
};
const UPDATE = {
  id: z.string(),
  name: z.string().optional(),
  type: z.enum(LIVE_TYPES).optional().describe('Neuer Elementtyp; ID und Verbindungen bleiben'),
  condition: z.string().optional().describe('Sequenzfluss: FEEL-Bedingung ("" entfernt sie)'),
  isDefault: z.boolean().optional().describe('Sequenzfluss als Standardfluss markieren'),
  newId: z.string().optional(),
  ...PROPS,
};
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

const live = (name, description, inputSchema, method, format) =>
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      const result = await callModeler(method, args);
      return ok(format ? format(result) : JSON.stringify(result, null, 2));
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  });

live('live_status', 'Prüft, ob der Camunda Modeler verbunden ist und welcher Tab aktiv ist.', {}, 'status', (r) =>
  JSON.stringify(
    r.plugin === PLUGIN_VERSION ? r : { ...r, warnung: 'Plugin im Modeler ist veraltet: ./install-plugin.sh ausführen und den Modeler komplett neu starten.' },
    null,
    2,
  ),
);

server.registerTool(
  'live_describe',
  {
    description: 'Listet alle Elemente und Verbindungen des im Modeler aktiven Diagramms mit IDs, Typ, Pool/Lane, Event-Typ usw. Vor Änderungen aufrufen.',
    inputSchema: { geometry: z.boolean().optional().describe('true: auch Positionen und Wegpunkte ausgeben') },
  },
  async ({ geometry }) => {
    try {
      const g = await callModeler('graph');
      const strip = ({ x, y, width, height, label, waypoints, members, ...rest }) => (geometry ? { ...rest, x, y, width, height, waypoints } : rest);
      return ok(JSON.stringify({ root: g.root, elements: g.nodes.map(strip), flows: g.edges.map(({ source, target, ...e }) => strip({ ...e, from: source, to: target })) }, null, 1));
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

live(
  'live_add_element',
  'Fügt dem aktiven Diagramm ein Element hinzu: Ereignisse (auch angeheftet), alle Aufgabentypen, Gateways, Teilprozesse, Pools/Lanes, Datenobjekte, Anmerkungen, Gruppen. Mit "after" wird es verbunden. Für mehrere Elemente live_batch nutzen, danach live_layout.',
  ADD,
  'addElement',
);
live('live_connect', 'Verbindet zwei Elemente: Sequenzfluss, Nachrichtenfluss (zwischen Pools) oder Assoziation – der Typ ergibt sich aus den BPMN-Regeln.', CONNECT, 'connect');
live(
  'live_update_element',
  'Ändert ein Element im aktiven Diagramm: Name, Typ, Event-Definition, Job-Typ, Bedingung/Standardfluss, Schleifen-Markierung, Farbe, Dokumentation, Camunda-8-Eigenschaften.',
  UPDATE,
  'update',
);
live(
  'live_remove_element',
  'Löscht ein oder mehrere Elemente (samt Verbindungen) im aktiven Diagramm.',
  { id: z.string().optional(), ids: z.array(z.string()).optional() },
  'remove',
);
live(
  'live_arrange',
  'Manuelle Anordnung wie mit der Maus: verschieben (auch in andere Lane/Pool), Größe ändern, Wegpunkte einer Linie setzen, Beschriftung verschieben, ausrichten, verteilen. Normalerweise reicht live_layout.',
  ARRANGE,
  'arrange',
);

async function runLayout() {
  const graph = await callModeler('graph');
  const result = await callModeler('applyLayout', computeLayout(graph));
  const res = layoutOnly(checkDiagram(await callModeler('graph')));
  return `Layout angewendet: ${result.shapes} Elemente, ${result.edges} Verbindungen (ein Undo-Schritt).\n${formatCheck(res)}`;
}

server.registerTool(
  'live_layout',
  {
    description:
      'Ordnet das aktive Diagramm nach den Modellierungskonventionen neu an: Hauptpfad gerade, Verzweigungen symmetrisch, keine Linie durch Elemente, Rückschleifen außen, Pools/Lanes/Teilprozesse passend. Ein Undo-Schritt.',
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await runLayout());
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

server.registerTool(
  'live_check',
  {
    description:
      'Prüft das aktive Diagramm gegen die Modellierungskonventionen: Darstellung (Linien durch Elemente, Kreuzungen, Überlappungen), Benennung, symmetrische Struktur, Camunda-8-Pflichtangaben.',
    inputSchema: {},
  },
  async () => {
    try {
      return ok(formatCheck(checkDiagram(await callModeler('graph'))));
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

server.registerTool(
  'live_screenshot',
  {
    description: 'Liefert ein Bild des aktiven Diagramms, um die Darstellung selbst zu beurteilen.',
    inputSchema: { maxSize: z.number().optional().describe('Maximale Kantenlänge in Pixeln (Standard 2000)') },
  },
  async ({ maxSize }) => {
    try {
      const r = await callModeler('screenshot', { maxSize }, 30000);
      return { content: [{ type: 'image', data: r.png, mimeType: 'image/png' }, { type: 'text', text: `${r.width}×${r.height} px` }] };
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

const OP = (op, shape) => z.object({ op: z.literal(op), ...shape });
server.registerTool(
  'live_batch',
  {
    description:
      'Führt mehrere Änderungen in einem Aufruf aus (der schnellste Weg, einen ganzen Prozess zu bauen). Bricht beim ersten Fehler ab. Mit layout: true wird danach automatisch angeordnet und geprüft.',
    inputSchema: {
      operations: z
        .array(
          z.discriminatedUnion('op', [
            OP('add', ADD),
            OP('connect', CONNECT),
            OP('update', UPDATE),
            OP('remove', { id: z.string().optional(), ids: z.array(z.string()).optional() }),
            OP('arrange', ARRANGE),
          ]),
        )
        .describe('Jeder Eintrag hat "op" (add | connect | update | remove | arrange) und die Parameter des gleichnamigen live_-Tools'),
      layout: z.boolean().optional().describe('Danach live_layout ausführen (empfohlen)'),
    },
  },
  async ({ operations, layout }) => {
    try {
      const r = await callModeler('batch', { operations }, 60000);
      const text = `${r.results.length} Operationen ausgeführt: ${JSON.stringify(r.results)}`;
      return ok(layout ? `${text}\n${await runLayout()}` : text);
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

live('live_undo', 'Macht die letzte Änderung im aktiven Diagramm rückgängig.', {}, 'undo');
live('live_redo', 'Stellt die zuletzt rückgängig gemachte Änderung wieder her.', {}, 'redo');
live('live_save', 'Speichert das aktive Diagramm im Modeler (Cmd+S).', {}, 'save');

await server.connect(new StdioServerTransport());
