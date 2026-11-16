// File mode with the full feature set (headless bpmn-js): the same scenarios as live-basic/live-pools,
// plus default flow, all-or-nothing batch, arrange without re-layout, undo/redo, screenshot.
// Usage: node test/file-full.mjs [output-prefix]  (then writes <prefix>-*.bpmn/.png)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT } from './render.mjs';

const out = process.argv[2];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmn-file-'));
const client = new Client({ name: 'test', version: '1' });
await client.connect(new StdioClientTransport({ command: 'node', args: [path.join(ROOT, 'server.js')], env: { ...process.env, BPMN_MCP_PORT: '17998' } }));

let failed = 0;
const call = async (name, args = {}, { expectError = false, quiet = false } = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.find((c) => c.type === 'text')?.text ?? '';
  const bad = !!r.isError !== expectError;
  if (bad) failed++;
  if (!quiet || bad) console.log(bad ? 'ERROR ' : 'ok    ', name, text.length > 300 ? text.slice(0, 300) + ' …' : text);
  return { ...r, text };
};
const expect = (label, cond) => { console.log(cond ? 'ok    ' : 'ERROR ', label); if (!cond) failed++; };

// ---------- 1. Order process (as in live-basic) ----------
const f1 = path.join(dir, 'order.bpmn');
await call('create_diagram', { file: f1, processId: 'Process_Order', name: 'Order' });
await call('create_diagram', { file: f1 }, { expectError: true });
await call('batch', { file: f1, operations: [
  { op: 'add', type: 'startEvent', id: 'S', name: 'Order received' },
  { op: 'add', type: 'userTask', id: 'T_Check', name: 'Check order', after: 'S', properties: { assignee: '= clerk', formId: 'check-form' } },
  { op: 'add', type: 'boundaryEvent', id: 'B_Timeout', name: '2 days passed', attachTo: 'T_Check', interrupting: false, eventDefinition: { type: 'timer', timerType: 'duration', value: 'P2D' } },
  { op: 'add', type: 'sendTask', id: 'T_Remind', name: 'Send reminder', after: 'B_Timeout', jobType: 'send-reminder' },
  { op: 'add', type: 'endEvent', id: 'E_Reminded', name: 'Reminder sent', after: 'T_Remind' },
  { op: 'add', type: 'exclusiveGateway', id: 'G_Ok', name: 'Order correct?', after: 'T_Check' },
  { op: 'add', type: 'subProcess', id: 'SP_Deliver', name: 'Deliver goods', after: 'G_Ok', flowName: 'yes' },
  { op: 'add', type: 'startEvent', id: 'SP_S', name: 'Delivery started', parent: 'SP_Deliver' },
  { op: 'add', type: 'serviceTask', id: 'SP_T', name: 'Pack goods', after: 'SP_S', jobType: 'pack', loop: { type: 'parallel', inputCollection: '= items', inputElement: 'item' } },
  { op: 'add', type: 'endEvent', id: 'SP_E', name: 'Goods packed', after: 'SP_T' },
  { op: 'add', type: 'endEvent', id: 'E_Ok', name: 'Order delivered', after: 'SP_Deliver' },
  { op: 'add', type: 'endEvent', id: 'E_Nok', name: 'Order rejected', after: 'G_Ok', flowName: 'no', eventDefinition: { type: 'error', name: 'rejected', code: 'REJECTED' } },
  { op: 'add', type: 'dataObject', id: 'D_Order', name: 'Order', attachTo: 'T_Check', direction: 'input' },
  { op: 'add', type: 'textAnnotation', id: 'A_1', name: 'New customers only', attachTo: 'G_Ok' },
  { op: 'update', id: 'T_Check', color: { fill: '#e3f2fd', stroke: '#1565c0' }, documentation: 'Check using the four-eyes principle' },
] });

// Default flow + condition
const d1 = JSON.parse((await call('describe_diagram', { file: f1 }, { quiet: true })).text);
const flow = (from, to) => d1.flows.find((f) => f.from === from && f.to === to).id;
await call('update_element', { file: f1, id: flow('G_Ok', 'SP_Deliver'), condition: '= correct' });
await call('update_element', { file: f1, id: flow('G_Ok', 'E_Nok'), isDefault: true });
// Elements inside the subprocess are reachable
await call('update_element', { file: f1, id: 'SP_T', name: 'Pack goods', properties: { retries: '5', headers: { prio: 'high' } } });
const check1 = await call('check_diagram', { file: f1 });
expect('no missing condition reported', !/condition-missing|without a condition/.test(check1.text));
expect('jobType survives a properties change', !/job-type-missing/.test(check1.text));

const xml1 = fs.readFileSync(f1, 'utf8');
const has = (s) => xml1.includes(s);
for (const [k, v] of Object.entries({
  boundary: has('cancelActivity="false"'), timer: has('<bpmn:timeDuration'), mi: has('multiInstanceLoopCharacteristics') && has('zeebe:loopCharacteristics'),
  assign: has('zeebe:assignmentDefinition') && has('zeebe:formDefinition'), error: has('errorCode="REJECTED"'), data: has('dataInputAssociation'),
  anno: has('New customers only') && has('bpmn:association'), color: has('#e3f2fd'), doc: has('four-eyes'), job: has('send-reminder'),
  sub: has('isExpanded="true"'), default: /exclusiveGateway id="G_Ok"[^>]*default=/.test(xml1), headers: has('zeebe:taskHeaders') && has('retries="5"'),
  platform: has('modeler:executionPlatform="Camunda Cloud"'),
})) expect(`file contains ${k}`, v);

