// Camunda 7 Process Engine über die REST-API (engine-rest): deployen, Instanzen starten, Aufgaben erledigen,
// Timer/Jobs auslösen, Nachrichten korrelieren, Incidents beheben und den Zustand einer Instanz ansehen.
// Ersetzt die curl-/Python-Skripte für Testläufe. Konfiguration: CAMUNDA_URL (Standard http://localhost:8080/engine-rest),
// optional CAMUNDA_USER/CAMUNDA_PASSWORD (Basic Auth). Jedes Tool nimmt zusätzlich "engineUrl".
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_URL = process.env.CAMUNDA_URL || 'http://localhost:8080/engine-rest';

function authHeader() {
  const u = process.env.CAMUNDA_USER, p = process.env.CAMUNDA_PASSWORD;
  return u ? { Authorization: `Basic ${Buffer.from(`${u}:${p ?? ''}`).toString('base64')}` } : {};
}

export function client(base = DEFAULT_URL) {
  const root = base.replace(/\/+$/, '');
  async function call(method, p, body, { raw = false } = {}) {
    const url = `${root}${p.startsWith('/') ? p : `/${p}`}`;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Accept: 'application/json', ...authHeader(), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
        body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      });
    } catch (e) {
      throw new Error(`Engine nicht erreichbar (${root}): ${e.cause?.code ?? e.message}. Läuft die Anwendung? Sonst CAMUNDA_URL bzw. engineUrl setzen.`);
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { const j = JSON.parse(text); msg = `${j.type ? `${j.type}: ` : ''}${j.message ?? text}`; } catch { /* Text */ }
      throw new Error(`${method} ${p} → HTTP ${res.status}: ${msg.slice(0, 1500)}`);
    }
    if (raw) return text;
    return text ? JSON.parse(text) : null;
  }
  const q = (o) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
    const str = s.toString();
    return str ? `?${str}` : '';
  };
  return { call, q, root };
}

// ---------- Variablen ----------
// JS-Wert -> Camunda-Variable. {value, type} wird unverändert übernommen; ganze Zahlen werden Long (wie in Generated Forms).
export function toVar(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v && ('type' in v || 'valueInfo' in v)) return v;
  if (v === null || v === undefined) return { value: null, type: 'Null' };
  if (typeof v === 'boolean') return { value: v, type: 'Boolean' };
  if (typeof v === 'number') return Number.isInteger(v) ? { value: v, type: 'Long' } : { value: v, type: 'Double' };
  if (typeof v === 'string') return { value: v, type: 'String' };
  return { value: JSON.stringify(v), type: 'Json' };
}
export const toVars = (o = {}) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toVar(v)]));
// Camunda-Variablen -> kompakt { name: wert }
export function fromVars(vars = {}) {
  const out = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v?.type === 'Json' && typeof v.value === 'string') { try { out[k] = JSON.parse(v.value); continue; } catch { /* Text */ } }
    out[k] = v?.type === 'Object' ? `<${v.valueInfo?.objectTypeName ?? 'Object'}>` : v?.value;
  }
  return out;
}

const line = (o) => JSON.stringify(o);
const lines = (title, list, fmt = line) => `${title} (${list.length}):${list.length ? '\n' + list.map((x) => `- ${fmt(x)}`).join('\n') : ' keine'}`;

// ---------- Instanz finden (ID oder Business Key, laufend oder beendet) ----------
async function findInstance(c, { processInstanceId, businessKey, processDefinitionKey }) {
  if (processInstanceId) {
    const h = await c.call('GET', `/history/process-instance/${processInstanceId}`);
    return h;
  }
  if (!businessKey) throw new Error('processInstanceId oder businessKey angeben.');
  const list = await c.call('GET', `/history/process-instance${c.q({ processInstanceBusinessKey: businessKey, processDefinitionKey, sortBy: 'startTime', sortOrder: 'desc' })}`);
  if (!list.length) throw new Error(`Keine Prozessinstanz mit Business Key "${businessKey}".`);
  return list[0];
}

