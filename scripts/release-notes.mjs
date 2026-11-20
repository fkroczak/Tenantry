// Gibt den CHANGELOG-Abschnitt einer Version aus (für die GitHub-Release-Notizen).
//   node scripts/release-notes.mjs 0.4.0
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2] ?? JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
const lines = (await readFile(resolve(root, 'CHANGELOG.md'), 'utf8')).split('\n');

const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`Kein Abschnitt "## [${version}]" in CHANGELOG.md`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && (l.startsWith('## [') || /^\[[^\]]+\]: /.test(l)));
if (end === -1) end = lines.length;
const body = lines.slice(start + 1, end).join('\n').trim();
console.log(body || '_Keine Einträge._');
