import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Engine } from '../../core/engine';
import { DEFAULT_LIMITS } from '../../core/guardrails';
import { NodeFs, NodeGit } from '../../core/nodeAdapters';
import { buildRuleSet, PathRules } from '../../core/rules/exclude';
import { WorkspaceStore } from '../../core/store';
import { decodeText, encodeText } from '../../core/textfile';

/**
 * Regressions for the data-loss findings of the 2026-08-17 audit (docs/AUDITORIA.md, «Auditoría de
 * la 0.2.1»). Every one of these used to end with a file the user had before the session being
 * deleted, or its bytes silently changed.
 */
const GIT = process.env.CK_TEST_GIT || 'git';
const git = (cwd: string, ...args: string[]) => execFileSync(GIT, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd, USERPROFILE: cwd } });
const write = (dir: string, rel: string, content: string | Buffer) => {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

function initRepo(dir: string): void {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'ck@test');
  git(dir, 'config', 'user.name', 'CK');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
}

function engineFor(folder: string, storeDir: string): { engine: Engine; store: WorkspaceStore } {
  const store = new WorkspaceStore(storeDir, folder);
  const engine = new Engine(folder, {
    store,
    git: new NodeGit(GIT, folder),
    gitPrefix: '',
    fs: new NodeFs(),
    openDoc: () => undefined,
    rules: new PathRules(buildRuleSet({})),
    limits: { ...DEFAULT_LIMITS },
    pid: process.pid,
  });
  return { engine, store };
}

describe('engine: data loss regressions (audit of 0.2.1)', function () {
  this.timeout(60000);
  let root: string;
  let repo: string;
  const engines: Engine[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-loss-'));
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    initRepo(repo);
    write(repo, 'a.txt', 'one\ntwo\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
  });
  afterEach(async () => {
    for (const e of engines.splice(0)) await e.stop().catch(() => undefined);
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* Windows may still hold a handle */
    }
  });

  /** C1: `.gitignore` = `.vscode/` makes git report the whole directory, never the file inside it. */
  it('a critical file inside an ignored DIRECTORY gets a baseline (restore must not delete it)', async () => {
    write(repo, '.gitignore', '.vscode/\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'ignore vscode');
    write(repo, '.vscode/settings.json', '{ "editor.tabSize": 2 }\n'); // the user's, before the session
    const { engine } = engineFor(repo, path.join(root, 'store'));
    engines.push(engine);
    await engine.start({});

    write(repo, '.vscode/settings.json', '{ "editor.tabSize": 8, "files.autoSave": "off" }\n'); // the agent
    const ch = await engine.handlePath('.vscode/settings.json');
    assert.ok(ch, 'the change is tracked');
    assert.strictEqual(ch!.kind, 'M', 'modified, not added — it existed before the session');
    assert.strictEqual(ch!.critical, true);

    const { results } = await engine.restore(['.vscode/settings.json'], 'file');
    assert.strictEqual(results[0].status, 'restored');
    assert.strictEqual(fs.readFileSync(path.join(repo, '.vscode', 'settings.json'), 'utf8'), '{ "editor.tabSize": 2 }\n');
  });

  /** C2: git does not descend into a nested repository; it reports `vendor/` as one untracked entry. */
  it('files inside a nested git repository get a baseline (restore must not delete them)', async () => {
    const nested = path.join(repo, 'vendorlib');
    fs.mkdirSync(nested);
    initRepo(nested);
    write(nested, 'important.js', 'module.exports = 1;\n');
    git(nested, 'add', '-A');
    git(nested, 'commit', '-q', '-m', 'vendor');

    const { engine } = engineFor(repo, path.join(root, 'store'));
    engines.push(engine);
    await engine.start({});

    write(repo, 'vendorlib/important.js', 'module.exports = 666;\n');
    const ch = await engine.handlePath('vendorlib/important.js');
    assert.ok(ch);
    assert.strictEqual(ch!.kind, 'M', 'it existed before the session');
    const { results } = await engine.restore(['vendorlib/important.js'], 'file');
    assert.strictEqual(results[0].status, 'restored');
    assert.strictEqual(fs.readFileSync(path.join(nested, 'important.js'), 'utf8'), 'module.exports = 1;\n');
  });

  /** C3: a corrupt index.json used to make the GC delete the blobs of the session that is open. */
  it('the GC never deletes blobs the running session needs, even with a corrupt index', async () => {
    write(repo, 'dirty.txt', 'before\n'); // untracked at start → copied into the store
    const storeDir = path.join(root, 'store');
    const { engine, store } = engineFor(repo, storeDir);
    engines.push(engine);
    await engine.start({});
    write(repo, 'dirty.txt', 'after the agent\n');
    await engine.handlePath('dirty.txt');
    assert.ok((await store.listBlobs()).length > 0, 'the baseline copy is in the store');

    fs.writeFileSync(path.join(storeDir, 'index.json'), '{ this is not json');
    const res = await engine.gc(0, 1);
    assert.strictEqual(res.deletedBlobs, 0, 'nothing was deleted');

    const { results } = await engine.restore(['dirty.txt'], 'file');
    assert.strictEqual(results[0].status, 'restored');
    assert.strictEqual(fs.readFileSync(path.join(repo, 'dirty.txt'), 'utf8'), 'before\n');
  });

  /** C5: a file that cannot be read (locked by another process) is not a deletion. */
  it('an unreadable file keeps its previous state instead of being reported as deleted', async () => {
    const { engine } = engineFor(repo, path.join(root, 'store'));
    engines.push(engine);
    await engine.start({});
    write(repo, 'a.txt', 'one\ntwo\nthree\n');
    const ch = await engine.handlePath('a.txt');
    assert.strictEqual(ch!.kind, 'M');

    // simulate the OS refusing the read while the file is still there
    const realRead = (engine as unknown as { deps: { fs: NodeFs } }).deps.fs.readFile.bind((engine as unknown as { deps: { fs: NodeFs } }).deps.fs);
    (engine as unknown as { deps: { fs: { readFile: (abs: string) => Promise<Buffer | undefined> } } }).deps.fs.readFile = async (abs: string) => (abs.endsWith('a.txt') ? undefined : realRead(abs));
    const after = await engine.handlePath('a.txt');
    assert.ok(after, 'the change survives');
    assert.strictEqual(after!.kind, 'M', 'still modified, NOT deleted');
  });

  /** C6: BOM + non-UTF-8 body must round-trip byte for byte. */
  it('a file with a UTF-8 BOM and a latin1 body keeps its BOM through decode/encode', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('caf\xe9 cr\xe8me\r\n', 'latin1')]);
    const d = decodeText(bytes);
    assert.strictEqual(d.encoding, 'latin1');
    assert.strictEqual(d.bom, true);
    assert.deepStrictEqual(encodeText(d.text, d.bom, d.encoding), bytes, 'byte-identical round trip');
  });
});
