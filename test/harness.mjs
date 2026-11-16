// Starts the MCP server (own port) + headless Chrome with a real bpmn-js modeler and the plugin.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT, launch } from './render.mjs';

export const EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="true"><bpmn:startEvent id="StartEvent_1" /></bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1"><bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
    <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1"><dc:Bounds x="182" y="102" width="36" height="36" /></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;

export async function startLive(xml = EMPTY, port = 17999) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({ command: 'node', args: [path.join(ROOT, 'server.js')], env: { ...process.env, BPMN_MCP_PORT: String(port) } }));
  const browser = await launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.setViewport({ width: 1600, height: 900 });
  const html = path.join(ROOT, 'test', '.modeler.html');
  fs.writeFileSync(html, `<!doctype html><link rel="stylesheet" href="../node_modules/bpmn-js/dist/assets/diagram-js.css"><link rel="stylesheet" href="../node_modules/bpmn-js/dist/assets/bpmn-js.css">
<body style="margin:0"><div id="c" style="width:1600px;height:900px"></div>
<script>window.__BPMN_MCP_PORT=${port}</script>
<script src="../node_modules/bpmn-js/dist/bpmn-modeler.development.js"></script><script src="../plugin/client.js"></script>`);
  await page.goto(pathToFileURL(html).href);
  const zeebe = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/zeebe-bpmn-moddle/resources/zeebe.json'), 'utf8'));
  await page.evaluate(async (xml, zeebe) => {
    const mods = window.plugins.filter((p) => p.type === 'bpmn.modeler.additionalModules').map((p) => p.plugin);
    window.modeler = new BpmnJS({ container: '#c', additionalModules: mods, moddleExtensions: { zeebe } });
    await window.modeler.importXML(xml);
    window.plugins.find((p) => p.type === 'client').plugin({
      triggerAction: async () => { window.__saved = (await window.modeler.saveXML({ format: true })).xml; },
      subscribe: (ev, cb) => cb({ activeTab: { name: 'test.bpmn', type: 'cloud-bpmn', file: { path: null } } }),
    });
  }, xml, zeebe);
  const call = async (name, args = {}, quiet) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.find((c) => c.type === 'text')?.text ?? '';
    if (!quiet || r.isError) console.log(r.isError ? 'ERROR ' : 'ok    ', name, text.length > 400 ? text.slice(0, 400) + ' …' : text);
    return { ...r, text };
  };
  for (let i = 0; i < 40; i++) { if (!(await client.callTool({ name: 'live_status', arguments: {} })).isError) break; await new Promise((r) => setTimeout(r, 250)); }
  const shot = async (file) => { const r = await client.callTool({ name: 'live_screenshot', arguments: {} }); fs.writeFileSync(file, Buffer.from(r.content[0].data, 'base64')); };
  const xmlOut = () => page.evaluate(async () => (await window.modeler.saveXML({ format: true })).xml);
  const stop = async () => { await client.close(); await browser.close(); };
  return { client, page, call, shot, xmlOut, stop };
}