// Kompakter Zustand: wartende Aktivitäten, offene Aufgaben, Jobs/Timer, External Tasks, Incidents, Variablen, Verlauf.
export async function instanceState(c, ref, { history = true, variables = true } = {}) {
  const h = await findInstance(c, ref);
  const id = h.id;
  const active = h.state === 'ACTIVE' || h.state === 'SUSPENDED';
  const parts = [`Instanz ${id} (${h.processDefinitionKey} v${h.processDefinitionVersion ?? '?'}${h.businessKey ? `, Business Key ${h.businessKey}` : ''}): ${h.state}${h.endTime ? `, beendet ${h.endTime}` : ''}`];
  if (active) {
    const [tasks, jobs, ext, inc] = await Promise.all([
      c.call('GET', `/task${c.q({ processInstanceId: id })}`),
      c.call('GET', `/job${c.q({ processInstanceId: id })}`),
      c.call('GET', `/external-task${c.q({ processInstanceId: id })}`),
      c.call('GET', `/incident${c.q({ processInstanceId: id })}`),
    ]);
    const ai = await c.call('GET', `/process-instance/${id}/activity-instances`).catch(() => null);
    const waiting = [];
    const walk = (n) => { if (!n) return; if (!n.childActivityInstances?.length && n.activityType !== 'processDefinition') waiting.push(`${n.activityName ?? n.activityId} [${n.activityType}]`); (n.childActivityInstances ?? []).forEach(walk); };
    walk(ai);
    parts.push(`Wartet in: ${waiting.join(', ') || '–'}`);
    parts.push(lines('Offene Aufgaben', tasks, (t) => line({ id: t.id, name: t.name, key: t.taskDefinitionKey, assignee: t.assignee ?? undefined, created: t.created })));
    if (jobs.length) parts.push(lines('Jobs/Timer', jobs, (j) => line({ id: j.id, due: j.dueDate ?? 'sofort', retries: j.retries, failed: j.exceptionMessage ?? undefined })));
    if (ext.length) parts.push(lines('External Tasks', ext, (t) => line({ id: t.id, topic: t.topicName, activity: t.activityId, retries: t.retries ?? undefined, locked: t.lockExpirationTime ? `bis ${t.lockExpirationTime} (${t.workerId})` : undefined, error: t.errorMessage ?? undefined })));
    if (inc.length) parts.push(lines('INCIDENTS', inc, (i) => line({ id: i.id, type: i.incidentType, activity: i.activityId, message: i.incidentMessage, job: i.configuration })));
  }
  if (variables) {
    const vars = active
      ? fromVars(await c.call('GET', `/process-instance/${id}/variables?deserializeValues=false`))
      : Object.fromEntries((await c.call('GET', `/history/variable-instance${c.q({ processInstanceId: id, deserializeValues: false })}`)).map((v) => [v.name, v.type === 'Json' && typeof v.value === 'string' ? safeJson(v.value) : v.value]));
    parts.push(`Variablen: ${line(vars)}`);
  }
  if (history) {
    const acts = await c.call('GET', `/history/activity-instance${c.q({ processInstanceId: id, sortBy: 'startTime', sortOrder: 'asc' })}`);
    const shown = acts.filter((a) => !/^(sequenceFlow|multiInstanceBody)$/.test(a.activityType));
    parts.push(`Verlauf: ${shown.map((a) => `${a.activityName ?? a.activityId}${a.endTime ? '' : ' (offen)'}${a.canceled ? ' (abgebrochen)' : ''}${a.assignee ? ` [${a.assignee}]` : ''}`).join(' → ') || '–'}`);
  }
  return parts.join('\n');
}
const safeJson = (s) => { try { return JSON.parse(s); } catch { return s; } };

// ---------- Aktionen ----------
export async function status(c) {
  const [version, engines, defs, dmns, count, incidents] = await Promise.all([
    c.call('GET', '/version').catch(() => null),
    c.call('GET', '/engine').catch(() => []),
    c.call('GET', `/process-definition${c.q({ latestVersion: true, sortBy: 'key', sortOrder: 'asc' })}`),
    c.call('GET', `/decision-definition${c.q({ latestVersion: true })}`).catch(() => []),
    c.call('GET', '/process-instance/count'),
    c.call('GET', '/incident/count'),
  ]);
  return [
    `Engine erreichbar: ${c.root} (Version ${version?.version ?? '?'}, Engines: ${engines.map((e) => e.name).join(', ') || '?'})`,
    `Laufende Instanzen: ${count.count}, offene Incidents: ${incidents.count}`,
    lines('Prozesse (neueste Version)', defs, (d) => line({ key: d.key, name: d.name ?? undefined, version: d.version, versionTag: d.versionTag ?? undefined, resource: d.resource, startableInTasklist: d.startableInTasklist })),
    lines('Entscheidungen (DMN)', dmns, (d) => line({ key: d.key, name: d.name ?? undefined, version: d.version, resource: d.resource })),
  ].join('\n');
}

