// UML-Werkzeuge über den MCP-Server: Klassendiagramm (Beispiel "Bibliothek") und Zustandsdiagramm (Angebot aus der Vorlesung).
// Aufruf: node test/uml.mjs [ausgabe-ordner]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT } from './render.mjs';

const dir = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'uml-'));
const client = new Client({ name: 'test', version: '1' });
await client.connect(new StdioClientTransport({ command: 'node', args: [path.join(ROOT, 'server.js')], env: { ...process.env, BPMN_MCP_PORT: '17996' } }));
let failed = 0;
const expect = (label, cond) => { console.log(cond ? 'ok    ' : 'FEHLER', label); if (!cond) failed++; };
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.find((c) => c.type === 'text')?.text ?? '';
  console.log(r.isError ? 'FEHLER' : 'ok    ', name, text.slice(0, 600));
  if (r.isError) failed++;
  return { ...r, text };
};

const k = path.join(dir, 'bibliothek');
const r1 = await call('uml_class_diagram', {
  file: k, title: 'Domänenmodell Bibliothek',
  classes: [
    { name: 'Person', abstract: true, attributes: ['name: Text', 'eMail: Text'] },
    { name: 'Leser', attributes: ['ausweisnummer: Text', 'gesperrt: Ja/Nein'] },
    { name: 'Bibliothekar', attributes: ['personalnummer: Text'] },
    { name: 'Ausleihe', attributes: ['ausgeliehenAm: Datum', 'faelligAm: Datum', 'status: Ausleihstatus'] },
    { name: 'Exemplar', attributes: ['signatur: Text', 'zustand: Text'] },
    { name: 'Buch', attributes: ['isbn: Text', 'titel: Text', 'erscheinungsjahr: Zahl'] },
    { name: 'Autor', attributes: ['name: Text'] },
    { name: 'Mahnung', attributes: ['stufe: Zahl', 'gebuehr: Euro', 'drucken()'] },
    { name: 'Ausleihstatus', stereotype: 'enumeration', attributes: ['offen', 'zurückgegeben', 'überfällig'] },
    { name: 'Vormerkung', attributes: ['vorgemerktAm: Datum'] },
  ],
  relations: [
    { from: 'Leser', to: 'Person', type: 'generalization' },
    { from: 'Bibliothekar', to: 'Person', type: 'generalization' },
    { from: 'Leser', to: 'Ausleihe', name: 'tätigt', fromMult: '1', toMult: '0..*' },
    { from: 'Ausleihe', to: 'Exemplar', name: 'betrifft', fromMult: '0..*', toMult: '1' },
    { from: 'Buch', to: 'Exemplar', type: 'composition', name: 'besteht aus', fromMult: '1', toMult: '1..*' },
    { from: 'Autor', to: 'Buch', name: 'verfasst', fromMult: '1..*', toMult: '0..*' },
    { from: 'Ausleihe', to: 'Mahnung', type: 'composition', fromMult: '1', toMult: '0..3' },
    { from: 'Bibliothekar', to: 'Ausleihe', name: 'bearbeitet', fromMult: '1', toMult: '0..*', navigable: true },
    { from: 'Leser', to: 'Vormerkung', name: 'erstellt', fromMult: '1', toMult: '0..*' },
    { from: 'Vormerkung', to: 'Buch', fromMult: '0..*', toMult: '1' },
  ],
  notes: [{ text: 'Ein Leser darf höchstens fünf Exemplare gleichzeitig ausleihen.', attachTo: 'Leser' }],
});
for (const ext of ['drawio', 'svg', 'pdf', 'png', 'uml.json']) expect(`bibliothek.${ext} geschrieben`, fs.statSync(`${k}.${ext}`).size > 200);
expect('Vorschaubild geliefert', r1.content.some((c) => c.type === 'image'));
expect('Methode wird bemängelt', /Methoden gehören nicht/.test(r1.text));
expect('unbenannte Assoziation wird bemängelt', /Vormerkung – Buch hat keinen Namen/.test(r1.text));
expect('keine Beziehung läuft durch eine Klasse', !/läuft durch Klasse/.test(r1.text));
const drawio = fs.readFileSync(`${k}.drawio`, 'utf8');
expect('draw.io: 10 Klassen, 10 Beziehungen', (drawio.match(/style="swimlane/g) ?? []).length === 10 && (drawio.match(/edge="1"/g) ?? []).length === 10);
expect('PDF beginnt mit %PDF', fs.readFileSync(`${k}.pdf`).subarray(0, 4).toString() === '%PDF');
const bad = await client.callTool({ name: 'uml_class_diagram', arguments: { file: k, classes: [{ name: 'A' }], relations: [{ from: 'A', to: 'B' }] } });
expect('unbekannte Klasse wird abgelehnt', bad.isError);
// erzwungene Anordnung mit einer Klasse im Weg: die Beziehung muss ausweichen
const r3 = await call('uml_class_diagram', {
  file: path.join(dir, 'ausweichen'),
  classes: [{ name: 'A', attributes: ['x: Zahl'], col: 0, row: 0 }, { name: 'B', attributes: ['x: Zahl'], col: 1, row: 0 }, { name: 'C', attributes: ['x: Zahl'], col: 2, row: 0 }],
  relations: [{ from: 'A', to: 'C', name: 'kennt', fromMult: '1', toMult: '1' }, { from: 'A', to: 'B', name: 'hat', fromMult: '1', toMult: '1' }, { from: 'B', to: 'C', name: 'hat', fromMult: '1', toMult: '1' }],
});
expect('Beziehung weicht der Klasse im Weg aus', !/läuft durch Klasse/.test(r3.text));

const z = path.join(dir, 'angebot');
const r2 = await call('uml_state_diagram', {
  file: z, title: 'Lebenszyklus Angebot', initial: 'initial', finals: ['accepted', 'rejected'],
  states: ['initial', 'draft', 'confirmed', 'sent', 'accepted', 'rejected'],
  transitions: [
    { from: 'initial', to: 'draft', label: 'Angebot erstellen' }, { from: 'draft', to: 'confirmed', label: 'Angebot prüfen' }, { from: 'draft', to: 'draft', label: 'Angebot überarbeiten' },
    { from: 'initial', to: 'confirmed', label: 'Standardangebot wählen' }, { from: 'confirmed', to: 'sent', label: 'Angebot versenden' },
    { from: 'sent', to: 'accepted', label: 'Zusage erhalten' }, { from: 'sent', to: 'rejected', label: 'Absage erhalten' },
  ],
});
for (const ext of ['drawio', 'svg', 'pdf', 'png']) expect(`angebot.${ext} geschrieben`, fs.statSync(`${z}.${ext}`).size > 200);
expect('Zustandsdiagramm ohne Hinweise', /Keine Auffälligkeiten/.test(r2.text));
await client.close();
console.log(failed ? `\n${failed} FEHLER` : '\nalles ok', '–', dir);
process.exitCode = failed ? 1 : 0;
