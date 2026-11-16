// Usage: node test/layout-file.mjs <in.bpmn> <out.bpmn> <out.png>  – re-lays out a file, checks and renders it.
import fs from 'node:fs';
import { BpmnModdle } from 'bpmn-moddle';
import zeebe from 'zeebe-bpmn-moddle/resources/zeebe.json' with { type: 'json' };
import { graphFromDefinitions, writeDi } from '../model.js';
import { computeLayout } from '../layout.js';
import { checkDiagram, formatCheck } from '../check.js';
import { renderPng } from './render.mjs';
const [inp, outp, png] = process.argv.slice(2);
const moddle = new BpmnModdle({ zeebe });
const { rootElement: defs } = await moddle.fromXML(fs.readFileSync(inp, 'utf8'));
const graph = graphFromDefinitions(defs);
writeDi(moddle, defs, graph, computeLayout(graph));
const { xml } = await moddle.toXML(defs, { format: true });
fs.writeFileSync(outp, xml);
const { rootElement: d2 } = await moddle.fromXML(xml);
const res = checkDiagram(graphFromDefinitions(d2));
console.log(formatCheck({ ...res, problems: res.problems.filter((p) => /line|overlap|crossing|label|diagonal/.test(p.rule)) }));
if (png) console.log(await renderPng(xml, png));
