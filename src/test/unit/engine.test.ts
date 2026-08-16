import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Engine, EngineError } from '../../core/engine';
import { DEFAULT_LIMITS, Limits } from '../../core/guardrails';
import { NodeFs, NodeGit } from '../../core/nodeAdapters';
import { buildRuleSet, PathRules } from '../../core/rules/exclude';
import { WorkspaceStore } from '../../core/store';

/**
 * Engine tests against a real git repository in a temp folder. `git` must be on PATH (it is in CI).
 * The "agent" is simulated with plain fs writes and git commands from this process, exactly like a
 * CLI agent would do.
 */

const GIT = process.env.CK_TEST_GIT || 'git';

function git(cwd: string, ...args: string[]): string {
  return execFileSync(GIT, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd, USERPROFILE: cwd } });
}

function initRepo(dir: string, opts: { autocrlf?: boolean } = {}): void {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'ck@test');
  git(dir, 'config', 'user.name', 'CK Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', opts.autocrlf ? 'true' : 'false');
}

function write(dir: string, rel: string, content: string | Buffer): void {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function read(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
}

interface Ctx {
  repo: string;
  storeDir: string;
  store: WorkspaceStore;
  engine: Engine;
  openDocs: Map<string, string>;
  changed: number;
}

function makeEngine(repo: string, storeDir: string, opts: { git?: boolean; limits?: Partial<Limits>; pid?: number; userExcludes?: string[] } = {}): Ctx {
  const store = new WorkspaceStore(storeDir, repo);
  const openDocs = new Map<string, string>();
  const ctx: Partial<Ctx> = { repo, storeDir, store, openDocs, changed: 0 };
  const engine = new Engine(repo, {
    store,
    git: opts.git === false ? undefined : new NodeGit(GIT, repo),
    fs: new NodeFs(),
    openDoc: (rel) => (openDocs.has(rel) ? { text: openDocs.get(rel)!, dirty: true } : undefined),
    rules: new PathRules(buildRuleSet({ userExcludes: opts.userExcludes })),
    limits: { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) },
    pid: opts.pid ?? process.pid,
    onChanged: () => {
      ctx.changed = (ctx.changed ?? 0) + 1;
    },
  });
  ctx.engine = engine;
  return ctx as Ctx;
}