export async function deploy(c, { files, name, changedOnly = true, tenantId }) {
  const fd = new FormData();
  fd.set('deployment-name', name || path.basename(files[0]).replace(/\.[^.]+$/, ''));
  fd.set('deployment-source', 'bpmn-mcp');
  if (changedOnly) { fd.set('enable-duplicate-filtering', 'true'); fd.set('deploy-changed-only', 'true'); }
  if (tenantId) fd.set('tenant-id', tenantId);
  for (const f of files) {
    if (!path.isAbsolute(f)) throw new Error(`Absoluten Pfad angeben: ${f}`);
    fd.set(path.basename(f), new Blob([await fs.readFile(f)]), path.basename(f));
  }
  const r = await c.call('POST', '/deployment/create', fd);
  const defs = Object.values(r.deployedProcessDefinitions ?? {}), dmn = Object.values(r.deployedDecisionDefinitions ?? {});
  const neu = defs.length + dmn.length + Object.keys(r.deployedCaseDefinitions ?? {}).length;
  return [
    `Deployment ${r.id} („${r.name}“)${neu ? '' : ' – keine Änderung, nichts Neues deployt (deploy-changed-only)'}`,
    ...defs.map((d) => `- Prozess ${d.key} v${d.version} (${d.resource})`),
    ...dmn.map((d) => `- Entscheidung ${d.key} v${d.version} (${d.resource})`),
  ].join('\n');
}

export async function start(c, { processDefinitionKey, businessKey, variables, tenantId }) {
  const p = tenantId ? `/process-definition/key/${encodeURIComponent(processDefinitionKey)}/tenant-id/${encodeURIComponent(tenantId)}/start` : `/process-definition/key/${encodeURIComponent(processDefinitionKey)}/start`;
  const r = await c.call('POST', p, { businessKey, variables: toVars(variables) });
  return `Gestartet.\n${await instanceState(c, { processInstanceId: r.id }, { history: true, variables: false })}`;
}

async function findTask(c, { taskId, processInstanceId, businessKey, name, taskDefinitionKey }) {
  if (taskId) return c.call('GET', `/task/${taskId}`);
  const inst = processInstanceId || businessKey ? await findInstance(c, { processInstanceId, businessKey }) : null;
  const list = await c.call('GET', `/task${c.q({ processInstanceId: inst?.id, taskDefinitionKey, nameLike: name ? `%${name}%` : undefined })}`);
  if (!list.length) throw new Error(`Keine offene Aufgabe gefunden${name ? ` mit Namen „${name}“` : ''}${inst ? ` in Instanz ${inst.id}` : ''}.`);
  const exact = name ? list.filter((t) => t.name === name) : list;
  const pool = exact.length ? exact : list;
  if (pool.length > 1) throw new Error(`Mehrere passende Aufgaben – taskId angeben:\n${pool.map((t) => `- ${t.id} „${t.name}“ (${t.taskDefinitionKey}, Instanz ${t.processInstanceId}${t.assignee ? `, ${t.assignee}` : ''})`).join('\n')}`);
  return pool[0];
}

export async function tasks(c, { processInstanceId, businessKey, assignee, candidateGroup, candidateUser, name, formVariables }) {
  const inst = processInstanceId || businessKey ? await findInstance(c, { processInstanceId, businessKey }) : null;
  const list = await c.call('GET', `/task${c.q({ processInstanceId: inst?.id, assignee, candidateGroup, candidateUser, nameLike: name ? `%${name}%` : undefined, sortBy: 'created', sortOrder: 'asc', maxResults: 100 })}`);
  const out = [];
  for (const t of list) {
    const o = { id: t.id, name: t.name, key: t.taskDefinitionKey, instance: t.processInstanceId, assignee: t.assignee ?? undefined, created: t.created, due: t.due ?? undefined, formKey: t.formKey ?? undefined };
    if (formVariables) o.form = fromVars(await c.call('GET', `/task/${t.id}/form-variables?deserializeValues=false`).catch(() => ({})));
    out.push(o);
  }
  return lines('Offene Aufgaben', out);
}

