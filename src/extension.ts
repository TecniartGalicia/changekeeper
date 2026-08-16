import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { BASELINE_SCHEME, EMPTY_SCHEME, log, output } from './vscode/env';
import { GuardManager } from './vscode/guardManager';
import { ReviewCommands } from './vscode/review';
import { BaselineContentProvider, EmptyContentProvider } from './vscode/views/contentProvider';
import { StatusBar } from './vscode/views/statusBar';
import { ChangesTree } from './vscode/views/tree';

/**
 * Activation registers commands, the view and the status bar, and reads one small index file per
 * folder. Watchers and baselines only exist while a session is running (persisted or auto-started).
 */
let manager: GuardManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const t0 = Date.now();
  manager = new GuardManager(context);
  const tree = new ChangesTree(manager);
  const commands = new ReviewCommands(manager);
  const provider = new BaselineContentProvider(manager);

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
    new StatusBar(manager),
    vscode.window.createTreeView('changekeeper.changes', { treeDataProvider: tree, showCollapseAll: true }),
    vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, provider),
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, new EmptyContentProvider()),
    vscode.commands.registerCommand('changekeeper.startSession', wrap('start session', (a) => commands.startSession(a))),
    vscode.commands.registerCommand('changekeeper.stopSession', wrap('stop session', (a) => commands.stopSession(a))),
    vscode.commands.registerCommand('changekeeper.refresh', wrap('refresh', () => tree.refresh())),
    vscode.commands.registerCommand('changekeeper.reviewAll', wrap('review all', () => commands.reviewAll())),
    vscode.commands.registerCommand('changekeeper.openDiff', wrap('open diff', (a) => commands.openDiff(a))),
    vscode.commands.registerCommand('changekeeper.openFile', wrap('open file', (a) => commands.openFile(a))),
    vscode.commands.registerCommand('changekeeper.acceptHunk', wrap('accept hunk', (a) => commands.acceptHunk(a))),
    vscode.commands.registerCommand('changekeeper.discardHunk', wrap('discard hunk', (a) => commands.discardHunk(a))),
    vscode.commands.registerCommand('changekeeper.acceptFile', wrap('accept file', (a) => commands.acceptFile(a))),
    vscode.commands.registerCommand('changekeeper.acceptAll', wrap('accept all', () => commands.acceptAll())),
    vscode.commands.registerCommand('changekeeper.restoreFile', wrap('restore file', (a) => commands.restoreFile(a))),
    vscode.commands.registerCommand('changekeeper.restoreSession', wrap('restore session', () => commands.restoreSession())),
    vscode.commands.registerCommand('changekeeper.undoRestore', wrap('undo restore', () => commands.undoRestore())),
    vscode.commands.registerCommand('changekeeper.acceptHunkFromGutter', wrap('accept hunk', (a) => commands.acceptHunkFromGutter(a))),
    vscode.commands.registerCommand('changekeeper.resumeBurst', wrap('burst', (a) => commands.resumeBurst(a))),
    vscode.commands.registerCommand('changekeeper.purgeData', wrap('purge', () => commands.purgeData())),
    // report commands arrive in F2; registered here so the menus never point at a missing command
    vscode.commands.registerCommand('changekeeper.showReport', wrap('report', async () => void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: the session report arrives in the next update.')))),
    vscode.commands.registerCommand('changekeeper.exportReport', wrap('export report', async () => void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: the session report arrives in the next update.')))),
    // internal, for tests
    vscode.commands.registerCommand('changekeeper._manager', () => manager),
  );

  await manager.initialize();
  log(`activated in ${Date.now() - t0} ms`);
  void maybeFirstRunNotice(context);
}

async function maybeFirstRunNotice(context: vscode.ExtensionContext): Promise<void> {
  const KEY = 'changekeeper.firstRunNoticeShown';
  if (context.globalState.get<boolean>(KEY)) return;
  if (!(vscode.workspace.workspaceFolders ?? []).length) return;
  await context.globalState.update(KEY, true);
  const open = l10n.t('Open ChangeKeeper');
  const settings = l10n.t('Auto-start settings');
  const pick = await vscode.window.showInformationMessage(l10n.t('ChangeKeeper is guarding this workspace: every change made from now on (by an AI agent, a script or you) can be reviewed hunk by hunk and rolled back from the ChangeKeeper view.'), open, settings);
  if (pick === open) await vscode.commands.executeCommand('changekeeper.changes.focus');
  else if (pick === settings) await vscode.commands.executeCommand('workbench.action.openSettings', 'changekeeper.autoStart');
}

export async function deactivate(): Promise<void> {
  await manager?.detachAll();
}
