// Peer-Multiple Radar: the program behind the dashboard.
//
// The sealed snapshot is the only input. This file turns it into a ranked board, writes the
// browser data file beside the dashboard, copies the static page and its screenshots, and asks
// the vendored dossier library to summarize exactly what was produced. It performs no network
// access and uses no clock or random source, so two runs over the same snapshot agree byte for
// byte.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const DOSSIER_TEXT_BYTES = 65_536;
const IMAGE_FILE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function option(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const exact = args.find((value) => value.startsWith(`--${name}=`));
  if (exact !== undefined) return exact.slice(name.length + 3);
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1]! : fallback;
}

function copyTree(source: string, target: string): string[] {
  if (!existsSync(source)) return [];
  mkdirSync(target, { recursive: true });
  const copied: string[] = [];
  const entries = readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copied.push(...copyTree(from, to));
    else if (entry.isFile()) {
      copyFileSync(from, to);
      copied.push(entry.name);
    }
  }
  return copied;
}

const inputOption = option('input', '/input');
const snapshotPath = inputOption.endsWith('.json') ? inputOption : join(inputOption, 'snapshot.json');
if (!existsSync(snapshotPath) || !statSync(snapshotPath).isFile()) {
  process.stderr.write(`peer-multiple radar: snapshot not found at ${snapshotPath}\n`);
  process.exit(2);
}

const outputDir = option('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`peer-multiple radar: refusing to write an invalid board: ${issue}\n`);
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outputDir, 'data.js'), dataScript(radar));

const dashboardFiles = copyTree(join(root, 'dashboard'), join(outputDir, 'dashboard'));
const screenshots = copyTree(join(root, 'screenshots'), join(outputDir, 'screenshots'));
if (dashboardFiles.length < 3) {
  process.stderr.write('peer-multiple radar: dashboard must contain index.html, a stylesheet, and a script\n');
  process.exit(1);
}
if (screenshots.length < 3 || screenshots.length > 4) {
  process.stderr.write(`peer-multiple radar: expected 3 or 4 screenshots, found ${screenshots.length}\n`);
  process.exit(1);
}
for (const name of screenshots) {
  if (!IMAGE_FILE.test(name)) {
    process.stderr.write(`peer-multiple radar: invalid screenshot name ${name}\n`);
    process.exit(1);
  }
}

writeFileSync(join(outputDir, 'dossier.json'), buildDossier(outputDir, {
  text_max_bytes: DOSSIER_TEXT_BYTES,
  screenshots: { max: 4, max_bytes: 524_288 },
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
}));

process.stdout.write(`peer-multiple radar: ranked ${board.length} pre-token protocols from ${snapshot.protocols.length} snapshot records\n`);
process.stdout.write(`peer-multiple radar: wrote board.json, data.js, ${dashboardFiles.length} dashboard files, ${screenshots.length} screenshots, and dossier.json to ${outputDir}\n`);
