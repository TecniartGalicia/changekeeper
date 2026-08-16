import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeHunks, discardHunkOnLines, hunkHeader, hunkNewLines, hunkOldLines } from '../../core/hunks';
import { decodeText, detectEol, dominantEol, encodeText, joinLines, looksBinary, plainLines, splitLines } from '../../core/textfile';
import { atomicWrite, planGc, WorkspaceStore } from '../../core/store';
import { buildRuleSet, DEFAULT_CRITICAL, PathRules } from '../../core/rules/exclude';
import { BurstDetector } from '../../core/guardrails';
import { parseCatFileBatch, parseCatFileSingle, parseCheckAttr, parseCheckIgnore, parseHead, parseLsFilesStage, parseStatusV2 } from '../../core/gitparse';
import { fromRelPosix, gitBlobSha1, pathKey, toRelPosix, workspaceKey } from '../../core/paths';
import { counters, FileChange, newSession, reconcileHunks } from '../../core/session';

const L = (s: string) => plainLines(splitLines(s));

describe('textfile', () => {
  it('splitLines keeps every terminator and round-trips', () => {
    for (const s of ['', 'a', 'a\n', 'a\r\nb', 'a\r\nb\n', '\n', '\r\n\r\n', 'x\ny\r\nz']) {
      assert.strictEqual(joinLines(splitLines(s)), s, JSON.stringify(s));
    }
    assert.deepStrictEqual(splitLines('a\r\nb'), [
      { text: 'a', eol: '\r\n' },
      { text: 'b', eol: '' },
    ]);
  });
  it('detects EOL styles', () => {
    assert.strictEqual(detectEol(splitLines('a\nb\n')), 'lf');
    assert.strictEqual(detectEol(splitLines('a\r\nb\r\n')), 'crlf');
    assert.strictEqual(detectEol(splitLines('a\r\nb\n')), 'mixed');
    assert.strictEqual(detectEol(splitLines('a')), 'none');
    assert.strictEqual(dominantEol(splitLines('a\r\nb\r\nc\n')), '\r\n');
    assert.strictEqual(dominantEol(splitLines('a'), '\r\n'), '\r\n');
  });
  it('binary sniffing and BOM', () => {
    assert.ok(looksBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])));
    assert.ok(!looksBinary(Buffer.from('héllo wörld', 'utf8')));
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x')]);
    const d = decodeText(withBom);
    assert.strictEqual(d.text, 'x');
    assert.ok(d.bom);
    assert.deepStrictEqual(encodeText('x', true), withBom);
  });
});

