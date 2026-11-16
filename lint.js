// bpmnlint with the same rules as Camunda Modeler: bpmnlint:recommended + camunda-compat for the platform and version
// from the file header (modeler:executionPlatform / executionPlatformVersion). camunda-compat does not check non-executable processes.
import { createRequire } from 'node:module';
import { BpmnModdle } from 'bpmn-moddle';
import { Linter } from 'bpmnlint';
import NodeResolver from 'bpmnlint/lib/resolver/node-resolver.js';

const require = createRequire(import.meta.url);
const camundaModdle = require('camunda-bpmn-moddle/resources/camunda.json');
const zeebeModdle = require('zeebe-bpmn-moddle/resources/zeebe.json');
const compat = require('bpmnlint-plugin-camunda-compat');

// Matching camunda-compat configuration: highest available version ≤ target version (otherwise the lowest).
export function compatConfig(xml) {
  const head = /<[\w:]*definitions[^>]*>/.exec(xml)?.[0] ?? '';
  const platform = /modeler:executionPlatform="([^"]*)"/.exec(head)?.[1] ?? '';
  const version = /modeler:executionPlatformVersion="(\d+)\.(\d+)/.exec(head);
  const c8 = /cloud|zeebe/i.test(platform) || (!platform && /xmlns:zeebe=/.test(head));
  const prefix = c8 ? 'camunda-cloud-' : 'camunda-platform-';
  const avail = Object.keys(compat.configs)
    .filter((k) => k.startsWith(prefix))
    .map((k) => ({ k, v: k.slice(prefix.length).split('-').map(Number) }))
    .sort((a, b) => a.v[0] - b.v[0] || a.v[1] - b.v[1]);
  if (!avail.length) return null;
  if (!version) return avail.at(-1).k;
  const want = [Number(version[1]), Number(version[2])];
  const fit = avail.filter(({ v }) => v[0] < want[0] || (v[0] === want[0] && v[1] <= want[1]));
  return (fit.at(-1) ?? avail[0]).k;
}

export async function lintXml(xml) {
  const cfg = compatConfig(xml);
  // The camunda and zeebe extensions collide when loaded together (modelerTemplate defined twice): only load the matching one.
  const moddle = new BpmnModdle(cfg?.startsWith('camunda-cloud') ? { zeebe: zeebeModdle } : { camunda: camundaModdle });
  const { rootElement, warnings } = await moddle.fromXML(xml, 'bpmn:Definitions');
  const linter = new Linter({
    config: { extends: ['bpmnlint:recommended', ...(cfg ? [`plugin:camunda-compat/${cfg}`] : [])] },
    resolver: new NodeResolver({ require }),
  });
  const reports = await linter.lint(rootElement);
  const problems = [];
  for (const [rule, list] of Object.entries(reports)) {
    for (const r of list) {
      const sev = r.category === 'error' ? 'error' : r.category === 'warn' ? 'warning' : 'hint';
      problems.push({ severity: sev, rule: `lint/${rule}`, message: `${r.id ? `${r.id}: ` : ''}${r.message}`, ids: r.id ? [r.id] : [] });
    }
  }
  return { config: cfg, problems, importWarnings: warnings.length };
}

export function formatLint({ config, problems }) {
  const label = { error: 'ERROR', warning: 'WARNING', hint: 'HINT' };
  const head = `bpmnlint (${config ? `engine rules camunda-compat/${config} as in Camunda Modeler + ` : ''}best practices bpmnlint:recommended): `;
  if (!problems.length) return `${head}no findings.`;
  const order = { error: 0, warning: 1, hint: 2 };
  const count = (s) => problems.filter((p) => p.severity === s).length;
  return [
    `${head}${count('error')} errors, ${count('warning')} warnings, ${count('hint')} hints`,
    ...[...problems].sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 40).map((p) => `[${label[p.severity]}] ${p.rule}: ${p.message}`),
    ...(problems.length > 40 ? [`… and ${problems.length - 40} more.`] : []),
  ].join('\n');
}
