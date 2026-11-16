#!/usr/bin/env node
// MCP server for drawing/editing BPMN diagrams (Camunda 8 / Zeebe and Camunda 7) plus UML class and state diagrams.
// Live mode: edits the diagram open in Camunda Modeler through the plugin (plugin/client.js).
// File mode: edits .bpmn files with the same plugin code in an invisible bpmn-js (headless.js).
// Both modes share the same commands; layout (layout.js) and checks (check.js) run here in the server.
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WebSocketServer } from 'ws';
import { computeLayout } from './layout.js';
import { checkAll, formatCheck, formatInventory, LEVELS, LEVEL_ALIASES, normalizeLevel } from './check.js';
import { withFile, undoFile, emptyDiagram, closeHeadless, renderSvg, PLATFORMS, DEFAULT_PLATFORM } from './headless.js';
import { classDiagram, stateDiagram } from './uml.js';
import { lintXml, formatLint } from './lint.js';
import * as engine from './engine.js';

// ---------- Live bridge to Camunda Modeler (the plugin connects here) ----------
const BRIDGE_PORT = Number(process.env.BPMN_MCP_PORT ?? 17877);
const PLUGIN_VERSION = 7;
let modelerSocket = null;
let nextId = 1;
const pending = new Map();

const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: BRIDGE_PORT,
  // Web pages in a browser must not connect (they send an http(s) origin).
  verifyClient: ({ origin }) => !origin || !/^https?:/i.test(origin),
});
wss.on('error', (e) => console.error(`[bpmn-mcp] Live bridge unavailable (port ${BRIDGE_PORT}): ${e.message}`));
wss.on('connection', (ws) => {
  modelerSocket = ws;
  console.error('[bpmn-mcp] Modeler connected');
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
    console.error('[bpmn-mcp] Modeler disconnected');
  });
});

function callModeler(method, params = {}, timeout = method === 'batch' ? 60000 : method === 'screenshot' ? 30000 : 15000) {
  if (!modelerSocket || modelerSocket.readyState !== 1) {
    return Promise.reject(
      new Error('Camunda Modeler is not connected. Is the "bpmn-mcp-bridge" plugin installed and the Modeler running?'),
    );
  }
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Timeout: the Modeler did not respond.'));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    modelerSocket.send(JSON.stringify({ id, method, params }));
  });
}

// ---------- Parameters shared by both modes ----------
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
      .describe('"none" removes an existing definition'),
    timerType: z
      .enum(['date', 'duration', 'cycle'])
      .optional()
      .describe('Timer only: date = point in time, duration = duration (e.g. P7D), cycle = repetition (e.g. R/P1M)'),
    value: z
      .string()
      .optional()
      .describe('Timer: expression (ISO 8601 or FEEL, e.g. "P7D" or "= startDate"); conditional: FEEL condition'),
    name: z.string().optional().describe('Message/signal/error/escalation/link name'),
    correlationKey: z.string().optional().describe('Message (catch) only: FEEL, e.g. "= employeeId"'),
    code: z.string().optional().describe('Error/escalation only: code'),
  })
  .describe('Turns the event into a timer/message/... event (events only)');
const MAPPING = z
  .array(z.object({ source: z.string().optional(), target: z.string().optional(), name: z.string().optional(), value: z.string().optional() }))
  .describe('Camunda 8: { source, target }; Camunda 7: { name, value }');
const LISTENER = z.array(
  z.object({
    event: z.string().optional().describe('Task Listener: create | assignment | complete | delete | update | timeout; Execution Listener: start | end | take'),
    class: z.string().optional(),
    delegateExpression: z.string().optional(),
    expression: z.string().optional(),
    script: z.string().optional().describe('Inline script instead of a class'),
    scriptFormat: z.string().optional(),
  }),
);
const FORM_FIELDS = z
  .array(
    z.object({
      id: z.string().describe('Name of the process variable'),
      label: z.string().optional(),
      type: z.enum(['string', 'long', 'boolean', 'date', 'enum']).optional(),
      defaultValue: z.any().optional(),
      required: z.boolean().optional(),
      readonly: z.boolean().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      minlength: z.number().optional(),
      maxlength: z.number().optional(),
      values: z.any().optional().describe('enum: { value: "Label" } or ["a", "b"]'),
    }),
  )
  .describe('Camunda 7: generated task form (fields = process variables)');