describe('hunks', () => {
  it('groups nearby changes with context and numbers lines like unified diff', () => {
    const oldT = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n';
    const newT = 'a\nB\nc\nd\ne\nf\ng\nh\ni\nJ\nk\nl\n'; // gap of 7 unchanged lines (> 2*3) → two hunks
    const hs = computeHunks(L(oldT), L(newT));
    assert.strictEqual(hs.length, 2);
    assert.deepStrictEqual([hs[0].oldStart, hs[0].oldLines, hs[0].newStart, hs[0].newLines], [1, 5, 1, 5]);
    assert.strictEqual(hs[0].added, 1);
    assert.strictEqual(hs[0].removed, 1);
    assert.deepStrictEqual([hs[1].oldStart, hs[1].oldLines, hs[1].newStart, hs[1].newLines], [7, 5, 7, 6]);
    assert.ok(hunkHeader(hs[1]).startsWith('@@ -7,5 +7,6 @@'));
  });
  it('merges changes whose gap fits inside 2*context', () => {
    const oldT = 'a\nb\nc\nd\ne\nf\ng\nh\n';
    const newT = 'A\nb\nc\nd\ne\nf\nG\nh\n'; // gap of 5 unchanged lines (<= 6) → one hunk
    assert.strictEqual(computeHunks(L(oldT), L(newT)).length, 1);
    const newT2 = 'A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL\n';
    assert.strictEqual(computeHunks(L(oldT + 'i\nj\nk\nl\n'), L(newT2)).length, 2);
  });
  it('pure insertion at start / deletion at end / empty baseline', () => {
    const ins = computeHunks(L('a\nb\n'), L('x\na\nb\n'));
    assert.strictEqual(ins.length, 1);
    assert.strictEqual(ins[0].oldStart, 1); // context line 'a' is included, so oldStart is 1
    const del = computeHunks(L('a\nb\nc\n'), L('a\nb\n'));
    assert.strictEqual(del[0].removed, 1);
    const empty = computeHunks([], L('n1\nn2\n'));
    assert.strictEqual(empty.length, 1);
    assert.strictEqual(empty[0].oldStart, 0);
    assert.strictEqual(empty[0].oldLines, 0);
    assert.strictEqual(empty[0].newLines, 2);
    assert.strictEqual(computeHunks(L('same\n'), L('same\n')).length, 0);
  });
  it('ids are stable when an earlier hunk is discarded', () => {
    const base = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n';
    const cur = 'A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nK\nl\nm\n';
    const h1 = computeHunks(L(base), L(cur));
    assert.strictEqual(h1.length, 2);
    // discard the first hunk
    const out = discardHunkOnLines(splitLines(cur), splitLines(base), h1[0], '\n')!;
    const h2 = computeHunks(L(base), plainLines(out));
    assert.strictEqual(h2.length, 1);
    assert.strictEqual(h2[0].id, h1[1].id);
  });
  it('discard restores baseline lines with their real terminators (CRLF, mixed, no final newline)', () => {
    const base = 'a\r\nb\r\nc\r\n';
    const cur = 'a\r\nB\r\nc\r\n';
    const hs = computeHunks(L(base), L(cur));
    const out = discardHunkOnLines(splitLines(cur), splitLines(base), hs[0], '\n')!;
    assert.strictEqual(joinLines(out), base);

    const baseMixed = 'a\nb\r\nc\n';
    const curMixed = 'a\nb\r\nc\nd';
    const hm = computeHunks(L(baseMixed), L(curMixed));
    const outM = discardHunkOnLines(splitLines(curMixed), splitLines(baseMixed), hm[0], '\r\n')!;
    assert.strictEqual(joinLines(outM), baseMixed);

    const baseNoNl = 'a\nb';
    const curNoNl = 'a\nb\nc';
    const hn = computeHunks(L(baseNoNl), L(curNoNl));
    const outN = discardHunkOnLines(splitLines(curNoNl), splitLines(baseNoNl), hn[0], '\n')!;
    assert.strictEqual(joinLines(outN), baseNoNl);

    // baseline ended with newline, current does not: discarding restores it
    const base2 = 'a\nb\n';
    const cur2 = 'a\nb\nc';
    const h2 = computeHunks(L(base2), L(cur2));
    assert.strictEqual(joinLines(discardHunkOnLines(splitLines(cur2), splitLines(base2), h2[0], '\n')!), base2);
  });
  it('discard only touches the hunk range; other edits stay', () => {
    const base = '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n';
    const cur = 'X\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\nY\n';
    const hs = computeHunks(L(base), L(cur));
    assert.strictEqual(hs.length, 2);
    const out = discardHunkOnLines(splitLines(cur), splitLines(base), hs[1], '\n')!;
    assert.strictEqual(joinLines(out), 'X\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n');
  });
  it('detects stale hunks', () => {
    const base = 'a\nb\nc\n';
    const cur = 'a\nB\nc\n';
    const hs = computeHunks(L(base), L(cur));
    assert.strictEqual(discardHunkOnLines(splitLines('a\nZ\nc\n'), splitLines(base), hs[0], '\n'), undefined);
    assert.deepStrictEqual(hunkOldLines(hs[0]), ['a', 'b', 'c']);
    assert.deepStrictEqual(hunkNewLines(hs[0]), ['a', 'B', 'c']);
  });
  it('falls back to a single hunk when the diff is too expensive', () => {
    const big1 = Array.from({ length: 4000 }, (_, i) => `l${i}`);
    const big2 = Array.from({ length: 4000 }, (_, i) => `m${(i * 7919) % 4000}`);
    const hs = computeHunks(big1, big2, { timeoutMs: 1 });
    assert.ok(hs.length >= 1);
    // even in fallback the hunks must round-trip: discarding all restores the baseline
    let cur = splitLines(big2.join('\n') + '\n');
    for (const h of [...hs].reverse()) cur = discardHunkOnLines(cur, splitLines(big1.join('\n') + '\n'), h, '\n')!;
    assert.strictEqual(joinLines(cur), big1.join('\n') + '\n');
  });
});

