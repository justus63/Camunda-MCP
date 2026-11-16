// Via the MCP server: create a Camunda 7 collaboration diagram in one call, check the levels, export,
// manual correction + reroute only the message flows. Usage: node test/c7-file.mjs [output-prefix]
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
const expect = (label, cond) => { console.log(cond ? 'ok    ' : 'ERROR ', label); if (!cond) failed++; };
const call = async (name, args = {}, expectError = false) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.find((c) => c.type === 'text')?.text ?? '';
  const bad = !!r.isError !== expectError;
  if (bad) failed++;
  console.log(bad ? 'ERROR ' : 'ok    ', name, text.length > 260 ? text.slice(0, 260) + ' …' : text);
  return { ...r, text };
};

// 1. Operational collaboration diagram (Camunda 7) in a single call
const f = path.join(dir, 'job.bpmn');
await call('create_diagram', { file: f, processId: 'Process_Engine', name: 'Job posting', platform: 'camunda7', operations: OPS });
const xml = fs.readFileSync(f, 'utf8');
expect('Camunda 7 header', xml.includes('modeler:executionPlatform="Camunda Platform"') && !xml.includes('zeebe:'));
expect('only the engine pool is executable', /<bpmn:process id="Process_Engine"[^>]*isExecutable="true"/.test(xml) && /<bpmn:process id="Process_HM"[^>]*isExecutable="false"/.test(xml));
const d = JSON.parse((await call('describe_diagram', { file: f })).text);
expect('describe is valid, compact JSON', d.root.platform === 'camunda7' && d.elements.length > 30);
expect('lane IDs as given', d.elements.some((e) => e.id === 'L_Auto' && e.type === 'Lane'));

const op = await call('check_diagram', { file: f, level: 'operational' });
expect('operational: no technical findings', !/implementation-missing|assignment-missing|condition-missing/.test(op.text));
expect('operational: missing data flow is reported', /operational-data-flow/.test(op.text));
expect('constructs are listed', /Basic constructs: 13 message flows/.test(op.text) && /3 expanded pools/.test(op.text));
const te = await call('check_diagram', { file: f, level: 'technical' });
expect('technical: missing conditions at the engine XOR', /condition-missing/.test(te.text) && /Approval granted\?/.test(te.text));
expect('technical: human pools are not checked', !/"Report vacancy" is not assigned/.test(te.text));
const st = await call('check_diagram', { file: f, level: 'strategic' });
expect('strategic: size, types, pools criticized', /strategic-size/.test(st.text) && /strategic-abstract/.test(st.text) && /strategic-pool/.test(st.text));
const alias = await call('check_diagram', { file: f, level: 'strategisch' });
expect('German level name still accepted', !alias.isError && /Level: strategic/.test(alias.text));

// 2. Deadlock detection and wrong condition syntax
const g = path.join(dir, 'deadlock.bpmn');
await call('create_diagram', { file: g, platform: 'camunda7', operations: [
  { op: 'add', type: 'startEvent', id: 'S', name: 'Request received' },
  { op: 'add', type: 'exclusiveGateway', id: 'X', name: 'Amount high?', after: 'S' },
  { op: 'add', type: 'userTask', id: 'A', name: 'Check request', after: 'X', flowName: 'yes', properties: { assignee: 'demo' } },
  { op: 'add', type: 'userTask', id: 'B', name: 'File request', after: 'X', flowName: 'no', properties: { assignee: 'demo' } },
  { op: 'add', type: 'parallelGateway', id: 'J', after: 'A' },
  { op: 'connect', source: 'B', target: 'J' },
  { op: 'add', type: 'endEvent', id: 'E', name: 'Request done', after: 'J' },
] });
const dd = JSON.parse((await call('describe_diagram', { file: g })).text);
await call('update_element', { file: g, id: dd.flows.find((x) => x.from === 'X' && x.to === 'A').id, condition: '= amount > 500' });
const dl = await call('check_diagram', { file: g });
expect('deadlock (XOR split, AND join) detected', /deadlock/.test(dl.text));
expect('FEEL condition in Camunda 7 criticized', /condition-syntax/.test(dl.text));

// 3. Export and "message flows only"
await call('export_diagram', { file: f, format: 'pdf' });
expect('PDF written', fs.readFileSync(f.replace('.bpmn', '.pdf')).subarray(0, 4).toString() === '%PDF');
await call('export_diagram', { file: f, format: 'svg', output: path.join(dir, 'x.svg') });
expect('SVG written', fs.readFileSync(path.join(dir, 'x.svg'), 'utf8').includes('<svg'));
await call('arrange', { file: f, action: 'move', id: 'HM_Fix', dx: 0, dy: 40 });
const pos = (x, id) => new RegExp(`bpmnElement="${id}"[^>]*>\\s*<dc:Bounds x="([\\d.-]+)" y="([\\d.-]+)"`).exec(x)?.slice(1).join(',');
const moved = fs.readFileSync(f, 'utf8');
await call('relayout', { file: f, only: 'messageFlows' });
const after = fs.readFileSync(f, 'utf8');
expect('only: messageFlows leaves the moved task in place', pos(moved, 'HM_Fix') === pos(after, 'HM_Fix') && pos(after, 'HM_Fix') !== pos(xml, 'HM_Fix'));
const chk = await call('check_diagram', { file: f, level: 'operational' });
expect('afterwards no line through an element', !/line-through-element/.test(chk.text));
await call('add_element', { file: f, type: 'userTask', name: 'Review documents', parent: 'HR clerk', layout: false });
await call('add_element', { file: f, type: 'task', name: 'X', parent: 'Does not exist' }, true);
await call('update_element', { file: f, id: 'PE_Post', jobType: 'x' }, true);
if (out) {
  const s = await client.callTool({ name: 'screenshot_diagram', arguments: { file: f, maxSize: 2400 } });
  fs.writeFileSync(`${out}.png`, Buffer.from(s.content[0].data, 'base64'));
  fs.copyFileSync(f, `${out}.bpmn`);
}
await client.close();
console.log(failed ? `\n${failed} ERRORS` : '\nall ok', '–', dir);
process.exitCode = failed ? 1 : 0;
