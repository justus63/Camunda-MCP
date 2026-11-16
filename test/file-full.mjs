// Datei-Modus mit vollem Funktionsumfang (headless bpmn-js): dieselben Szenarien wie live-basic/live-pools,
// dazu Standardfluss, Alles-oder-nichts-Batch, arrange ohne Neu-Layout, undo/redo, Screenshot.
// Aufruf: node test/file-full.mjs [ausgabe-präfix]  (schreibt dann <präfix>-*.bpmn/.png)
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
  if (!quiet || bad) console.log(bad ? 'FEHLER' : 'ok    ', name, text.length > 300 ? text.slice(0, 300) + ' …' : text);
  return { ...r, text };
};
const expect = (label, cond) => { console.log(cond ? 'ok    ' : 'FEHLER', label); if (!cond) failed++; };

// ---------- 1. Bestellprozess (wie live-basic) ----------
const f1 = path.join(dir, 'bestellung.bpmn');
await call('create_diagram', { file: f1, processId: 'Process_Bestellung', name: 'Bestellung' });
await call('create_diagram', { file: f1 }, { expectError: true });
await call('batch', { file: f1, operations: [
  { op: 'add', type: 'startEvent', id: 'S', name: 'Bestellung eingegangen' },
  { op: 'add', type: 'userTask', id: 'T_Pruefen', name: 'Bestellung prüfen', after: 'S', properties: { assignee: '= sachbearbeiter', formId: 'pruefen-form' } },
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

// Standardfluss + Bedingung (gab es im alten Datei-Modus nicht)
const d1 = JSON.parse((await call('describe_diagram', { file: f1 }, { quiet: true })).text);
const flow = (from, to) => d1.flows.find((f) => f.from === from && f.to === to).id;
await call('update_element', { file: f1, id: flow('G_Ok', 'SP_Liefern'), condition: '= korrekt' });
await call('update_element', { file: f1, id: flow('G_Ok', 'E_Nok'), isDefault: true });
// Elemente im Teilprozess sind jetzt erreichbar
await call('update_element', { file: f1, id: 'SP_T', name: 'Ware verpacken', properties: { retries: '5', headers: { prio: 'hoch' } } });
const check1 = await call('check_diagram', { file: f1 });
expect('keine fehlende Bedingung gemeldet', !/bedingung-fehlt|ohne Bedingung/.test(check1.text));
expect('jobType bleibt bei properties-Änderung erhalten', !/jobtyp-fehlt/.test(check1.text));

const xml1 = fs.readFileSync(f1, 'utf8');
const has = (s) => xml1.includes(s);
for (const [k, v] of Object.entries({
  boundary: has('cancelActivity="false"'), timer: has('<bpmn:timeDuration'), mi: has('multiInstanceLoopCharacteristics') && has('zeebe:loopCharacteristics'),
  assign: has('zeebe:assignmentDefinition') && has('zeebe:formDefinition'), error: has('errorCode="REJECTED"'), data: has('dataInputAssociation'),
  anno: has('Nur bei Neukunden') && has('bpmn:association'), color: has('#e3f2fd'), doc: has('Vier-Augen'), job: has('send-reminder'),
  sub: has('isExpanded="true"'), default: /exclusiveGateway id="G_Ok"[^>]*default=/.test(xml1), headers: has('zeebe:taskHeaders') && has('retries="5"'),
  platform: has('modeler:executionPlatform="Camunda Cloud"'),
})) expect(`Datei enthält ${k}`, v);

const shot = await call('screenshot_diagram', { file: f1 }, { quiet: true });
const img = shot.content.find((c) => c.type === 'image');
expect('Screenshot geliefert', img && img.data.length > 1000);
if (out) { fs.copyFileSync(f1, `${out}-bestellung.bpmn`); fs.writeFileSync(`${out}-bestellung.png`, Buffer.from(img.data, 'base64')); }

// ---------- 2. Alles oder nichts, undo/redo, arrange ----------
const before = fs.readFileSync(f1, 'utf8');
await call('batch', { file: f1, operations: [
  { op: 'add', type: 'task', id: 'X_1', name: 'Zwischenschritt', after: 'S' },
  { op: 'connect', source: 'X_1', target: 'GIBTS_NICHT' },
] }, { expectError: true });
expect('fehlgeschlagener Batch lässt Datei unverändert', fs.readFileSync(f1, 'utf8') === before);
await call('remove_element', { file: f1, ids: ['A_1', 'D_Best'] });
expect('Element gelöscht', !fs.readFileSync(f1, 'utf8').includes('Nur bei Neukunden'));
await call('undo', { file: f1 });
expect('undo stellt Datei wieder her', fs.readFileSync(f1, 'utf8') === before);
await call('redo', { file: f1 });
expect('redo löscht wieder', !fs.readFileSync(f1, 'utf8').includes('Nur bei Neukunden'));
await call('undo', { file: f1 });
await call('arrange', { file: f1, action: 'move', id: 'A_1', dx: 0, dy: -40 });
const moved = fs.readFileSync(f1, 'utf8');
await call('update_element', { file: f1, id: 'A_1', name: 'Nur bei Neukunden!', layout: false });
const yOf = (xml) => /bpmnElement="A_1">\s*<dc:Bounds x="[\d.]+" y="([\d.]+)"/.exec(xml)?.[1];
expect('layout: false behält manuelle Anordnung', yOf(moved) && yOf(moved) === yOf(fs.readFileSync(f1, 'utf8')));
await call('add_element', { file: path.join(dir, 'fehlt.bpmn'), type: 'task' }, { expectError: true });
await call('add_element', { file: 'relativ.bpmn', type: 'task' }, { expectError: true });

// ---------- 3. Pools, Lanes, Nachrichtenfluss (wie live-pools) ----------
const f2 = path.join(dir, 'urlaub.bpmn');
await call('create_diagram', { file: f2, processId: 'Process_Urlaub' });
await call('batch', { file: f2, operations: [
  { op: 'add', type: 'startEvent', id: 'S', name: 'Urlaubswunsch entstanden' },
  { op: 'add', type: 'participant', id: 'P_Firma', name: 'Unternehmen', lanes: ['Mitarbeiter', 'Führungskraft', 'Personalabteilung'] },
] }, { quiet: true });
const d2 = JSON.parse((await call('describe_diagram', { file: f2 }, { quiet: true })).text);
const lane = (n) => d2.elements.find((e) => e.type === 'Lane' && e.name === n).id;
await call('batch', { file: f2, operations: [
  { op: 'add', type: 'userTask', id: 'T_Antrag', name: 'Urlaubsantrag stellen', after: 'S' },
  { op: 'add', type: 'userTask', id: 'T_Pruefen', name: 'Antrag prüfen', after: 'T_Antrag', parent: lane('Führungskraft') },
  { op: 'add', type: 'exclusiveGateway', id: 'G_Ok', name: 'Antrag genehmigt?', after: 'T_Pruefen' },
  { op: 'add', type: 'serviceTask', id: 'T_Buchen', name: 'Urlaub eintragen', after: 'G_Ok', flowName: 'ja', parent: lane('Personalabteilung'), jobType: 'book-vacation' },
  { op: 'add', type: 'userTask', id: 'T_Info', name: 'Ablehnung lesen', after: 'G_Ok', flowName: 'nein', parent: lane('Mitarbeiter') },
  { op: 'add', type: 'exclusiveGateway', id: 'G_Join', after: 'T_Buchen' },
  { op: 'connect', source: 'T_Info', target: 'G_Join' },
  { op: 'add', type: 'endEvent', id: 'E_1', name: 'Antrag bearbeitet', after: 'G_Join' },
  { op: 'add', type: 'participant', id: 'P_Kasse', name: 'Lohnabrechnung (extern)', expanded: false },
  { op: 'connect', source: 'T_Buchen', target: 'P_Kasse', name: 'Urlaubstage' },
] });
await call('check_diagram', { file: f2 });
const xml2 = fs.readFileSync(f2, 'utf8');
expect('3 Lanes', (xml2.match(/<bpmn:lane /g) ?? []).length === 3);
expect('Nachrichtenfluss', xml2.includes('bpmn:messageFlow'));
// Elemente in Pools bearbeiten (im alten Datei-Modus unsichtbar)
await call('update_element', { file: f2, id: 'T_Buchen', properties: { retries: '3' } });
expect('Pool-Element bearbeitet', /type="book-vacation" retries="3"/.test(fs.readFileSync(f2, 'utf8')));
if (out) {
  fs.copyFileSync(f2, `${out}-urlaub.bpmn`);
  const s2 = await call('screenshot_diagram', { file: f2 }, { quiet: true });
  fs.writeFileSync(`${out}-urlaub.png`, Buffer.from(s2.content[0].data, 'base64'));
}

// ---------- 4. Vorhandene Datei aus dem alten Datei-Modus weiterbearbeiten ----------
const f3 = path.join(dir, 'beispiel.bpmn');
fs.copyFileSync(path.join(ROOT, 'beispiel.bpmn'), f3);
await call('describe_diagram', { file: f3 }, { quiet: true });
await call('relayout', { file: f3 });

await client.close();
console.log(failed ? `\n${failed} FEHLER` : '\nalles ok', '–', dir);
process.exitCode = failed ? 1 : 0;
