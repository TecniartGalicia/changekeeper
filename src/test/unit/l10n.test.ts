import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Every user-facing string must have a Spanish translation. This walks the sources and collects
 * the first literal argument of `l10n.t(...)` (VS Code layer) and `t(...)` (core/findings.ts).
 */
const ROOT = path.join(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src');
const BUNDLE = path.join(ROOT, 'l10n', 'bundle.l10n.es.json');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'test') walk(p, out);
    } else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function unescapeTs(s: string): string {
  return s.replace(/\\(n|'|"|\\)/g, (_, c) => (c === 'n' ? '\n' : c));
}

function collect(): Set<string> {
  const keys = new Set<string>();
  // first literal argument, single- or double-quoted (must match scripts/l10n-sync.mjs)
  const stringLit = String.raw`(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")`;
  for (const file of walk(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    const patterns = [new RegExp(String.raw`l10n\.t\(\s*` + stringLit, 'g')];
    if (file.endsWith(path.join('core', 'report.ts'))) patterns.push(new RegExp(String.raw`(?<![\w.])t\(\s*` + stringLit, 'g'));
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) keys.add(unescapeTs(m[1] ?? m[2]));
    }
  }
  return keys;
}

describe('l10n coverage', () => {
  it('bundle.l10n.es.json is valid JSON', () => {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(BUNDLE, 'utf8')));
  });

  it('every source string has a Spanish translation, and no translation is orphaned', () => {
    const bundle: Record<string, string> = JSON.parse(fs.readFileSync(BUNDLE, 'utf8'));
    const used = collect();
    assert.ok(used.size >= 60, `collected only ${used.size} strings — regex broke?`);
    const missing = [...used].filter((k) => !(k in bundle));
    assert.deepStrictEqual(missing, [], `missing translations:\n${missing.map((m) => JSON.stringify(m)).join('\n')}`);
    const orphans = Object.keys(bundle).filter((k) => !used.has(k));
    assert.deepStrictEqual(orphans, [], `orphan translations:\n${orphans.map((m) => JSON.stringify(m)).join('\n')}`);
  });

  it('placeholders match between source and translation', () => {
    const bundle: Record<string, string> = JSON.parse(fs.readFileSync(BUNDLE, 'utf8'));
    for (const [en, es] of Object.entries(bundle)) {
      const ph = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join(',');
      assert.strictEqual(ph(es), ph(en), `placeholder mismatch for ${JSON.stringify(en)}`);
      assert.ok(es.trim().length > 0, `empty translation for ${JSON.stringify(en)}`);
    }
  });

  it('package.nls.es.json covers package.nls.json', () => {
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.json'), 'utf8'));
    const es = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.es.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(es).sort(), Object.keys(en).sort());
  });
});
