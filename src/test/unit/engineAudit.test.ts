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

/** Regression tests for the F1a audit findings (docs/AUDITORIA.md, Auditoría F1a). Real git in temp folders. */

const GIT = process.env.CK_TEST_GIT || 'git';
const git = (cwd: string, ...args: string[]) => execFileSync(GIT, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd, USERPROFILE: cwd } });
const write = (dir: string, rel: string, content: string | Buffer) => {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};
const readBytes = (dir: string, rel: string) => fs.readFileSync(path.join(dir, ...rel.split('/')));
const TWELVE = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'].join(String.fromCharCode(10)) + String.fromCharCode(10);

function initRepo(dir: string): void {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'ck@test');
  git(dir, 'config', 'user.name', 'CK');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
}

function engineFor(folder: string, storeDir: string, opts: { git?: NodeGit; prefix?: string; limits?: Partial<Limits>; pid?: number; openDocs?: Map<string, string> } = {}): { engine: Engine; store: WorkspaceStore } {
  const store = new WorkspaceStore(storeDir, folder);
  const engine = new Engine(folder, {
    store,
    git: opts.git,
    gitPrefix: opts.prefix,
    fs: new NodeFs(),
    openDoc: (rel) => (opts.openDocs?.has(rel) ? { text: opts.openDocs.get(rel)!, dirty: true } : undefined),
    rules: new PathRules(buildRuleSet({})),
    limits: { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) },
    pid: opts.pid ?? process.pid,
  });
  return { engine, store };
}

