// engine_*-Tools gegen eine kleine Nachbildung der Camunda-7-REST-API (keine echte Engine nötig).
// Prüft Variablen-Typen, Aufgabe per Name + Business Key finden, claim, Timer auslösen, Incident-Retry, Fehlermeldungen.
import http from 'node:http';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT } from './render.mjs';

const log = [];
const PI = 'pi-1', BK = 'DR-1';
let taskOpen = true, jobs = [{ id: 'job-1', processInstanceId: PI, dueDate: '2030-01-01T00:00:00.000+0100', retries: 3 }];
const routes = {
  'GET /version': () => ({ version: '7.20.0' }),
  'GET /engine': () => [{ name: 'default' }],
  'GET /process-definition': () => [{ key: 'antrag', name: 'Antrag', version: 3, resource: 'antrag.bpmn' }],
  'GET /decision-definition': () => [],
  'GET /process-instance/count': () => ({ count: 1 }),
  'GET /incident/count': () => ({ count: 1 }),
  'POST /process-definition/key/antrag/start': () => ({ id: PI }),
  [`GET /history/process-instance/${PI}`]: () => ({ id: PI, processDefinitionKey: 'antrag', processDefinitionVersion: 3, businessKey: BK, state: 'ACTIVE' }),
  'GET /history/process-instance': () => [{ id: PI, processDefinitionKey: 'antrag', businessKey: BK, state: 'ACTIVE' }],
  'GET /task': () => (taskOpen ? [{ id: 't-1', name: 'Antrag prüfen', taskDefinitionKey: 'T_Pruefen', processInstanceId: PI, assignee: null }] : []),
  'POST /task/t-1/claim': () => null,
  'POST /task/t-1/complete': () => { taskOpen = false; return null; },
  'GET /job': () => jobs,
  'POST /job/job-1/execute': () => { jobs = []; return null; },
  'GET /external-task': () => [],
  'GET /incident': () => [{ id: 'inc-1', incidentType: 'failedJob', activityId: 'T_Service', processInstanceId: PI, incidentMessage: 'NullPointerException', configuration: 'job-9' }],
  'GET /job/job-9/stacktrace': () => 'java.lang.NullPointerException\n\tat Foo.bar(Foo.java:1)',
  'PUT /job/job-9/retries': () => null,
  [`GET /process-instance/${PI}/activity-instances`]: () => ({ activityType: 'processDefinition', childActivityInstances: taskOpen ? [{ activityId: 'T_Pruefen', activityName: 'Antrag prüfen', activityType: 'userTask', childActivityInstances: [] }] : [] }),
  [`GET /process-instance/${PI}/variables`]: () => ({ betrag: { type: 'Long', value: 500 } }),
  'GET /history/activity-instance': () => [{ activityId: 'S', activityName: 'Antrag gestellt', activityType: 'startEvent', endTime: 'x' }],
};
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const p = req.url.replace(/^\/engine-rest/, '').split('?')[0];
    log.push({ m: req.method, p, body });
    const r = routes[`${req.method} ${p}`];
    if (!r) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ type: 'RestException', message: `nicht nachgebildet: ${p}` })); }
    const out = r(body);
    res.writeHead(out === null ? 204 : 200, { 'Content-Type': typeof out === 'string' ? 'text/plain' : 'application/json' });
    res.end(out === null ? '' : typeof out === 'string' ? out : JSON.stringify(out));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const URL = `http://127.0.0.1:${srv.address().port}/engine-rest`;

const client = new Client({ name: 'test', version: '1' });
await client.connect(new StdioClientTransport({ command: 'node', args: [path.join(ROOT, 'server.js')], env: { ...process.env, BPMN_MCP_PORT: '17996', CAMUNDA_URL: URL } }));
let failed = 0;
const expect = (label, cond) => { console.log(cond ? 'ok    ' : 'FEHLER', label); if (!cond) failed++; };
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { err: !!r.isError, text: r.content.find((c) => c.type === 'text')?.text ?? '' };
};

let r = await call('engine_status');
expect('Status nennt Version und Prozess', /7\.20\.0/.test(r.text) && /"key":"antrag"/.test(r.text));

r = await call('engine_start_instance', { processDefinitionKey: 'antrag', businessKey: BK, variables: { betrag: 500, eilig: true, faktor: 1.5, name: 'Mara', datum: { value: '2026-12-01T00:00:00.000+0100', type: 'Date' }, liste: [1, 2] } });
const sent = JSON.parse(log.find((l) => l.p === '/process-definition/key/antrag/start').body);
expect('Variablentypen automatisch', sent.variables.betrag.type === 'Long' && sent.variables.eilig.type === 'Boolean' && sent.variables.faktor.type === 'Double' && sent.variables.name.type === 'String' && sent.variables.liste.type === 'Json');
expect('expliziter Typ bleibt', sent.variables.datum.type === 'Date');
expect('Start zeigt wartende Aufgabe', /Wartet in: Antrag prüfen/.test(r.text));

r = await call('engine_complete_task', { businessKey: BK, name: 'prüfen', user: 'henrik', variables: { ok: true } });
expect('Aufgabe per Business Key + Namensteil erledigt', !r.err && /Erledigt: „Antrag prüfen“ .* als henrik/.test(r.text));
expect('vorher geclaimt', log.some((l) => l.p === '/task/t-1/claim' && JSON.parse(l.body).userId === 'henrik'));

r = await call('engine_execute_jobs', { processInstanceId: PI });
expect('Timer ausgelöst', /job-1 ausgeführt/.test(r.text));

r = await call('engine_incidents', { retry: true });
expect('Incident mit Stacktrace und Retry', /NullPointerException/.test(r.text) && /Retries auf 1/.test(r.text) && log.some((l) => l.p === '/job/job-9/retries'));

r = await call('engine_instance', { businessKey: BK });
expect('Instanzzustand mit Variablen und Verlauf', /Variablen: \{"betrag":500\}/.test(r.text) && /Verlauf: Antrag gestellt/.test(r.text));

r = await call('engine_rest', { path: '/gibt-es-nicht' });
expect('REST-Fehler mit Meldung der Engine', r.err && /HTTP 404.*nicht nachgebildet/.test(r.text));

r = await call('engine_status', { engineUrl: 'http://127.0.0.1:1/engine-rest' });
expect('nicht erreichbare Engine verständlich gemeldet', r.err && /nicht erreichbar/.test(r.text));

await client.close();
srv.close();
console.log(failed ? `${failed} FEHLER` : 'alles ok');
process.exit(failed ? 1 : 0);
