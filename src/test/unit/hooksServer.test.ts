import './vscodeStub';
import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { HookEvent } from '../../core/hooks/events';
import { HookServer } from '../../vscode/hooks/server';
import { HooksFeature } from '../../vscode/hooks';

const IS_WIN = process.platform === 'win32';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

function post(port: number, body: unknown, opts: { token?: string; method?: string; path?: string; raw?: string | Buffer } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = opts.raw !== undefined ? Buffer.from(opts.raw) : Buffer.from(JSON.stringify(body));
    let status: number | undefined;
    const req = http.request({ host: '127.0.0.1', port, path: opts.path ?? '/hook', method: opts.method ?? 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...(opts.token ? { 'X-CK-Token': opts.token } : {}) } }, (res) => {
      status = res.statusCode ?? 0;
      res.resume();
      res.on('end', () => resolve(status!));
    });
    // an oversized body is answered and then cut: the write may fail with EPIPE/ECONNRESET, which is
    // a legitimate end of that exchange as long as the status line already arrived
    req.on('error', (e) => (status !== undefined ? resolve(status) : reject(e)));
    req.end(data);
  });
}

function connectRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => {
      s.destroy();
      resolve(false);
    });
    s.once('error', () => resolve(true));
  });
}

async function until<T>(fn: () => T | undefined | Promise<T | undefined>, what: string, ms = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ck-hooks-'));
}

const claudePayload = (file: string, cwd: string) => ({ session_id: 's1', transcript_path: '/home/u/.claude/projects/p/t.jsonl', cwd, permission_mode: 'default', hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'x'.repeat(2000) }, tool_response: {} });

