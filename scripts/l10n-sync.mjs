// Keeps l10n/bundle.l10n.es.json in sync with the strings used in src/.
// Usage:
//   node scripts/l10n-sync.mjs                 → report missing / orphan keys (exit 1 if any)
//   node scripts/l10n-sync.mjs --prune         → drop orphan keys
//   node scripts/l10n-sync.mjs --merge file.json → add translations from a {en: es} JSON file
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const BUNDLE = path.join(ROOT, 'l10n', 'bundle.l10n.es.json');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'test') walk(p, out);
    } else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}
const unescapeTs = (s) => s.replace(/\\(n|'|"|\\)/g, (_, c) => (c === 'n' ? '\n' : c));
// first literal argument, single- or double-quoted
const stringLit = String.raw`(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")`;

export function collectUsed() {
  const keys = new Set();
  for (const file of walk(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    const patterns = [new RegExp(String.raw`l10n\.t\(\s*` + stringLit, 'g')];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(src))) keys.add(unescapeTs(m[1] ?? m[2]));
    }
  }
  return keys;
}

const args = process.argv.slice(2);
const bundle = JSON.parse(fs.readFileSync(BUNDLE, 'utf8'));
const used = collectUsed();
const mergeIdx = args.indexOf('--merge');
if (mergeIdx >= 0) {
  const extra = JSON.parse(fs.readFileSync(path.resolve(args[mergeIdx + 1]), 'utf8'));
  Object.assign(bundle, extra);
}
if (args.includes('--prune')) for (const k of Object.keys(bundle)) if (!used.has(k)) delete bundle[k];

const missing = [...used].filter((k) => !(k in bundle));
const orphans = Object.keys(bundle).filter((k) => !used.has(k));
if (mergeIdx >= 0 || args.includes('--prune')) {
  fs.writeFileSync(BUNDLE, JSON.stringify(bundle, null, 2) + '\n');
  console.log(`bundle written: ${Object.keys(bundle).length} keys`);
}
console.log(`used: ${used.size} · missing: ${missing.length} · orphans: ${orphans.length}`);
for (const m of missing) console.log('  MISSING', JSON.stringify(m));
for (const o of orphans) console.log('  ORPHAN ', JSON.stringify(o));
process.exit(missing.length || orphans.length ? 1 : 0);
