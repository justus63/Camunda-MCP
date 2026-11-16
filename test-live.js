// Live test: expects a running Camunda Modeler with the plugin installed and example.bpmn (or a copy) open.
// Usage: node test-live.js <path-to-the-open-file.bpmn>
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const file = process.argv[2];
const client = new Client({ name: 'test-live', version: '1' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['server.js'] }));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  console.log(r.isError ? 'ERROR' : 'ok   ', name, JSON.stringify(args), '->', text.split('\n').join(' ').slice(0, 160));
  if (r.isError) process.exitCode = 1;
  return text;
};

let connected = false;
for (let i = 0; i < 30 && !connected; i++) {
  const r = await client.callTool({ name: 'live_status', arguments: {} });
  connected = !r.isError;
  if (!connected) await new Promise((res) => setTimeout(res, 1000));
  else console.log('Status:', r.content[0].text.replace(/\s+/g, ' '));
}
if (!connected) {
  console.log('Modeler not connected.');
  process.exit(2);
}

await call('live_describe');
await call('live_add_element', { type: 'userTask', id: 'Invoice', name: 'Write invoice', after: 'Ship' });
await call('live_add_element', { type: 'endEvent', id: 'LiveEnd', name: 'Live end', after: 'Invoice' });
await call('live_update_element', { id: 'Invoice', name: 'Create invoice' });
await call('live_update_element', { id: 'Check', jobType: 'check-stock-v2' });
await call('live_connect', { source: 'GW', target: 'LiveEnd', name: 'Special case', condition: '= amount > 100' });
await call('live_add_element', { type: 'task', id: 'Gone', name: 'Will be deleted' });
await call('live_remove_element', { id: 'Gone' });
await call('live_update_element', { id: 'Check', condition: 'x' }); // must return an ERROR
process.exitCode = 0;
await call('live_save');

if (file) {
  const xml = fs.readFileSync(file, 'utf8');
  const checks = {
    'Create invoice': xml.includes('Create invoice'),
    LiveEnd: xml.includes('id="LiveEnd"'),
    'jobType check-stock-v2': xml.includes('check-stock-v2'),
    condition: xml.includes('amount &gt; 100') || xml.includes('amount > 100'),
    'deleted task gone': !xml.includes('id="Gone"'),
    'shapes for new elements': xml.includes('bpmnElement="Invoice"'),
  };
  console.log(checks);
  process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
}
await client.close();
