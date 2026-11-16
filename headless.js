// File mode: opens .bpmn files in an invisible bpmn-js (headless Chrome) and runs exactly
// the same commands there as the Modeler plugin in live mode (plugin/client.js).
// A browser is started on the first call and shut down again after a longer idle period.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import zeebe from 'zeebe-bpmn-moddle/resources/zeebe.json' with { type: 'json' };
import camunda from 'camunda-bpmn-moddle/resources/camunda.json' with { type: 'json' };

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const BPMN_JS = path.join(path.dirname(require.resolve('bpmn-js/package.json')), 'dist');
const IDLE_MS = 10 * 60 * 1000;
const HISTORY = 50;

const CHROME_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge'],
  win32: [
    [process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'],
    [process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'],
    [process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'],
    [process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'],
  ].filter(([base]) => base).map(([base, rel]) => path.join(base, rel)),
};

export function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const found = (CHROME_CANDIDATES[process.platform] ?? []).find((p) => existsSync(p));
  if (!found) {
    throw new Error('File mode needs Google Chrome, Chromium or Edge. No browser found: set the CHROME_PATH environment variable to the executable.');
  }
  return found;
}

// ---------- Browser with bpmn-js + plugin ----------
let session = null; // { browser, page, file, xml }
let idleTimer = null;

async function openSession() {
  if (session?.browser.connected) return session;
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.setContent('<!doctype html><body style="margin:0"><div id="c8" style="width:1600px;height:900px"></div><div id="c7" style="width:1600px;height:900px;display:none"></div></body>');
  await page.addStyleTag({ path: path.join(BPMN_JS, 'assets', 'diagram-js.css') });
  await page.addScriptTag({ path: path.join(BPMN_JS, 'bpmn-modeler.production.min.js') });
  await page.addScriptTag({ path: path.join(ROOT, 'plugin', 'client.js') });
  // One modeler per platform (the zeebe and camunda extensions cannot be registered together).
  // Only the one matching the file is visible; the plugin works on the visible one.
  await page.evaluate((zeebe, camunda) => {
    const modules = window.plugins.filter((p) => p.type === 'bpmn.modeler.additionalModules').map((p) => p.plugin);
    const make = (id, ext) => new window.BpmnJS({ container: '#' + id, additionalModules: modules, moddleExtensions: ext });
    const all = { camunda8: make('c8', { zeebe }), camunda7: make('c7', { camunda }) };
    window.__use = (platform) => {
      document.getElementById('c8').style.display = platform === 'camunda7' ? 'none' : 'block';
      document.getElementById('c7').style.display = platform === 'camunda7' ? 'block' : 'none';
      window.modeler = all[platform] ?? all.camunda8;
    };
    window.__use('camunda8');
  }, zeebe, camunda);
  session = { browser, page, file: null, xml: null };
  browser.on('disconnected', () => { if (session?.browser === browser) session = null; });
  return session;
}

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => closeHeadless(), IDLE_MS);
  idleTimer.unref?.();
}

export async function closeHeadless() {
  clearTimeout(idleTimer);
  const s = session;
  session = null;
  await s?.browser.close().catch(() => {});
}

// Errors from the page come back with a stack trace; only the actual message matters.
function cleanError(e) {
  const msg = String(e?.message ?? e).split('\n')[0].replace(/^(Error|TypeError):\s*/, '');
  return new Error(msg);
}

// ---------- Run calls one after another (one browser, one diagram) ----------
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// ---------- History per file for undo/redo ----------
const history = new Map(); // file -> { past, future, last }

function remember(file, before, after) {
  let h = history.get(file);
  if (!h || h.last !== before) h = { past: [], future: [] };
  h.past.push(before);
  if (h.past.length > HISTORY) h.past.shift();
  h.future = [];
  h.last = after;
  history.set(file, h);
}

async function readXml(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`File not found: ${file} (create new diagrams with create_diagram)`);
    throw e;
  }
}

/**
 * Loads the file into bpmn-js, calls fn(exec) and writes the result back if mutate is set.
 * exec(method, params) calls the same command as live mode (graph, addElement, connect, ...).
 * If fn fails, the file stays unchanged.
 */
export function withFile(file, fn, { mutate = false } = {}) {
  return serial(async () => {
    const xml = await readXml(file);
    const s = await openSession();
    touch();
    if (s.file !== file || s.xml !== xml) {
      s.file = null;
      try {
        await s.page.evaluate((x, platform) => { window.__use(platform); return window.modeler.importXML(x).then(() => undefined); }, xml, platformOfXml(xml));
      } catch (e) {
        throw new Error(`The file could not be loaded: ${cleanError(e).message}`);
      }
      s.file = file;
      s.xml = xml;
    }
    const exec = async (method, params = {}) => {
      try {
        return await s.page.evaluate((m, p) => window.__bpmnMcp.call(m, p), method, params);
      } catch (e) {
        throw cleanError(e);
      }
    };
    try {
      const result = await fn(exec);
      if (mutate) {
        const out = await s.page.evaluate(async () => (await window.modeler.saveXML({ format: true })).xml);
        if (out !== xml) {
          await fs.writeFile(file, out, 'utf8');
          remember(file, xml, out);
        }
        s.xml = out;
      }
      return result;
    } catch (e) {
      s.file = null; // the diagram in the browser may be half changed: reload it next time
      throw e;
    }
  });
}

