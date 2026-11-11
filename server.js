#!/usr/bin/env node
// MCP-Server zum Zeichnen/Bearbeiten von BPMN-Dateien (Camunda 8 / Zeebe).
// Jede Änderung wird in die .bpmn-Datei geschrieben und das Layout automatisch neu berechnet.
// Der Camunda Modeler erkennt die Änderung und bietet ein Neuladen an.
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WebSocketServer } from 'ws';
import { BpmnModdle } from 'bpmn-moddle';
import zeebeModdle from 'zeebe-bpmn-moddle/resources/zeebe.json' with { type: 'json' };
import { layoutProcess } from 'bpmn-auto-layout';

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

function callModeler(method, params = {}) {
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
    }, 10000);
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
  intermediateCatchEvent: 'bpmn:IntermediateCatchEvent',
  intermediateThrowEvent: 'bpmn:IntermediateThrowEvent',
};

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
  // Diagramm-Info (DI) verwerfen und frisch layouten, damit es nie veraltet ist.
  definitions.diagrams = [];
  // incoming/outgoing pro Knoten neu aufbauen (Layout und gültiges BPMN brauchen sie).
  const process = definitions.rootElements.find((e) => e.$type === 'bpmn:Process');
  const nodes = process.flowElements.filter((e) => e.$type !== 'bpmn:SequenceFlow');
  for (const n of nodes) {
    n.incoming = [];
    n.outgoing = [];
  }
  for (const f of process.flowElements.filter((e) => e.$type === 'bpmn:SequenceFlow')) {
    f.sourceRef.outgoing.push(f);
    f.targetRef.incoming.push(f);
  }
  const { xml } = await moddle.toXML(definitions, { format: true });
  const laidOut = await layoutProcess(xml);
  await fs.writeFile(file, laidOut, 'utf8');
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
    lines.push(`- ${n.id} [${n.$type.replace('bpmn:', '')}]${n.name ? ` "${n.name}"` : ''}${extra.length ? ` (${extra.join(', ')})` : ''}`);
  }
  lines.push('', 'Verbindungen:');
  for (const f of flows) {
    lines.push(`- ${f.id}: ${f.sourceRef.id} -> ${f.targetRef.id}${f.name ? ` "${f.name}"` : ''}`);
  }
  return lines.join('\n');
}

const server = new McpServer({ name: 'bpmn-modeler-mcp', version: '0.1.0' });

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
    },
  },
  async ({ file, type, name, id, after, flowName }) => {
    try {
      const { definitions, process } = await load(file);
      const bpmnType = ELEMENT_TYPES[type];
      const elementId = id ?? uniqueId(process, bpmnType.replace('bpmn:', ''));
      if (findFlowElement(process, elementId)) return fail(`ID existiert schon: ${elementId}`);
      const el = moddle.create(bpmnType, { id: elementId, name });
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
    description: 'Ändert Name oder (bei Service Tasks) den Job-Typ eines Elements bzw. den Namen/die Bedingung einer Verbindung.',
    inputSchema: {
      file: z.string(),
      id: z.string(),
      name: z.string().optional(),
      jobType: z.string().optional().describe('zeebe:taskDefinition type, nur für Service Tasks'),
      condition: z.string().optional().describe('FEEL-Bedingung, nur für Sequenzflüsse'),
    },
  },
  async ({ file, id, name, jobType, condition }) => {
    try {
      const { definitions, process } = await load(file);
      const el = findFlowElement(process, id);
      if (!el) return fail(`Element nicht gefunden: ${id}`);
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
    description: 'Berechnet das Diagramm-Layout neu.',
    inputSchema: { file: z.string() },
  },
  async ({ file }) => {
    try {
      const { definitions } = await load(file);
      await save(file, definitions);
      return ok('Layout aktualisiert.');
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

// ---------- Live-Tools: bearbeiten das im Modeler geöffnete Diagramm (mit Undo/Redo) ----------
const live = (name, description, inputSchema, method, format) =>
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      const result = await callModeler(method, args);
      return ok(format ? format(result) : JSON.stringify(result, null, 2));
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  });

live('live_status', 'Prüft, ob der Camunda Modeler verbunden ist und welcher Tab aktiv ist.', {}, 'status');

live(
  'live_describe',
  'Listet alle Elemente und Verbindungen des im Modeler aktiven Diagramms mit IDs. Vor Änderungen aufrufen.',
  {},
  'describe',
);

live(
  'live_add_element',
  'Fügt dem aktiven Diagramm im Modeler ein Element hinzu; mit "after" wird es automatisch platziert und verbunden. Änderung ist sofort sichtbar und per Undo rückgängig zu machen.',
  {
    type: z.enum(Object.keys(ELEMENT_TYPES)),
    name: z.string().optional(),
    id: z.string().optional(),
    after: z.string().optional().describe('ID des Elements, hinter dem eingefügt wird'),
    flowName: z.string().optional().describe('Beschriftung der neuen Verbindung'),
  },
  'addElement',
);

live(
  'live_connect',
  'Verbindet zwei Elemente im aktiven Diagramm mit einem Sequenzfluss.',
  {
    source: z.string(),
    target: z.string(),
    name: z.string().optional(),
    condition: z.string().optional().describe('FEEL-Bedingung, z. B. "= amount > 100"'),
  },
  'connect',
);

live(
  'live_update_element',
  'Ändert Name, Job-Typ (Service Task) oder Bedingung (Sequenzfluss) im aktiven Diagramm.',
  {
    id: z.string(),
    name: z.string().optional(),
    jobType: z.string().optional(),
    condition: z.string().optional(),
  },
  'update',
);

live('live_remove_element', 'Löscht ein Element (samt Verbindungen) im aktiven Diagramm.', { id: z.string() }, 'remove');
live('live_undo', 'Macht die letzte Änderung im aktiven Diagramm rückgängig.', {}, 'undo');
live('live_save', 'Speichert das aktive Diagramm im Modeler (Cmd+S).', {}, 'save');

await server.connect(new StdioServerTransport());
