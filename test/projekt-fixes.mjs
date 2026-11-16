// Verbesserungen aus dem Dienstreise-Projekt: Prozess-Eigenschaften über die Prozess-ID, Bedingungsereignis ohne Ausdruck,
// Drill-down-Ebenen zugeklappter Teilprozesse (Datei- und Live-Modus), Zielversion, bpmnlint, Ausschnitt-Screenshots,
// Export aller Ebenen, Anmerkungen in Kollaborationen, Silbentrennungs-Hinweis, kleine Stufen.
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
const expect = (label, cond) => { console.log(cond ? 'ok    ' : 'FEHLER', label); if (!cond) failed++; };
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { err: !!r.isError, text: r.content.find((c) => c.type === 'text')?.text ?? '', image: r.content.find((c) => c.type === 'image') };
};
const planes = (xml) => Object.fromEntries([...xml.matchAll(/<bpmndi:BPMNPlane id="[^"]*" bpmnElement="([^"]+)"(?:\s*\/>|>(.*?)<\/bpmndi:BPMNPlane>)/gs)].map((m) => [m[1], [...(m[2] ?? '').matchAll(/bpmnElement="([^"]+)"/g)].map((q) => q[1])]));

// ---------- strategisches Modell: Kollaboration, Prozess-Eigenschaften, zugeklappter Teilprozess mit Inhalt ----------
const f = path.join(dir, 'strategisch.bpmn');
let r = await call('create_diagram', {
  file: f, processId: 'dienstreise', platform: 'camunda7', platformVersion: '7.20.0', operations: [
    { op: 'add', type: 'participant', id: 'Pool', name: 'Hochschule', processId: 'dienstreise', executable: true, lanes: [{ id: 'L_MA', name: 'Mitarbeitende' }, { id: 'L_GEN', name: 'Genehmigende' }] },
    { op: 'update', id: 'dienstreise', properties: { historyTimeToLive: 'P30D', versionTag: '1.0' } },
    { op: 'add', type: 'startEvent', id: 'S', name: 'Dienstreise erforderlich', parent: 'L_MA', eventDefinition: { type: 'conditional' } },
    { op: 'add', type: 'task', id: 'T', name: 'Reise beantragen', after: 'S' },
    { op: 'add', type: 'subProcess', id: 'SP', name: 'Antragsgenehmigung', after: 'T', parent: 'L_GEN', expanded: false },
    { op: 'add', type: 'startEvent', id: 'SP_S', name: 'Antrag eingereicht', parent: 'SP' },
    { op: 'add', type: 'task', id: 'SP_T', name: 'Budget prüfen', after: 'SP_S' },
    { op: 'add', type: 'endEvent', id: 'SP_E', name: 'Antrag geprüft', after: 'SP_T' },
    { op: 'add', type: 'endEvent', id: 'E', name: 'Reise genehmigt', after: 'SP' },
    { op: 'add', type: 'textAnnotation', id: 'A', name: 'Kostenstellenleitung, Vorgesetzte, je nach Betrag Finanzen', attachTo: 'SP' },
  ],
});
expect('create mit update auf Prozess-ID und Conditional ohne Bedingung', !r.err);
let xml = fs.readFileSync(f, 'utf8');
expect('Prozess-Eigenschaften gesetzt', /<bpmn:process id="dienstreise"[^>]*camunda:historyTimeToLive="P30D"/.test(xml) && /camunda:versionTag="1.0"/.test(xml));
expect('Zielversion im Dateikopf', /executionPlatformVersion="7.20.0"/.test(xml));
const pl = planes(xml);
expect('Inhalt des Teilprozesses in eigener Drill-down-Ebene', ['SP_S', 'SP_T', 'SP_E'].every((id) => pl.SP?.includes(id)));
expect('…und nicht in der Hauptebene', !Object.entries(pl).some(([k, v]) => k !== 'SP' && v.includes('SP_T')));
expect('Layout meldet keine Fehler', !/FEHLER/.test(r.text));

r = await call('describe_diagram', { file: f });
expect('describe listet Ebenen-Inhalt mit plane', /"id":"SP_T"[^\n]*"plane":"SP"/.test(r.text));
r = await call('describe_diagram', { file: f, ids: ['T', 'SP'] });
expect('describe mit ids filtert', /"id":"T"/.test(r.text) && !/"id":"S"/.test(r.text));

r = await call('check_diagram', { file: f, level: 'technisch' });
expect('fehlende Bedingung am Bedingungsereignis gemeldet', /bedingung-fehlt: Bedingungsereignis/.test(r.text));
expect('Meldungen der Drill-down-Ebene markiert', /\[Ebene „Antragsgenehmigung“\]/.test(r.text));
expect('bpmnlint mit passender Engine-Version', /camunda-compat\/camunda-platform-7-20/.test(r.text));
r = await call('check_diagram', { file: f, level: 'strategisch' });
expect('kein Objekt+Verb-Hinweis für zugeklappten Teilprozess', !/Antragsgenehmigung“: Schema/.test(r.text));
expect('Silbentrennungs-Hinweis', /silbentrennung: „Antragsgenehmigung“/.test(r.text));
expect('strategisch ohne bpmnlint', !/bpmnlint/.test(r.text));

r = await call('screenshot_diagram', { file: f, plane: 'SP' });
expect('Screenshot der Drill-down-Ebene', !r.err && r.image);
const full = await call('screenshot_diagram', { file: f });
r = await call('screenshot_diagram', { file: f, ids: ['S', 'T'] });
expect('Ausschnitt kleiner als Gesamtbild', /(\d+)×(\d+)/.test(r.text) && Number(r.text.match(/(\d+)×/)[1]) < Number(full.text.match(/(\d+)×/)[1]));
r = await call('export_diagram', { file: f, format: 'svg', includePlanes: true });
expect('Export aller Ebenen', fs.existsSync(path.join(dir, 'strategisch.svg')) && fs.existsSync(path.join(dir, 'strategisch_SP.svg')));

// ---------- Anmerkung an einem Element im Pool (gehört zur Kollaboration) wird mit angeordnet ----------
r = await call('describe_diagram', { file: f, ids: ['A', 'SP'], geometry: true });
const els = JSON.parse(r.text).elements, a = els.find((e) => e.id === 'A'), sp = els.find((e) => e.id === 'SP');
expect('Anmerkung über ihrem Teilprozess', a && sp && a.y + a.height < sp.y);

// ---------- Kleine Stufen: erkennen und begradigen ----------
expect('miniSteps erkennt Stufe', miniSteps([{ x: 0, y: 100 }, { x: 50, y: 100 }, { x: 50, y: 106 }, { x: 120, y: 106 }]).length === 1);
expect('keine Stufe bei echtem Versatz', !miniSteps([{ x: 0, y: 100 }, { x: 50, y: 100 }, { x: 50, y: 160 }, { x: 120, y: 160 }]).length);
const g = { root: {}, nodes: [{ id: 'a', type: 'Task', x: 0, y: 0, width: 100, height: 80 }, { id: 'b', type: 'Task', x: 300, y: 6, width: 100, height: 80 }], edges: [{ id: 'f', type: 'SequenceFlow', source: 'a', target: 'b', waypoints: [{ x: 100, y: 40 }, { x: 200, y: 40 }, { x: 200, y: 46 }, { x: 300, y: 46 }] }] };
expect('Prüfung meldet mini-stufe', checkDiagram(g).problems.some((p) => p.rule === 'mini-stufe'));
const lay = computeLayout(g);
expect('Layout erzeugt keine Stufe', Object.values(lay.edges).every((w) => !miniSteps(w).length));

// ---------- Pool-Reihenfolge: zugeklappter Pool, der nur mit der Engine spricht, gehört neben die Engine ----------
{
  const P = (id, expanded) => ({ id, type: 'Participant', name: id, x: 0, y: 0, width: 600, height: expanded ? 200 : 60, expanded });
  const T = (id, parent) => ({ id, type: 'Task', name: `${id} prüfen`, parent, x: 0, y: 0, width: 100, height: 80 });
  const S = (id, parent, type = 'StartEvent') => ({ id, type, name: id, parent, x: 0, y: 0, width: 36, height: 36 });
  const nodes = [P('X', false), P('M', true), P('E', true), S('m0', 'M'), T('m1', 'M'), T('m2', 'M'), S('m3', 'M', 'EndEvent'), S('e0', 'E'), T('e1', 'E'), T('e2', 'E'), S('e3', 'E', 'EndEvent')];
  const sf = (id, s, t) => ({ id, type: 'SequenceFlow', source: s, target: t, waypoints: [] });
  const mf = (id, s, t) => ({ id, type: 'MessageFlow', source: s, target: t, waypoints: [] });
  const edges = [sf('a', 'm0', 'm1'), sf('b', 'm1', 'm2'), sf('c', 'm2', 'm3'), sf('d', 'e0', 'e1'), sf('e', 'e1', 'e2'), sf('f', 'e2', 'e3'), mf('g', 'm1', 'e1'), mf('h', 'e2', 'm2'), mf('i', 'e1', 'X'), mf('j', 'X', 'e2')];
  const l = computeLayout({ root: { type: 'Collaboration' }, nodes, edges });
  const ys = ['X', 'M', 'E'].map((id) => l.shapes[id].y);
  const order = ['X', 'M', 'E'].sort((p, q) => l.shapes[p].y - l.shapes[q].y).join('');
  expect(`zugeklappter Pool liegt neben seinem einzigen Partner (Reihenfolge ${order})`, Math.abs(order.indexOf('X') - order.indexOf('E')) === 1 && ys.every(Number.isFinite));
}

// ---------- Live-Modus: Drill-down-Ebene im Modeler ----------
const live = await startLive(undefined, 17994);
const lr = await live.call('live_batch', { layout: true, operations: [
  { op: 'update', id: 'StartEvent_1', name: 'Antrag gestellt' },
  { op: 'add', type: 'subProcess', id: 'LSP', name: 'Antrag prüfen', after: 'StartEvent_1', expanded: false },
  { op: 'add', type: 'startEvent', id: 'LSP_S', name: 'Prüfung begonnen', parent: 'LSP' },
  { op: 'add', type: 'userTask', id: 'LSP_T', name: 'Daten prüfen', after: 'LSP_S' },
  { op: 'add', type: 'endEvent', id: 'LSP_E', name: 'Daten geprüft', after: 'LSP_T' },
  { op: 'add', type: 'endEvent', id: 'LE', name: 'Antrag geprüft', after: 'LSP' },
] }, true);
expect('live: Teilprozess mit Inhalt angelegt', !lr.isError && /Drill-down/.test(lr.text));
const lxml = await live.xmlOut();
expect('live: Inhalt in eigener Ebene', planes(lxml).LSP?.includes('LSP_T'));
const ld = await live.call('live_describe', {}, true);
expect('live: describe zeigt Ebene', /"id":"LSP_T"[^\n]*"plane":"LSP"/.test(ld.text));
const ls = await live.client.callTool({ name: 'live_screenshot', arguments: { plane: 'LSP' } });
expect('live: Screenshot der Ebene', !ls.isError);
const root = await live.page.evaluate(() => window.modeler.get('canvas').getRootElement().id);
expect('live: Ansicht danach wieder auf der Hauptebene', !/_plane$/.test(root));
await live.stop();

await client.close();
console.log(failed ? `${failed} FEHLER – ${dir}` : `alles ok – ${dir}`);
process.exit(failed ? 1 : 0);
