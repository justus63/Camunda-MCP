// Direct test of the Camunda 7 properties via headless.js (without the MCP server).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withFile, emptyDiagram, closeHeadless } from '../headless.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmn-c7-'));
const f = path.join(dir, 'c7.bpmn');
fs.writeFileSync(f, emptyDiagram('Process_Loan', 'Loan', { platform: 'camunda7' }));
let failed = 0;
const expect = (label, cond) => { console.log(cond ? 'ok    ' : 'ERROR ', label); if (!cond) failed++; };
try {
  await withFile(f, async (exec) => {
    const ops = [
      { op: 'add', type: 'startEvent', id: 'S', name: 'Loan application received', properties: { initiator: 'starter', formFields: [{ id: 'amount', label: 'Amount', type: 'long', required: true, min: 1 }, { id: 'kind', label: 'Kind', values: { private: 'Private', business: 'Business' } }] } },
      { op: 'add', type: 'userTask', id: 'T_Check', name: 'Check application', after: 'S', properties: { candidateGroups: 'clerks', formKey: 'embedded:app:forms/check.html', dueDate: '${dateTime().plusDays(3).toDate()}', taskListeners: [{ event: 'create', delegateExpression: '${mailListener}' }] } },
      { op: 'add', type: 'businessRuleTask', id: 'T_Rule', name: 'Determine risk', after: 'T_Check', properties: { decisionRef: 'risk', resultVariable: 'risk', mapDecisionResult: 'singleEntry' } },
      { op: 'add', type: 'exclusiveGateway', id: 'G', name: 'Risk high?', after: 'T_Rule' },
      { op: 'add', type: 'serviceTask', id: 'T_Java', name: 'Book loan', after: 'G', flowName: 'no', properties: { class: 'com.example.LoanDelegate', asyncBefore: true, inputs: [{ name: 'sum', value: '${amount}' }] } },
      { op: 'add', type: 'scriptTask', id: 'T_Script', name: 'Write log', after: 'T_Java', properties: { scriptFormat: 'groovy', script: 'new File("out.txt") << amount', resultVariable: 'ok' } },
      { op: 'add', type: 'sendTask', id: 'T_Mail', name: 'Send approval', after: 'T_Script', properties: { delegateExpression: '${mailBean}' } },
      { op: 'add', type: 'endEvent', id: 'E_Ok', name: 'Loan granted', after: 'T_Mail' },
      { op: 'add', type: 'serviceTask', id: 'T_Ext', name: 'Query credit bureau', after: 'G', flowName: 'yes', properties: { topic: 'credit-check' }, loop: { type: 'parallel', collection: 'guarantors', elementVariable: 'guarantor' } },
      { op: 'add', type: 'endEvent', id: 'E_Nok', name: 'Loan rejected', after: 'T_Ext', eventDefinition: { type: 'message', name: 'rejection' }, properties: { expression: '${rejection.send(execution)}' } },
      { op: 'update', id: 'Process_Loan', properties: { historyTimeToLive: 30, candidateStarterGroups: 'customers', executionListeners: [{ event: 'start', script: 'println "start"' }] } },
    ];
    const r = await exec('batch', { operations: ops });
    const g = await exec('graph');
    const flow = (a, b) => g.edges.find((e) => e.source === a && e.target === b).id;
    await exec('update', { id: flow('G', 'T_Java'), condition: '${risk != "high"}' });
    await exec('update', { id: flow('G', 'T_Ext'), isDefault: true });
    let err = null;
    try { await exec('update', { id: 'T_Java', jobType: 'x' }); } catch (e) { err = e.message; }
    expect('jobType rejected in C7: ' + err, /only exists in Camunda 8/.test(err ?? ''));
    const g2 = await exec('graph');
    expect('platform camunda7', g2.root.platform === 'camunda7');
    expect('props in graph', g2.nodes.find((n) => n.id === 'T_Java').props?.class === 'com.example.LoanDelegate' && g2.nodes.find((n) => n.id === 'S').props?.formFields?.length === 2);
    console.log(JSON.stringify(g2.root), JSON.stringify(g2.nodes.find((n) => n.id === 'E_Nok').props));
    return r;
  }, { mutate: true });
  const xml = fs.readFileSync(f, 'utf8');
  const has = (s) => xml.includes(s);
  for (const [k, v] of Object.entries({
    header: has('modeler:executionPlatform="Camunda Platform"') && has('xmlns:camunda='),
    ttl: has('camunda:historyTimeToLive="30"') && has('camunda:candidateStarterGroups="customers"'),
    formFields: has('<camunda:formData>') && has('<camunda:formField id="amount" label="Amount" type="long">') && has('<camunda:constraint name="required"') && has('<camunda:value id="private" name="Private"'),
    initiator: has('camunda:initiator="starter"'),
    userTask: has('camunda:candidateGroups="clerks"') && has('camunda:formKey="embedded:app:forms/check.html"') && has('<camunda:taskListener delegateExpression="${mailListener}" event="create"'),
    dmn: has('camunda:decisionRef="risk"') && has('camunda:mapDecisionResult="singleEntry"') && has('camunda:resultVariable="risk"'),
    java: has('camunda:class="com.example.LoanDelegate"') && has('camunda:asyncBefore="true"') && has('<camunda:inputParameter name="sum">${amount}</camunda:inputParameter>'),
    script: has('scriptFormat="groovy"') && has('<bpmn:script>new File("out.txt") &lt;&lt; amount</bpmn:script>'),
    send: has('camunda:delegateExpression="${mailBean}"'),
    external: has('camunda:type="external"') && has('camunda:topic="credit-check"'),
    mi: has('camunda:collection="guarantors"') && has('camunda:elementVariable="guarantor"'),
    msgEnd: /<bpmn:messageEventDefinition[^>]*camunda:expression="\$\{rejection.send\(execution\)\}"/.test(xml),
    cond: has('<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${risk != "high"}</bpmn:conditionExpression>'),
    execListener: has('<camunda:executionListener event="start">') && has('<camunda:script scriptFormat="groovy">println "start"</camunda:script>'),
    noZeebe: !has('zeebe:'),
  })) expect(`file contains ${k}`, v);
  if (process.argv[2]) fs.copyFileSync(f, process.argv[2]);
  if (failed) console.log(xml);
} finally {
  await closeHeadless();
}
console.log(failed ? `\n${failed} ERRORS` : '\nall ok');
process.exitCode = failed ? 1 : 0;
