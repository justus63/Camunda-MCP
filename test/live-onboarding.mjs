// Converts an onboarding diagram (state before the improvements) with the live tools and lays it out.
import fs from 'node:fs';
import { startLive } from './harness.mjs';
const [inp, out] = process.argv.slice(2);
const t = await startLive(fs.readFileSync(inp, 'utf8'));
const pre = await t.call('live_update_element', { id: 'GW_NextEvent', type: 'eventBasedGateway' }); // must be rejected
console.log('Protection works:', pre.isError === true, '| flows still there:', JSON.parse((await t.call('live_describe', {}, true)).text).flows.length);
const timer = (id, timerType, value) => ({ op: 'update', id, eventDefinition: { type: 'timer', timerType, value } });
await t.call('live_batch', { layout: true, operations: [
  timer('Event_FirstDay', 'date', '= firstWorkingDay'),
  timer('Event_Week1', 'date', '= date and time(firstWorkingDay) + duration("P7D")'),
  timer('Event_Month1', 'date', '= date and time(firstWorkingDay) + duration("P30D")'),
  timer('Event_MonthPassed', 'duration', 'P30D'),
  timer('Event_Probation', 'date', '= onboardingEnd'),
  { op: 'update', id: 'Event_Project', eventDefinition: { type: 'message', name: 'project_assigned', correlationKey: '= employeeId' } },
  { op: 'update', id: 'GW_NextEvent', type: 'eventBasedGateway' },
  { op: 'update', id: 'Task_IT', jobType: 'it-provisioning' },
] });
await t.call('live_check');
await t.shot(out + '.png');
fs.writeFileSync(out + '.bpmn', await t.xmlOut());
await t.stop();