describe('store', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-store-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('atomicWrite creates dirs and leaves no temp files', async () => {
    const f = path.join(dir, 'a', 'b', 'x.json');
    await atomicWrite(f, '{"a":1}');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"a":1}');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(f)), ['x.json']);
  });
  it('blobs are content-addressed and idempotent', async () => {
    const st = new WorkspaceStore(dir, 'C:/x');
    await st.ensure();
    const sha = await st.putBlob(Buffer.from('hello'));
    assert.strictEqual(sha, await st.putBlob(Buffer.from('hello')));
    assert.strictEqual((await st.getBlob(sha))!.toString(), 'hello');
    assert.strictEqual(await st.getBlob('0'.repeat(64)), undefined);
    assert.strictEqual((await st.listBlobs()).length, 1);
  });
  it('lock: live owner blocks, dead owner is taken over, release only by owner', async () => {
    const st = new WorkspaceStore(dir, 'C:/x');
    await st.ensure();
    assert.deepStrictEqual(await st.acquireLock(100, () => true), { ok: true });
    assert.deepStrictEqual(await st.acquireLock(200, () => true), { ok: false, ownerPid: 100 });
    assert.deepStrictEqual(await st.acquireLock(200, (pid) => pid !== 100), { ok: true });
    await st.releaseLock(100); // not the owner any more → no-op
    assert.deepStrictEqual(await st.acquireLock(300, () => true), { ok: false, ownerPid: 200 });
    await st.releaseLock(200);
    assert.deepStrictEqual(await st.acquireLock(300, () => true), { ok: true });
  });
  it('index/session json round-trip', async () => {
    const st = new WorkspaceStore(dir, 'C:/x');
    await st.ensure();
    const idx = await st.readIndex();
    assert.strictEqual(idx.sessions.length, 0);
    idx.sessions.push({ id: 's1', startedAt: 'now' });
    await st.writeIndex(idx);
    assert.strictEqual((await st.readIndex()).sessions[0].id, 's1');
    await st.writeSessionJson('s1', { a: 1 });
    assert.deepStrictEqual(await st.readSessionJson('s1'), { a: 1 });
    await st.deleteSessionFiles('s1');
    assert.strictEqual(await st.readSessionJson('s1'), undefined);
  });
  it('planGc: retention, size cap on closed sessions, active never dropped, unreferenced blobs', () => {
    const day = 86400_000;
    const now = 100 * day;
    const plan = planGc({
      now,
      retentionDays: 30,
      maxBytes: 150,
      activeSessionId: 'act',
      sessions: [
        { id: 'old', startedAt: new Date(now - 40 * day).toISOString(), stoppedAt: new Date(now - 35 * day).toISOString(), blobRefs: ['b1'] },
        { id: 'act', startedAt: new Date(now - 50 * day).toISOString(), blobRefs: ['b2', 'shared'] },
        { id: 'c1', startedAt: new Date(now - 10 * day).toISOString(), stoppedAt: new Date(now - 9 * day).toISOString(), blobRefs: ['b3', 'shared'] },
        { id: 'c2', startedAt: new Date(now - 5 * day).toISOString(), stoppedAt: new Date(now - 4 * day).toISOString(), blobRefs: ['b4'] },
      ],
      blobSizes: { b1: 10, b2: 1000, shared: 100, b3: 100, b4: 100, orphan: 5 },
    });
    // 'old' by retention; closed size = c1(200) + c2(100) = 300 > 150 → drop oldest closed (c1) → 100 ok
    assert.deepStrictEqual(plan.dropSessions.sort(), ['c1', 'old']);
    assert.deepStrictEqual(plan.deleteBlobs.sort(), ['b1', 'b3', 'orphan']); // 'shared' still referenced by act
  });
});

