// Live-Test: erwartet einen laufenden Camunda Modeler mit installiertem Plugin und geöffneter .bpmn-Datei.
// Aufruf: node test-live.js <pfad-zur-geöffneten-datei.bpmn>
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const file = process.argv[2];
const client = new Client({ name: 'test-live', version: '1' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['server.js'] }));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  console.log(r.isError ? 'FEHLER' : 'ok   ', name, JSON.stringify(args), '->', text.split('\n').join(' ').slice(0, 160));
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
  console.log('Modeler nicht verbunden.');
  process.exit(2);
}

await call('live_describe');
await call('live_add_element', { type: 'userTask', id: 'Rechnung', name: 'Rechnung schreiben', after: 'Versand' });
await call('live_add_element', { type: 'endEvent', id: 'LiveEnde', name: 'Live-Ende', after: 'Rechnung' });
await call('live_update_element', { id: 'Rechnung', name: 'Rechnung erstellen' });
await call('live_update_element', { id: 'Pruefen', jobType: 'check-stock-v2' });
await call('live_connect', { source: 'GW', target: 'LiveEnde', name: 'Sonderfall', condition: '= amount > 100' });
await call('live_add_element', { type: 'task', id: 'Weg', name: 'Wird gelöscht' });
await call('live_remove_element', { id: 'Weg' });
await call('live_update_element', { id: 'Pruefen', condition: 'x' }); // soll FEHLER liefern
process.exitCode = 0;
await call('live_save');

if (file) {
  const xml = fs.readFileSync(file, 'utf8');
  const checks = {
    'Rechnung erstellen': xml.includes('Rechnung erstellen'),
    'LiveEnde': xml.includes('id="LiveEnde"'),
    'jobType check-stock-v2': xml.includes('check-stock-v2'),
    'Bedingung': xml.includes('amount &gt; 100') || xml.includes('amount > 100'),
    'gelöschter Task weg': !xml.includes('id="Weg"'),
    'Shapes für neue Elemente': xml.includes('bpmnElement="Rechnung"'),
  };
  console.log(checks);
  process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
}
await client.close();
