import * as assert from 'assert';
import { buildReport, suggestCommitMessage } from '../../core/report';
import { FileChange, newSession, Session } from '../../core/session';

function sess(changes: Partial<FileChange>[]): Session {
  const s = newSession({ id: 's1', folder: '/w', kind: 'git', now: new Date('2026-08-16T10:00:00Z') });
  for (const c of changes) {
    const f: FileChange = { path: c.path!, kind: c.kind ?? 'M', critical: c.critical ?? false, hunks: c.hunks ?? {}, hunkMeta: c.hunkMeta, firstSeenAt: '', lastChangeAt: '', ...c };
    s.changes[f.path.toLowerCase()] = f;
  }
  return s;
}

describe('report', () => {
  it('lists files, hunks and counters; critical files first; hunk text hidden for critical files', () => {
    const s = sess([
      { path: 'src/a.ts', kind: 'M', hunks: { h1: 'accepted', h2: 'pending' }, hunkMeta: { h1: { header: '@@ -1,3 +1,3 @@ const x = 1', added: 1, removed: 1, newStart: 1, newLines: 3, firstLine: 0 }, h2: { header: '@@ -10,2 +10,3 @@ foo()', added: 1, removed: 0, newStart: 10, newLines: 3, firstLine: 10 } } },
      { path: '.env', kind: 'M', critical: true, hunks: { h3: 'pending' }, hunkMeta: { h3: { header: '@@ -1,1 +1,1 @@ STRIPE_KEY=sk_live_abcdef', added: 1, removed: 1, newStart: 1, newLines: 1, firstLine: 0 } } },
    ]);
    const md = buildReport(s, { folderName: 'demo', now: new Date('2026-08-16T10:30:00Z') });
    assert.ok(md.startsWith('# ChangeKeeper session report — demo'));
    assert.ok(md.includes('- Files: 2 (0 added, 2 modified, 0 deleted, 0 renamed) · critical: 1'));
    assert.ok(md.includes('- Hunks: 3 (1 accepted, 2 pending, 0 discarded)'));
    assert.ok(md.indexOf('.env') < md.indexOf('src/a.ts'), 'critical first');
    assert.ok(md.includes('`@@ -1,3 +1,3 @@ const x = 1`'), 'non-critical hunk keeps its first changed line');
    assert.ok(!md.includes('sk_live'), 'critical file hunk text is not in the report');
    assert.ok(md.includes('`@@ -1,1 +1,1 @@`'), 'critical hunk keeps only the range');
    assert.ok(md.includes('## Suggested commit message'));
    assert.ok(md.includes('30 min'));
  });

  it('suggests a conventional-commit-ish message: type by area, no scope duplication, ≤72 chars head', () => {
    const one = suggestCommitMessage(sess([{ path: 'README.md', kind: 'M' }]));
    assert.ok(one.startsWith('docs: update README.md'), one);
    const two = suggestCommitMessage(sess([{ path: 'src/a.ts', kind: 'A' }, { path: 'src/b.ts', kind: 'A' }]));
    assert.ok(two.startsWith('feat(src): add 2 files\n'), two);
    assert.ok(!two.includes('in src'), 'scope is not repeated in the subject');
    const tests = suggestCommitMessage(sess([{ path: 'test/x.test.ts' }, { path: 'test/y.test.ts' }]));
    assert.ok(tests.startsWith('test('), tests);
    // "fix" needs a word boundary: prefix.ts / fixtures are not fixes
    const notFix = suggestCommitMessage(sess([{ path: 'src/utils/prefix.ts' }, { path: 'src/dispatcher.ts' }]));
    assert.ok(notFix.startsWith('feat('), notFix);
    const fix = suggestCommitMessage(sess([{ path: 'src/fixes/thing.ts' }, { path: 'src/other.ts' }]));
    assert.ok(fix.startsWith('fix('), fix);
    const long = suggestCommitMessage(sess([{ path: 'a/' + 'x'.repeat(120) + '.ts', kind: 'M' }]));
    assert.ok(long.split('\n')[0].length <= 72);
    const many = suggestCommitMessage(sess(Array.from({ length: 40 }, (_, i) => ({ path: `p/f${i}.ts`, kind: 'M' as const }))));
    assert.ok(many.includes('… and 10 more'));
    assert.strictEqual(suggestCommitMessage(sess([])), 'chore: no changes');
  });
});
