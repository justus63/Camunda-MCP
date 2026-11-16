// UML tools via the MCP server: class diagram (example "library") and state diagram (quote lifecycle).
// Usage: node test/uml.mjs [output-folder]
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
const expect = (label, cond) => { console.log(cond ? 'ok    ' : 'ERROR ', label); if (!cond) failed++; };
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.find((c) => c.type === 'text')?.text ?? '';
  console.log(r.isError ? 'ERROR ' : 'ok    ', name, text.slice(0, 600));
  if (r.isError) failed++;
  return { ...r, text };
};

const k = path.join(dir, 'library');
const r1 = await call('uml_class_diagram', {
  file: k, title: 'Library domain model',
  classes: [
    { name: 'Person', abstract: true, attributes: ['name: Text', 'email: Text'] },
    { name: 'Reader', attributes: ['cardNumber: Text', 'blocked: Yes/No'] },
    { name: 'Librarian', attributes: ['staffNumber: Text'] },
    { name: 'Loan', attributes: ['loanedOn: Date', 'dueOn: Date', 'status: LoanStatus'] },
    { name: 'Copy', attributes: ['shelfMark: Text', 'condition: Text'] },
    { name: 'Book', attributes: ['isbn: Text', 'title: Text', 'year: Number'] },
    { name: 'Author', attributes: ['name: Text'] },
    { name: 'Reminder', attributes: ['level: Number', 'fee: Euro', 'print()'] },
    { name: 'LoanStatus', stereotype: 'enumeration', attributes: ['open', 'returned', 'overdue'] },
    { name: 'Reservation', attributes: ['reservedOn: Date'] },
  ],
  relations: [
    { from: 'Reader', to: 'Person', type: 'generalization' },
    { from: 'Librarian', to: 'Person', type: 'generalization' },
    { from: 'Reader', to: 'Loan', name: 'makes', fromMult: '1', toMult: '0..*' },
    { from: 'Loan', to: 'Copy', name: 'concerns', fromMult: '0..*', toMult: '1' },
    { from: 'Book', to: 'Copy', type: 'composition', name: 'consists of', fromMult: '1', toMult: '1..*' },
    { from: 'Author', to: 'Book', name: 'writes', fromMult: '1..*', toMult: '0..*' },
    { from: 'Loan', to: 'Reminder', type: 'composition', fromMult: '1', toMult: '0..3' },
    { from: 'Librarian', to: 'Loan', name: 'handles', fromMult: '1', toMult: '0..*', navigable: true },
    { from: 'Reader', to: 'Reservation', name: 'creates', fromMult: '1', toMult: '0..*' },
    { from: 'Reservation', to: 'Book', fromMult: '0..*', toMult: '1' },
  ],
  notes: [{ text: 'A reader may borrow at most five copies at the same time.', attachTo: 'Reader' }],
});
for (const ext of ['drawio', 'svg', 'pdf', 'png', 'uml.json']) expect(`library.${ext} written`, fs.statSync(`${k}.${ext}`).size > 200);
expect('preview image returned', r1.content.some((c) => c.type === 'image'));
expect('method is criticized', /methods do not belong/.test(r1.text));
expect('unnamed association is criticized', /Reservation – Book has no name/.test(r1.text));
expect('no relation runs through a class', !/runs through class/.test(r1.text));
const drawio = fs.readFileSync(`${k}.drawio`, 'utf8');
expect('draw.io: 10 classes, 10 relations', (drawio.match(/style="swimlane/g) ?? []).length === 10 && (drawio.match(/edge="1"/g) ?? []).length === 10);
expect('PDF starts with %PDF', fs.readFileSync(`${k}.pdf`).subarray(0, 4).toString() === '%PDF');
const bad = await client.callTool({ name: 'uml_class_diagram', arguments: { file: k, classes: [{ name: 'A' }], relations: [{ from: 'A', to: 'B' }] } });
expect('unknown class is rejected', bad.isError);
// forced arrangement with a class in the way: the relation has to route around it
const r3 = await call('uml_class_diagram', {
  file: path.join(dir, 'detour'),
  classes: [{ name: 'A', attributes: ['x: Number'], col: 0, row: 0 }, { name: 'B', attributes: ['x: Number'], col: 1, row: 0 }, { name: 'C', attributes: ['x: Number'], col: 2, row: 0 }],
  relations: [{ from: 'A', to: 'C', name: 'knows', fromMult: '1', toMult: '1' }, { from: 'A', to: 'B', name: 'has', fromMult: '1', toMult: '1' }, { from: 'B', to: 'C', name: 'has', fromMult: '1', toMult: '1' }],
});
expect('relation routes around the class in the way', !/runs through class/.test(r3.text));

const z = path.join(dir, 'quote');
const r2 = await call('uml_state_diagram', {
  file: z, title: 'Quote lifecycle', initial: 'initial', finals: ['accepted', 'rejected'],
  states: ['initial', 'draft', 'confirmed', 'sent', 'accepted', 'rejected'],
  transitions: [
    { from: 'initial', to: 'draft', label: 'Create quote' }, { from: 'draft', to: 'confirmed', label: 'Check quote' }, { from: 'draft', to: 'draft', label: 'Revise quote' },
    { from: 'initial', to: 'confirmed', label: 'Choose standard quote' }, { from: 'confirmed', to: 'sent', label: 'Send quote' },
    { from: 'sent', to: 'accepted', label: 'Acceptance received' }, { from: 'sent', to: 'rejected', label: 'Rejection received' },
  ],
});
for (const ext of ['drawio', 'svg', 'pdf', 'png']) expect(`quote.${ext} written`, fs.statSync(`${z}.${ext}`).size > 200);
expect('state diagram without hints', /No issues/.test(r2.text));
await client.close();
console.log(failed ? `\n${failed} ERRORS` : '\nall ok', '–', dir);
process.exitCode = failed ? 1 : 0;
