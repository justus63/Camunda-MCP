// Direkter Test der Camunda-7-Eigenschaften über headless.js (ohne MCP-Server).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withFile, emptyDiagram, closeHeadless } from '../headless.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmn-c7-'));
const f = path.join(dir, 'c7.bpmn');
fs.writeFileSync(f, emptyDiagram('Process_Kredit', 'Kredit', { platform: 'camunda7' }));
let failed = 0;
const expect = (label, cond) => { console.log(cond ? 'ok    ' : 'FEHLER', label); if (!cond) failed++; };
try {
  await withFile(f, async (exec) => {
    const ops = [
      { op: 'add', type: 'startEvent', id: 'S', name: 'Kreditantrag eingegangen', properties: { initiator: 'starter', formFields: [{ id: 'betrag', label: 'Betrag', type: 'long', required: true, min: 1 }, { id: 'art', label: 'Art', values: { privat: 'Privat', firma: 'Firma' } }] } },
      { op: 'add', type: 'userTask', id: 'T_Pruefen', name: 'Antrag prüfen', after: 'S', properties: { candidateGroups: 'sachbearbeitung', formKey: 'embedded:app:forms/pruefen.html', dueDate: '${dateTime().plusDays(3).toDate()}', taskListeners: [{ event: 'create', delegateExpression: '${mailListener}' }] } },
      { op: 'add', type: 'businessRuleTask', id: 'T_Regel', name: 'Risiko ermitteln', after: 'T_Pruefen', properties: { decisionRef: 'risiko', resultVariable: 'risiko', mapDecisionResult: 'singleEntry' } },
      { op: 'add', type: 'exclusiveGateway', id: 'G', name: 'Risiko hoch?', after: 'T_Regel' },
      { op: 'add', type: 'serviceTask', id: 'T_Java', name: 'Kredit buchen', after: 'G', flowName: 'nein', properties: { class: 'de.fh.KreditDelegate', asyncBefore: true, inputs: [{ name: 'summe', value: '${betrag}' }] } },
      { op: 'add', type: 'scriptTask', id: 'T_Script', name: 'Protokoll schreiben', after: 'T_Java', properties: { scriptFormat: 'groovy', script: 'new File("out.txt") << betrag', resultVariable: 'ok' } },
      { op: 'add', type: 'sendTask', id: 'T_Mail', name: 'Zusage senden', after: 'T_Script', properties: { delegateExpression: '${mailBean}' } },
      { op: 'add', type: 'endEvent', id: 'E_Ok', name: 'Kredit gewährt', after: 'T_Mail' },
      { op: 'add', type: 'serviceTask', id: 'T_Ext', name: 'Schufa abfragen', after: 'G', flowName: 'ja', properties: { topic: 'schufa' }, loop: { type: 'parallel', collection: 'buergen', elementVariable: 'buerge' } },
      { op: 'add', type: 'endEvent', id: 'E_Nok', name: 'Kredit abgelehnt', after: 'T_Ext', eventDefinition: { type: 'message', name: 'absage' }, properties: { expression: '${absage.senden(execution)}' } },
      { op: 'update', id: 'Process_Kredit', properties: { historyTimeToLive: 30, candidateStarterGroups: 'kunden', executionListeners: [{ event: 'start', script: 'println "start"' }] } },
    ];
    const r = await exec('batch', { operations: ops });
    const g = await exec('graph');
    const flow = (a, b) => g.edges.find((e) => e.source === a && e.target === b).id;
    await exec('update', { id: flow('G', 'T_Java'), condition: '${risiko != "hoch"}' });
    await exec('update', { id: flow('G', 'T_Ext'), isDefault: true });
    let err = null;
    try { await exec('update', { id: 'T_Java', jobType: 'x' }); } catch (e) { err = e.message; }
    expect('jobType in C7 abgelehnt: ' + err, /nur in Camunda 8/.test(err ?? ''));
    const g2 = await exec('graph');
    expect('Plattform camunda7', g2.root.platform === 'camunda7');
    expect('props in graph', g2.nodes.find((n) => n.id === 'T_Java').props?.class === 'de.fh.KreditDelegate' && g2.nodes.find((n) => n.id === 'S').props?.formFields?.length === 2);
    console.log(JSON.stringify(g2.root), JSON.stringify(g2.nodes.find((n) => n.id === 'E_Nok').props));
    return r;
  }, { mutate: true });
  const xml = fs.readFileSync(f, 'utf8');
  const has = (s) => xml.includes(s);
  for (const [k, v] of Object.entries({
    kopf: has('modeler:executionPlatform="Camunda Platform"') && has('xmlns:camunda='),
    ttl: has('camunda:historyTimeToLive="30"') && has('camunda:candidateStarterGroups="kunden"'),
    formFields: has('<camunda:formData>') && has('<camunda:formField id="betrag" label="Betrag" type="long">') && has('<camunda:constraint name="required"') && has('<camunda:value id="privat" name="Privat"'),
    initiator: has('camunda:initiator="starter"'),
    userTask: has('camunda:candidateGroups="sachbearbeitung"') && has('camunda:formKey="embedded:app:forms/pruefen.html"') && has('<camunda:taskListener delegateExpression="${mailListener}" event="create"'),
    dmn: has('camunda:decisionRef="risiko"') && has('camunda:mapDecisionResult="singleEntry"') && has('camunda:resultVariable="risiko"'),
    java: has('camunda:class="de.fh.KreditDelegate"') && has('camunda:asyncBefore="true"') && has('<camunda:inputParameter name="summe">${betrag}</camunda:inputParameter>'),
    script: has('scriptFormat="groovy"') && has('<bpmn:script>new File("out.txt") &lt;&lt; betrag</bpmn:script>'),
    send: has('camunda:delegateExpression="${mailBean}"'),
    external: has('camunda:type="external"') && has('camunda:topic="schufa"'),
    mi: has('camunda:collection="buergen"') && has('camunda:elementVariable="buerge"'),
    msgEnd: /<bpmn:messageEventDefinition[^>]*camunda:expression="\$\{absage.senden\(execution\)\}"/.test(xml),
    cond: has('<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${risiko != "hoch"}</bpmn:conditionExpression>'),
    execListener: has('<camunda:executionListener event="start">') && has('<camunda:script scriptFormat="groovy">println "start"</camunda:script>'),
    keinZeebe: !has('zeebe:'),
  })) expect(`Datei enthält ${k}`, v);
  if (process.argv[2]) fs.copyFileSync(f, process.argv[2]);
  if (failed) console.log(xml);
} finally {
  await closeHeadless();
}
console.log(failed ? `\n${failed} FEHLER` : '\nalles ok');
process.exitCode = failed ? 1 : 0;
