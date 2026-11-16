// Kollaborationsdiagramm mit drei ausmodellierten Pools (Beispiel "Stellenausschreibung" aus der Vorlesung) direkt über headless.js:
// prüft Pool-Ausrichtung entlang der Nachrichtenflüsse und das Nachrichtenfluss-Routing.
// Aufruf: node test/collab-direct.mjs [ausgabe-präfix]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withFile, emptyDiagram, closeHeadless } from '../headless.js';
import { computeLayout } from '../layout.js';
import { checkDiagram, formatCheck } from '../check.js';

const out = process.argv[2];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmn-collab-'));
const f = path.join(dir, 'stelle.bpmn');
fs.writeFileSync(f, emptyDiagram('Process_Engine', 'Stellenausschreibung', { platform: 'camunda7' }));
const msgEnd = { type: 'message' };
export const OPS = [
  // Reihenfolge absichtlich "falsch": die Process Engine gehört zwischen die beiden menschlichen Pools
  { op: 'add', type: 'participant', id: 'P_FK', name: 'Führungskraft Fachbereich', processId: 'Process_FK', executable: false },
  { op: 'add', type: 'participant', id: 'P_SB', name: 'Sachbearbeiter Personal', processId: 'Process_SB', executable: false },
  { op: 'add', type: 'participant', id: 'P_PE', name: 'Process Engine', lanes: [{ id: 'L_FB', name: 'Fachbereich' }, { id: 'L_Auto', name: 'automatisch' }, { id: 'L_PA', name: 'Personalabteilung' }], processId: 'Process_Engine', executable: true },
  { op: 'add', type: 'participant', id: 'P_Portal', name: 'Jobportal', expanded: false },
  // Führungskraft
  { op: 'add', type: 'startEvent', id: 'FK_S', name: 'Personalbedarf erkannt', parent: 'P_FK' },
  { op: 'add', type: 'userTask', id: 'FK_Melden', name: 'Freie Stelle melden', after: 'FK_S' },
  { op: 'add', type: 'intermediateCatchEvent', id: 'FK_Entwurf', name: 'Entwurf erhalten', after: 'FK_Melden', eventDefinition: { type: 'message', name: 'entwurf' } },
  { op: 'add', type: 'userTask', id: 'FK_Pruefen', name: 'Stellenbeschreibung prüfen', after: 'FK_Entwurf' },
  { op: 'add', type: 'exclusiveGateway', id: 'FK_G', name: 'Beschreibung in Ordnung?', after: 'FK_Pruefen' },
  { op: 'add', type: 'userTask', id: 'FK_Frei', name: 'Stellenbeschreibung freigeben', after: 'FK_G', flowName: 'ja' },
  { op: 'add', type: 'userTask', id: 'FK_Korr', name: 'Korrektur anfordern', after: 'FK_G', flowName: 'nein' },
  { op: 'connect', source: 'FK_Korr', target: 'FK_Entwurf' },
  { op: 'add', type: 'intermediateCatchEvent', id: 'FK_Erfolg', name: 'Ausschreibung erfolgt', after: 'FK_Frei', eventDefinition: { type: 'message', name: 'erfolg' } },
  { op: 'add', type: 'endEvent', id: 'FK_E', name: 'Stelle ausgeschrieben', after: 'FK_Erfolg' },
  // Process Engine
  { op: 'add', type: 'startEvent', id: 'PE_S', name: 'Freie Stelle gemeldet', parent: 'L_Auto', eventDefinition: { type: 'message', name: 'stelle_gemeldet' } },
  { op: 'add', type: 'userTask', id: 'PE_Beschr', name: 'Stelle beschreiben', after: 'PE_S', parent: 'L_PA', properties: { candidateGroups: 'personal' } },
  { op: 'add', type: 'userTask', id: 'PE_Pruefen', name: 'Stellenbeschreibung prüfen', after: 'PE_Beschr', parent: 'L_FB', properties: { candidateGroups: 'fachbereich' } },
  { op: 'add', type: 'boundaryEvent', id: 'PE_Timer', name: '3 Tage vergangen', attachTo: 'PE_Pruefen', interrupting: false, eventDefinition: { type: 'timer', value: 'P3D' } },
  { op: 'add', type: 'sendTask', id: 'PE_Erinnern', name: 'Erinnerung senden', after: 'PE_Timer', parent: 'L_Auto', properties: { delegateExpression: '${mail}' } },
  { op: 'add', type: 'endEvent', id: 'PE_E2', name: 'Erinnerung gesendet', after: 'PE_Erinnern' },
  { op: 'add', type: 'exclusiveGateway', id: 'PE_G', name: 'Freigabe erteilt?', after: 'PE_Pruefen' },
  { op: 'add', type: 'userTask', id: 'PE_Korr', name: 'Stellenbeschreibung korrigieren', after: 'PE_G', flowName: 'nein', parent: 'L_PA', properties: { candidateGroups: 'personal' } },
  { op: 'connect', source: 'PE_Korr', target: 'PE_Pruefen' },
  { op: 'add', type: 'userTask', id: 'PE_Anst', name: 'Ausschreibung anstoßen', after: 'PE_G', flowName: 'ja', parent: 'L_PA', properties: { candidateGroups: 'personal' } },
  { op: 'add', type: 'serviceTask', id: 'PE_Durchf', name: 'Ausschreibung durchführen', after: 'PE_Anst', parent: 'L_Auto', properties: { class: 'de.fh.Ausschreibung' } },
  { op: 'add', type: 'sendTask', id: 'PE_Erfolg', name: 'Erfolgsmeldung senden', after: 'PE_Durchf', properties: { delegateExpression: '${mail}' } },
  { op: 'add', type: 'endEvent', id: 'PE_E', name: 'Stelle ausgeschrieben', after: 'PE_Erfolg' },
  // Sachbearbeiter
  { op: 'add', type: 'startEvent', id: 'SB_S', name: 'Aufgabe erhalten', parent: 'P_SB', eventDefinition: { type: 'message', name: 'aufgabe' } },
  { op: 'add', type: 'userTask', id: 'SB_Beschr', name: 'Stelle beschreiben', after: 'SB_S' },
  { op: 'add', type: 'eventBasedGateway', id: 'SB_EG', after: 'SB_Beschr' },
  { op: 'add', type: 'intermediateCatchEvent', id: 'SB_Korr_E', name: 'Korrektur erbeten', after: 'SB_EG', eventDefinition: { type: 'message', name: 'korrektur' } },
  { op: 'add', type: 'userTask', id: 'SB_Korr', name: 'Stellenbeschreibung überarbeiten', after: 'SB_Korr_E' },
  { op: 'connect', source: 'SB_Korr', target: 'SB_EG' },
  { op: 'add', type: 'intermediateCatchEvent', id: 'SB_Frei_E', name: 'Beschreibung freigegeben', after: 'SB_EG', eventDefinition: { type: 'message', name: 'freigabe' } },
  { op: 'add', type: 'userTask', id: 'SB_Anst', name: 'Ausschreibung anstoßen', after: 'SB_Frei_E' },
  { op: 'add', type: 'endEvent', id: 'SB_E', name: 'Ausschreibung angestoßen', after: 'SB_Anst' },
  // Nachrichtenflüsse
  { op: 'connect', source: 'FK_Melden', target: 'PE_S', name: 'Stellenmeldung' },
  { op: 'connect', source: 'PE_Beschr', target: 'SB_S' },
  { op: 'connect', source: 'SB_Beschr', target: 'PE_Beschr', name: 'Entwurf' },
  { op: 'connect', source: 'PE_Pruefen', target: 'FK_Entwurf' },
  { op: 'connect', source: 'FK_Frei', target: 'PE_Pruefen' },
  { op: 'connect', source: 'FK_Korr', target: 'PE_Pruefen' },
  { op: 'connect', source: 'PE_Korr', target: 'SB_Korr_E' },
  { op: 'connect', source: 'SB_Korr', target: 'PE_Korr' },
  { op: 'connect', source: 'PE_Anst', target: 'SB_Frei_E' },
  { op: 'connect', source: 'SB_Anst', target: 'PE_Anst' },
  { op: 'connect', source: 'PE_Erfolg', target: 'FK_Erfolg', name: 'Erfolgsmeldung' },
  { op: 'connect', source: 'PE_Durchf', target: 'P_Portal', name: 'Anzeige' },
  { op: 'connect', source: 'PE_Erinnern', target: 'P_FK' },
];
if (import.meta.url === `file://${process.argv[1]}`) {
  let failed = 0;
  const expect = (label, cond) => { console.log(cond ? 'ok    ' : 'FEHLER', label); if (!cond) failed++; };
  try {
    for (const [tag, opts] of [['aligned', {}], ['unaligned', { align: false, poolOrder: ['P_FK', 'P_SB', 'P_PE', 'P_Portal'] }]]) {
      fs.writeFileSync(f, emptyDiagram('Process_Engine', 'Stellenausschreibung', { platform: 'camunda7' }));
      const png = await withFile(f, async (exec) => {
        await exec('batch', { operations: OPS });
        await exec('applyLayout', computeLayout(await exec('graph'), opts));
        const g = await exec('graph');
        const res = checkDiagram(g);
        const lay = res.problems.filter((p) => /linie|ueberlapp|kreuz|beschrift|schraeg/.test(p.rule));
        console.log(`--- ${tag}: ${formatCheck({ ...res, problems: lay })}`);
        const msg = g.edges.filter((e) => e.type === 'MessageFlow');
        const straight = msg.filter((e) => e.waypoints.length === 2 && e.waypoints[0].x === e.waypoints[1].x).length;
        const len = msg.reduce((s, e) => s + e.waypoints.slice(1).reduce((t, p, i) => t + Math.abs(p.x - e.waypoints[i].x) + Math.abs(p.y - e.waypoints[i].y), 0), 0);
        console.log(`${tag}: ${straight}/${msg.length} Nachrichtenflüsse senkrecht, Gesamtlänge ${Math.round(len)} px, Kreuzungen ${res.crossings}`);
        if (tag === 'aligned') {
          const y = (id) => g.nodes.find((n) => n.id === id).y;
          expect('Process Engine liegt zwischen den menschlichen Pools', (y('P_FK') < y('P_PE') && y('P_PE') < y('P_SB')) || (y('P_SB') < y('P_PE') && y('P_PE') < y('P_FK')));
          expect('mindestens vier Nachrichtenflüsse senkrecht', straight >= 4);
          expect('Nachrichtenflüsse insgesamt kürzer als 7500 px', len < 7500);
          expect('ja/nein-Beschriftungen überlappen nicht', !lay.some((p) => p.rule === 'beschriftungen-ueberlappen'));
          expect('keine Linie durch ein Element', !lay.some((p) => p.rule === 'linie-durch-element'));
        }
        return (await exec('screenshot', { maxSize: 2400 })).png;
      }, { mutate: true });
      if (out) { fs.writeFileSync(`${out}-${tag}.png`, Buffer.from(png, 'base64')); fs.copyFileSync(f, `${out}-${tag}.bpmn`); }
    }
  } finally {
    await closeHeadless();
  }
  console.log(failed ? `\n${failed} FEHLER` : '\nalles ok');
  process.exitCode = failed ? 1 : 0;
}
