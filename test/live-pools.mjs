import fs from 'node:fs';
import { startLive } from './harness.mjs';
const out = process.argv[2];
const t = await startLive();
await t.call('live_batch', { layout: true, operations: [
  { op: 'update', id: 'StartEvent_1', name: 'Vacation wanted' },
  { op: 'add', type: 'participant', id: 'P_Company', name: 'Company', lanes: ['Employee', 'Manager', 'HR department'] },
] }, true);
const d = JSON.parse((await t.call('live_describe', {}, true)).text);
const lane = (n) => d.elements.find((e) => e.type === 'Lane' && e.name === n).id;
await t.call('live_batch', { layout: true, operations: [
  { op: 'add', type: 'userTask', id: 'T_Request', name: 'Submit vacation request', after: 'StartEvent_1' },
  { op: 'add', type: 'userTask', id: 'T_Check', name: 'Check request', after: 'T_Request', parent: lane('Manager') },
  { op: 'add', type: 'exclusiveGateway', id: 'G_Ok', name: 'Request approved?', after: 'T_Check' },
  { op: 'add', type: 'serviceTask', id: 'T_Book', name: 'Record vacation', after: 'G_Ok', flowName: 'yes', parent: lane('HR department'), jobType: 'book-vacation' },
  { op: 'add', type: 'userTask', id: 'T_Info', name: 'Read rejection', after: 'G_Ok', flowName: 'no', parent: lane('Employee') },
  { op: 'add', type: 'exclusiveGateway', id: 'G_Join', after: 'T_Book' },
  { op: 'connect', source: 'T_Info', target: 'G_Join' },
  { op: 'add', type: 'endEvent', id: 'E_1', name: 'Request handled', after: 'G_Join' },
  { op: 'add', type: 'participant', id: 'P_Payroll', name: 'Payroll (external)', expanded: false },
  { op: 'connect', source: 'T_Book', target: 'P_Payroll', name: 'Vacation days' },
  { op: 'update', id: d.flows[0]?.id ?? 'x', name: undefined },
].filter((o) => o.id !== 'x') });
await t.call('live_check');
const xml = await t.xmlOut();
if (out) { fs.writeFileSync(out + '.bpmn', xml); await t.shot(out + '.png'); }
console.log({ lanes: (xml.match(/<bpmn:lane /g) ?? []).length, msg: xml.includes('bpmn:messageFlow'), refs: (xml.match(/flowNodeRef/g) ?? []).length });
await t.call('live_undo'); await t.call('live_redo');
await t.stop();
