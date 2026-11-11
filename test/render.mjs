// Rendert BPMN-XML mit echtem bpmn-js in Headless-Chrome zu einem PNG (zum Ansehen von Layout-Ergebnissen).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const launch = () => puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--allow-file-access-from-files'] });

export async function renderPng(xml, pngFile, browser) {
  const own = !browser;
  browser ??= await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  const html = path.join(ROOT, 'test', '.viewer.html');
  fs.writeFileSync(html, `<!doctype html><link rel="stylesheet" href="../node_modules/bpmn-js/dist/assets/diagram-js.css"><body style="margin:0"><div id="c" style="width:1600px;height:900px"></div><script src="../node_modules/bpmn-js/dist/bpmn-viewer.development.js"></script>`);
  await page.goto(pathToFileURL(html).href);
  const svg = await page.evaluate(async (xml) => { const v = new BpmnJS({ container: '#c' }); await v.importXML(xml); return (await v.saveSVG()).svg; }, xml);
  const m = /width="([\d.]+)" height="([\d.]+)"/.exec(svg);
  const [w, h] = [Math.ceil(Number(m[1])), Math.ceil(Number(m[2]))];
  await page.setViewport({ width: w + 40, height: h + 40 });
  await page.setContent(`<body style="margin:20px;background:#fff">${svg}</body>`);
  await page.screenshot({ path: pngFile });
  await page.close();
  if (own) await browser.close();
  return { width: w, height: h };
}