describe('rules', () => {
  const rules = new PathRules(buildRuleSet({ userExcludes: ['**/generated/**'], userCritical: ['**/secrets/**'] }));
  it('critical beats excluded and ignored; hard excludes always win', () => {
    assert.deepStrictEqual(rules.decide('.env', true), { watch: true, critical: true, reason: 'critical' });
    assert.deepStrictEqual(rules.decide('.env.local', true).watch, true);
    assert.deepStrictEqual(rules.decide('.claude/settings.local.json', true).critical, true);
    assert.deepStrictEqual(rules.decide('.git/HEAD', false), { watch: false, critical: false, reason: 'hard' });
    assert.deepStrictEqual(rules.decide('node_modules/x/index.js', false).reason, 'excluded');
    assert.deepStrictEqual(rules.decide('src/generated/a.ts', false).reason, 'excluded');
    assert.deepStrictEqual(rules.decide('src/a.ts', true).reason, 'ignored');
    assert.deepStrictEqual(rules.decide('src/a.ts', false).reason, 'ok');
    assert.deepStrictEqual(rules.decide('app/secrets/x.txt', true).critical, true);
    assert.deepStrictEqual(rules.decide('db/migrations/001.sql', false).critical, true);
    assert.deepStrictEqual(rules.decide('.github/workflows/ci.yml', false).critical, true);
    assert.deepStrictEqual(rules.decide('sub/pkg/package.json', false).critical, true);
    assert.deepStrictEqual(rules.decide('Dockerfile', false).critical, true);
    assert.deepStrictEqual(rules.decide('README.md', false).critical, false);
  });
  it('defaults can be disabled', () => {
    const r = new PathRules(buildRuleSet({ excludeDefaults: false }));
    assert.strictEqual(r.decide('dist/bundle.js', false).watch, true);
    assert.strictEqual(r.decide('.git/index', false).watch, false);
    assert.ok(DEFAULT_CRITICAL.includes('**/.env*'));
  });
  it('is case-insensitive', () => {
    assert.strictEqual(rules.decide('DOCKERFILE.prod', false).critical, true);
  });
});

describe('guardrails', () => {
  it('burst detector trips once above threshold within the window and resets', () => {
    let t = 0;
    const b = new BurstDetector(3, 1000, () => t);
    assert.strictEqual(b.register('a'), false);
    assert.strictEqual(b.register('b'), false);
    assert.strictEqual(b.register('c'), false);
    assert.strictEqual(b.register('a'), false); // duplicate
    assert.strictEqual(b.register('d'), true); // 4 > 3
    assert.ok(b.paused);
    assert.strictEqual(b.register('e'), false); // already paused
    b.reset();
    t = 5000;
    assert.strictEqual(b.register('f'), false);
    assert.strictEqual(b.windowCount, 1);
  });
});

describe('gitparse', () => {
  it('ls-files -s -z', () => {
    const e = parseLsFilesStage(['100644 d0d6371de329ffb232ba2fb9b79732165a702be7 0\t.gitattributes', '100755 abc 0\tbin/run sh', '160000 def 0\tsub'].join('\0') + '\0');
    assert.strictEqual(e.length, 3);
    assert.deepStrictEqual(e[1], { mode: '100755', oid: 'abc', stage: 0, path: 'bin/run sh' });
    assert.strictEqual(e[2].mode, '160000');
  });
  it('status --porcelain=v2 -z with changed, renamed, untracked and unmerged', () => {
    const s = ['1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts', '1 M. N... 100644 100644 100644 aaaa cccc src/b.ts', '1 .D N... 100644 100644 000000 aaaa dddd gone.txt', '2 R. N... 100644 100644 100644 eeee ffff R100 new name.txt', 'old name.txt', 'u UU N... 100644 100644 100644 100644 1111 2222 3333 conflict.txt', '? untracked dir/x.js', '! ignored.log'].join('\0') + '\0';
    const e = parseStatusV2(s);
    assert.strictEqual(e.length, 7);
    assert.deepStrictEqual(e[0], { path: 'src/a.ts', x: '.', y: 'M', kind: 'changed', indexOid: 'bbbb' });
    assert.deepStrictEqual(e[1].y, '.');
    assert.deepStrictEqual(e[2].y, 'D');
    assert.deepStrictEqual([e[3].path, e[3].origPath, e[3].kind], ['new name.txt', 'old name.txt', 'renamed']);
    assert.deepStrictEqual([e[4].path, e[4].kind], ['conflict.txt', 'unmerged']);
    assert.deepStrictEqual([e[5].path, e[5].kind], ['untracked dir/x.js', 'untracked']);
    assert.deepStrictEqual([e[6].path, e[6].kind], ['ignored.log', 'ignored']);
  });
  it('check-ignore / check-attr / head', () => {
    assert.deepStrictEqual([...parseCheckIgnore('node_modules/x\0.env\0')], ['node_modules/x', '.env']);
    const a = parseCheckAttr('package.json\0filter\0unspecified\0big.bin\0filter\0lfs\0');
    assert.strictEqual(a.get('big.bin')!.filter, 'lfs');
    assert.strictEqual(parseHead('abc'), undefined);
    assert.strictEqual(parseHead('a'.repeat(40) + '\n'), 'a'.repeat(40));
  });
  it('cat-file --batch framing incl. missing and binary content', () => {
    const body = Buffer.from([0x00, 0x01, 0x0a, 0x02]);
    const out = Buffer.concat([Buffer.from(`${'a'.repeat(40)} blob ${body.length}\n`), body, Buffer.from('\n'), Buffer.from(`${'b'.repeat(40)} missing\n`), Buffer.from(`${'c'.repeat(40)} blob 2\nhi\n`)]);
    const recs = parseCatFileBatch(out);
    assert.strictEqual(recs.length, 3);
    assert.deepStrictEqual(recs[0].content, body);
    assert.strictEqual(recs[1].content, undefined);
    assert.strictEqual(recs[2].content!.toString(), 'hi');
    // --filters: header size is the raw size, body is filtered → single-object parser ignores the size
    const filtered = Buffer.from(`${'a'.repeat(40)} blob 14\none\r\ntwo\r\nthree\r\n\n`);
    assert.strictEqual(parseCatFileSingle(filtered)!.content!.toString(), 'one\r\ntwo\r\nthree\r\n');
    assert.strictEqual(parseCatFileSingle(Buffer.from(`${'b'.repeat(40)} missing\n`))!.content, undefined);
  });
});

