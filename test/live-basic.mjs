import fs from 'node:fs';
import { startLive } from './harness.mjs';
const out = process.argv[2];
const t = await startLive();
await t.call('live_status');
await t.call('live_batch', { layout: true, operations: [
  { op: 'update', id: 'StartEvent_1', name: 'Bestellung eingegangen' },
  { op: 'add', type: 'userTask', id: 'T_Pruefen', name: 'Bestellung prüfen', after: 'StartEvent_1', properties: { assignee: '= sachbearbeiter', formId: 'pruefen-form' } },
  { op: 'add', type: 'boundaryEvent', id: 'B_Timeout', name: '2 Tage vergangen', attachTo: 'T_Pruefen', interrupting: false, eventDefinition: { type: 'timer', timerType: 'duration', value: 'P2D' } },
  { op: 'add', type: 'sendTask', id: 'T_Erinnern', name: 'Erinnerung senden', after: 'B_Timeout', jobType: 'send-reminder' },
  { op: 'add', type: 'endEvent', id: 'E_Erinnert', name: 'Erinnerung gesendet', after: 'T_Erinnern' },
  { op: 'add', type: 'exclusiveGateway', id: 'G_Ok', name: 'Bestellung korrekt?', after: 'T_Pruefen' },
  { op: 'add', type: 'subProcess', id: 'SP_Liefern', name: 'Ware liefern', after: 'G_Ok', flowName: 'ja' },
  { op: 'add', type: 'startEvent', id: 'SP_S', name: 'Lieferung gestartet', parent: 'SP_Liefern' },
  { op: 'add', type: 'serviceTask', id: 'SP_T', name: 'Ware verpacken', after: 'SP_S', jobType: 'pack', loop: { type: 'parallel', inputCollection: '= positionen', inputElement: 'position' } },
  { op: 'add', type: 'endEvent', id: 'SP_E', name: 'Ware verpackt', after: 'SP_T' },
  { op: 'add', type: 'endEvent', id: 'E_Ok', name: 'Bestellung geliefert', after: 'SP_Liefern' },
  { op: 'add', type: 'endEvent', id: 'E_Nok', name: 'Bestellung abgelehnt', after: 'G_Ok', flowName: 'nein', eventDefinition: { type: 'error', name: 'abgelehnt', code: 'REJECTED' } },
  { op: 'add', type: 'dataObject', id: 'D_Best', name: 'Bestellung', attachTo: 'T_Pruefen', direction: 'input' },
  { op: 'add', type: 'textAnnotation', id: 'A_1', name: 'Nur bei Neukunden', attachTo: 'G_Ok' },
  { op: 'update', id: 'T_Pruefen', color: { fill: '#e3f2fd', stroke: '#1565c0' }, documentation: 'Prüfung nach Vier-Augen-Prinzip' },
] });
await t.call('live_check');
await t.call('live_describe', {}, true);
const xml = await t.xmlOut();
if (out) { fs.writeFileSync(out + '.bpmn', xml); await t.shot(out + '.png'); }
const has = (s) => xml.includes(s);
console.log({ boundary: has('cancelActivity="false"'), timer: has('<bpmn:timeDuration'), mi: has('multiInstanceLoopCharacteristics') && has('zeebe:loopCharacteristics'),
  assign: has('zeebe:assignmentDefinition') && has('zeebe:formDefinition'), error: has('errorCode="REJECTED"'), data: has('dataInputAssociation'), anno: has('Nur bei Neukunden') && has('bpmn:association'),
  color: has('#e3f2fd'), doc: has('Vier-Augen'), job: has('send-reminder'), sub: has('isExpanded="true"') });
await t.stop();