const PROPS = {
  eventDefinition: EVENT_DEFINITION.optional(),
  jobType: z.string().optional().describe('Job type (service/send/business rule/script task)'),
  documentation: z.string().optional(),
  interrupting: z.boolean().optional().describe('Boundary/start event: false = non-interrupting'),
  loop: z
    .object({
      type: z.enum(['none', 'loop', 'parallel', 'sequential']),
      inputCollection: z.string().optional(),
      inputElement: z.string().optional(),
      outputCollection: z.string().optional(),
      outputElement: z.string().optional(),
      collection: z.string().optional().describe('Camunda 7: process variable holding the collection'),
      elementVariable: z.string().optional().describe('Camunda 7: variable for the single element'),
      cardinality: z.union([z.string(), z.number()]).optional().describe('Camunda 7: number of instances (number or expression)'),
      completionCondition: z.string().optional(),
    })
    .optional()
    .describe('Loop/multi-instance marker (parallel/sequential = multi-instance)'),
  state: z.string().optional().describe('Data object/store: state, e.g. "approved" (shown as "Name [approved]"; "" removes it)'),
  collection: z.boolean().optional().describe('Data object: collection (list) of objects'),
  color: z.object({ fill: z.string().optional(), stroke: z.string().optional() }).optional().describe('e.g. { fill: "#e1f5fe", stroke: "#0277bd" }'),
  properties: z
    .object({
      retries: z.string().optional(),
      assignee: z.string().optional(),
      candidateGroups: z.string().optional(),
      candidateUsers: z.string().optional(),
      dueDate: z.string().optional(),
      formId: z.string().optional(),
      calledProcessId: z.string().optional().describe('Call activity: called process'),
      decisionId: z.string().optional().describe('Business rule task: DMN decision'),
      resultVariable: z.string().optional(),
      script: z.string().optional().describe('Script task: Camunda 8 FEEL expression, Camunda 7 script text (e.g. Groovy)'),
      inputs: MAPPING.optional(),
      outputs: MAPPING.optional(),
      headers: z.record(z.string(), z.string()).optional().describe('Camunda 8 only'),
      // ----- Camunda 7 only -----
      followUpDate: z.string().optional(),
      priority: z.string().optional(),
      formKey: z.string().optional().describe('C7 embedded form, e.g. "embedded:app:forms/request.html"'),
      formRef: z.string().optional().describe('C7 Camunda Form (ID of the .form file); formId is an alias'),
      formFields: FORM_FIELDS.optional(),
      initiator: z.string().optional().describe('C7 start event: variable that receives the user ID of the starter'),
      class: z.string().optional().describe('C7 service/send/business rule task or throwing message event: Java class (JavaDelegate)'),
      delegateExpression: z.string().optional().describe('C7: Spring bean, e.g. "${loggingBean}"'),
      expression: z.string().optional().describe('C7: method call, e.g. "${bean.calculate(execution)}"'),
      topic: z.string().optional().describe('C7: external task with this topic'),
      decisionRef: z.string().optional().describe('C7 business rule task: ID of the DMN decision (decisionId is an alias)'),
      mapDecisionResult: z.enum(['singleEntry', 'singleResult', 'collectEntries', 'resultList']).optional(),
      scriptFormat: z.string().optional().describe('C7 script task: groovy (default), javascript, …'),
      resource: z.string().optional().describe('C7 script task: external script, e.g. "classpath://scripts/export.groovy"'),
      calledElement: z.string().optional().describe('C7 call activity (calledProcessId is an alias)'),
      asyncBefore: z.boolean().optional(),
      asyncAfter: z.boolean().optional(),
      taskListeners: LISTENER.optional().describe('C7 User Task'),
      executionListeners: LISTENER.optional().describe('C7: any element or process'),
      historyTimeToLive: z.union([z.string(), z.number()]).optional().describe('C7 process (pass the ID of the pool or process)'),
      candidateStarterGroups: z.string().optional().describe('C7 process'),
      candidateStarterUsers: z.string().optional().describe('C7 process'),
      versionTag: z.string().optional().describe('C7 process'),
      isExecutable: z.boolean().optional().describe('Process (pass the ID of the pool or process)'),
    })
    .optional()
    .describe('Technical properties of the execution platform (Camunda 8 or Camunda 7, depending on the diagram)'),
};
const ADD = {
  type: z.enum(TYPES),
  name: z.string().optional().describe('Name; for textAnnotation the text'),
  id: z.string().optional(),
  after: z.string().optional().describe('ID of the element after which the new one is inserted and connected'),
  flowName: z.string().optional().describe('Label of the new connection'),
  parent: z.string().optional().describe('Pool, lane or subprocess that should contain the element (ID or unique name)'),
  attachTo: z.string().optional().describe('boundaryEvent: activity to attach to; textAnnotation/dataObject/dataStore: linked element'),
  direction: z.enum(['input', 'output']).optional().describe('dataObject/dataStore: read (input) or written (output, default)'),
  expanded: z.boolean().optional().describe('false: create the subprocess/pool collapsed'),
  lanes: z
    .array(z.union([z.string(), z.object({ id: z.string().optional(), name: z.string() })]))
    .optional()
    .describe('participant: lanes from top to bottom, as names or { id, name }'),
  processId: z.string().optional().describe('participant: ID of the process in this pool'),
  executable: z.boolean().optional().describe("participant: whether the pool's process is executable (true for the process engine's pool, otherwise false)"),
  around: z.array(z.string()).optional().describe('group: elements to enclose'),
  position: z.any().optional().describe('{x,y} center (only if needed – otherwise use the layout); for lane: "top"/"bottom"'),
  ...PROPS,
};
const CONNECT = {
  source: z.string(),
  target: z.string(),
  name: z.string().optional(),
  condition: z.string().optional().describe('Condition: Camunda 8 FEEL ("= amount > 100"), Camunda 7 expression ("${amount > 100}")'),
  isDefault: z.boolean().optional().describe("The gateway's default flow"),
  type: z.enum(['sequence', 'message', 'association']).optional().describe('Default: automatic (sequence flow, message flow between pools, data association)'),
};
const UPDATE = {
  id: z.string(),
  name: z.string().optional(),
  type: z.enum(TYPES).optional().describe('New element type; ID and connections are kept'),
  condition: z.string().optional().describe('Sequence flow: condition (C8 FEEL "= …", C7 "${…}"; "" removes it)'),
  isDefault: z.boolean().optional().describe('Mark the sequence flow as default flow'),
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
  x: z.number().optional().describe('move/resize/label: new top-left corner'),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  parent: z.string().optional().describe('move: move into this pool/subprocess/lane'),
  waypoints: z.array(z.object({ x: z.number(), y: z.number() })).optional().describe('waypoints: empty = recompute the line'),
  to: z.enum(['left', 'center', 'right', 'top', 'middle', 'bottom']).optional(),
  axis: z.enum(['horizontal', 'vertical']).optional(),
};
const OP = (op, shape) => z.object({ op: z.literal(op), ...shape });
const OPERATIONS = z
  .array(z.discriminatedUnion('op', [OP('add', ADD), OP('connect', CONNECT), OP('update', UPDATE), OP('remove', REMOVE), OP('arrange', ARRANGE)]))
  .describe('Each entry has "op" (add | connect | update | remove | arrange) and the parameters of the tool with that name');
