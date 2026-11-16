// Collaboration diagram with three expanded pools (example "job posting") directly via headless.js:
// checks the pool alignment along the message flows and the message flow routing.
// Usage: node test/collab-direct.mjs [output-prefix]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withFile, emptyDiagram, closeHeadless } from '../headless.js';
import { computeLayout } from '../layout.js';
import { checkDiagram, formatCheck } from '../check.js';

const out = process.argv[2];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmn-collab-'));
const f = path.join(dir, 'job.bpmn');
fs.writeFileSync(f, emptyDiagram('Process_Engine', 'Job posting', { platform: 'camunda7' }));
export const OPS = [
  // Order deliberately "wrong": the process engine belongs between the two human pools
  { op: 'add', type: 'participant', id: 'P_HM', name: 'Hiring manager', processId: 'Process_HM', executable: false },
  { op: 'add', type: 'participant', id: 'P_HR', name: 'HR clerk', processId: 'Process_HR', executable: false },
  { op: 'add', type: 'participant', id: 'P_PE', name: 'Process Engine', lanes: [{ id: 'L_Dept', name: 'Department' }, { id: 'L_Auto', name: 'automated' }, { id: 'L_HR', name: 'HR department' }], processId: 'Process_Engine', executable: true },
  { op: 'add', type: 'participant', id: 'P_Portal', name: 'Job portal', expanded: false },
  // Hiring manager
  { op: 'add', type: 'startEvent', id: 'HM_S', name: 'Staffing need identified', parent: 'P_HM' },
  { op: 'add', type: 'userTask', id: 'HM_Report', name: 'Report vacancy', after: 'HM_S' },
  { op: 'add', type: 'intermediateCatchEvent', id: 'HM_Draft', name: 'Draft received', after: 'HM_Report', eventDefinition: { type: 'message', name: 'draft' } },
  { op: 'add', type: 'userTask', id: 'HM_Check', name: 'Check job description', after: 'HM_Draft' },
  { op: 'add', type: 'exclusiveGateway', id: 'HM_G', name: 'Description okay?', after: 'HM_Check' },
  { op: 'add', type: 'userTask', id: 'HM_Approve', name: 'Approve job description', after: 'HM_G', flowName: 'yes' },
  { op: 'add', type: 'userTask', id: 'HM_Fix', name: 'Request correction', after: 'HM_G', flowName: 'no' },
  { op: 'connect', source: 'HM_Fix', target: 'HM_Draft' },
  { op: 'add', type: 'intermediateCatchEvent', id: 'HM_Done', name: 'Job posted', after: 'HM_Approve', eventDefinition: { type: 'message', name: 'success' } },
  { op: 'add', type: 'endEvent', id: 'HM_E', name: 'Vacancy advertised', after: 'HM_Done' },
  // Process engine
  { op: 'add', type: 'startEvent', id: 'PE_S', name: 'Vacancy reported', parent: 'L_Auto', eventDefinition: { type: 'message', name: 'vacancy_reported' } },
  { op: 'add', type: 'userTask', id: 'PE_Describe', name: 'Describe position', after: 'PE_S', parent: 'L_HR', properties: { candidateGroups: 'hr' } },
  { op: 'add', type: 'userTask', id: 'PE_Check', name: 'Check job description', after: 'PE_Describe', parent: 'L_Dept', properties: { candidateGroups: 'department' } },
  { op: 'add', type: 'boundaryEvent', id: 'PE_Timer', name: '3 days passed', attachTo: 'PE_Check', interrupting: false, eventDefinition: { type: 'timer', value: 'P3D' } },
  { op: 'add', type: 'sendTask', id: 'PE_Remind', name: 'Send reminder', after: 'PE_Timer', parent: 'L_Auto', properties: { delegateExpression: '${mail}' } },
  { op: 'add', type: 'endEvent', id: 'PE_E2', name: 'Reminder sent', after: 'PE_Remind' },
  { op: 'add', type: 'exclusiveGateway', id: 'PE_G', name: 'Approval granted?', after: 'PE_Check' },
  { op: 'add', type: 'userTask', id: 'PE_Fix', name: 'Correct job description', after: 'PE_G', flowName: 'no', parent: 'L_HR', properties: { candidateGroups: 'hr' } },
  { op: 'connect', source: 'PE_Fix', target: 'PE_Check' },
  { op: 'add', type: 'userTask', id: 'PE_Trigger', name: 'Trigger job posting', after: 'PE_G', flowName: 'yes', parent: 'L_HR', properties: { candidateGroups: 'hr' } },
  { op: 'add', type: 'serviceTask', id: 'PE_Post', name: 'Post job ad', after: 'PE_Trigger', parent: 'L_Auto', properties: { class: 'com.example.JobPosting' } },
  { op: 'add', type: 'sendTask', id: 'PE_Success', name: 'Send success note', after: 'PE_Post', properties: { delegateExpression: '${mail}' } },
  { op: 'add', type: 'endEvent', id: 'PE_E', name: 'Vacancy advertised', after: 'PE_Success' },
  // HR clerk
  { op: 'add', type: 'startEvent', id: 'HR_S', name: 'Task received', parent: 'P_HR', eventDefinition: { type: 'message', name: 'task' } },
  { op: 'add', type: 'userTask', id: 'HR_Describe', name: 'Describe position', after: 'HR_S' },
  { op: 'add', type: 'eventBasedGateway', id: 'HR_EG', after: 'HR_Describe' },
  { op: 'add', type: 'intermediateCatchEvent', id: 'HR_Fix_E', name: 'Correction requested', after: 'HR_EG', eventDefinition: { type: 'message', name: 'correction' } },
  { op: 'add', type: 'userTask', id: 'HR_Fix', name: 'Revise job description', after: 'HR_Fix_E' },
  { op: 'connect', source: 'HR_Fix', target: 'HR_EG' },
  { op: 'add', type: 'intermediateCatchEvent', id: 'HR_Ok_E', name: 'Description approved', after: 'HR_EG', eventDefinition: { type: 'message', name: 'approval' } },
  { op: 'add', type: 'userTask', id: 'HR_Trigger', name: 'Trigger job posting', after: 'HR_Ok_E' },
  { op: 'add', type: 'endEvent', id: 'HR_E', name: 'Job posting triggered', after: 'HR_Trigger' },
  // Message flows
  { op: 'connect', source: 'HM_Report', target: 'PE_S', name: 'Vacancy report' },
  { op: 'connect', source: 'PE_Describe', target: 'HR_S' },
  { op: 'connect', source: 'HR_Describe', target: 'PE_Describe', name: 'Draft' },
  { op: 'connect', source: 'PE_Check', target: 'HM_Draft' },
  { op: 'connect', source: 'HM_Approve', target: 'PE_Check' },
  { op: 'connect', source: 'HM_Fix', target: 'PE_Check' },
  { op: 'connect', source: 'PE_Fix', target: 'HR_Fix_E' },
  { op: 'connect', source: 'HR_Fix', target: 'PE_Fix' },
  { op: 'connect', source: 'PE_Trigger', target: 'HR_Ok_E' },
  { op: 'connect', source: 'HR_Trigger', target: 'PE_Trigger' },
  { op: 'connect', source: 'PE_Success', target: 'HM_Done', name: 'Success note' },
  { op: 'connect', source: 'PE_Post', target: 'P_Portal', name: 'Job ad' },
  { op: 'connect', source: 'PE_Remind', target: 'P_HM' },
];
if (import.meta.url === `file://${process.argv[1]}`) {
  let failed = 0;
  const expect = (label, cond) => { console.log(cond ? 'ok    ' : 'ERROR ', label); if (!cond) failed++; };
  try {
    for (const [tag, opts] of [['aligned', {}], ['unaligned', { align: false, poolOrder: ['P_HM', 'P_HR', 'P_PE', 'P_Portal'] }]]) {
      fs.writeFileSync(f, emptyDiagram('Process_Engine', 'Job posting', { platform: 'camunda7' }));
      const png = await withFile(f, async (exec) => {
        await exec('batch', { operations: OPS });
        await exec('applyLayout', computeLayout(await exec('graph'), opts));
        const g = await exec('graph');
        const res = checkDiagram(g);
        const lay = res.problems.filter((p) => /line|overlap|crossing|label|diagonal/.test(p.rule));
        console.log(`--- ${tag}: ${formatCheck({ ...res, problems: lay })}`);
        const msg = g.edges.filter((e) => e.type === 'MessageFlow');
        const straight = msg.filter((e) => e.waypoints.length === 2 && e.waypoints[0].x === e.waypoints[1].x).length;
        const len = msg.reduce((s, e) => s + e.waypoints.slice(1).reduce((t, p, i) => t + Math.abs(p.x - e.waypoints[i].x) + Math.abs(p.y - e.waypoints[i].y), 0), 0);
        console.log(`${tag}: ${straight}/${msg.length} message flows vertical, total length ${Math.round(len)} px, crossings ${res.crossings}`);
        if (tag === 'aligned') {
          const y = (id) => g.nodes.find((n) => n.id === id).y;
          expect('process engine lies between the human pools', (y('P_HM') < y('P_PE') && y('P_PE') < y('P_HR')) || (y('P_HR') < y('P_PE') && y('P_PE') < y('P_HM')));
          expect('at least four message flows vertical', straight >= 4);
          expect('message flows shorter than 7500 px in total', len < 7500);
          expect('yes/no labels do not overlap', !lay.some((p) => p.rule === 'labels-overlap'));
          expect('no line through an element', !lay.some((p) => p.rule === 'line-through-element'));
        }
        return (await exec('screenshot', { maxSize: 2400 })).png;
      }, { mutate: true });
      if (out) { fs.writeFileSync(`${out}-${tag}.png`, Buffer.from(png, 'base64')); fs.copyFileSync(f, `${out}-${tag}.bpmn`); }
    }
  } finally {
    await closeHeadless();
  }
  console.log(failed ? `\n${failed} ERRORS` : '\nall ok');
  process.exitCode = failed ? 1 : 0;
}
