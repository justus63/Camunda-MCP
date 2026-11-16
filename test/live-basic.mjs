import fs from 'node:fs';
import { startLive } from './harness.mjs';
const out = process.argv[2];
const t = await startLive();
await t.call('live_status');
await t.call('live_batch', { layout: true, operations: [
  { op: 'update', id: 'StartEvent_1', name: 'Order received' },
  { op: 'add', type: 'userTask', id: 'T_Check', name: 'Check order', after: 'StartEvent_1', properties: { assignee: '= clerk', formId: 'check-form' } },
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
await t.call('live_check');
await t.call('live_describe', {}, true);
const xml = await t.xmlOut();
if (out) { fs.writeFileSync(out + '.bpmn', xml); await t.shot(out + '.png'); }
const has = (s) => xml.includes(s);
console.log({ boundary: has('cancelActivity="false"'), timer: has('<bpmn:timeDuration'), mi: has('multiInstanceLoopCharacteristics') && has('zeebe:loopCharacteristics'),
  assign: has('zeebe:assignmentDefinition') && has('zeebe:formDefinition'), error: has('errorCode="REJECTED"'), data: has('dataInputAssociation'), anno: has('New customers only') && has('bpmn:association'),
  color: has('#e3f2fd'), doc: has('four-eyes'), job: has('send-reminder'), sub: has('isExpanded="true"') });
await t.stop();