const shot = await call('screenshot_diagram', { file: f1 }, { quiet: true });
const img = shot.content.find((c) => c.type === 'image');
expect('screenshot returned', img && img.data.length > 1000);
if (out) { fs.copyFileSync(f1, `${out}-order.bpmn`); fs.writeFileSync(`${out}-order.png`, Buffer.from(img.data, 'base64')); }

// ---------- 2. All or nothing, undo/redo, arrange ----------
const before = fs.readFileSync(f1, 'utf8');
await call('batch', { file: f1, operations: [
  { op: 'add', type: 'task', id: 'X_1', name: 'Intermediate step', after: 'S' },
  { op: 'connect', source: 'X_1', target: 'DOES_NOT_EXIST' },
] }, { expectError: true });
expect('failed batch leaves the file unchanged', fs.readFileSync(f1, 'utf8') === before);
await call('remove_element', { file: f1, ids: ['A_1', 'D_Order'] });
expect('element deleted', !fs.readFileSync(f1, 'utf8').includes('New customers only'));
await call('undo', { file: f1 });
expect('undo restores the file', fs.readFileSync(f1, 'utf8') === before);
await call('redo', { file: f1 });
expect('redo deletes again', !fs.readFileSync(f1, 'utf8').includes('New customers only'));
await call('undo', { file: f1 });
await call('arrange', { file: f1, action: 'move', id: 'A_1', dx: 0, dy: -40 });
const moved = fs.readFileSync(f1, 'utf8');
await call('update_element', { file: f1, id: 'A_1', name: 'New customers only!', layout: false });
const yOf = (xml) => /bpmnElement="A_1">\s*<dc:Bounds x="[\d.]+" y="([\d.]+)"/.exec(xml)?.[1];
expect('layout: false keeps the manual arrangement', yOf(moved) && yOf(moved) === yOf(fs.readFileSync(f1, 'utf8')));
await call('add_element', { file: path.join(dir, 'missing.bpmn'), type: 'task' }, { expectError: true });
await call('add_element', { file: 'relative.bpmn', type: 'task' }, { expectError: true });

// ---------- 3. Pools, lanes, message flow (as in live-pools) ----------
const f2 = path.join(dir, 'vacation.bpmn');
await call('create_diagram', { file: f2, processId: 'Process_Vacation' });
await call('batch', { file: f2, operations: [
  { op: 'add', type: 'startEvent', id: 'S', name: 'Vacation wanted' },
  { op: 'add', type: 'participant', id: 'P_Company', name: 'Company', lanes: ['Employee', 'Manager', 'HR department'] },
] }, { quiet: true });
const d2 = JSON.parse((await call('describe_diagram', { file: f2 }, { quiet: true })).text);
const lane = (n) => d2.elements.find((e) => e.type === 'Lane' && e.name === n).id;
await call('batch', { file: f2, operations: [
  { op: 'add', type: 'userTask', id: 'T_Request', name: 'Submit vacation request', after: 'S' },
  { op: 'add', type: 'userTask', id: 'T_Check', name: 'Check request', after: 'T_Request', parent: lane('Manager') },
  { op: 'add', type: 'exclusiveGateway', id: 'G_Ok', name: 'Request approved?', after: 'T_Check' },
  { op: 'add', type: 'serviceTask', id: 'T_Book', name: 'Record vacation', after: 'G_Ok', flowName: 'yes', parent: lane('HR department'), jobType: 'book-vacation' },
  { op: 'add', type: 'userTask', id: 'T_Info', name: 'Read rejection', after: 'G_Ok', flowName: 'no', parent: lane('Employee') },
  { op: 'add', type: 'exclusiveGateway', id: 'G_Join', after: 'T_Book' },
  { op: 'connect', source: 'T_Info', target: 'G_Join' },
  { op: 'add', type: 'endEvent', id: 'E_1', name: 'Request handled', after: 'G_Join' },
  { op: 'add', type: 'participant', id: 'P_Payroll', name: 'Payroll (external)', expanded: false },
  { op: 'connect', source: 'T_Book', target: 'P_Payroll', name: 'Vacation days' },
] });
await call('check_diagram', { file: f2 });
const xml2 = fs.readFileSync(f2, 'utf8');
expect('3 lanes', (xml2.match(/<bpmn:lane /g) ?? []).length === 3);
expect('message flow', xml2.includes('bpmn:messageFlow'));
// Edit elements inside pools
await call('update_element', { file: f2, id: 'T_Book', properties: { retries: '3' } });
expect('pool element edited', /type="book-vacation" retries="3"/.test(fs.readFileSync(f2, 'utf8')));
if (out) {
  fs.copyFileSync(f2, `${out}-vacation.bpmn`);
  const s2 = await call('screenshot_diagram', { file: f2 }, { quiet: true });
  fs.writeFileSync(`${out}-vacation.png`, Buffer.from(s2.content[0].data, 'base64'));
}

// ---------- 4. Continue editing an existing file ----------
const f3 = path.join(dir, 'example.bpmn');
fs.copyFileSync(path.join(ROOT, 'example.bpmn'), f3);
await call('describe_diagram', { file: f3 }, { quiet: true });
await call('relayout', { file: f3 });

await client.close();
console.log(failed ? `\n${failed} ERRORS` : '\nall ok', '–', dir);
process.exitCode = failed ? 1 : 0;
