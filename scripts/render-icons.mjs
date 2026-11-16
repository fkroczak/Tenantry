// Rendert static/icons/icon.svg in die PNG-Größen der Erweiterung.
//   node scripts/render-icons.mjs
// Nur nach Änderungen am SVG nötig; die PNGs liegen im Repository.
// Voraussetzung: Playwright mit Chromium (global installiert, wie für e2e).
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../static/icons');
const svg = await readFile(resolve(dir, 'icon.svg'), 'utf8');

const browser = await chromium.launch();
const page = await browser.newPage();
for (const s of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: s, height: s });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${s}px;height:${s}px;display:block}</style>${svg}`);
  await page.screenshot({ path: resolve(dir, `icon${s}.png`), omitBackground: true });
}
await browser.close();
console.log('Icons erzeugt:', dir);
