// Überträgt die Version aus package.json (einzige Quelle) in static/manifest.json
// und macht im CHANGELOG aus "## [Unreleased]" einen datierten Versionsabschnitt.
// Wird automatisch von `npm version <patch|minor|major>` aufgerufen.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  // Chrome akzeptiert nur Ziffern-Versionen (kein "-beta" o. Ä.).
  throw new Error(`Ungültige Version "${version}": erwartet MAJOR.MINOR.PATCH`);
}

const manifestPath = resolve(root, 'static/manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.version = version;
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const changelogPath = resolve(root, 'CHANGELOG.md');
let changelog = await readFile(changelogPath, 'utf8');
if (!changelog.includes(`## [${version}]`)) {
  const date = new Date().toISOString().slice(0, 10);
  changelog = changelog.replace('## [Unreleased]', `## [Unreleased]\n\n## [${version}] – ${date}`);
  // Vergleichslinks am Dateiende fortschreiben.
  const repo = 'https://github.com/fkroczak/Tenantry';
  changelog = changelog.replace(
    /^\[Unreleased\]: .*$/m,
    `[Unreleased]: ${repo}/compare/v${version}...HEAD\n[${version}]: ${repo}/releases/tag/v${version}`,
  );
  await writeFile(changelogPath, changelog);
}
console.log(`Version ${version} in manifest.json und CHANGELOG.md übernommen.`);