export function undoFile(file, redo = false) {
  return serial(async () => {
    const current = await readXml(file);
    const h = history.get(file);
    const from = redo ? h?.future : h?.past;
    if (!h || h.last !== current) throw new Error('No history for this file (not changed in this session, or edited elsewhere in the meantime).');
    if (!from.length) throw new Error(redo ? 'Nothing to redo.' : 'Nothing to undo.');
    const xml = from.pop();
    (redo ? h.past : h.future).push(current);
    await fs.writeFile(file, xml, 'utf8');
    h.last = xml;
    return { undo: h.past.length, redo: h.future.length };
  });
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export const PLATFORMS = ['camunda7', 'camunda8'];
/** Platform of a BPMN file according to its header (detected the same way as in the plugin). */
export function platformOfXml(xml) {
  const head = /<[\w:]*definitions[^>]*>/.exec(xml)?.[0] ?? '';
  const p = /modeler:executionPlatform="([^"]*)"/.exec(head)?.[1];
  if (p) return /cloud|zeebe|8/i.test(p) ? 'camunda8' : 'camunda7';
  return /xmlns:camunda=/.test(head) && !/xmlns:zeebe=/.test(head) ? 'camunda7' : 'camunda8';
}
export const DEFAULT_PLATFORM = PLATFORMS.includes(process.env.BPMN_MCP_PLATFORM) ? process.env.BPMN_MCP_PLATFORM : 'camunda8';

/**
 * Empty diagram for the chosen platform.
 * Camunda 7: camunda namespace, executionPlatform "Camunda Platform", historyTimeToLive (required for deployment since 7.20).
 * executable: false creates a purely business model (strategic/operational) that the engine does not deploy.
 */
export const DEFAULT_VERSION = { camunda7: process.env.BPMN_MCP_C7_VERSION || '7.23.0', camunda8: process.env.BPMN_MCP_C8_VERSION || '8.8.0' };
export function emptyDiagram(processId, name, { platform = DEFAULT_PLATFORM, executable = true, version } = {}) {
  const c7 = platform === 'camunda7';
  const ns = c7 ? 'xmlns:camunda="http://camunda.org/schema/1.0/bpmn"' : 'xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';
  const v = esc(version || DEFAULT_VERSION[platform]);
  const exec = c7 ? `modeler:executionPlatform="Camunda Platform" modeler:executionPlatformVersion="${v}"` : `modeler:executionPlatform="Camunda Cloud" modeler:executionPlatformVersion="${v}"`;
  const ttl = c7 && executable ? ' camunda:historyTimeToLive="180"' : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ${ns} xmlns:modeler="http://camunda.org/schema/modeler/1.0" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn" exporter="bpmn-mcp" ${exec}>
  <bpmn:process id="${esc(processId)}"${name ? ` name="${esc(name)}"` : ''} isExecutable="${executable ? 'true' : 'false'}"${ttl} />
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="${esc(processId)}" />
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;
}

// ---------- Export: SVG -> PDF/PNG via the same headless browser (also for UML diagrams) ----------
function svgSize(svg) {
  const head = /<svg[^>]*>/.exec(svg)?.[0] ?? '';
  const w = /\swidth="([\d.]+)/.exec(head), h = /\sheight="([\d.]+)/.exec(head), vb = /viewBox="([-\d.]+)[ ,]+([-\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)"/.exec(head);
  return { width: Math.ceil(Number(w?.[1] ?? vb?.[3] ?? 800)), height: Math.ceil(Number(h?.[1] ?? vb?.[4] ?? 600)) };
}

/** Converts an SVG into a PDF (one page, exactly the size of the diagram) or a PNG. */
export function renderSvg(svg, format, { margin = 20, scale = 2, maxSize } = {}) {
  return serial(async () => {
    const s = await openSession();
    touch();
    const page = await s.browser.newPage();
    try {
      const { width, height } = svgSize(svg);
      const W = width + 2 * margin, H = height + 2 * margin;
      await page.setContent(`<!doctype html><html><head><style>@page{size:${W}px ${H}px;margin:0}html,body{margin:0;background:#fff}svg{display:block;margin:${margin}px}</style></head><body>${svg}</body></html>`);
      if (format === 'pdf') return { data: Buffer.from(await page.pdf({ width: `${W}px`, height: `${H}px`, printBackground: true, pageRanges: '1' })), width: W, height: H };
      const k = maxSize ? Math.min(scale, maxSize / Math.max(W, H)) : scale;
      await page.setViewport({ width: W, height: H, deviceScaleFactor: Math.max(0.1, k) });
      return { data: Buffer.from(await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } })), width: Math.round(W * k), height: Math.round(H * k) };
    } finally {
      await page.close().catch(() => {});
    }
  });
}
