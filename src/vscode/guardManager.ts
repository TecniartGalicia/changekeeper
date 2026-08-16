import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { FileChange } from '../core/session';
import { log, readRetention } from './env';
import { Approvals, FolderGuard } from './folderGuard';

/** All guarded folders of this window + the derived context keys. */
export class GuardManager implements vscode.Disposable {
  private guards = new Map<string, FolderGuard>(); // folder uri string → guard
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private disposables: vscode.Disposable[] = [];
  private gcTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly approvals: Approvals;

  constructor(private readonly context: vscode.ExtensionContext) {
    const KEY = 'changekeeper.approvedWorkspaceSettings';
    this.approvals = {
      isApproved: (hash) => (context.workspaceState.get<string[]>(KEY) ?? []).includes(hash),
      approve: async (hash) => {
        const cur = context.workspaceState.get<string[]>(KEY) ?? [];
        if (!cur.includes(hash)) await context.workspaceState.update(KEY, [...cur, hash]);
      },
    };
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
        for (const f of e.removed) await this.removeFolder(f);
        for (const f of e.added) await this.addFolder(f, true);
        this.fire();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('changekeeper')) for (const g of this.guards.values()) g.reconfigure();
        this.fire();
      }),
    );
  }

  /** Called at activation: cheap (no git, no I/O beyond object creation); the rest continues in the background. */
  async initialize(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) await this.addFolder(f, false);
    void (async () => {
      for (const g of [...this.guards.values()]) {
        try {
          await g.activate();
        } catch (e) {
          log(`[${g.folder.name}] activate failed: ${String(e)}`);
        }
      }
      this.fire();
      void this.maybeFirstRunNotice();
      this.scheduleGc();
    })();
  }

  private async addFolder(f: vscode.WorkspaceFolder, activate: boolean): Promise<void> {
    if (this.guards.has(f.uri.toString())) return;
    try {
      const g = new FolderGuard(f, this.context.globalStorageUri, this.approvals);
      this.guards.set(f.uri.toString(), g);
      g.onDidChange(() => this.fire(), null, this.disposables);
      if (activate) await g.activate();
    } catch (e) {
      log(`[${f.name}] could not create guard: ${String(e)}`);
    }
  }

  private async removeFolder(f: vscode.WorkspaceFolder): Promise<void> {
    const g = this.guards.get(f.uri.toString());
    if (!g) return;
    this.guards.delete(f.uri.toString());
    await g.detach();
    g.dispose();
  }

  all(): FolderGuard[] {
    return [...this.guards.values()];
  }

  guardFor(uri: vscode.Uri): FolderGuard | undefined {
    const wf = vscode.workspace.getWorkspaceFolder(uri);
    if (wf) return this.guards.get(wf.uri.toString());
    for (const g of this.guards.values()) if (uri.toString().startsWith(g.folder.uri.toString())) return g;
    return undefined;
  }

  guardByFolderUri(folder: vscode.Uri): FolderGuard | undefined {
    return this.guards.get(folder.toString());
  }

  /**
   * The guard to act on when a command has no explicit target: the only candidate, the one of the
   * active editor, or a pick. `filter` narrows the candidates (e.g. only guards with a session).
   */
  async pickGuard(filter: (g: FolderGuard) => boolean = () => true): Promise<FolderGuard | undefined> {
    const all = this.all().filter(filter);
    if (all.length === 0) return undefined;
    if (all.length === 1) return all[0];
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) {
      const g = this.guardFor(active);
      if (g && all.includes(g)) return g;
    }
    const pick = await vscode.window.showQuickPick(
      all.map((g) => ({ label: g.folder.name, description: g.hasSession ? l10n.t('guarded') : l10n.t('not guarded'), g })),
      { placeHolder: l10n.t('Which folder?') },
    );
    return pick?.g;
  }

  hasAnySession(): boolean {
    return this.all().some((g) => g.hasSession);
  }

  allChanges(): { guard: FolderGuard; change: FileChange }[] {
    const out: { guard: FolderGuard; change: FileChange }[] = [];
    for (const g of this.all()) if (g.hasSession) for (const c of g.engine.changes()) out.push({ guard: g, change: c });
    return out;
  }

  private fire(): void {
    const hasSession = this.hasAnySession();
    const hasChanges = this.all().some((g) => g.hasSession && g.engine.changes().length > 0);
    const canUndo = this.all().some((g) => g.hasSession && !!g.engine.lastUndoableRestore());
    const hasReport = this.all().some((g) => !!g.engine.session);
    void vscode.commands.executeCommand('setContext', 'changekeeper.hasReport', hasReport);
    void vscode.commands.executeCommand('setContext', 'changekeeper.hasSession', hasSession);
    void vscode.commands.executeCommand('setContext', 'changekeeper.hasChanges', hasChanges);
    void vscode.commands.executeCommand('setContext', 'changekeeper.canUndoRestore', canUndo);
    this._onDidChange.fire();
  }

  private async maybeFirstRunNotice(): Promise<void> {
    const KEY = 'changekeeper.firstRunNoticeShown';
    if (this.context.globalState.get<boolean>(KEY)) return;
    if (!this.guards.size) return;
    await this.context.globalState.update(KEY, true);
    const open = l10n.t('Open ChangeKeeper');
    const settings = l10n.t('Auto-start settings');
    const msg = this.hasAnySession()
      ? l10n.t('ChangeKeeper is guarding this workspace: every change made from now on (by an AI agent, a script or you) can be reviewed hunk by hunk and rolled back from the ChangeKeeper view.')
      : l10n.t('ChangeKeeper is installed but not guarding this folder (no git repository, or auto-start is off). Use "ChangeKeeper: New Session" to start, or change the auto-start setting.');
    const pick = await vscode.window.showInformationMessage(msg, open, settings);
    if (pick === open) await vscode.commands.executeCommand('changekeeper.changes.focus');
    else if (pick === settings) await vscode.commands.executeCommand('workbench.action.openSettings', 'changekeeper.autoStart');
  }

  private scheduleGc(): void {
    // GC runs a while after activation, never during it, only for stores this window may touch, and
    // never against the active session
    if (this.gcTimer) clearTimeout(this.gcTimer);
    this.gcTimer = setTimeout(async () => {
      const r = readRetention();
      for (const g of this.all()) {
        try {
          if (!(await g.mayTouchStore())) continue;
          const res = await g.engine.gc(r.days, r.maxBytes);
          if (res.droppedSessions || res.deletedBlobs) log(`[${g.folder.name}] gc: dropped ${res.droppedSessions} session(s), ${res.deletedBlobs} blob(s)`);
        } catch (e) {
          log(`[${g.folder.name}] gc failed: ${String(e)}`);
        }
      }
    }, 90_000);
  }

  async detachAll(): Promise<void> {
    for (const g of this.guards.values()) await g.detach();
  }

  dispose(): void {
    if (this.gcTimer) clearTimeout(this.gcTimer);
    for (const d of this.disposables) d.dispose();
    for (const g of this.guards.values()) g.dispose();
    this._onDidChange.dispose();
  }
}