const GEOMETRY = z.boolean().optional().describe('true: also output positions and waypoints');
const DESCRIBE = {
  geometry: GEOMETRY,
  ids: z.array(z.string()).optional().describe('Only output these elements/connections (saves tokens on large diagrams)'),
  region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional().describe('Only elements/connections touching this area (coordinates as in geometry)'),
};
const MAX_SIZE = z.number().optional().describe('Maximum edge length in pixels (default 2000)');
const VIEW = {
  maxSize: MAX_SIZE,
  plane: z.string().optional().describe('ID of a collapsed subprocess: show its drill-down plane'),
  ids: z.array(z.string()).optional().describe('Crop: only the area around these elements (zoom, for large diagrams)'),
  region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional().describe('Crop in diagram coordinates'),
};

// ---------- Shared logic; exec(method, params) runs a plugin command (live or headless) ----------
const LAYOUT_RULES = /^(mini-step|line-through-element|overlap|crossing|lines-overlap|label-covered|label-on-line|labels-overlap|diagonal-line)$/;
const layoutOnly = (res) => ({ ...res, problems: res.problems.filter((p) => LAYOUT_RULES.test(p.rule)) });

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });
const json = (v) => JSON.stringify(v, null, 2);

// Compact output: valid JSON, but only one line per element (saves many tokens on large diagrams).
// Main level + drill-down planes of the collapsed subprocesses (their elements have their own coordinates).
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
  only: z.enum(['all', 'messageFlows']).optional().describe('messageFlows: only reroute the message flows – elements, sequence flows and manual corrections stay unchanged'),
  poolOrder: z.array(z.string()).optional().describe('Order of the pools from top to bottom (IDs or names). Default: automatic, so that message flows run between neighbors where possible'),
  align: z.boolean().optional().describe('false: do not align pools along the message flows (default: true)'),
};
const layoutOpts = ({ only, poolOrder, align }) => ({ only: only === 'messageFlows' ? only : undefined, poolOrder, align });

async function runLayout(exec, undoHint = '(one undo step)', opts = {}) {
  const [main, ...subs] = await allGraphs(exec);
  const layout = computeLayout(main, opts);
  // Lay out the drill-down planes of collapsed subprocesses separately (own coordinates), in the same undo step.
  if (opts.only !== 'messageFlows') for (const s of subs) {
    const l = computeLayout(s);
    for (const k of ['shapes', 'labels', 'edges']) Object.assign(layout[k], l[k]);
  }
  const result = await exec('applyLayout', layout);
  const res = layoutOnly(checkAll(await allGraphs(exec)));
  const what = opts.only === 'messageFlows' ? `Message flows rerouted: ${result.edges}` : `Layout applied: ${result.shapes} elements, ${result.edges} connections${subs.length ? ` (incl. ${subs.length} drill-down plane(s))` : ''}`;
  return `${what} ${undoHint}.\n${formatCheck(res)}`;
}

const LEVEL = z
  .enum([...LEVELS, ...Object.keys(LEVEL_ALIASES)])
  .optional()
  .describe('Model level: strategic (coarse, happy path, max. 10 steps), operational (collaboration, message and data flow, no deadlocks), technical (executable on the platform). Omitted: general conventions + technical requirements of the executable processes');
const LINT = z
  .boolean()
  .optional()
  .describe('bpmnlint with the rules of Camunda Modeler (camunda-compat for the platform/version from the file header + bpmnlint:recommended). Default: on, except for level strategic/operational');
async function check(exec, level, lint) {
  level = normalizeLevel(level);
  const res = checkAll(await allGraphs(exec), { level });
  let text = `${level ? `Level: ${level}\n` : ''}${formatCheck(res)}\n${formatInventory(res.inventory)}`;
  if (lint ?? !/^(strategic|operational)$/.test(level ?? '')) {
    try {
      text += `\n${formatLint(await lintXml((await exec('xml')).xml))}`;
    } catch (e) {
      text += `\nbpmnlint not run: ${e.message}`;
    }
  }
  return text;
}

