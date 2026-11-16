// Über den MCP-Server: Camunda-7-Kollaborationsdiagramm in einem Aufruf anlegen, Ebenen prüfen, exportieren,
// manuelle Korrektur + nur Nachrichtenflüsse neu verlegen. Aufruf: node test/c7-file.mjs [ausgabe-präfix]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT } from './render.mjs';
import { OPS } from './collab-direct.mjs';

const out = process.argv[2];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmn-c7file-'));
const client = new Client({ name: 'test', version: '1' });
await client.connect(new StdioClientTransport({ command: 'node', args: [path.join(ROOT, 'server.js')], env: { ...process.env, BPMN_MCP_PORT: '17995' } }));
let failed = 0;
const expect = (label, cond) => { console.log(cond ? 'ok    ' : 'FEHLER', label); if (!cond) failed++; };
const call = async (name, args = {}, expectError = false) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.find((c) => c.type === 'text')?.text ?? '';
  const bad = !!r.isError !== expectError;
  if (bad) failed++;
  console.log(bad ? 'FEHLER' : 'ok    ', name, text.length > 260 ? text.slice(0, 260) + ' …' : text);
  return { ...r, text };
};

// 1. Operatives Kollaborationsdiagramm (Camunda 7) in einem einzigen Aufruf
const f = path.join(dir, 'stelle.bpmn');
await call('create_diagram', { file: f, processId: 'Process_Engine', name: 'Stellenausschreibung', platform: 'camunda7', operations: OPS });
const xml = fs.readFileSync(f, 'utf8');
expect('Camunda-7-Kopf', xml.includes('modeler:executionPlatform="Camunda Platform"') && !xml.includes('zeebe:'));
expect('nur der Engine-Pool ist ausführbar', /<bpmn:process id="Process_Engine"[^>]*isExecutable="true"/.test(xml) && /<bpmn:process id="Process_FK"[^>]*isExecutable="false"/.test(xml));
const d = JSON.parse((await call('describe_diagram', { file: f })).text);
expect('describe ist gültiges, kompaktes JSON', d.root.platform === 'camunda7' && d.elements.length > 30);
expect('Lane-IDs wie angegeben', d.elements.some((e) => e.id === 'L_Auto' && e.type === 'Lane'));

const op = await call('check_diagram', { file: f, level: 'operativ' });
expect('operativ: keine technischen Meldungen', !/implementierung-fehlt|zuweisung-fehlt|bedingung-fehlt/.test(op.text));
expect('operativ: Datenfluss wird angemahnt', /operativ-datenfluss/.test(op.text));
expect('Konstrukte werden aufgelistet', /Basiskonstrukte: 13 Nachrichtenflüsse/.test(op.text) && /3 ausmodellierte Pools/.test(op.text));
const te = await call('check_diagram', { file: f, level: 'technisch' });
expect('technisch: fehlende Bedingungen am XOR der Engine', /bedingung-fehlt/.test(te.text) && /Freigabe erteilt/.test(te.text));
expect('technisch: menschliche Pools werden nicht geprüft', !/„Freie Stelle melden“ ist niemandem zugewiesen/.test(te.text));
const st = await call('check_diagram', { file: f, level: 'strategisch' });
expect('strategisch: Umfang, Typen, Pools bemängelt', /strategisch-umfang/.test(st.text) && /strategisch-abstrakt/.test(st.text) && /strategisch-pool/.test(st.text));

// 2. Deadlock-Erkennung und falsche Bedingungssyntax
const g = path.join(dir, 'deadlock.bpmn');
await call('create_diagram', { file: g, platform: 'camunda7', operations: [
  { op: 'add', type: 'startEvent', id: 'S', name: 'Antrag eingegangen' },
  { op: 'add', type: 'exclusiveGateway', id: 'X', name: 'Betrag hoch?', after: 'S' },
  { op: 'add', type: 'userTask', id: 'A', name: 'Antrag prüfen', after: 'X', flowName: 'ja', properties: { assignee: 'demo' } },
  { op: 'add', type: 'userTask', id: 'B', name: 'Antrag ablegen', after: 'X', flowName: 'nein', properties: { assignee: 'demo' } },
  { op: 'add', type: 'parallelGateway', id: 'J', after: 'A' },
  { op: 'connect', source: 'B', target: 'J' },
  { op: 'add', type: 'endEvent', id: 'E', name: 'Antrag erledigt', after: 'J' },
] });
const dd = JSON.parse((await call('describe_diagram', { file: g })).text);
await call('update_element', { file: g, id: dd.flows.find((x) => x.from === 'X' && x.to === 'A').id, condition: '= betrag > 500' });
const dl = await call('check_diagram', { file: g });
expect('Deadlock (XOR-Split, AND-Join) erkannt', /deadlock/.test(dl.text));
expect('FEEL-Bedingung in Camunda 7 bemängelt', /bedingung-syntax/.test(dl.text));

// 3. Export und "nur Nachrichtenflüsse"
await call('export_diagram', { file: f, format: 'pdf' });
expect('PDF geschrieben', fs.readFileSync(f.replace('.bpmn', '.pdf')).subarray(0, 4).toString() === '%PDF');
await call('export_diagram', { file: f, format: 'svg', output: path.join(dir, 'x.svg') });
expect('SVG geschrieben', fs.readFileSync(path.join(dir, 'x.svg'), 'utf8').includes('<svg'));
await call('arrange', { file: f, action: 'move', id: 'FK_Korr', dx: 0, dy: 40 });
const pos = (x, id) => new RegExp(`bpmnElement="${id}"[^>]*>\\s*<dc:Bounds x="([\\d.-]+)" y="([\\d.-]+)"`).exec(x)?.slice(1).join(',');
const moved = fs.readFileSync(f, 'utf8');
await call('relayout', { file: f, only: 'messageFlows' });
const after = fs.readFileSync(f, 'utf8');
expect('only: messageFlows lässt die verschobene Aufgabe stehen', pos(moved, 'FK_Korr') === pos(after, 'FK_Korr') && pos(after, 'FK_Korr') !== pos(xml, 'FK_Korr'));
const chk = await call('check_diagram', { file: f, level: 'operativ' });
expect('danach keine Linie durch ein Element', !/linie-durch-element/.test(chk.text));
await call('add_element', { file: f, type: 'userTask', name: 'Unterlagen sichten', parent: 'Sachbearbeiter Personal', layout: false });
await call('add_element', { file: f, type: 'task', name: 'X', parent: 'Gibt es nicht' }, true);
await call('update_element', { file: f, id: 'PE_Durchf', jobType: 'x' }, true);
if (out) {
  const s = await client.callTool({ name: 'screenshot_diagram', arguments: { file: f, maxSize: 2400 } });
  fs.writeFileSync(`${out}.png`, Buffer.from(s.content[0].data, 'base64'));
  fs.copyFileSync(f, `${out}.bpmn`);
}
await client.close();
console.log(failed ? `\n${failed} FEHLER` : '\nalles ok', '–', dir);
process.exitCode = failed ? 1 : 0;
