import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as settingsEdit from '../../../core/hooks/settingsEdit';

/**
 * End-to-end in a real VS Code: the workspace opened by runTest.ts is a small git repo, so the
 * extension auto-starts a session. We then behave like agents and check what ChangeKeeper sees.
 */
const WS = process.env.CK_IT_WORKSPACE!;
const abs = (rel: string) => path.join(WS, ...rel.split('/'));
const uriOf = (rel: string) => vscode.Uri.file(abs(rel));

async function manager(): Promise<any> {
  const m = await vscode.commands.executeCommand<any>('changekeeper._manager');
  assert.ok(m, 'manager command must exist');
  return m;
}

async function guard(): Promise<any> {
  const m = await manager();
  const g = m.all()[0];
  assert.ok(g, 'one guard for the workspace folder');
  return g;
}

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, what: string, timeoutMs = 20000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v !== undefined && v !== null && v !== false) return v as T;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting for ${what}`);
}

function changeOf(g: any, rel: string): any {
  return g.engine.changes().find((c: any) => c.path === rel);
}

describe('ChangeKeeper end to end', function () {
  this.timeout(90000);

  before(async () => {
    const ext = vscode.extensions.getExtension('argalla.changekeeper');
    assert.ok(ext, 'extension present');
    await ext!.activate();
  });

  it('activates and auto-starts a git session for the workspace folder', async () => {
    const g = await guard();
    await until(() => (g.hasSession ? true : undefined), 'session auto-start');
    assert.ok(g.isGit, 'workspace is a git repo');
    assert.strictEqual(g.engine.session.kind, 'git');
    const rows = g.engine.baseline.rows.map((r: any) => r[0]);
    assert.ok(rows.includes('src/app.ts'));
    assert.strictEqual(g.engine.changes().length, 0);
    for (const cmd of ['changekeeper.startSession', 'changekeeper.stopSession', 'changekeeper.reviewAll', 'changekeeper.restoreSession', 'changekeeper.undoRestore', 'changekeeper.purgeData', 'changekeeper.acceptHunkAtCursor', 'changekeeper.discardHunkAtCursor', 'changekeeper.showReport', 'changekeeper.exportReport', 'changekeeper.copyCommitMessage']) {
      assert.ok((await vscode.commands.getCommands(true)).includes(cmd), cmd);
    }
  });

  it('sees a CLI-style edit on disk, builds hunks and serves the baseline for the diff', async () => {
    const g = await guard();
    fs.writeFileSync(abs('src/app.ts'), 'export function add(a: number, b: number) {\n  return a + b; // agent\n}\n\nexport const VERSION = 2;\n\nexport function sub(a: number, b: number) {\n  return a - b;\n}\n');
    const ch = await until(() => changeOf(g, 'src/app.ts'), 'change for src/app.ts');
    assert.strictEqual(ch.kind, 'M');
    const view = await g.engine.view('src/app.ts');
    assert.strictEqual(view.hunks.length, 1, 'both edits are 3 lines apart → one hunk');
    // baseline document through our content provider
    const left = vscode.Uri.from({ scheme: 'ck-baseline', path: '/src/app.ts', query: new URLSearchParams({ folder: g.folder.uri.toString(), session: g.engine.session.id }).toString() });
    const doc = await vscode.workspace.openTextDocument(left);
    assert.ok(doc.getText().includes('export const VERSION = 1;'), 'baseline text is the committed content');
    // open the diff via the command with a file-like node
    await vscode.commands.executeCommand('changekeeper.openDiff', { guard: g, change: ch });
    const active = vscode.window.activeTextEditor;
    assert.ok(active, 'diff editor opened');
    assert.ok(active!.document.uri.fsPath.toLowerCase() === abs('src/app.ts').toLowerCase(), 'right side is the real file');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('discards a hunk on disk (closed document) and the change disappears', async () => {
    const g = await guard();
    const view = await g.engine.view('src/app.ts');
    assert.strictEqual(view.hunks.length, 1);
    await vscode.commands.executeCommand('changekeeper.discardHunk', { guard: g, change: view.change, hunkId: view.hunks[0].id });
    await until(() => (changeOf(g, 'src/app.ts') ? undefined : true), 'change removed after discard');
    assert.strictEqual(fs.readFileSync(abs('src/app.ts'), 'utf8').includes('VERSION = 1'), true);
  });

  it('sees an editor-style edit (WorkspaceEdit on an open document) and discards it through the editor', async () => {
    const g = await guard();
    const doc = await vscode.workspace.openTextDocument(uriOf('src/app.ts'));
    await vscode.window.showTextDocument(doc);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uriOf('src/app.ts'), new vscode.Position(0, 0), '// header added by an editor agent\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    const ch = await until(() => changeOf(g, 'src/app.ts'), 'change from dirty document');
    assert.strictEqual(ch.kind, 'M');
    const view = await g.engine.view('src/app.ts');
    assert.strictEqual(view.hunks.length, 1);
    await vscode.commands.executeCommand('changekeeper.discardHunk', { guard: g, change: view.change, hunkId: view.hunks[0].id });
    await until(() => (doc.getText().startsWith('// header') ? undefined : true), 'document text reverted');
    await until(() => (changeOf(g, 'src/app.ts') ? undefined : true), 'change removed');
    // the document was dirty before the discard (the agent's edit was unsaved), so ChangeKeeper leaves it
    // dirty on purpose: the buffer is the truth while the user works. Save it to close cleanly.
    assert.strictEqual(doc.isDirty, true);
    await doc.save();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('tracks new, deleted and critical files; restore and undo work end to end', async () => {
    const g = await guard();
    fs.writeFileSync(abs('src/new.ts'), 'export const x = 1;\n');
    fs.writeFileSync(abs('.env'), 'TOKEN=abc\n'); // git-ignored but critical
    fs.rmSync(abs('README.md'));
    const nw = await until(() => changeOf(g, 'src/new.ts'), 'new file');
    assert.strictEqual(nw.kind, 'A');
    const env = await until(() => changeOf(g, '.env'), '.env tracked although ignored');
    assert.strictEqual(env.critical, true);
    const del = await until(() => changeOf(g, 'README.md'), 'deleted file');
    assert.strictEqual(del.kind, 'D');
    // package.json is critical by default
    fs.writeFileSync(abs('package.json'), '{ "name": "demo", "version": "1.0.1" }\n');
    const pkg = await until(() => changeOf(g, 'package.json'), 'package.json change');
    assert.strictEqual(pkg.critical, true);
    // restore README (deleted) → recreated; restore new.ts → deleted; undo → back
    const r1 = await g.engine.restore(['README.md', 'src/new.ts'], 'session');
    assert.deepStrictEqual(
      r1.results.map((x: any) => x.status),
      ['restored', 'deleted'],
    );
    assert.strictEqual(fs.readFileSync(abs('README.md'), 'utf8'), '# demo\n');
    assert.ok(!fs.existsSync(abs('src/new.ts')));
    const rec = g.engine.lastUndoableRestore();
    const u = await g.engine.undoRestore(rec);
    assert.deepStrictEqual(
      u.map((x: any) => x.status),
      ['undone', 'undone'],
    );
    assert.ok(!fs.existsSync(abs('README.md')));
    assert.strictEqual(fs.readFileSync(abs('src/new.ts'), 'utf8'), 'export const x = 1;\n');
    // status bar / context keys are derived from the same state
    await until(() => (g.engine.changes().length >= 4 ? true : undefined), 'changes settled');
  });

  it('accept/discard at cursor work in the editor; the report and commit message are produced', async () => {
    const g = await guard();
    fs.writeFileSync(abs('src/app.ts'), 'export function add(a: number, b: number) {\n  return a + b; // again\n}\n\nexport const VERSION = 1;\n\nexport function sub(a: number, b: number) {\n  return a - b;\n}\n');
    const ch = await until(() => changeOf(g, 'src/app.ts'), 'change');
    const view = await g.engine.view('src/app.ts');
    assert.strictEqual(view.hunks.length, 1);
    // gutter-shaped argument (mapping) still understood, no proposed API needed
    await vscode.commands.executeCommand('changekeeper.acceptHunkAtCursor', { modifiedUri: uriOf('src/app.ts'), mapping: { modified: { startLineNumber: 2, endLineNumberExclusive: 3 } } });
    assert.strictEqual(ch.hunks[view.hunks[0].id], 'accepted');
    // cursor-based: open the file, put the cursor on the changed line, discard
    const doc = await vscode.workspace.openTextDocument(uriOf('src/app.ts'));
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    await vscode.commands.executeCommand('changekeeper.discardHunkAtCursor');
    await until(() => (changeOf(g, 'src/app.ts') ? undefined : true), 'change removed by discard at cursor');
    assert.ok(!doc.getText().includes('// again'));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // report: markdown document with the session summary + commit message on the clipboard
    fs.writeFileSync(abs('src/report-me.ts'), 'export const r = 1;\n');
    await until(() => changeOf(g, 'src/report-me.ts'), 'report file');
    const reports = await vscode.commands.executeCommand<any>('changekeeper._reports');
    const md: string = await reports.build(g);
    assert.ok(md.includes('# ChangeKeeper session report'), 'report header');
    assert.ok(md.includes('src/report-me.ts'), 'report lists the file');
    assert.ok(md.includes('## Suggested commit message'));
    // the OS clipboard is not always available on CI: exercise the command and check the message itself
    await vscode.commands.executeCommand('changekeeper.copyCommitMessage');
    const clip = await vscode.env.clipboard.readText().then((t) => t, () => '');
    if (clip) assert.ok(/^(feat|fix|docs|test|build|ci|chore)/.test(clip), `commit message on clipboard: ${clip.slice(0, 40)}`);
    assert.ok(/(feat|fix|docs|test|build|ci|chore)(\(|:)/.test(md.split('## Suggested commit message')[1] ?? ''), 'commit message inside the report');
    // CodeLens: per-hunk lenses on the first changed line, with working commands (accept from the lens)
    const doc2 = await vscode.workspace.openTextDocument(uriOf('src/report-me.ts'));
    const lenses = await until(async () => {
      const l = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc2.uri, 50);
      return l && l.some((x) => x.command?.command === 'changekeeper.acceptHunk') ? l : undefined;
    }, 'code lenses');
    const acceptLens = lenses.find((x) => x.command?.command === 'changekeeper.acceptHunk')!;
    assert.strictEqual(acceptLens.range.start.line, 0, 'lens on the first changed line');
    assert.ok(lenses.some((x) => x.command?.command === 'changekeeper.discardHunk'));
    await vscode.commands.executeCommand(acceptLens.command!.command, ...(acceptLens.command!.arguments ?? []));
    const rm = changeOf(g, 'src/report-me.ts');
    assert.ok(Object.values(rm.hunks).every((s: any) => s === 'accepted'), 'accepted from the lens');
    // review all opens the multi-diff editor without throwing
    await vscode.commands.executeCommand('changekeeper.reviewAll');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('a directory moved by a CLI is seen: old children deleted, new ones added (rename by content)', async () => {
    const g = await guard();
    fs.mkdirSync(abs('lib'), { recursive: true });
    fs.writeFileSync(abs('lib/one.ts'), 'export const one = 1;\n');
    fs.writeFileSync(abs('lib/two.ts'), 'export const two = 2;\n');
    await until(() => changeOf(g, 'lib/one.ts') && changeOf(g, 'lib/two.ts'), 'new dir children');
    // start a fresh session so lib/* is part of the baseline, then move the directory like `mv lib moved`
    await g.start({ silent: true });
    await until(() => (g.engine.changes().length === 0 ? true : undefined), 'clean after re-baseline');
    fs.renameSync(abs('lib'), abs('moved'));
    const d1 = await until(() => changeOf(g, 'lib/one.ts'), 'old child seen as deleted');
    assert.strictEqual(d1.kind, 'D');
    const m1 = await until(() => changeOf(g, 'moved/one.ts'), 'new child seen');
    assert.ok(m1.kind === 'R' || m1.kind === 'A', `moved/one.ts is ${m1.kind}`);
    // move it back: everything settles to "no change"
    fs.renameSync(abs('moved'), abs('lib'));
    await until(() => (changeOf(g, 'lib/one.ts') || changeOf(g, 'moved/one.ts') ? undefined : true), 'ghosts cleared after moving back');
  });

  it('Pro (dev unlock): secret scanner flags added credentials; a validation runs through the Task API and lands in the report', async () => {
    const g = await guard();
    const pro = await vscode.commands.executeCommand<any>('changekeeper._pro');
    await pro.refreshScanner();
    fs.writeFileSync(abs('src/config.ts'), 'export const GH = "ghp_' + 'A'.repeat(40) + '";' + String.fromCharCode(10));
    const ch = await until(() => {
      const c = changeOf(g, 'src/config.ts');
      return c && c.secrets && c.secrets.length ? c : undefined;
    }, 'secret finding on the change');
    assert.strictEqual(ch.secrets[0].label, 'GitHub token');
    assert.ok(!ch.secrets[0].redacted.includes('AAAAAAAAAA'), 'redacted');
    // validation: pre-approve (what the confirmation dialog would do) and run a trivial command
    const rule = { name: 'ok', command: 'node -e "process.exit(0)"', runOn: 'manual', timeoutSec: 60 };
    await pro.validations.approveRule(g, rule);
    await pro.validations.runRule(g, rule, 'manual', true);
    const run = g.engine.session.validations?.find((v: any) => v.name === 'ok');
    assert.ok(run, 'validation recorded in the session');
    assert.strictEqual(run.status, 'passed');
    const failing = { name: 'ko', command: 'node -e "process.exit(3)"', runOn: 'manual', timeoutSec: 60 };
    await pro.validations.approveRule(g, failing);
    await pro.validations.runRule(g, failing, 'manual', true);
    const run2 = g.engine.session.validations?.find((v: any) => v.name === 'ko');
    assert.strictEqual(run2.status, 'failed');
    assert.strictEqual(run2.exitCode, 3);
    const reports = await vscode.commands.executeCommand<any>('changekeeper._reports');
    const md: string = await reports.build(g);
    assert.ok(md.includes('## Validations') && md.includes('**ok**') && md.includes('**ko**'), 'validations section in the report');
    assert.ok(md.includes('## Possible secrets') && md.includes('src/config.ts:1'), 'secrets section in the report');
    // commit message into the SCM box (git extension API)
    const gitExt = vscode.extensions.getExtension<any>('vscode.git');
    const api = gitExt?.isActive ? gitExt.exports.getAPI(1) : (await gitExt!.activate()).getAPI(1);
    await vscode.commands.executeCommand('changekeeper.commitMessageToScm');
    const repo = api.getRepository(g.folder.uri);
    if (repo) assert.ok(/^(feat|fix|docs|test|build|ci|chore)/.test(repo.inputBox.value), `scm input box: ${repo.inputBox.value.slice(0, 30)}`);
  });

  it('Pro hooks: a real POST to the local receiver tags the file with its agent (token required)', async () => {
    const g = await guard();
    const pro = await vscode.commands.executeCommand<any>('changekeeper._pro');
    const server = pro.hooks.server;
    // the receiver is lazy (nothing installed yet in this fresh user-data-dir): not running until asked
    assert.strictEqual(server.isStarted, false, 'receiver is not running for a user without hooks');
    await pro.hooks.ensureStarted();
    await until(() => (server.isOwner ? true : undefined), 'this window owns the hook port', 30000);
    const token: string = await server.token();
    const port: number = server.currentPort;
    assert.strictEqual(port, 47399, 'the suite uses its own port (user settings of the test profile)');
    const http = await import('http');
    const post = (body: any, tok?: string) =>
      new Promise<number>((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(body));
        const req = http.request({ host: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...(tok ? { 'X-CK-Token': tok } : {}) } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end(data);
      });
    // without the token: refused
    assert.strictEqual(await post({ hook_event_name: 'Stop' }), 401);
    // an agent edits a file and its PostToolUse hook fires
    fs.writeFileSync(abs('src/hooked.ts'), 'export const hooked = 1;' + String.fromCharCode(10));
    const status = await post({ session_id: 's1', transcript_path: 'C:/Users/x/.claude/projects/p/t.jsonl', cwd: WS, permission_mode: 'default', hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: abs('src/hooked.ts'), content: 'x' }, tool_response: {} }, token);
    assert.strictEqual(status, 204);
    const ch = await until(() => {
      const c = changeOf(g, 'src/hooked.ts');
      return c && c.agent ? c : undefined;
    }, 'change tagged with the agent');
    assert.strictEqual(ch.agent, 'claude-code');
    // session start from an agent when a session already exists: the session gets the tag
    await post({ hook_event_name: 'SessionStart', cwd: WS, transcript_path: '/home/u/.claude/x', session_id: 's1' }, token);
    await until(() => (g.engine.session.agent === 'claude-code' ? true : undefined), 'session tagged');
    // settings editing on a scratch object (never the real ~/.claude/settings.json in tests)
    const added = settingsEdit.addChangeKeeperHooks({}, port, token);
    assert.strictEqual(settingsEdit.installedHooks(added.next).length, 3, 'SessionStart + UserPromptSubmit + PostToolUse only');
    // project-level install (no dialog: `apply`): the file is git-excluded and marked reviewed, and revert restores it
    const file = abs('.claude/settings.local.json');
    assert.ok(!fs.existsSync(file));
    const written = await pro.hooks.installer.apply('project', WS);
    assert.strictEqual(written, file);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(settingsEdit.installedHooks(parsed).length, 3);
    assert.ok(settingsEdit.installedHooks(parsed).every((h: any) => h.token === token && h.port === port));
    const exclude = fs.readFileSync(abs('.git/info/exclude'), 'utf8');
    assert.ok(exclude.includes('/.claude/settings.local.json'), '.git/info/exclude lists the file we created');
    assert.strictEqual(await pro.hooks.installer.ensureGitExcluded(WS, file), 'ignored', 'git now ignores it');
    await pro.hooks.markOwnWrite(g, file);
    const own = await until(() => changeOf(g, '.claude/settings.local.json'), 'our own write is a (critical) change');
    assert.strictEqual(own.critical, true);
    assert.strictEqual(own.fileAccepted, true, 'but it is marked reviewed: it is our own write');
    const doctor: string = await pro.hooks.installer.report([WS]);
    assert.ok(doctor.includes(String(port)), 'doctor mentions the port');
    assert.ok(doctor.includes('SessionStart, UserPromptSubmit, PostToolUse'), 'doctor lists the project file hooks: ' + doctor);
    assert.ok(!doctor.includes('token differs'), 'doctor is happy with the token');
    assert.strictEqual(await pro.hooks.installer.revert('project', WS), true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {}, 'revert leaves an empty object (the file was ours)');
    fs.rmSync(file, { force: true });
  });

  it('new session re-baselines: current state becomes the baseline; stop clears the active session', async () => {
    const g = await guard();
    fs.writeFileSync(abs('README.md'), '# demo changed before re-baseline' + String.fromCharCode(10));
    await until(() => changeOf(g, 'README.md'), 'change before re-baseline');
    assert.ok(g.engine.changes().length > 0);
    await g.start({ silent: true });
    await until(() => (g.engine.changes().length === 0 ? true : undefined), 'no changes after re-baseline');
    const idx = await g.store.readIndex();
    assert.strictEqual(idx.sessions.length >= 2, true);
    await vscode.commands.executeCommand('changekeeper.stopSession');
    await until(() => (g.hasSession ? undefined : true), 'session stopped');
    assert.strictEqual((await g.store.readIndex()).activeSessionId, undefined);
  });
});