describe('engine (git)', function () {
  this.timeout(60000);
  let root: string;
  let ctx: Ctx;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-eng-'));
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    initRepo(repo);
    write(repo, 'src/a.ts', 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n');
    write(repo, 'src/b.ts', 'b1\nb2\n');
    write(repo, 'README.md', '# hi\n');
    write(repo, '.gitignore', 'node_modules/\n.env\n*.log\n');
    write(repo, 'db/migrations/001.sql', 'create table x;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    // pre-existing dirty + untracked state
    write(repo, 'src/b.ts', 'b1\nb2 dirty before session\n');
    write(repo, 'notes.txt', 'untracked at start\n');
    ctx = makeEngine(repo, path.join(root, 'store'));
  });
  afterEach(async () => {
    await ctx.engine.detach().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('builds a baseline from the index without copying clean files, copies dirty/untracked', async () => {
    const s = await ctx.engine.start();
    assert.strictEqual(s.kind, 'git');
    const rows = ctx.engine.baseline!.rows;
    const byPath = new Map(rows.map((r) => [r[0], r]));
    assert.strictEqual(byPath.get('src/a.ts')![1], 'git-blob');
    assert.strictEqual(byPath.get('src/b.ts')![1], 'store'); // dirty at start → copied
    assert.strictEqual(byPath.get('notes.txt')![1], 'store'); // untracked → copied
    assert.strictEqual(byPath.get('db/migrations/001.sql')![1], 'git-blob');
    assert.strictEqual((await ctx.store.listBlobs()).length, 2);
    // untouched → no changes
    assert.strictEqual(ctx.engine.changes().length, 0);
    const idx = await ctx.store.readIndex();
    assert.strictEqual(idx.activeSessionId, s.id);
  });

  it('detects M/A/D/R with hunks, and equality removes the change', async () => {
    await ctx.engine.start();
    const e = ctx.engine;
    // modify clean tracked file (like `sed -i` from a CLI agent)
    write(ctx.repo, 'src/a.ts', 'line1 CHANGED\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\n');
    const ch = await e.handlePath('src/a.ts');
    assert.ok(ch);
    assert.strictEqual(ch!.kind, 'M');
    const view = await e.view('src/a.ts');
    assert.strictEqual(view!.hunks!.length, 2);
    assert.strictEqual(view!.baselineText, 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n');
    assert.ok(Object.keys(ch!.hunks).length === 2);
    // materialised into the store by OID
    assert.strictEqual((await ctx.store.listBlobs()).length, 3);
    // same content back → change disappears
    write(ctx.repo, 'src/a.ts', 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n');
    assert.strictEqual(await e.handlePath('src/a.ts'), undefined);
    assert.strictEqual(e.changes().length, 0);
    // new file
    write(ctx.repo, 'src/new.ts', 'n1\nn2\n');
    const a = await e.handlePath('src/new.ts');
    assert.strictEqual(a!.kind, 'A');
    assert.strictEqual(Object.keys(a!.hunks).length, 1);
    // delete tracked
    fs.rmSync(path.join(ctx.repo, 'README.md'));
    const d = await e.handlePath('README.md');
    assert.strictEqual(d!.kind, 'D');
    // rename: delete b (baseline is the dirty copy) and create c with those bytes
    const bContent = read(ctx.repo, 'src/b.ts');
    fs.rmSync(path.join(ctx.repo, 'src', 'b.ts'));
    await e.handlePath('src/b.ts');
    write(ctx.repo, 'src/c.ts', bContent);
    const r = await e.handlePath('src/c.ts');
    assert.strictEqual(r!.kind, 'R');
    assert.strictEqual(r!.renamedFrom, 'src/b.ts');
    // new file deleted again → gone
    fs.rmSync(path.join(ctx.repo, 'src', 'new.ts'));
    assert.strictEqual(await e.handlePath('src/new.ts'), undefined);
    const c = e.counters!;
    assert.strictEqual(c.deleted, 2);
    assert.strictEqual(c.renamed, 1);
  });

  it('discard writes exactly the hunk back; restore + undo round-trip', async () => {
    await ctx.engine.start();
    const e = ctx.engine;
    write(ctx.repo, 'src/a.ts', 'X\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nY\n');
    await e.handlePath('src/a.ts');
    const v = await e.view('src/a.ts');
    assert.strictEqual(v!.hunks!.length, 2);
    const plan = await e.planDiscard('src/a.ts', v!.hunks![1].id);
    assert.ok(plan.ok);
    if (!plan.ok) return;
    assert.strictEqual(plan.newText, 'X\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n');
    await e.applyDiscardToDisk(plan, v!.hunks![1].id);
    assert.strictEqual(read(ctx.repo, 'src/a.ts'), 'X\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n');
    const v2 = await e.view('src/a.ts');
    assert.strictEqual(v2!.hunks!.length, 1);
    assert.strictEqual(v2!.change.archivedDiscarded, 1);
    // stale hunk id → refused
    const stale = await e.planDiscard('src/a.ts', v!.hunks![1].id);
    assert.deepStrictEqual(stale.ok, false);
    // restore file → baseline; undo → back to X version
    const r = await e.restore(['src/a.ts'], 'file');
    assert.strictEqual(r.results[0].status, 'restored');
    assert.strictEqual(read(ctx.repo, 'src/a.ts'), 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n');
    assert.strictEqual(e.changes().length, 0);
    const rec = e.lastUndoableRestore();
    assert.ok(rec);
    const u = await e.undoRestore(rec!);
    assert.strictEqual(u[0].status, 'undone');
    assert.strictEqual(read(ctx.repo, 'src/a.ts'), 'X\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n');
    assert.strictEqual(e.changes().length, 1);
    // restore a created file = delete it; undo recreates
    write(ctx.repo, 'created.txt', 'new\n');
    await e.handlePath('created.txt');
    const r2 = await e.restore(['created.txt'], 'file');
    assert.strictEqual(r2.results[0].status, 'deleted');
    assert.ok(!fs.existsSync(path.join(ctx.repo, 'created.txt')));
    await e.undoRestore(e.lastUndoableRestore()!);
    assert.strictEqual(read(ctx.repo, 'created.txt'), 'new\n');
    // undo refuses when the file changed since the restore
    await e.restore(['created.txt'], 'file');
    write(ctx.repo, 'created.txt', 'edited after restore\n');
    const u2 = await e.undoRestore(e.lastUndoableRestore()!);
    assert.strictEqual(u2[0].status, 'skipped');
  });

  it('keeps the original baseline when the agent commits, checks out and stashes mid-session', async () => {
    await ctx.engine.start();
    const e = ctx.engine;
    write(ctx.repo, 'src/a.ts', 'line1\nline2 v2\nline3\nline4\nline5\nline6\nline7\nline8\n');
    git(ctx.repo, 'add', '-A');
    git(ctx.repo, 'commit', '-q', '-m', 'agent commit');
    // watcher event arrives after the commit (worst case): baseline must still be the pre-session content
    const ch = await e.handlePath('src/a.ts');
    assert.strictEqual(ch!.kind, 'M');
    const v = await e.view('src/a.ts');
    assert.strictEqual(v!.baselineText, 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n');
    // agent stashes / resets: file goes back → change disappears
    git(ctx.repo, 'reset', '-q', '--hard', 'HEAD~1');
    assert.strictEqual(await e.handlePath('src/a.ts'), undefined);
    // gc by the agent must not lose the captured blob (it is reachable from HEAD~ / reflog anyway)
    git(ctx.repo, 'gc', '-q', '--prune=now');
    write(ctx.repo, 'src/a.ts', 'zzz\n');
    const ch2 = await e.handlePath('src/a.ts');
    assert.strictEqual((await e.view('src/a.ts'))!.baselineText!.startsWith('line1\n'), true);
    assert.strictEqual(ch2!.kind, 'M');
  });

  it('critical files beat .gitignore; ignored files are not tracked; hard excludes never', async () => {
    await ctx.engine.start();
    const e = ctx.engine;
    write(ctx.repo, '.env', 'SECRET=1\n');
    const env = await e.handlePath('.env');
    assert.ok(env, '.env must be tracked although ignored');
    assert.strictEqual(env!.critical, true);
    assert.strictEqual(env!.kind, 'A');
    write(ctx.repo, 'debug.log', 'x\n');
    assert.strictEqual(await e.handlePath('debug.log'), undefined);
    write(ctx.repo, 'node_modules/p/index.js', 'x\n');
    assert.strictEqual(await e.handlePath('node_modules/p/index.js'), undefined);
    assert.strictEqual(await e.handlePath('.git/HEAD'), undefined);
    write(ctx.repo, 'db/migrations/002.sql', 'drop table x;\n');
    const mig = await e.handlePath('db/migrations/002.sql');
    assert.strictEqual(mig!.critical, true);
  });

  it('open (dirty) documents are the current content, and their edits count', async () => {
    await ctx.engine.start();
    const e = ctx.engine;
    ctx.openDocs.set('src/a.ts', 'line1\nEDIT\nline3\nline4\nline5\nline6\nline7\nline8\n');
    const ch = await e.handlePath('src/a.ts');
    assert.strictEqual(ch!.kind, 'M');
    const plan = await e.planDiscard('src/a.ts', Object.keys(ch!.hunks)[0]);
    assert.ok(plan.ok && plan.isOpen);
    if (plan.ok) {
      assert.strictEqual(plan.startLine, 0);
      assert.strictEqual(plan.endLine, 5);
      assert.strictEqual(plan.replacement, 'line1\nline2\nline3\nline4\nline5\n');
    }
    ctx.openDocs.delete('src/a.ts');
    assert.strictEqual(await e.handlePath('src/a.ts'), undefined);
  });

  it('burst guard pauses new paths and resumes on demand', async () => {
    ctx = makeEngine(ctx.repo, path.join(root, 'store2'), { limits: { burstThreshold: 3, burstWindowMs: 60_000 } });
    await ctx.engine.start();
    const e = ctx.engine;
    for (let i = 0; i < 6; i++) write(ctx.repo, `gen/f${i}.txt`, `${i}\n`);
    for (let i = 0; i < 6; i++) await e.handlePath(`gen/f${i}.txt`);
    assert.strictEqual(e.changes().length, 3);
    assert.ok(e.burst.paused);
    assert.strictEqual(e.burstQueue.length, 3);
    const n = await e.resumeBurst('track');
    assert.strictEqual(n, 3);
    assert.strictEqual(e.changes().length, 6);
    assert.ok(!e.burst.paused);
  });

  it('persists, resumes in a new engine and reconciles what changed while down', async () => {
    const s = await ctx.engine.start();
    write(ctx.repo, 'src/a.ts', 'A\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n');
    await ctx.engine.handlePath('src/a.ts');
    await ctx.engine.detach();
    // "VS Code closed": agent keeps working
    write(ctx.repo, 'src/b.ts', 'b1\nb2 changed while down\n');
    write(ctx.repo, 'brand-new.txt', 'hi\n');
    fs.rmSync(path.join(ctx.repo, 'db', 'migrations', '001.sql'));
    const ctx2 = makeEngine(ctx.repo, ctx.storeDir);
    assert.strictEqual(await ctx2.engine.resume(), true);
    assert.strictEqual(ctx2.engine.session!.id, s.id);
    assert.strictEqual(ctx2.engine.changes().length, 1);
    const n = await ctx2.engine.reconcile();
    assert.ok(n >= 4);
    const kinds = Object.fromEntries(ctx2.engine.changes().map((c) => [c.path, c.kind]));
    assert.deepStrictEqual(kinds, { 'src/a.ts': 'M', 'src/b.ts': 'M', 'brand-new.txt': 'A', 'db/migrations/001.sql': 'D' });
    // second window on the same folder is refused while the first is alive
    const ctx3 = makeEngine(ctx.repo, ctx.storeDir, { pid: process.pid + 100000 });
    await assert.rejects(() => ctx3.engine.resume(), (e: any) => e instanceof EngineError && e.code === 'locked');
    await ctx2.engine.stop();
    assert.strictEqual((await ctx.store.readIndex()).activeSessionId, undefined);
    ctx = ctx2;
  });

  it('gc keeps the active session and drops old closed ones', async () => {
    const s1 = await ctx.engine.start();
    write(ctx.repo, 'src/a.ts', 'old session change\n');
    await ctx.engine.handlePath('src/a.ts');
    await ctx.engine.stop();
    // backdate s1
    const idx = await ctx.store.readIndex();
    idx.sessions.find((x) => x.id === s1.id)!.stoppedAt = new Date(Date.now() - 40 * 86400_000).toISOString();
    await ctx.store.writeIndex(idx);
    const s2 = await ctx.engine.start();
    const res = await ctx.engine.gc(30, 500 * 1024 * 1024);
    assert.strictEqual(res.droppedSessions, 1);
    const idx2 = await ctx.store.readIndex();
    assert.deepStrictEqual(
      idx2.sessions.map((x) => x.id),
      [s2.id],
    );
  });
});

describe('engine (git, core.autocrlf=true)', function () {
  this.timeout(60000);
  let root: string;
  let ctx: Ctx;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-crlf-'));
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    initRepo(repo, { autocrlf: true });
    write(repo, 'win.txt', 'one\r\ntwo\r\nthree\r\n'); // committed as LF in the index, checked out CRLF
    write(repo, '.gitattributes', '* text=auto\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    ctx = makeEngine(repo, path.join(root, 'store'));
  });
  afterEach(async () => {
    await ctx.engine.detach().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a CRLF working file is not a change, and a one-line edit yields one small hunk', async () => {
    assert.ok(git(ctx.repo, 'ls-files', '--eol', 'win.txt').includes('i/lf'));
    await ctx.engine.start();
    // touch with identical bytes
    write(ctx.repo, 'win.txt', 'one\r\ntwo\r\nthree\r\n');
    assert.strictEqual(await ctx.engine.handlePath('win.txt'), undefined);
    write(ctx.repo, 'win.txt', 'one\r\nTWO\r\nthree\r\n');
    const ch = await ctx.engine.handlePath('win.txt');
    assert.strictEqual(ch!.kind, 'M');
    const v = await ctx.engine.view('win.txt');
    assert.strictEqual(v!.hunks!.length, 1);
    assert.strictEqual(v!.hunks![0].removed, 1);
    assert.strictEqual(v!.baselineText, 'one\r\ntwo\r\nthree\r\n', 'baseline must be the checkout form (CRLF), not the LF blob');
    // restore writes CRLF back
    await ctx.engine.restore(['win.txt'], 'file');
    assert.strictEqual(fs.readFileSync(path.join(ctx.repo, 'win.txt'), 'utf8'), 'one\r\ntwo\r\nthree\r\n');
  });
});

describe('engine (plain folder)', function () {
  this.timeout(60000);
  let root: string;
  let ctx: Ctx;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-plain-'));
    const folder = path.join(root, 'folder');
    fs.mkdirSync(folder);
    write(folder, 'a.txt', 'a1\na2\n');
    write(folder, 'sub/b.txt', 'b1\n');
    write(folder, 'node_modules/x.js', 'x');
    write(folder, 'big.bin', Buffer.alloc(3 * 1024 * 1024, 1));
    ctx = makeEngine(folder, path.join(root, 'store'), { git: false });
  });
  afterEach(async () => {
    await ctx.engine.detach().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('copies the folder as baseline (respecting excludes and size) and tracks changes', async () => {
    const s = await ctx.engine.start();
    assert.strictEqual(s.kind, 'plain');
    const rows = new Map(ctx.engine.baseline!.rows.map((r) => [r[0], r]));
    assert.strictEqual(rows.get('a.txt')![1], 'store');
    assert.strictEqual(rows.get('sub/b.txt')![1], 'store');
    assert.strictEqual(rows.has('node_modules/x.js'), false);
    assert.strictEqual(rows.get('big.bin')![1], 'unavailable');
    write(ctx.repo, 'a.txt', 'a1\nA2\n');
    const ch = await ctx.engine.handlePath('a.txt');
    assert.strictEqual(ch!.kind, 'M');
    assert.strictEqual(Object.keys(ch!.hunks).length, 1);
    write(ctx.repo, 'new.txt', 'n\n');
    assert.strictEqual((await ctx.engine.handlePath('new.txt'))!.kind, 'A');
    write(ctx.repo, 'big.bin', Buffer.alloc(3 * 1024 * 1024, 2));
    const big = await ctx.engine.handlePath('big.bin');
    assert.strictEqual(big!.tooLarge, true);
    assert.strictEqual(big!.baselineUnavailable, 'large');
    // reconcile after "reload" finds a change made while down
    await ctx.engine.detach();
    write(ctx.repo, 'sub/b.txt', 'b1\nb2\n');
    const ctx2 = makeEngine(ctx.repo, ctx.storeDir, { git: false });
    assert.strictEqual(await ctx2.engine.resume(), true);
    await ctx2.engine.reconcile();
    assert.ok(ctx2.engine.changes().some((c) => c.path === 'sub/b.txt' && c.kind === 'M'));
    ctx = ctx2;
  });
});
