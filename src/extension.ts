import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { BASELINE_SCHEME, EMPTY_SCHEME, log, output } from './vscode/env';
import { GuardManager } from './vscode/guardManager';
import { ProFeatures } from './pro/features';
import { ReportCommands } from './vscode/reportCommands';
import { ReviewCommands } from './vscode/review';
import { HunkCodeLensProvider, HunkDecorations } from './vscode/views/codelens';
import { BaselineContentProvider, EmptyContentProvider } from './vscode/views/contentProvider';
import { StatusBar } from './vscode/views/statusBar';
import { ChangesTree } from './vscode/views/tree';

/**
 * Activation registers commands, the view, the status bar and the editor providers. Git detection,
 * session resume/auto-start and the watchers all happen afterwards in the background (GuardManager).
 */
let manager: GuardManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const t0 = Date.now();
  manager = new GuardManager(context);
  const tree = new ChangesTree(manager);
  const commands = new ReviewCommands(manager);
  const reports = new ReportCommands(manager);
  const provider = new BaselineContentProvider(manager);
  const pro = new ProFeatures(context, manager, reports);
  commands.beforeStop = (g) => pro.validations.onSessionEnd(g);
  commands.extraPurge.push(() => pro.hooks.installer.purgeBackups());

  const wrap = (name: string, fn: (...args: any[]) => Promise<void> | void) => async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`${name} failed: ${msg}`);
      void vscode.window.showErrorMessage(l10n.t('ChangeKeeper: {0} failed — {1}', name, msg));
    }
  };

  context.subscriptions.push(
    output(),
    manager,
    pro,
    new StatusBar(manager),
    new HunkDecorations(manager),
    vscode.window.createTreeView('changekeeper.changes', { treeDataProvider: tree, showCollapseAll: true }),
    vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, provider),
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, new EmptyContentProvider()),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new HunkCodeLensProvider(manager)),
    vscode.commands.registerCommand('changekeeper.startSession', wrap('start session', (a) => commands.startSession(a))),
    vscode.commands.registerCommand('changekeeper.stopSession', wrap('stop session', (a) => commands.stopSession(a))),
    vscode.commands.registerCommand('changekeeper.refresh', wrap('refresh', () => tree.refresh())),
    vscode.commands.registerCommand('changekeeper.reviewAll', wrap('review all', () => commands.reviewAll())),
    vscode.commands.registerCommand('changekeeper.openDiff', wrap('open diff', (a) => commands.openDiff(a))),
    vscode.commands.registerCommand('changekeeper.openFile', wrap('open file', (a) => commands.openFile(a))),
    vscode.commands.registerCommand('changekeeper.acceptHunk', wrap('accept hunk', (a) => commands.acceptHunk(a))),
    vscode.commands.registerCommand('changekeeper.discardHunk', wrap('discard hunk', (a) => commands.discardHunk(a))),
    vscode.commands.registerCommand('changekeeper.acceptHunkAtCursor', wrap('accept hunk', (a) => commands.acceptHunkAtCursor(a))),
    vscode.commands.registerCommand('changekeeper.discardHunkAtCursor', wrap('discard hunk', (a) => commands.discardHunkAtCursor(a))),
    vscode.commands.registerCommand('changekeeper.acceptFile', wrap('accept file', (a) => commands.acceptFile(a))),
    vscode.commands.registerCommand('changekeeper.acceptAll', wrap('accept all', () => commands.acceptAll())),
    vscode.commands.registerCommand('changekeeper.restoreFile', wrap('restore file', (a) => commands.restoreFile(a))),
    vscode.commands.registerCommand('changekeeper.restoreSession', wrap('restore session', () => commands.restoreSession())),
    vscode.commands.registerCommand('changekeeper.undoRestore', wrap('undo restore', () => commands.undoRestore())),
    vscode.commands.registerCommand('changekeeper.resumeBurst', wrap('burst', (a) => commands.resumeBurst(a))),
    vscode.commands.registerCommand('changekeeper.purgeData', wrap('purge', () => commands.purgeData())),
    vscode.commands.registerCommand('changekeeper.showReport', wrap('report', () => reports.show())),
    vscode.commands.registerCommand('changekeeper.exportReport', wrap('export report', () => reports.export())),
    vscode.commands.registerCommand('changekeeper.copyCommitMessage', wrap('copy commit message', () => reports.copyCommitMessage())),
    // internal, for tests
    vscode.commands.registerCommand('changekeeper._manager', () => manager),
    vscode.commands.registerCommand('changekeeper._reports', () => reports),
    vscode.commands.registerCommand('changekeeper._pro', () => pro),
  );

  await manager.initialize();
  log(`activated in ${Date.now() - t0} ms (git detection and session resume continue in the background)`);
}

export async function deactivate(): Promise<void> {
  await manager?.detachAll();
}