describe('hooks: local receiver (HookServer)', function () {
  this.timeout(20000);
  const servers: HookServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.dispose();
  });

  it('validates the port setting and falls back to the default', () => {
    assert.strictEqual(HookServer.validPort(47391), 47391);
    assert.strictEqual(HookServer.validPort(1024), 1024);
    assert.strictEqual(HookServer.validPort(65535), 65535);
    for (const bad of [0, null, undefined, 70000, 1.5, -1, 'abc', 80, NaN]) assert.strictEqual(HookServer.validPort(bad), 47391, String(bad));
  });

  it('two windows creating the token together agree on one value (exclusive create) and it is private', async () => {
    const root = tmpdir();
    const a = new HookServer(root, 47391);
    const b = new HookServer(root, 47391, process.ppid);
    servers.push(a, b);
    const [ta, tb] = await Promise.all([a.token(), b.token()]);
    assert.strictEqual(ta, tb, 'same token in both windows');
    assert.match(ta, /^[a-f0-9]{48}$/);
    assert.strictEqual(fs.readFileSync(path.join(root, 'hooks', 'token'), 'utf8'), ta);
    if (!IS_WIN) assert.strictEqual(fs.statSync(path.join(root, 'hooks', 'token')).mode & 0o777, 0o600);
    // a third window later reads the same one
    const c = new HookServer(root, 47391);
    servers.push(c);
    assert.strictEqual(await c.token(), ta);
  });

  it('is off until started; answers 403/404/401/400/413/204 and never with a body; delivers to every folder containing the path', async () => {
    const root = tmpdir();
    const port = await freePort();
    const folder = path.join(root, 'ws');
    const nested = path.join(folder, 'packages', 'web');
    fs.mkdirSync(nested, { recursive: true });
    const s = new HookServer(root, port);
    servers.push(s);
    assert.strictEqual(s.isStarted, false);
    assert.ok(await connectRefused(port), 'nothing listens before start');
    const got: { folder: string; event: HookEvent }[] = [];
    s.onEvent((e) => got.push(e));
    await s.start([folder, nested]);
    assert.strictEqual(s.isOwner, true);
    const token = await s.token();
    assert.strictEqual(await post(port, {}, { method: 'OPTIONS' }), 403);
    assert.strictEqual(await post(port, {}, { method: 'GET', token }), 404);
    assert.strictEqual(await post(port, {}, { token, path: '/other' }), 404);
    assert.strictEqual(await post(port, {}), 401, 'no token');
    assert.strictEqual(await post(port, {}, { token: 'x'.repeat(48) }), 401, 'wrong token of the right length');
    assert.strictEqual(await post(port, {}, { token: token + 'a' }), 401, 'wrong length');
    assert.strictEqual(await post(port, undefined, { token, raw: '{not json' }), 400);
    assert.strictEqual(await post(port, undefined, { token, raw: Buffer.alloc(600 * 1024, 0x20) }), 413);
    assert.strictEqual(got.length, 0, 'nothing delivered so far');
    // a real payload for a nested file: both the outer and the nested folder get it (each guard decides)
    const file = path.join(nested, 'src', 'a.ts');
    assert.strictEqual(await post(port, claudePayload(file, nested), { token }), 204);
    await until(() => (got.length >= 2 ? true : undefined), 'two deliveries');
    assert.deepStrictEqual(got.map((g) => g.folder).sort(), [folder, nested].sort());
    assert.strictEqual(got[0].event.kind, 'tool-done');
    assert.strictEqual(got[0].event.agent, 'claude-code');
    assert.strictEqual(got[0].event.filePath, file);
    assert.strictEqual((got[0].event as any).raw, undefined, 'raw payload is not kept');
    // outside every folder: nothing
    got.length = 0;
    assert.strictEqual(await post(port, claudePayload(path.join(root, 'elsewhere', 'b.ts'), root), { token }), 204);
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(got.length, 0);
    // response bodies are always empty (a hook can never add context)
    const body = await new Promise<string>((resolve, reject) => {
      const data = Buffer.from(JSON.stringify({ hook_event_name: 'Stop' }));
      const req = http.request({ host: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { 'Content-Length': data.length, 'X-CK-Token': token } }, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve(out));
      });
      req.on('error', reject);
      req.end(data);
    });
    assert.strictEqual(body, '');
    await s.stop();
    assert.ok(await connectRefused(port), 'port released on stop');
    assert.strictEqual(s.isStarted, false);
    assert.ok(!fs.existsSync(path.join(root, 'hooks', 'windows', `${process.pid}.json`)), 'registration removed on stop');
  });

  it('honours a token regenerated on disk (owner re-reads the file on a mismatch)', async () => {
    const root = tmpdir();
    const port = await freePort();
    const s = new HookServer(root, port);
    servers.push(s);
    await s.start([root]);
    const old = await s.token();
    const fresh = 'f'.repeat(48);
    fs.writeFileSync(path.join(root, 'hooks', 'token'), fresh);
    assert.strictEqual(await post(port, { hook_event_name: 'Stop' }, { token: fresh }), 204, 'new token accepted after reload');
    assert.strictEqual(await post(port, { hook_event_name: 'Stop' }, { token: old }), 401, 'old token no longer valid');
  });

  it('a second window is not the owner, receives through its inbox, and takes the port over when the owner stops', async () => {
    const root = tmpdir();
    const port = await freePort();
    const fa = path.join(root, 'a');
    const fb = path.join(root, 'b');
    fs.mkdirSync(fa);
    fs.mkdirSync(fb);
    const a = new HookServer(root, port);
    const b = new HookServer(root, port, process.ppid); // looks like another (alive) window
    servers.push(a, b);
    const gotB: { folder: string; event: HookEvent }[] = [];
    b.onEvent((e) => gotB.push(e));
    await a.start([fa]);
    await b.start([fb]);
    assert.strictEqual(a.isOwner, true);
    assert.strictEqual(b.isOwner, false);
    assert.strictEqual(await b.liveOwnerElsewhere(), true);
    const token = await a.token();
    assert.strictEqual(await post(port, claudePayload(path.join(fb, 'x.ts'), fb), { token }), 204);
    // the owner wrote it to b's inbox; b polls every 1.5 s
    await until(() => (gotB.length ? true : undefined), 'inbox delivery', 6000);
    assert.strictEqual(gotB[0].folder, fb);
    assert.strictEqual(gotB[0].event.filePath, path.join(fb, 'x.ts'));
    assert.strictEqual(fs.readdirSync(path.join(root, 'hooks', 'inbox', String(process.ppid))).length, 0, 'inbox item consumed');
    // owner goes away: b notices on its owner check and binds immediately (no 30 s wait)
    await a.stop();
    for (let i = 0; i < 4 && !b.isOwner; i++) await (b as any).onTick();
    assert.strictEqual(b.isOwner, true, 'b took the port over');
    assert.strictEqual(await post(port, { hook_event_name: 'Stop' }, { token }), 204);
  });

  it('tryBind is idempotent and setPort moves the listener (no self-EADDRINUSE, old port released)', async () => {
    const root = tmpdir();
    const p1 = await freePort();
    const s = new HookServer(root, p1);
    servers.push(s);
    await s.start([root]);
    await (s as any).tryBind();
    await (s as any).tryBind();
    assert.strictEqual(s.isOwner, true, 'still the owner after redundant tryBind calls');
    assert.ok((s as any).server, 'server kept');
    const p2 = await freePort();
    await s.setPort(p2);
    assert.strictEqual(s.currentPort, p2);
    assert.strictEqual(s.isOwner, true);
    assert.ok(await connectRefused(p1), 'old port released');
    assert.strictEqual(await post(p2, { hook_event_name: 'Stop' }, { token: await s.token() }), 204);
    await s.setPort(0); // invalid → default; not equal → would move; we only assert it did not throw and stays consistent
    assert.strictEqual(s.currentPort, 47391);
  });

  it('cleans registrations (and inboxes) of dead or stale windows', async () => {
    const root = tmpdir();
    const port = await freePort();
    const s = new HookServer(root, port);
    servers.push(s);
    await s.start([root]);
    const dir = path.join(root, 'hooks', 'windows');
    fs.writeFileSync(path.join(dir, '999999.json'), JSON.stringify({ pid: 999999, folders: [root], since: 'x', beat: new Date().toISOString() }));
    fs.mkdirSync(path.join(root, 'hooks', 'inbox', '999999'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hooks', 'inbox', '999999', '1.json'), '{}');
    // alive pid but a heartbeat from long ago (reused pid)
    fs.writeFileSync(path.join(dir, `${process.ppid}.json`), JSON.stringify({ pid: process.ppid, folders: [root], since: 'x', beat: new Date(Date.now() - 3600_000).toISOString() }));
    const live = await (s as any).liveWindows();
    assert.deepStrictEqual(
      live.map((w: any) => w.pid),
      [process.pid],
    );
    assert.ok(!fs.existsSync(path.join(dir, '999999.json')));
    assert.ok(!fs.existsSync(path.join(root, 'hooks', 'inbox', '999999')));
    assert.ok(!fs.existsSync(path.join(dir, `${process.ppid}.json`)));
    const own = JSON.parse(fs.readFileSync(path.join(dir, `${process.pid}.json`), 'utf8'));
    assert.strictEqual(own.owner, true);
    assert.ok(own.beat);
  });
});

