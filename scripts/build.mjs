// Build: TypeScript -> dist/ (entpackt in Chrome ladbar).
//   node scripts/build.mjs           einmaliger Build
//   node scripts/build.mjs --watch   neu bauen bei Änderungen
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIcon } from './icons.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  target: 'chrome121',
  sourcemap: 'linked',
  logLevel: 'info',
  legalComments: 'none',
};

const builds = [
  // Service Worker als ES-Modul
  { entryPoints: { background: 'src/background/index.ts' }, format: 'esm' },
  // Content-Scripts und Popup als IIFE (keine Module erlaubt / nötig)
  { entryPoints: { 'content-main': 'src/content/main.ts' }, format: 'iife', sourcemap: false },
  { entryPoints: { 'content-bridge': 'src/content/bridge.ts' }, format: 'iife', sourcemap: false },
  { entryPoints: { popup: 'src/popup/popup.ts' }, format: 'iife' },
];

async function copyStatic() {
  await mkdir(resolve(out, 'icons'), { recursive: true });
  await cp(resolve(root, 'static/manifest.json'), resolve(out, 'manifest.json'));
  await cp(resolve(root, 'src/popup/popup.html'), resolve(out, 'popup.html'));
  await cp(resolve(root, 'src/popup/popup.css'), resolve(out, 'popup.css'));
  for (const s of [16, 32, 48, 128]) await writeFile(resolve(out, `icons/icon${s}.png`), makeIcon(s));
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await copyStatic();

const opts = builds.map((b) => ({ ...common, ...b, outdir: out, absWorkingDir: root }));
if (watch) {
  for (const o of opts) await (await esbuild.context(o)).watch();
  const { watch: fsWatch } = await import('node:fs');
  for (const d of ['static', 'src/popup']) fsWatch(resolve(root, d), { recursive: true }, () => void copyStatic());
  console.log('Watch-Modus aktiv – nach Änderungen die Erweiterung in chrome://extensions neu laden.');
} else {
  await Promise.all(opts.map((o) => esbuild.build(o)));
  console.log(`Fertig: ${out}`);
}
