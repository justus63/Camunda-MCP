import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bpmn-')), 'test.bpmn');
const client = new Client({ name: 'test', version: '1' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['server.js'] }));

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: { file, ...args } });
  console.log(r.isError ? 'FEHLER' : 'ok   ', name, '->', r.content[0].text.split('\n')[0]);
  if (r.isError) process.exitCode = 1;
  return r.content[0].text;
};

console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));
await call('create_diagram', { name: 'Bestellung' });
await call('add_element', { type: 'startEvent', id: 'Start', name: 'Bestellung eingegangen' });
await call('add_element', { type: 'serviceTask', id: 'Pruefen', name: 'Bestand prüfen', after: 'Start' });
await call('update_element', { id: 'Pruefen', jobType: 'check-stock' });
await call('add_element', { type: 'exclusiveGateway', id: 'GW', name: 'Verfügbar?', after: 'Pruefen' });
await call('add_element', { type: 'userTask', id: 'Versand', name: 'Versenden', after: 'GW', flowName: 'ja' });
await call('add_element', { type: 'endEvent', id: 'EndeOk', name: 'Fertig', after: 'Versand' });
await call('add_element', { type: 'endEvent', id: 'EndeNok', name: 'Abgelehnt' });
await call('connect', { source: 'GW', target: 'EndeNok', name: 'nein' });
console.log('\n' + (await call('describe_diagram', {})));

const xml = fs.readFileSync(file, 'utf8');
console.log('\nBPMNShapes:', (xml.match(/<bpmndi:BPMNShape/g) || []).length, ' BPMNEdges:', (xml.match(/<bpmndi:BPMNEdge/g) || []).length);
console.log('zeebe:taskDefinition vorhanden:', xml.includes('zeebe:taskDefinition'));
console.log('Datei:', file);
await client.close();