describe('hooks: feature (routing into guards)', function () {
  this.timeout(20000);
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  let root: string;
  before(() => {
    root = tmpdir();
    process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude-cfg'); // never the real ~/.claude in tests
  });
  after(() => {
    if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevCfg;
  });

  function fakeGuard(folder: string, autoStart: string, opts: { isGit?: boolean; hasSession?: boolean; stoppedByUser?: boolean; sessionAgent?: string } = {}) {
    const calls = { start: [] as any[], touches: [] as [string, string][], enq: [] as string[] };
    const g: any = {
      folder: { uri: { scheme: 'file', fsPath: folder }, name: path.basename(folder) },
      hasSession: !!opts.hasSession,
      stoppedByUser: !!opts.stoppedByUser,
      isGit: opts.isGit ?? true,
      config: { autoStart },
      engine: {
        session: opts.hasSession ? { agent: opts.sessionAgent } : undefined,
        relOf: (abs: string) => {
          const rel = path.relative(folder, abs);
          return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : undefined;
        },
        noteAgentTouch: (rel: string, agent: string) => calls.touches.push([rel, agent]),
        touch() {},
        handlePath: async () => undefined,
        acceptFile() {},
      },
      start: async (o: any) => {
        calls.start.push(o);
        g.hasSession = true;
        g.engine.session = { agent: o.agent };
        return true;
      },
      enqueueRel: (rel: string) => calls.enq.push(rel),
      calls,
    };
    return g;
  }

  function feature(guards: any[]): { f: HooksFeature; guards: any[] } {
    const manager: any = { all: () => guards, onDidAddGuard: () => ({ dispose() {} }), pickGuard: async () => guards[0] };
    const context: any = { globalStorageUri: { fsPath: path.join(root, 'storage-' + Math.random().toString(36).slice(2)) }, globalState: { get: (_k: string, d: unknown) => d, update: async () => undefined } };
    const f = new HooksFeature(context, manager, async () => true);
    return { f, guards };
  }

  it('does not start the receiver for a user without hooks and without whenAgentDetected', async () => {
    const ws = path.join(root, 'w0');
    const { f } = feature([fakeGuard(ws, 'git')]);
    await f.startIfUseful();
    assert.strictEqual(f.server.isStarted, false);
    f.dispose();
  });

  it('starts the receiver when a folder has autoStart whenAgentDetected', async () => {
    const ws = path.join(root, 'w1');
    const { f } = feature([fakeGuard(ws, 'whenAgentDetected')]);
    // the constructor kicked the check off; wait for it (port may be busy: started is what matters, not owner)
    await until(() => (f.server.isStarted ? true : undefined), 'receiver started');
    f.dispose();
    await f.server.dispose();
  });

  it('session-start: starts a session with the agent tag per autoStart, respects a manual stop, upgrades a generic tag', async () => {
    const ws = path.join(root, 'w2');
    const gWhen = fakeGuard(path.join(ws, 'when'), 'whenAgentDetected');
    const gOff = fakeGuard(path.join(ws, 'off'), 'off');
    const gGitStopped = fakeGuard(path.join(ws, 'gitstopped'), 'git', { stoppedByUser: true });
    const gGit = fakeGuard(path.join(ws, 'git'), 'git');
    const gPlain = fakeGuard(path.join(ws, 'plain'), 'git', { isGit: false });
    const gGeneric = fakeGuard(path.join(ws, 'generic'), 'git', { hasSession: true, sessionAgent: 'agent' });
    const gCopilot = fakeGuard(path.join(ws, 'copilot'), 'git', { hasSession: true, sessionAgent: 'copilot' });
    const { f } = feature([gWhen, gOff, gGitStopped, gGit, gPlain, gGeneric, gCopilot]);
    const evt: HookEvent = { kind: 'session-start', agent: 'claude-code', cwd: ws };
    for (const g of [gWhen, gOff, gGitStopped, gGit, gPlain, gGeneric, gCopilot]) await f.handle(g.folder.uri.fsPath, evt);
    assert.strictEqual(gWhen.calls.start.length, 1);
    assert.strictEqual(gWhen.calls.start[0].agent, 'claude-code');
    assert.strictEqual(gWhen.calls.start[0].silent, true);
    assert.strictEqual(gOff.calls.start.length, 0, 'autoStart off: never');
    assert.strictEqual(gGitStopped.calls.start.length, 0, 'the user stopped it on purpose');
    assert.strictEqual(gGit.calls.start.length, 1);
    assert.strictEqual(gPlain.calls.start.length, 0, 'git mode on a plain folder: no');
    assert.strictEqual(gGeneric.engine.session.agent, 'claude-code', 'generic tag upgraded');
    assert.strictEqual(gCopilot.engine.session.agent, 'copilot', 'a specific tag is kept');
    // a whenAgentDetected folder stopped by hand still restarts on the agent (that is what the mode means)
    const gWhenStopped = fakeGuard(path.join(ws, 'whenstopped'), 'whenAgentDetected', { stoppedByUser: true });
    const { f: f2 } = feature([gWhenStopped]);
    await f2.handle(gWhenStopped.folder.uri.fsPath, evt);
    assert.strictEqual(gWhenStopped.calls.start.length, 1);
    // UserPromptSubmit (the signal that really fires over HTTP) behaves like session-start
    const gPrompt = fakeGuard(path.join(ws, 'prompt'), 'whenAgentDetected');
    const { f: f3 } = feature([gPrompt]);
    await f3.handle(gPrompt.folder.uri.fsPath, { kind: 'prompt', agent: 'claude-code', cwd: gPrompt.folder.uri.fsPath });
    await f3.handle(gPrompt.folder.uri.fsPath, { kind: 'prompt', agent: 'claude-code', cwd: gPrompt.folder.uri.fsPath });
    assert.strictEqual(gPrompt.calls.start.length, 1, 'started once, second prompt is a no-op');
    f3.dispose();
    f.dispose();
    f2.dispose();
  });

  it('tool-done: tags the file, enqueues it when guarded, starts a session with whenAgentDetected, ignores paths outside the folder', async () => {
    const ws = path.join(root, 'w3');
    const gWhen = fakeGuard(path.join(ws, 'when'), 'whenAgentDetected');
    const gGit = fakeGuard(path.join(ws, 'git'), 'git');
    const gLive = fakeGuard(path.join(ws, 'live'), 'git', { hasSession: true });
    const { f } = feature([gWhen, gGit, gLive]);
    const mk = (folder: string, rel: string): HookEvent => ({ kind: 'tool-done', agent: 'claude-code', filePath: path.join(folder, rel), cwd: folder, toolName: 'Write' });
    await f.handle(gWhen.folder.uri.fsPath, mk(gWhen.folder.uri.fsPath, 'src/a.ts'));
    assert.strictEqual(gWhen.calls.start.length, 1, 'an agent edit is the detection signal');
    assert.deepStrictEqual(gWhen.calls.touches, [['src/a.ts', 'claude-code']]);
    assert.deepStrictEqual(gWhen.calls.enq, ['src/a.ts']);
    await f.handle(gGit.folder.uri.fsPath, mk(gGit.folder.uri.fsPath, 'b.ts'));
    assert.strictEqual(gGit.calls.start.length, 0, 'git mode without a session: no auto start from a tool event');
    assert.deepStrictEqual(gGit.calls.touches, [['b.ts', 'claude-code']], 'attribution is remembered anyway');
    assert.deepStrictEqual(gGit.calls.enq, []);
    await f.handle(gLive.folder.uri.fsPath, mk(gLive.folder.uri.fsPath, 'c.ts'));
    assert.deepStrictEqual(gLive.calls.enq, ['c.ts']);
    // traversal / outside
    await f.handle(gLive.folder.uri.fsPath, mk(gLive.folder.uri.fsPath, path.join('..', '..', 'etc', 'passwd')));
    await f.handle(gLive.folder.uri.fsPath, { kind: 'tool-done', agent: 'claude-code', filePath: path.join(root, 'other.ts') });
    assert.deepStrictEqual(gLive.calls.enq, ['c.ts'], 'nothing outside the folder is enqueued');
    assert.strictEqual(gLive.calls.touches.length, 1);
    f.dispose();
  });
});

