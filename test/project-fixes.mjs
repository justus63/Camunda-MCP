// Process properties via the process ID, conditional event without expression, drill-down planes of collapsed
// subprocesses (file and live mode), target version, bpmnlint, cropped screenshots, export of all planes,
// annotations in collaborations, hyphenation hint, mini steps.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT } from './render.mjs';
import { startLive } from './harness.mjs';
import { miniSteps, checkDiagram } from '../check.js';
import { computeLayout } from '../layout.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmn-fixes-'));
const client = new Client({ name: 'test', version: '1' });
await client.connect(new StdioClientTransport({ command: 'node', args: [path.join(ROOT, 'server.js')], env: { ...process.env, BPMN_MCP_PORT: '17995' } }));
let failed = 0;
const expect = (label, cond) => { console.log(cond ? 'ok    ' : 'ERROR ', label); if (!cond) failed++; };
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { err: !!r.isError, text: r.content.find((c) => c.type === 'text')?.text ?? '', image: r.content.find((c) => c.type === 'image') };
};
const planes = (xml) => Object.fromEntries([...xml.matchAll(/<bpmndi:BPMNPlane id="[^"]*" bpmnElement="([^"]+)"(?:\s*\/>|>(.*?)<\/bpmndi:BPMNPlane>)/gs)].map((m) => [m[1], [...(m[2] ?? '').matchAll(/bpmnElement="([^"]+)"/g)].map((q) => q[1])]));

// ---------- Strategic model: collaboration, process properties, collapsed subprocess with content ----------
const f = path.join(dir, 'strategic.bpmn');
let r = await call('create_diagram', {
  file: f, processId: 'business_trip', platform: 'camunda7', platformVersion: '7.20.0', operations: [
    { op: 'add', type: 'participant', id: 'Pool', name: 'University', processId: 'business_trip', executable: true, lanes: [{ id: 'L_EMP', name: 'Employees' }, { id: 'L_APP', name: 'Approvers' }] },
    { op: 'update', id: 'business_trip', properties: { historyTimeToLive: 'P30D', versionTag: '1.0' } },
    { op: 'add', type: 'startEvent', id: 'S', name: 'Business trip needed', parent: 'L_EMP', eventDefinition: { type: 'conditional' } },
    { op: 'add', type: 'task', id: 'T', name: 'Request trip', after: 'S' },
    { op: 'add', type: 'subProcess', id: 'SP', name: 'Preauthorization', after: 'T', parent: 'L_APP', expanded: false },
    { op: 'add', type: 'startEvent', id: 'SP_S', name: 'Request submitted', parent: 'SP' },
    { op: 'add', type: 'task', id: 'SP_T', name: 'Check budget', after: 'SP_S' },
    { op: 'add', type: 'endEvent', id: 'SP_E', name: 'Request checked', after: 'SP_T' },
    { op: 'add', type: 'endEvent', id: 'E', name: 'Trip approved', after: 'SP' },
    { op: 'add', type: 'textAnnotation', id: 'A', name: 'Cost center head, supervisor, finance depending on the amount', attachTo: 'SP' },
  ],
});
expect('create with update on the process ID and conditional without condition', !r.err);
let xml = fs.readFileSync(f, 'utf8');
expect('process properties set', /<bpmn:process id="business_trip"[^>]*camunda:historyTimeToLive="P30D"/.test(xml) && /camunda:versionTag="1.0"/.test(xml));
expect('target version in the file header', /executionPlatformVersion="7.20.0"/.test(xml));
const pl = planes(xml);
expect('content of the subprocess in its own drill-down plane', ['SP_S', 'SP_T', 'SP_E'].every((id) => pl.SP?.includes(id)));
expect('…and not on the main level', !Object.entries(pl).some(([k, v]) => k !== 'SP' && v.includes('SP_T')));
expect('layout reports no errors', !/ERROR/.test(r.text));

r = await call('describe_diagram', { file: f });
expect('describe lists plane content with plane', /"id":"SP_T"[^\n]*"plane":"SP"/.test(r.text));
r = await call('describe_diagram', { file: f, ids: ['T', 'SP'] });
expect('describe filters with ids', /"id":"T"/.test(r.text) && !/"id":"S"/.test(r.text));

r = await call('check_diagram', { file: f, level: 'technical' });
expect('missing condition at the conditional event reported', /condition-missing: Conditional event/.test(r.text));
expect('findings of the drill-down plane marked', /\[Plane "Preauthorization"\]/.test(r.text));
expect('bpmnlint with matching engine version', /camunda-compat\/camunda-platform-7-20/.test(r.text));
r = await call('check_diagram', { file: f, level: 'strategic' });
expect('no verb+object hint for a collapsed subprocess', !/Preauthorization": use the pattern/.test(r.text));
expect('hyphenation hint', /hyphenation: "Preauthorization"/.test(r.text));
expect('strategic without bpmnlint', !/bpmnlint/.test(r.text));

r = await call('screenshot_diagram', { file: f, plane: 'SP' });
expect('screenshot of the drill-down plane', !r.err && r.image);
const full = await call('screenshot_diagram', { file: f });
r = await call('screenshot_diagram', { file: f, ids: ['S', 'T'] });
expect('crop smaller than the full image', /(\d+)×(\d+)/.test(r.text) && Number(r.text.match(/(\d+)×/)[1]) < Number(full.text.match(/(\d+)×/)[1]));
r = await call('export_diagram', { file: f, format: 'svg', includePlanes: true });
expect('export of all planes', fs.existsSync(path.join(dir, 'strategic.svg')) && fs.existsSync(path.join(dir, 'strategic_SP.svg')));

// ---------- An annotation on an element inside a pool (belongs to the collaboration) is laid out too ----------
r = await call('describe_diagram', { file: f, ids: ['A', 'SP'], geometry: true });
const els = JSON.parse(r.text).elements, a = els.find((e) => e.id === 'A'), sp = els.find((e) => e.id === 'SP');
expect('annotation above its subprocess', a && sp && a.y + a.height < sp.y);

// ---------- Mini steps: detect and straighten ----------
expect('miniSteps detects a step', miniSteps([{ x: 0, y: 100 }, { x: 50, y: 100 }, { x: 50, y: 106 }, { x: 120, y: 106 }]).length === 1);
expect('no step for a real offset', !miniSteps([{ x: 0, y: 100 }, { x: 50, y: 100 }, { x: 50, y: 160 }, { x: 120, y: 160 }]).length);
const g = { root: {}, nodes: [{ id: 'a', type: 'Task', x: 0, y: 0, width: 100, height: 80 }, { id: 'b', type: 'Task', x: 300, y: 6, width: 100, height: 80 }], edges: [{ id: 'f', type: 'SequenceFlow', source: 'a', target: 'b', waypoints: [{ x: 100, y: 40 }, { x: 200, y: 40 }, { x: 200, y: 46 }, { x: 300, y: 46 }] }] };
expect('check reports mini-step', checkDiagram(g).problems.some((p) => p.rule === 'mini-step'));
const lay = computeLayout(g);
expect('layout creates no step', Object.values(lay.edges).every((w) => !miniSteps(w).length));

// ---------- Pool order: a collapsed pool that only talks to the engine belongs next to the engine ----------
{
  const P = (id, expanded) => ({ id, type: 'Participant', name: id, x: 0, y: 0, width: 600, height: expanded ? 200 : 60, expanded });
  const T = (id, parent) => ({ id, type: 'Task', name: `Check ${id}`, parent, x: 0, y: 0, width: 100, height: 80 });
  const S = (id, parent, type = 'StartEvent') => ({ id, type, name: id, parent, x: 0, y: 0, width: 36, height: 36 });
  const nodes = [P('X', false), P('M', true), P('E', true), S('m0', 'M'), T('m1', 'M'), T('m2', 'M'), S('m3', 'M', 'EndEvent'), S('e0', 'E'), T('e1', 'E'), T('e2', 'E'), S('e3', 'E', 'EndEvent')];
  const sf = (id, s, t) => ({ id, type: 'SequenceFlow', source: s, target: t, waypoints: [] });
  const mf = (id, s, t) => ({ id, type: 'MessageFlow', source: s, target: t, waypoints: [] });
  const edges = [sf('a', 'm0', 'm1'), sf('b', 'm1', 'm2'), sf('c', 'm2', 'm3'), sf('d', 'e0', 'e1'), sf('e', 'e1', 'e2'), sf('f', 'e2', 'e3'), mf('g', 'm1', 'e1'), mf('h', 'e2', 'm2'), mf('i', 'e1', 'X'), mf('j', 'X', 'e2')];
  const l = computeLayout({ root: { type: 'Collaboration' }, nodes, edges });
  const ys = ['X', 'M', 'E'].map((id) => l.shapes[id].y);
  const order = ['X', 'M', 'E'].sort((p, q) => l.shapes[p].y - l.shapes[q].y).join('');
  expect(`collapsed pool lies next to its only partner (order ${order})`, Math.abs(order.indexOf('X') - order.indexOf('E')) === 1 && ys.every(Number.isFinite));
}

// ---------- Live mode: drill-down plane in the Modeler ----------
const live = await startLive(undefined, 17994);
const lr = await live.call('live_batch', { layout: true, operations: [
  { op: 'update', id: 'StartEvent_1', name: 'Request submitted' },
  { op: 'add', type: 'subProcess', id: 'LSP', name: 'Check request', after: 'StartEvent_1', expanded: false },
  { op: 'add', type: 'startEvent', id: 'LSP_S', name: 'Check started', parent: 'LSP' },
  { op: 'add', type: 'userTask', id: 'LSP_T', name: 'Check data', after: 'LSP_S' },
  { op: 'add', type: 'endEvent', id: 'LSP_E', name: 'Data checked', after: 'LSP_T' },
  { op: 'add', type: 'endEvent', id: 'LE', name: 'Request checked', after: 'LSP' },
] }, true);
expect('live: subprocess with content created', !lr.isError && /drill-down/.test(lr.text));
const lxml = await live.xmlOut();
expect('live: content in its own plane', planes(lxml).LSP?.includes('LSP_T'));
const ld = await live.call('live_describe', {}, true);
expect('live: describe shows the plane', /"id":"LSP_T"[^\n]*"plane":"LSP"/.test(ld.text));
const ls = await live.client.callTool({ name: 'live_screenshot', arguments: { plane: 'LSP' } });
expect('live: screenshot of the plane', !ls.isError);
const root = await live.page.evaluate(() => window.modeler.get('canvas').getRootElement().id);
expect('live: view back on the main level afterwards', !/_plane$/.test(root));
await live.stop();

await client.close();
console.log(failed ? `${failed} ERRORS – ${dir}` : `all ok – ${dir}`);
process.exit(failed ? 1 : 0);