export async function complete(c, args) {
  const t = await findTask(c, args);
  if (args.user && t.assignee !== args.user) {
    if (t.assignee) await c.call('POST', `/task/${t.id}/unclaim`);
    await c.call('POST', `/task/${t.id}/claim`, { userId: args.user });
  }
  await c.call('POST', `/task/${t.id}/${args.submitForm ? 'submit-form' : 'complete'}`, { variables: toVars(args.variables) });
  return `Erledigt: „${t.name}“ (${t.id})${args.user ? ` als ${args.user}` : ''}.\n${await instanceState(c, { processInstanceId: t.processInstanceId }, { history: false, variables: false })}`;
}

export async function executeJobs(c, { processInstanceId, businessKey, jobId, timersOnly }) {
  let jobs;
  if (jobId) jobs = [await c.call('GET', `/job/${jobId}`)];
  else {
    const inst = await findInstance(c, { processInstanceId, businessKey });
    jobs = await c.call('GET', `/job${c.q({ processInstanceId: inst.id, timers: timersOnly ? true : undefined })}`);
  }
  if (!jobs.length) return 'Keine Jobs/Timer vorhanden.';
  const done = [];
  for (const j of jobs) {
    try { await c.call('POST', `/job/${j.id}/execute`); done.push(`- ${j.id} ausgeführt${j.dueDate ? ` (war fällig ${j.dueDate})` : ''}`); }
    catch (e) { done.push(`- ${j.id} FEHLER: ${e.message}`); }
  }
  return `${done.join('\n')}\n${await instanceState(c, { processInstanceId: jobs[0].processInstanceId }, { history: false, variables: false })}`;
}

export async function correlate(c, { messageName, businessKey, processInstanceId, variables, correlationKeys, all }) {
  const r = await c.call('POST', '/message', {
    messageName, businessKey, processInstanceId, all: !!all, resultEnabled: true,
    processVariables: variables ? toVars(variables) : undefined,
    correlationKeys: correlationKeys ? toVars(correlationKeys) : undefined,
  });
  const ids = [...new Set((r ?? []).map((x) => x.processInstance?.id ?? x.execution?.processInstanceId).filter(Boolean))];
  const states = [];
  for (const id of ids.slice(0, 3)) states.push(await instanceState(c, { processInstanceId: id }, { history: false, variables: false }));
  return `Nachricht „${messageName}“ korreliert (${(r ?? []).length} Treffer: ${(r ?? []).map((x) => x.resultType).join(', ')}).${states.length ? `\n${states.join('\n')}` : ''}`;
}

export async function incidents(c, { processInstanceId, businessKey, retry }) {
  const inst = processInstanceId || businessKey ? await findInstance(c, { processInstanceId, businessKey }) : null;
  const list = await c.call('GET', `/incident${c.q({ processInstanceId: inst?.id })}`);
  const out = [];
  for (const i of list) {
    let detail = '';
    if (i.incidentType === 'failedJob') detail = (await c.call('GET', `/job/${i.configuration}/stacktrace`, undefined, { raw: true }).catch(() => '')).split('\n').slice(0, 6).join(' | ');
    if (i.incidentType === 'failedExternalTask') detail = (await c.call('GET', `/external-task/${i.configuration}/errorDetails`, undefined, { raw: true }).catch(() => '')).split('\n').slice(0, 6).join(' | ');
    let fixed = '';
    if (retry) {
      const p = i.incidentType === 'failedExternalTask' ? `/external-task/${i.configuration}/retries` : `/job/${i.configuration}/retries`;
      try { await c.call('PUT', p, { retries: 1 }); fixed = ' → Retries auf 1 gesetzt (wird erneut versucht)'; } catch (e) { fixed = ` → Retry fehlgeschlagen: ${e.message}`; }
    }
    out.push(`- ${i.id} ${i.incidentType} in ${i.activityId} (Instanz ${i.processInstanceId}): ${i.incidentMessage ?? ''}${detail ? `\n    ${detail.slice(0, 900)}` : ''}${fixed}`);
  }
  return `Incidents (${list.length}):${out.length ? '\n' + out.join('\n') : ' keine'}`;
}

export async function rest(c, { method = 'GET', path: p, body }) {
  const r = await c.call(method, p, body);
  const s = JSON.stringify(r, null, 1) ?? '(leer)';
  return s.length > 20000 ? `${s.slice(0, 20000)}\n… (gekürzt, ${s.length} Zeichen – Abfrage mit maxResults/Filtern eingrenzen)` : s;
}