describe('engine (audit F1a regressions)', function () {
  this.timeout(60000);
  let root: string;
  let repo: string;
  const engines: Engine[] = [];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-aud-'));
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    initRepo(repo);
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\n');
    write(repo, '.gitignore', '.env\n*.log\nnode_modules/\n');
    write(repo, '.env', 'SECRET=old\n'); // ignored, critical, pre-existing
    write(repo, 'node_modules/dep/package.json', '{"name":"dep"}\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
  });
  afterEach(async () => {
    for (const e of engines.splice(0)) await e.detach().catch(() => undefined);
    // git may keep a handle for a moment (submodule test); a leftover temp dir is not a test failure
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      console.warn(`temp dir not removed: ${String(e)}`);
    }
  });
  const mk = (opts: Parameters<typeof engineFor>[2] = {}, folder = repo, storeDir = path.join(root, 'store')) => {
    const r = engineFor(folder, storeDir, { git: new NodeGit(GIT, folder), ...opts });
    engines.push(r.engine);
    return r;
  };

  it('A1: latin1 (non-UTF-8) file — discard on disk touches only the hunk bytes; encoding round-trips', async () => {
    const latin = Buffer.from('caf\xe9\nni\xf1o\nl\xednea3\n', 'latin1');
    write(repo, 'latin.txt', latin);
    git(repo, 'add', 'latin.txt');
    git(repo, 'commit', '-q', '-m', 'latin');
    const { engine } = mk();
    await engine.start();
    write(repo, 'latin.txt', Buffer.concat([latin, Buffer.from('a\xf1adido\n', 'latin1')]));
    const ch = await engine.handlePath('latin.txt');
    assert.strictEqual(ch!.kind, 'M');
    const v = await engine.view('latin.txt');
    assert.strictEqual(v!.hunks!.length, 1);
    assert.strictEqual(v!.encoding, 'latin1');
    const plan = await engine.planDiscard('latin.txt', v!.hunks![0].id);
    assert.ok(plan.ok);
    if (!plan.ok) return;
    const r = await engine.applyDiscardToDisk(plan, v!.hunks![0].id);
    assert.ok(r.ok);
    assert.deepStrictEqual(readBytes(repo, 'latin.txt'), latin, 'bytes identical to the baseline, no U+FFFD');
    assert.strictEqual(engine.changes().length, 0);
  });

  it('A2/A15: pre-existing git-ignored critical file has a baseline; heavy trees are not critical', async () => {
    const { engine } = mk();
    await engine.start();
    const row = engine.baselineRow('.env');
    assert.ok(row && row[1] === 'store', '.env copied although ignored (critical)');
    assert.strictEqual(engine.baselineRow('node_modules/dep/package.json'), undefined, 'ignored heavy trees are not baselined');
    write(repo, '.env', 'SECRET=new\n');
    const ch = await engine.handlePath('.env');
    assert.strictEqual(ch!.kind, 'M', 'a modification, not an addition');
    assert.strictEqual(Object.keys(ch!.hunks).length, 1);
    const r = await engine.restore(['.env'], 'file');
    assert.strictEqual(r.results[0].status, 'restored');
    assert.strictEqual(readBytes(repo, '.env').toString(), 'SECRET=old\n');
    write(repo, 'node_modules/dep/package.json', '{"name":"dep","x":1}\n');
    assert.strictEqual(await engine.handlePath('node_modules/dep/package.json'), undefined);
  });

  it('A3: workspace folder inside the repo — path attributes are honoured when materialising', async () => {
    write(repo, '.gitattributes', 'sub/*.txt text eol=crlf\n');
    write(repo, 'sub/w.txt', 'one\r\ntwo\r\n');
    write(repo, 'other.md', 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'sub');
    // checkout form for sub/w.txt is CRLF (attribute), blob is LF
    const sub = path.join(repo, 'sub');
    const { engine } = mk({ git: new NodeGit(GIT, sub), prefix: 'sub/' }, sub, path.join(root, 'store-sub'));
    await engine.start();
    assert.ok(engine.baselineRow('w.txt'), 'rows are folder-relative');
    assert.strictEqual(engine.baselineRow('other.md'), undefined, 'files outside the folder are not part of the session');
    write(sub, 'w.txt', 'one\r\nTWO\r\n');
    const ch = await engine.handlePath('w.txt');
    assert.strictEqual(ch!.kind, 'M');
    const v = await engine.view('w.txt');
    assert.strictEqual(v!.baselineText, 'one\r\ntwo\r\n', 'baseline in checkout form (CRLF), attribute resolved against the repo root');
    assert.strictEqual(v!.hunks!.length, 1);
    assert.strictEqual(v!.hunks![0].removed, 1);
  });

  it('A4: re-baseline keeps the lock; another pid is still refused', async () => {
    const { engine, store } = mk();
    await engine.start();
    await engine.start();
    const other = await store.acquireLock(process.pid + 424242, () => true);
    assert.deepStrictEqual(other, { ok: false, ownerPid: process.pid });
    const { engine: e2 } = mk({ pid: process.pid + 424242 });
    await assert.rejects(() => e2.resume(), (e: any) => e instanceof EngineError && e.code === 'locked');
  });

  it('A5: accepting a file does not pre-accept later edits by the agent', async () => {
    const { engine } = mk();
    await engine.start();
    write(repo, 'a.txt', 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\n');
    await engine.handlePath('a.txt');
    engine.acceptFile('a.txt');
    assert.strictEqual(engine.counters!.pending, 0);
    write(repo, 'a.txt', 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\nTWELVE\n');
    const ch = await engine.handlePath('a.txt');
    assert.strictEqual(ch!.fileAccepted, false);
    const states = Object.values(ch!.hunks);
    assert.ok(states.includes('pending'), 'the new hunk is pending');
    assert.ok(states.includes('accepted'), 'the previously accepted hunk keeps its state');
  });

  it('A6: reconcile re-checks copied and missing rows after a reload', async () => {
    write(repo, 'dirty.txt', 'v1\n');
    git(repo, 'add', 'dirty.txt');
    git(repo, 'commit', '-q', '-m', 'd');
    write(repo, 'dirty.txt', 'v1 dirty\n');
    fs.rmSync(path.join(repo, 'a.txt')); // deleted in the worktree at start → row 'missing'
    const { engine, store } = mk();
    await engine.start();
    assert.strictEqual(engine.baselineRow('dirty.txt')![1], 'store');
    assert.strictEqual(engine.baselineRow('a.txt')![1], 'missing');
    await engine.detach();
    git(repo, 'checkout', '--', 'dirty.txt'); // clean again while VS Code is closed
    git(repo, 'checkout', '--', 'a.txt'); // recreated (equals HEAD, so plain status shows nothing)
    const e2 = engineFor(repo, store.root, { git: new NodeGit(GIT, repo) }).engine;
    engines.push(e2);
    assert.ok(await e2.resume());
    await e2.reconcile();
    const kinds = Object.fromEntries(e2.changes().map((c) => [c.path, c.kind]));
    assert.deepStrictEqual(kinds, { 'dirty.txt': 'M', 'a.txt': 'A' });
  });

  it('A9/A22: tracked files above the size limit are not materialised (and the negative answer is cached)', async () => {
    write(repo, 'big.bin', Buffer.alloc(300 * 1024, 7));
    git(repo, 'add', 'big.bin');
    git(repo, 'commit', '-q', '-m', 'big');
    const { engine, store } = mk({ limits: { maxFileBytes: 100 * 1024 } });
    await engine.start();
    write(repo, 'big.bin', Buffer.alloc(300 * 1024, 8));
    const ch = await engine.handlePath('big.bin');
    assert.strictEqual(ch!.tooLarge, true);
    assert.strictEqual(ch!.baselineUnavailable, 'large');
    assert.ok((await store.listBlobs()).every((b) => b.size < 200 * 1024), 'the big blob was not copied into the store');
    await engine.handlePath('big.bin');
    const mat = await (async () => {
      await engine.flush();
      return store.readMaterialized(engine.session!.id);
    })();
    assert.strictEqual(mat['big.bin'], '!large');
  });

  it('A10: rename detected whichever half arrives first; the deleted half is not double-counted', async () => {
    const { engine } = mk();
    await engine.start();
    const content = readBytes(repo, 'a.txt');
    write(repo, 'b.txt', content);
    fs.rmSync(path.join(repo, 'a.txt'));
    const a = await engine.handlePath('b.txt'); // A first
    assert.strictEqual(a!.kind, 'A');
    const d = await engine.handlePath('a.txt'); // then D → the A becomes R
    assert.strictEqual(d!.kind, 'D');
    const b = engine.changes().find((c) => c.path === 'b.txt')!;
    assert.strictEqual(b.kind, 'R');
    assert.strictEqual(b.renamedFrom, 'a.txt');
    assert.strictEqual(engine.counters!.renamed, 1);
    assert.strictEqual(engine.counters!.deleted, 0);
    // source comes back → plain addition again
    write(repo, 'a.txt', content);
    await engine.handlePath('a.txt');
    assert.strictEqual(engine.changes().find((c) => c.path === 'b.txt')!.kind, 'A');
  });

  it('A14: EOL-only change is flagged (M with no hunks, eolOnly)', async () => {
    const { engine } = mk();
    await engine.start();
    write(repo, 'a.txt', 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven\r\neight\r\nnine\r\nten\r\neleven\r\ntwelve\r\n');
    const ch = await engine.handlePath('a.txt');
    assert.strictEqual(ch!.kind, 'M');
    assert.strictEqual(Object.keys(ch!.hunks).length, 0);
    assert.strictEqual(ch!.eolOnly, true);
  });

  it('A21: applying a stale discard plan is refused', async () => {
    const { engine } = mk();
    await engine.start();
    write(repo, 'a.txt', TWELVE.replace('one', 'ONE'));
    await engine.handlePath('a.txt');
    const v = await engine.view('a.txt');
    const plan = await engine.planDiscard('a.txt', v!.hunks![0].id);
    assert.ok(plan.ok);
    write(repo, 'a.txt', TWELVE.replace('one', 'ONE!'));
    if (plan.ok) {
      const r = await engine.applyDiscardToDisk(plan, v!.hunks![0].id);
      assert.deepStrictEqual(r, { ok: false, reason: 'stale' });
      assert.strictEqual(readBytes(repo, 'a.txt').toString(), TWELVE.replace('one', 'ONE!'), 'nothing written');
    }
  });

  it('A23: an open clean document whose file was deleted on disk counts as deleted', async () => {
    const openDocs = new Map<string, string>();
    const { engine } = mk({ openDocs });
    // engineFor's openDoc marks docs dirty; emulate a clean one by returning dirty:false through a custom engine
    const store = new WorkspaceStore(path.join(root, 'store2'), repo);
    const clean = new Engine(repo, {
      store,
      git: new NodeGit(GIT, repo),
      fs: new NodeFs(),
      openDoc: (rel) => (rel === 'a.txt' ? { text: readBytes(repo, 'a.txt').toString(), dirty: false } : undefined),
      rules: new PathRules(buildRuleSet({})),
      limits: DEFAULT_LIMITS,
      pid: process.pid + 7,
    });
    engines.push(clean);
    await engine.detach();
    await clean.start();
    // the document text is captured now (as VS Code would still hold it), then the agent deletes the file
    const captured = readBytes(repo, 'a.txt').toString();
    (clean as any).deps.openDoc = (rel: string) => (rel === 'a.txt' ? { text: captured, dirty: false } : undefined);
    fs.rmSync(path.join(repo, 'a.txt'));
    const ch = await clean.handlePath('a.txt');
    assert.strictEqual(ch!.kind, 'D');
    void openDocs;
  });

  it('A7: files inside a submodule are marked unavailable:submodule instead of "new"', async () => {
    const subRepo = path.join(root, 'subrepo');
    fs.mkdirSync(subRepo);
    initRepo(subRepo);
    write(subRepo, 's.txt', 'sub content\n');
    git(subRepo, 'add', '-A');
    git(subRepo, 'commit', '-q', '-m', 'sub init');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subRepo, 'sub');
    git(repo, 'commit', '-q', '-m', 'add submodule');
    const { engine } = mk();
    await engine.start();
    const row = engine.baselineRow('sub/s.txt');
    assert.ok(row, 'submodule files are known');
    assert.strictEqual(row![1], 'unavailable');
    assert.strictEqual(row![2], 'submodule');
    write(repo, 'sub/s.txt', 'edited\n');
    const ch = await engine.handlePath('sub/s.txt');
    assert.strictEqual(ch!.kind, 'M');
    assert.strictEqual(ch!.baselineUnavailable, 'submodule');
  });

  it('A8: a copied file that changes during the baseline window becomes uncertain', async () => {
    write(repo, 'dirty.txt', 'v1\n');
    git(repo, 'add', 'dirty.txt');
    git(repo, 'commit', '-q', '-m', 'd');
    write(repo, 'dirty.txt', 'v1 dirty\n');
    const store = new WorkspaceStore(path.join(root, 'store3'), repo);
    let hooked = false;
    const fsa = new NodeFs();
    const orig = fsa.readFile.bind(fsa);
    fsa.readFile = async (abs: string) => {
      const b = await orig(abs);
      if (!hooked && abs.endsWith('dirty.txt')) {
        hooked = true;
        // agent writes right after we read the bytes we are about to store
        await new Promise((r) => setTimeout(r, 15));
        fs.writeFileSync(abs, 'v2 during copy\n');
      }
      return b;
    };
    const e = new Engine(repo, { store, git: new NodeGit(GIT, repo), fs: fsa, openDoc: () => undefined, rules: new PathRules(buildRuleSet({})), limits: DEFAULT_LIMITS, pid: process.pid + 9 });
    engines.push(e);
    await e.start();
    const row = e.baselineRow('dirty.txt');
    assert.strictEqual(row![1], 'uncertain');
    const ch = await e.handlePath('dirty.txt');
    assert.strictEqual(ch!.baselineUncertain, true);
  });
});