async function screenshot(exec, { maxSize, plane, ids, region } = {}) {
  const r = await exec('screenshot', { maxSize, plane, ids, region });
  return { content: [{ type: 'image', data: r.png, mimeType: 'image/png' }, { type: 'text', text: `${r.width}×${r.height} px` }] };
}

const FORMAT = z.enum(['pdf', 'svg', 'png']).default('pdf').describe('Output format (PDF: one page the size of the diagram, vector graphics)');
// Fetch the SVG first, then convert it: renderSvg uses the same browser and must not run inside withFile.
async function exportDiagram(svg, format, output) {
  if (!path.isAbsolute(output)) throw new Error(`"output" must be an absolute path: ${output}`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  if (format === 'svg') await fs.writeFile(output, svg, 'utf8');
  else await fs.writeFile(output, (await renderSvg(svg, format)).data);
  return `Exported: ${output}`;
}
const INCLUDE_PLANES = z.boolean().optional().describe('true: additionally write each drill-down plane of collapsed subprocesses as its own file <output>_<subprocess ID>.<format>');
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

const INSTRUCTIONS = `BPMN modeling for Camunda Modeler (Camunda 8 and Camunda 7) and UML diagrams. Two BPMN modes with the same capabilities:
- Live mode (live_*): edits the diagram open in the Modeler. Flow: live_status -> live_describe -> changes (bundled with live_batch, layout: true) -> live_check -> look at live_screenshot -> live_save.
- File mode (parameter file = absolute path): edits .bpmn files directly, without the Modeler. Flow: create_diagram (ideally with operations right away) or describe_diagram -> batch (lays out automatically) -> check_diagram -> look at screenshot_diagram -> export_diagram (PDF). Every change is saved immediately; undo/redo step back.
Prefer a few large calls over many small ones: a whole diagram fits into one create_diagram or batch call. Assign IDs yourself; "parent" also accepts the name of a pool or lane.
Platform: stored in the file header (create_diagram platform: camunda8 | camunda7) and determines which "properties" apply.
- Camunda 8: jobType, FEEL conditions ("= x > 5"), properties.formId/assignee/decisionId.
- Camunda 7: properties.class | delegateExpression | expression | topic instead of jobType; conditions as "\${x > 5}"; user tasks with candidateGroups/assignee and formKey | formRef | formFields; script task with scriptFormat + script; business rule task with decisionRef + resultVariable + mapDecisionResult; multi-instance with loop.collection/elementVariable; taskListeners/executionListeners.
Model levels (check_diagram level):
- strategic: one pool with lanes, at most 10 steps, abstract tasks, collapsed subprocesses (named with nouns), only the standard flow, hardly any gateways, data objects instead of message flows.
- operational: collaboration diagram; every participant and the process engine in its own expanded pool (create/add participant with executable: true only for the process engine), message flows only between pools and only at tasks or message events, data objects with state, no deadlocks.
- technical: the executable pool with all required platform properties.
Layout: pools are stacked and aligned column by column automatically so that message flows are short and as vertical as possible. After manual corrections (arrange), run further changes with layout: false; relayout/live_layout with only: "messageFlows" only reroutes the message flows.
Modeling conventions (mandatory):
- Model from left to right; the normal flow ("happy path") lies on a straight line.
- Avoid overlaps: no line through an element, as few crossings as possible (the layout takes care of this; do not set waypoints by hand unless the check reports something).
- Naming (use the language of the user/diagram): start event = process trigger ("Order received"), task = verb + object ("Check order"), intermediate event = object + past participle ("Order checked"), splitting XOR/OR gateway = question ("Order data correct?"), its outgoing flows = answers ("yes"/"no"), end event = end state ("Order rejected"). Short names; hyphenate long words ("Pre-authorization"), otherwise the Modeler breaks them in the middle of the word.
- Model symmetrically: every split gets its own merging gateway of the same type; never let a gateway merge and split at the same time; explicit gateways instead of several incoming/outgoing flows on tasks.
- Same task size (do not change the default 100x80).
- Intermediate events need a type (eventDefinition); an event-based gateway is followed only by catching events, without conditions and without further incoming flows.
Collapsed subprocesses (expanded: false) have their own drill-down plane as in the Modeler: elements with parent = subprocess go there, layout and checks handle each plane separately; screenshot/export with plane = subprocess ID show it, export with includePlanes: true writes all planes. Large diagrams: screenshot with ids/region for an enlarged crop, describe with ids/region instead of everything.
Process properties (historyTimeToLive, versionTag, candidateStarterGroups, isExecutable): update with id = process ID or pool ID. create_diagram platformVersion sets the target engine (e.g. "7.20.0"); check_diagram additionally runs bpmnlint with the rules of Camunda Modeler.
Camunda 7 engine (engine_*, REST, default http://localhost:8080/engine-rest): engine_status -> engine_deploy -> engine_start_instance -> engine_tasks / engine_complete_task (with user) -> engine_execute_jobs (fire timers immediately) / engine_correlate_message -> engine_instance (state, variables, history) and engine_incidents (with retry). engine_rest for everything else.
UML: uml_class_diagram (domain model: classes with business attributes, named associations with multiplicities, no methods) and uml_state_diagram (object lifecycle) generate .drawio (XML), .svg, .pdf and .png from a description in one call.`;

const server = new McpServer({ name: 'bpmn-modeler-mcp', version: '0.6.0' }, { instructions: INSTRUCTIONS });

// ---------- Live tools: edit the diagram open in the Modeler (with undo/redo) ----------
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

liveTool('live_status', 'Checks whether Camunda Modeler is connected and which tab is active.', {}, async () => {
  const r = await callModeler('status');
  return json(r.plugin === PLUGIN_VERSION ? r : { ...r, warning: 'The plugin in the Modeler is outdated: run ./install-plugin.sh and restart the Modeler completely.' });
});
liveTool(
  'live_describe',
  'Lists all elements and connections of the active diagram in the Modeler with IDs, type, pool/lane, event type etc. (including the content of collapsed subprocesses, marked with "plane"). Call before making changes.',
  DESCRIBE,
  (args) => describe(callModeler, args),
);
liveTool(
  'live_add_element',
  'Adds an element to the active diagram: events (also boundary events), all task types, gateways, subprocesses, pools/lanes, data objects, annotations, groups. With "after" it gets connected. For several elements use live_batch, then live_layout.',
  ADD,
  plain('addElement'),
);
liveTool('live_connect', 'Connects two elements: sequence flow, message flow (between pools) or association – the type follows from the BPMN rules.', CONNECT, plain('connect'));
liveTool(
  'live_update_element',
  'Changes an element in the active diagram: name, type, event definition, job type, condition/default flow, loop marker, color, documentation, technical properties (Camunda 8 or 7).',
  UPDATE,
  plain('update'),
);
liveTool('live_remove_element', 'Deletes one or more elements (including their connections) in the active diagram.', REMOVE, plain('remove'));
liveTool(
  'live_arrange',
  'Manual arrangement as with the mouse: move (also into another lane/pool), resize, set the waypoints of a line, move a label, align, distribute. Normally live_layout is enough.',
  ARRANGE,
  plain('arrange'),
);
liveTool(
  'live_layout',
  'Re-lays out the active diagram following the modeling conventions: straight main path, symmetric branches, no line through elements, loops on the outside, pools stacked and aligned along the message flows. One undo step. only: "messageFlows" leaves everything except the message flows unchanged.',
  LAYOUT_OPTS,
  (args) => runLayout(callModeler, undefined, layoutOpts(args)),
);
liveTool(
  'live_check',
  'Checks the active diagram: layout (lines through elements, crossings, overlaps), naming, symmetric structure, message flows, possible deadlocks, required platform properties; with level also the rules of the model level. Lists the constructs used.',
  { level: LEVEL, lint: LINT },
  ({ level, lint }) => check(callModeler, level, lint),
);
liveTool(
  'live_export',
  'Exports the active diagram as PDF, SVG or PNG.',
  { format: FORMAT, output: z.string().describe('Absolute path of the output file'), plane: VIEW.plane, includePlanes: INCLUDE_PLANES },
  async ({ format, output, plane, includePlanes }) => exportAll(callModeler, format, output, { plane, includePlanes }),
);
liveTool(
  'live_screenshot',
  'Returns an image of the active diagram so you can judge the layout yourself. For large diagrams use ids/region to view an enlarged crop; plane shows the plane of a collapsed subprocess.',
  VIEW,
  (args) => screenshot(callModeler, args),
);
liveTool(
  'live_batch',
  'Runs several changes in one call (the fastest way to build a whole process). Stops at the first error. With layout: true the diagram is laid out and checked automatically afterwards.',
  { operations: OPERATIONS, layout: z.boolean().optional().describe('Run live_layout afterwards (recommended)'), poolOrder: LAYOUT_OPTS.poolOrder },
  async ({ operations, layout, poolOrder }) => {
    const r = await callModeler('batch', { operations });
    const text = `${r.results.length} operations executed: ${JSON.stringify(r.results)}`;
    return layout ? `${text}\n${await runLayout(callModeler, undefined, { poolOrder })}` : text;
  },
);
liveTool('live_undo', 'Undoes the last change in the active diagram.', {}, plain('undo'));
liveTool('live_redo', 'Redoes the last undone change.', {}, plain('redo'));
liveTool('live_save', 'Saves the active diagram in the Modeler (Cmd+S).', {}, plain('save'));

// ---------- File tools: the same commands on a .bpmn file (headless bpmn-js) ----------
const FILE = z.string().describe('Absolute path of the .bpmn file');
const AUTO_LAYOUT = z
  .boolean()
  .optional()
  .describe('Lay out and check the layout automatically afterwards (default: true). false keeps the current arrangement, e.g. after arrange.');
const FILE_UNDO = '(revert with undo)';

const fileTool = (name, description, shape, run, { mutate = false } = {}) =>
  server.registerTool(name, { description, inputSchema: { file: FILE, ...shape } }, async ({ file, ...args }) => {
    try {
      if (!path.isAbsolute(file)) return fail(`"file" must be an absolute path: ${file}`);
      const r = await withFile(file, (exec) => run(exec, args), { mutate });
      return typeof r === 'string' ? ok(r) : r;
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  });
// Mutating command, followed (by default) by layout + layout check.
const fileChange = (method) => async (exec, { layout, ...args }) => {
  const text = json(await exec(method, args));
  return layout === false ? text : `${text}\n${await runLayout(exec, FILE_UNDO)}`;
};

const batchText = (r) => `${r.results.length} operations executed: ${JSON.stringify(r.results)}`;
server.registerTool(
  'create_diagram',
  {
    description:
      'Creates a new BPMN file (Camunda 8 or Camunda 7). With "operations" the whole diagram is built, laid out and checked in the same call. Fails if the file already exists.',
    inputSchema: {
      file: FILE,
      processId: z.string().regex(/^[A-Za-z_][\w.-]*$/, 'Valid XML ID, e.g. Process_Order').default('Process_1').describe('ID of the process'),
      name: z.string().optional().describe('Display name of the process'),
      platform: z.enum(PLATFORMS).default(DEFAULT_PLATFORM).describe('Execution platform: determines the file header and technical properties'),
      executable: z.boolean().default(true).describe('false for purely business models (strategic/operational) that are not deployed'),
      platformVersion: z.string().regex(/^\d+\.\d+(\.\d+)?$/).optional().describe('Version of the target engine, e.g. "7.20.0" (controls the checks in the Modeler; default 7.23.0 or 8.8.0)'),
      operations: OPERATIONS.optional(),
      poolOrder: LAYOUT_OPTS.poolOrder,
    },
  },
  async ({ file, processId, name, platform, executable, platformVersion, operations, poolOrder }) => {
    try {
      if (!path.isAbsolute(file)) return fail(`"file" must be an absolute path: ${file}`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, emptyDiagram(processId, name, { platform, executable, version: platformVersion }), { encoding: 'utf8', flag: 'wx' });
      if (!operations?.length) return ok(`Diagram created (${platform}): ${file}`);
      try {
        const text = await withFile(file, async (exec) => `${batchText(await exec('batch', { operations }))}\n${await runLayout(exec, FILE_UNDO, { poolOrder })}`, { mutate: true });
        return ok(`Diagram created (${platform}): ${file}\n${text}`);
      } catch (e) {
        await fs.rm(file, { force: true });
        return fail(String(e.message ?? e).replace(/ – \d+ earlier steps were executed\.$/, '') + ' – nothing created.');
      }
    } catch (e) {
      return fail(e.code === 'EEXIST' ? `File already exists: ${file}` : String(e.message ?? e));
    }
  },
);
fileTool(
  'describe_diagram',
  'Lists all elements and connections of a BPMN file with IDs, type, pool/lane, event type etc. (including the content of collapsed subprocesses, marked with "plane"). Call before making changes.',
  DESCRIBE,
  (exec, args) => describe(exec, args),
);
fileTool(
  'add_element',
  'Adds an element: events (also boundary events), all task types, gateways, subprocesses, pools/lanes, data objects, annotations, groups. With "after" it gets connected. For several elements use batch.',
  { ...ADD, layout: AUTO_LAYOUT },
  fileChange('addElement'),
  { mutate: true },
);
fileTool(
  'connect',
  'Connects two elements: sequence flow, message flow (between pools) or association – the type follows from the BPMN rules.',
  { ...CONNECT, layout: AUTO_LAYOUT },
  fileChange('connect'),
  { mutate: true },
);
fileTool(
  'update_element',
  'Changes an element: name, type, event definition, job type, condition/default flow, loop marker, color, documentation, technical properties (Camunda 8 or 7).',
  { ...UPDATE, layout: AUTO_LAYOUT },
  fileChange('update'),
  { mutate: true },
);
fileTool('remove_element', 'Deletes one or more elements (including their connections).', { ...REMOVE, layout: AUTO_LAYOUT }, fileChange('remove'), { mutate: true });
fileTool(
  'arrange',
  'Manual arrangement: move (also into another lane/pool), resize, set waypoints, move a label, align, distribute. Normally the automatic layout is enough. Call later changes with layout: false, otherwise the diagram is laid out again.',
  ARRANGE,
  async (exec, args) => json(await exec('arrange', args)),
  { mutate: true },
);
fileTool(
  'batch',
  'Runs several changes in one call (the fastest way to build a whole process), followed by automatic layout and layout check. All or nothing: on an error the file stays unchanged.',
  { operations: OPERATIONS, layout: AUTO_LAYOUT, poolOrder: LAYOUT_OPTS.poolOrder },
  async (exec, { operations, layout, poolOrder }) => {
    let r;
    try {
      r = await exec('batch', { operations });
    } catch (e) {
      throw new Error(String(e.message).replace(/ – \d+ earlier steps were executed\.$/, '') + ' – nothing saved, the file is unchanged.');
    }
    return layout === false ? batchText(r) : `${batchText(r)}\n${await runLayout(exec, FILE_UNDO, { poolOrder })}`;
  },
  { mutate: true },
);
fileTool(
  'relayout',
  'Re-lays out a BPMN file following the modeling conventions (pools stacked and aligned along the message flows, lanes, subprocesses) and reports remaining issues. only: "messageFlows" leaves everything except the message flows unchanged.',
  LAYOUT_OPTS,
  (exec, args) => runLayout(exec, FILE_UNDO, layoutOpts(args)),
  { mutate: true },
);
fileTool(
  'check_diagram',
  'Checks a BPMN file: layout (lines through elements, crossings, overlaps), naming, structure, message flows, possible deadlocks, required platform properties; with level also the rules of the model level. Lists the constructs used.',
  { level: LEVEL, lint: LINT },
  (exec, { level, lint }) => check(exec, level, lint),
);
server.registerTool(
  'export_diagram',
  {
    description: 'Exports a BPMN file as PDF, SVG or PNG. Default: same file name with a different extension.',
    inputSchema: { file: FILE, format: FORMAT, output: z.string().optional().describe('Absolute path of the output file'), plane: VIEW.plane, includePlanes: INCLUDE_PLANES },
  },
  async ({ file, format, output, plane, includePlanes }) => {
    try {
      if (!path.isAbsolute(file)) return fail(`"file" must be an absolute path: ${file}`);
      const svgs = await withFile(file, (exec) => collectSvgs(exec, { plane, includePlanes }));
      return ok(await writeSvgs(svgs, format, output ?? withExt(file, format)));
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);
fileTool(
  'screenshot_diagram',
  'Returns an image of the BPMN file so you can judge the layout yourself. For large diagrams use ids/region to view an enlarged crop; plane shows the plane of a collapsed subprocess.',
  VIEW,
  (exec, args) => screenshot(exec, args),
);
for (const redo of [false, true]) {
  server.registerTool(
    redo ? 'redo' : 'undo',
    {
      description: redo
        ? 'Restores the change to the file that was last reverted with undo.'
        : 'Undoes the last change to the file (history of the current session, up to 50 steps).',
      inputSchema: { file: FILE },
    },
    async ({ file }) => {
      try {
        const r = await undoFile(file, redo);
        return ok(`${redo ? 'Redone' : 'Undone'}. ${r.undo} step(s) left to undo, ${r.redo} to redo.`);
      } catch (e) {
        return fail(String(e.message ?? e));
      }
    },
  );
}

// ---------- UML: class and state diagrams from a description (draw.io XML, SVG, PDF, PNG) ----------
const UML_FILE = z.string().describe('Absolute path without extension (or with .drawio); .drawio, .svg, .pdf, .png and .uml.json are written next to it');
const MULT = z.string().optional();
async function writeUml(file, spec, built) {
  if (!path.isAbsolute(file)) return fail(`"file" must be an absolute path: ${file}`);
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
  const notes = built.problems.length ? `${built.problems.length} hints:\n${built.problems.map((p) => `- ${p}`).join('\n')}` : 'No issues.';
  return { content: [{ type: 'image', data: png.data.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: `Written: ${base}.{drawio,svg,pdf,png,uml.json}\n${notes}` }] };
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
  'Generates a UML class diagram (domain model) from a description: arranges the classes automatically, routes the relations at right angles and writes draw.io XML, SVG, PDF and PNG. Overwrites existing output; to change it, read the .uml.json, adjust it and call again. Returns a preview image and hints (unnamed associations, missing multiplicities, methods, …).',
  {
    title: z.string().optional(),
    classes: z.array(
      z.object({
        name: z.string(),
        stereotype: z.string().optional().describe('e.g. "enumeration" or "actor"'),
        abstract: z.boolean().optional(),
        attributes: z.array(z.string()).optional().describe('business attributes as "name: Type"; for enumeration the values'),
        col: z.number().optional().describe('Column in the grid (0 = left); only set it to override the automatic arrangement'),
        row: z.number().optional().describe('Row in the grid (0 = top)'),
        color: z.string().optional().describe('Fill color of the header, e.g. "#dbe9f4"'),
      }),
    ),
    relations: z.array(
      z.object({
        from: z.string().describe('Class name; for composition/aggregation the whole, for generalization the subclass'),
        to: z.string().describe('Class name; for generalization the superclass'),
        type: z.enum(['association', 'aggregation', 'composition', 'generalization', 'dependency']).default('association'),
        name: z.string().optional().describe('Name of the association (verb), e.g. "places"'),
        fromMult: MULT.describe('Multiplicity at the from end, e.g. "1"'),
        toMult: MULT.describe('Multiplicity at the to end, e.g. "0..*"'),
        fromRole: z.string().optional(),
        toRole: z.string().optional(),
        navigable: z.boolean().optional().describe('true: arrowhead at the to end (navigation direction)'),
      }),
    ),
    notes: z.array(z.object({ text: z.string(), attachTo: z.string().optional().describe('Class name') })).optional(),
  },
  classDiagram,
);
umlTool(
  'uml_state_diagram',
  'Generates a UML state diagram (object lifecycle, e.g. the states of a request) from a description and writes draw.io XML, SVG, PDF and PNG. The states should match the states of the data objects in the BPMN model.',
  {
    title: z.string().optional(),
    states: z.array(z.union([z.string(), z.object({ name: z.string(), description: z.string().optional() })])).describe('States in a sensible order'),
    initial: z.string().describe('Initial state'),
    finals: z.array(z.string()).optional().describe('States after which the lifecycle ends'),
    transitions: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional().describe('triggering activity/event [condition]') })),
  },
  stateDiagram,
);

// ---------- Camunda 7 process engine (REST): deploy, start, complete tasks, fire timers, inspect state ----------
const ENGINE_URL = z.string().optional().describe(`Base URL of the REST API (default: ${engine.DEFAULT_URL}, configurable via CAMUNDA_URL)`);
const INSTANCE = {
  processInstanceId: z.string().optional(),
  businessKey: z.string().optional().describe('Instead of the ID: business key of the instance (the most recent one with this key)'),
};
const VARIABLES = z
  .record(z.string(), z.any())
  .optional()
  .describe('Process variables as { name: value }; type is automatic (true → Boolean, 5 → Long, 1.5 → Double, "x" → String, object → Json) or explicit { value, type: "Date" | "Integer" | … }');
const engineTool = (name, description, shape, run) =>
  server.registerTool(name, { description, inputSchema: { ...shape, engineUrl: ENGINE_URL } }, async ({ engineUrl, ...args }) => {
    try {
      return ok(await run(engine.client(engineUrl), args));
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  });
engineTool('engine_status', 'Camunda 7: checks whether the engine is reachable and lists deployed processes and DMN decisions (latest version) as well as running instances and incidents.', {}, (c) => engine.status(c));
engineTool(
  'engine_deploy',
  'Camunda 7: deploys BPMN, DMN and form files (.bpmn, .dmn, .form, .html) via the REST API. Default: only changed files (deploy-changed-only). Run check_diagram with level "technical" first.',
  {
    files: z.array(z.string()).min(1).describe('Absolute paths of the files'),
    name: z.string().optional().describe('Name of the deployment (default: first file name)'),
    changedOnly: z.boolean().optional().describe('false: always create new versions (default true)'),
    tenantId: z.string().optional(),
  },
  (c, a) => engine.deploy(c, a),
);
engineTool(
  'engine_start_instance',
  'Camunda 7: starts a process instance (latest version of the key) with variables and business key and shows where it waits afterwards.',
  { processDefinitionKey: z.string().describe('ID of the process (process id in the BPMN)'), businessKey: z.string().optional(), variables: VARIABLES, tenantId: z.string().optional() },
  (c, a) => engine.start(c, a),
);
engineTool(
  'engine_tasks',
  'Camunda 7: lists open user tasks – per instance (ID or business key), assignee, candidate group or name; with formVariables also the form fields.',
  { ...INSTANCE, assignee: z.string().optional(), candidateGroup: z.string().optional(), candidateUser: z.string().optional(), name: z.string().optional().describe('Part of the task name'), formVariables: z.boolean().optional() },
  (c, a) => engine.tasks(c, a),
);
engineTool(
  'engine_complete_task',
  'Camunda 7: completes a user task with variables – by taskId or by instance (ID/business key) + task name. With user it is claimed by that user first, as in the Tasklist. Shows where the instance waits afterwards.',
  {
    taskId: z.string().optional(),
    ...INSTANCE,
    name: z.string().optional().describe('Task name (exact or part of it)'),
    taskDefinitionKey: z.string().optional().describe('ID of the user task in the BPMN'),
    variables: VARIABLES,
    user: z.string().optional().describe('User who claims and completes the task'),
    submitForm: z.boolean().optional().describe('true: submit like the form in the Tasklist (submit-form, validates generated form fields)'),
  },
  (c, a) => engine.complete(c, a),
);
engineTool(
  'engine_instance',
  'Camunda 7: state of a process instance (ID or business key, also finished ones): where it waits, open tasks, timers/jobs, external tasks, incidents, variables and history of the activities passed.',
  { ...INSTANCE, history: z.boolean().optional().describe('Output the history (default true)'), variables: z.boolean().optional().describe('Output the variables (default true)') },
  (c, { history, variables, ...ref }) => engine.instanceState(c, ref, { history: history ?? true, variables: variables ?? true }),
);
engineTool(
  'engine_execute_jobs',
  'Camunda 7: executes due and not yet due jobs of an instance immediately – e.g. fire timers ("3 days passed") in a test run or trigger asynchronous continuations.',
  { ...INSTANCE, jobId: z.string().optional(), timersOnly: z.boolean().optional().describe('timer jobs only') },
  (c, a) => engine.executeJobs(c, a),
);
engineTool(
  'engine_correlate_message',
  'Camunda 7: sends a message to waiting message events/receive tasks or starts an instance via a message start event.',
  {
    messageName: z.string(),
    ...INSTANCE,
    variables: VARIABLES.describe('Process variables set with the message'),
    correlationKeys: z.record(z.string(), z.any()).optional().describe('Correlation via variable values'),
    all: z.boolean().optional().describe('to all matching recipients'),
  },
  (c, a) => engine.correlate(c, a),
);
engineTool(
  'engine_incidents',
  'Camunda 7: lists incidents (failed jobs/external tasks) with error message and the start of the stack trace; with retry: true the retries are set to 1 (after fixing the cause).',
  { ...INSTANCE, retry: z.boolean().optional() },
  (c, a) => engine.incidents(c, a),
);
engineTool(
  'engine_rest',
  'Camunda 7: any REST API call for everything the other engine_ tools do not cover (e.g. GET /history/detail?processInstanceId=…, DELETE /process-instance/{id}, POST /decision-definition/key/{key}/evaluate).',
  {
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('GET'),
    path: z.string().describe('Path relative to the base URL, e.g. "/history/process-instance?finished=true"'),
    body: z.any().optional().describe('JSON body for POST/PUT'),
  },
  (c, a) => engine.rest(c, a),
);

// Also shut down the headless browser when the session ends.
const shutdown = () => closeHeadless().finally(() => process.exit(0));
process.stdin.on('end', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await server.connect(new StdioServerTransport());
