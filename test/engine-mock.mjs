// engine_* tools against a small mock of the Camunda 7 REST API (no real engine needed).
// Checks variable types, finding a task by name + business key, claim, firing timers, incident retry, error messages.
import http from 'node:http';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT } from './render.mjs';

const log = [];
const PI = 'pi-1', BK = 'TR-1';
let taskOpen = true, jobs = [{ id: 'job-1', processInstanceId: PI, dueDate: '2030-01-01T00:00:00.000+0100', retries: 3 }];
const routes = {
  'GET /version': () => ({ version: '7.20.0' }),
  'GET /engine': () => [{ name: 'default' }],
  'GET /process-definition': () => [{ key: 'request', name: 'Request', version: 3, resource: 'request.bpmn' }],
  'GET /decision-definition': () => [],
  'GET /process-instance/count': () => ({ count: 1 }),
  'GET /incident/count': () => ({ count: 1 }),
  'POST /process-definition/key/request/start': () => ({ id: PI }),
  [`GET /history/process-instance/${PI}`]: () => ({ id: PI, processDefinitionKey: 'request', processDefinitionVersion: 3, businessKey: BK, state: 'ACTIVE' }),
  'GET /history/process-instance': () => [{ id: PI, processDefinitionKey: 'request', businessKey: BK, state: 'ACTIVE' }],
  'GET /task': () => (taskOpen ? [{ id: 't-1', name: 'Check request', taskDefinitionKey: 'T_Check', processInstanceId: PI, assignee: null }] : []),
  'POST /task/t-1/claim': () => null,
  'POST /task/t-1/complete': () => { taskOpen = false; return null; },
  'GET /job': () => jobs,
  'POST /job/job-1/execute': () => { jobs = []; return null; },
  'GET /external-task': () => [],
  'GET /incident': () => [{ id: 'inc-1', incidentType: 'failedJob', activityId: 'T_Service', processInstanceId: PI, incidentMessage: 'NullPointerException', configuration: 'job-9' }],
  'GET /job/job-9/stacktrace': () => 'java.lang.NullPointerException\n\tat Foo.bar(Foo.java:1)',
  'PUT /job/job-9/retries': () => null,
  [`GET /process-instance/${PI}/activity-instances`]: () => ({ activityType: 'processDefinition', childActivityInstances: taskOpen ? [{ activityId: 'T_Check', activityName: 'Check request', activityType: 'userTask', childActivityInstances: [] }] : [] }),
  [`GET /process-instance/${PI}/variables`]: () => ({ amount: { type: 'Long', value: 500 } }),
  'GET /history/activity-instance': () => [{ activityId: 'S', activityName: 'Request submitted', activityType: 'startEvent', endTime: 'x' }],
};
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const p = req.url.replace(/^\/engine-rest/, '').split('?')[0];
    log.push({ m: req.method, p, body });
    const r = routes[`${req.method} ${p}`];
    if (!r) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ type: 'RestException', message: `not mocked: ${p}` })); }
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
const expect = (label, cond) => { console.log(cond ? 'ok    ' : 'ERROR ', label); if (!cond) failed++; };
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { err: !!r.isError, text: r.content.find((c) => c.type === 'text')?.text ?? '' };
};

let r = await call('engine_status');
expect('status shows version and process', /7\.20\.0/.test(r.text) && /"key":"request"/.test(r.text));

r = await call('engine_start_instance', { processDefinitionKey: 'request', businessKey: BK, variables: { amount: 500, urgent: true, factor: 1.5, name: 'Mara', date: { value: '2026-12-01T00:00:00.000+0100', type: 'Date' }, list: [1, 2] } });
const sent = JSON.parse(log.find((l) => l.p === '/process-definition/key/request/start').body);
expect('variable types detected automatically', sent.variables.amount.type === 'Long' && sent.variables.urgent.type === 'Boolean' && sent.variables.factor.type === 'Double' && sent.variables.name.type === 'String' && sent.variables.list.type === 'Json');
expect('explicit type is kept', sent.variables.date.type === 'Date');
expect('start shows the waiting task', /Waiting in: Check request/.test(r.text));

r = await call('engine_complete_task', { businessKey: BK, name: 'Check', user: 'henrik', variables: { ok: true } });
expect('task completed via business key + part of the name', !r.err && /Completed: "Check request" .* as henrik/.test(r.text));
expect('claimed before', log.some((l) => l.p === '/task/t-1/claim' && JSON.parse(l.body).userId === 'henrik'));

r = await call('engine_execute_jobs', { processInstanceId: PI });
expect('timer fired', /job-1 executed/.test(r.text));

r = await call('engine_incidents', { retry: true });
expect('incident with stack trace and retry', /NullPointerException/.test(r.text) && /retries set to 1/.test(r.text) && log.some((l) => l.p === '/job/job-9/retries'));

r = await call('engine_instance', { businessKey: BK });
expect('instance state with variables and history', /Variables: \{"amount":500\}/.test(r.text) && /History: Request submitted/.test(r.text));

r = await call('engine_rest', { path: '/does-not-exist' });
expect('REST error with the engine message', r.err && /HTTP 404.*not mocked/.test(r.text));

r = await call('engine_status', { engineUrl: 'http://127.0.0.1:1/engine-rest' });
expect('unreachable engine reported clearly', r.err && /not reachable/.test(r.text));

await client.close();
srv.close();
console.log(failed ? `${failed} ERRORS` : 'all ok');
process.exit(failed ? 1 : 0);