describe('hooks: vscode:uninstall script', function () {
  this.timeout(20000);
  const script = path.resolve(__dirname, '..', '..', 'hook', 'uninstall.js');
  function run(cfgDir: string): Promise<number> {
    return new Promise((resolve) => execFile(process.execPath, [script], { env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir } }, (err: any) => resolve(err ? err.code ?? 1 : 0)));
  }
  it('removes only our hooks from ~/.claude/settings.json (CLAUDE_CONFIG_DIR), keeps a .bak, is idempotent, never rewrites invalid JSON', async () => {
    const dir = tmpdir();
    const file = path.join(dir, 'settings.json');
    const original = { permissions: { allow: ['Bash(git:*)'] }, hooks: { SessionStart: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:47391/hook', headers: { 'X-CK-Token': 'abc' } }] }, { hooks: [{ type: 'command', command: 'echo hi' }] }], PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'http', url: 'http://127.0.0.1:47391/hook' }] }] }, allowedHttpHookUrls: ['http://127.0.0.1:47391/hook', 'http://other/x'] };
    fs.writeFileSync(file, JSON.stringify(original, null, 2));
    assert.strictEqual(await run(dir), 0);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(after, { permissions: { allow: ['Bash(git:*)'] }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] }, allowedHttpHookUrls: ['http://other/x'] });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file + '.changekeeper-uninstall.bak', 'utf8')), original, 'backup is the original');
    // idempotent: second run changes nothing (and does not overwrite the backup)
    const bakBefore = fs.readFileSync(file + '.changekeeper-uninstall.bak', 'utf8');
    assert.strictEqual(await run(dir), 0);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), after);
    assert.strictEqual(fs.readFileSync(file + '.changekeeper-uninstall.bak', 'utf8'), bakBefore);
    // invalid JSON is left alone
    fs.writeFileSync(file, '{ not json');
    assert.strictEqual(await run(dir), 0);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ not json');
    // no file: nothing created
    const empty = tmpdir();
    assert.strictEqual(await run(empty), 0);
    assert.deepStrictEqual(fs.readdirSync(empty), []);
  });
});
