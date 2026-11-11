import fs from 'node:fs';
import { startLive } from './harness.mjs';
const out = process.argv[2];
const t = await startLive();
await t.call('live_batch', { layout: true, operations: [
  { op: 'update', id: 'StartEvent_1', name: 'Urlaubswunsch entstanden' },
  { op: 'add', type: 'participant', id: 'P_Firma', name: 'Unternehmen', lanes: ['Mitarbeiter', 'Führungskraft', 'Personalabteilung'] },
] }, true);
const d = JSON.parse((await t.call('live_describe', {}, true)).text);
const lane = (n) => d.elements.find((e) => e.type === 'Lane' && e.name === n).id;
await t.call('live_batch', { layout: true, operations: [
  { op: 'add', type: 'userTask', id: 'T_Antrag', name: 'Urlaubsantrag stellen', after: 'StartEvent_1' },
  { op: 'add', type: 'userTask', id: 'T_Pruefen', name: 'Antrag prüfen', after: 'T_Antrag', parent: lane('Führungskraft') },
  { op: 'add', type: 'exclusiveGateway', id: 'G_Ok', name: 'Antrag genehmigt?', after: 'T_Pruefen' },
  { op: 'add', type: 'serviceTask', id: 'T_Buchen', name: 'Urlaub eintragen', after: 'G_Ok', flowName: 'ja', parent: lane('Personalabteilung'), jobType: 'book-vacation' },
  { op: 'add', type: 'userTask', id: 'T_Info', name: 'Ablehnung lesen', after: 'G_Ok', flowName: 'nein', parent: lane('Mitarbeiter') },
  { op: 'add', type: 'exclusiveGateway', id: 'G_Join', after: 'T_Buchen' },
  { op: 'connect', source: 'T_Info', target: 'G_Join' },
  { op: 'add', type: 'endEvent', id: 'E_1', name: 'Antrag bearbeitet', after: 'G_Join' },
  { op: 'add', type: 'participant', id: 'P_Kasse', name: 'Lohnabrechnung (extern)', expanded: false },
  { op: 'connect', source: 'T_Buchen', target: 'P_Kasse', name: 'Urlaubstage' },
  { op: 'update', id: d.flows[0]?.id ?? 'x', name: undefined },
].filter((o) => o.id !== 'x') });
await t.call('live_check');
const xml = await t.xmlOut();
if (out) { fs.writeFileSync(out + '.bpmn', xml); await t.shot(out + '.png'); }
console.log({ lanes: (xml.match(/<bpmn:lane /g) ?? []).length, msg: xml.includes('bpmn:messageFlow'), refs: (xml.match(/flowNodeRef/g) ?? []).length });
await t.call('live_undo'); await t.call('live_redo');
await t.stop();