describe('paths', () => {
  it('workspaceKey normalises drive letter, slashes and trailing separator on win32', () => {
    assert.strictEqual(workspaceKey('C:\\Repo\\', 'win32'), workspaceKey('c:/repo', 'win32'));
    assert.notStrictEqual(workspaceKey('/a/b', 'linux'), workspaceKey('/a/B', 'linux'));
    assert.strictEqual(workspaceKey('/a/b/', 'linux'), workspaceKey('/a/b', 'linux'));
  });
  it('rel/abs conversions on both platforms', () => {
    assert.strictEqual(toRelPosix('C:\\w', 'C:\\w\\src\\a.ts', path.win32), 'src/a.ts');
    assert.strictEqual(toRelPosix('C:\\w', 'D:\\other\\a.ts', path.win32), undefined);
    assert.strictEqual(toRelPosix('/w', '/w/src/a.ts', path.posix), 'src/a.ts');
    assert.strictEqual(toRelPosix('/w', '/w', path.posix), '');
    assert.strictEqual(fromRelPosix('C:\\w', 'src/a.ts', path.win32), 'C:\\w\\src\\a.ts');
    assert.strictEqual(pathKey('Src/A.ts', 'win32'), 'src/a.ts');
    assert.strictEqual(pathKey('Src/A.ts', 'linux'), 'Src/A.ts');
  });
  it('gitBlobSha1 matches git hash-object', () => {
    // echo -n "hello" | git hash-object --stdin → b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0
    assert.strictEqual(gitBlobSha1(Buffer.from('hello')), 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0');
  });
});

describe('session model', () => {
  it('counters and hunk reconciliation keep states by id and archive vanished ones', () => {
    const s = newSession({ id: 's', folder: '/w', kind: 'git' });
    const f: FileChange = { path: 'a', kind: 'M', critical: false, hunks: {}, firstSeenAt: '', lastChangeAt: '' };
    s.changes['a'] = f;
    const hs = computeHunks(L('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n'), L('A\nb\nc\nd\ne\nf\ng\nh\ni\nJ\n'));
    reconcileHunks(f, hs);
    assert.strictEqual(Object.keys(f.hunks).length, 2);
    f.hunks[hs[0].id] = 'accepted';
    f.hunks[hs[1].id] = 'discarded';
    reconcileHunks(f, [hs[0]]); // second vanished
    assert.strictEqual(f.hunks[hs[0].id], 'accepted');
    assert.strictEqual(f.archivedDiscarded, 1);
    const c = counters(s);
    assert.strictEqual(c.files, 1);
    assert.strictEqual(c.accepted, 1);
    assert.strictEqual(c.reviewedFiles, 1);
  });
});
