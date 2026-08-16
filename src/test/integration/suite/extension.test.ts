import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

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
    for (const cmd of ['changekeeper.startSession', 'changekeeper.stopSession', 'changekeeper.reviewAll', 'changekeeper.restoreSession', 'changekeeper.undoRestore', 'changekeeper.purgeData', 'changekeeper.acceptHunkFromGutter']) {
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
    await until(() => (vscode.workspace.textDocuments.some((d) => d.uri.fsPath === doc.uri.fsPath && !d.isClosed) ? undefined : true), 'document closed', 10000).catch(() => undefined);
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

  it('accept from the diff gutter marks overlapping hunks accepted (synthetic VS Code context)', async () => {
    const g = await guard();
    fs.writeFileSync(abs('src/app.ts'), 'export function add(a: number, b: number) {\n  return a + b; // again\n}\n\nexport const VERSION = 1;\n\nexport function sub(a: number, b: number) {\n  return a - b;\n}\n');
    const ch = await until(() => changeOf(g, 'src/app.ts'), 'change');
    const view = await g.engine.view('src/app.ts');
    assert.strictEqual(view.hunks.length, 1);
    await vscode.commands.executeCommand('changekeeper.acceptHunkFromGutter', { modifiedUri: uriOf('src/app.ts'), mapping: { modified: { startLineNumber: 2, endLineNumberExclusive: 3 } } });
    assert.strictEqual(ch.hunks[view.hunks[0].id], 'accepted');
    // review all opens the multi-diff editor without throwing
    await vscode.commands.executeCommand('changekeeper.reviewAll');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('new session re-baselines: current state becomes the baseline; stop clears the active session', async () => {
    const g = await guard();
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
