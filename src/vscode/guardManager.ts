import * as vscode from 'vscode';
import { FileChange } from '../core/session';
import { log, readRetention } from './env';
import { FolderGuard } from './folderGuard';

/** All guarded folders of this window + the derived context keys. */
export class GuardManager implements vscode.Disposable {
  private guards = new Map<string, FolderGuard>(); // folder uri string → guard
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private disposables: vscode.Disposable[] = [];
  private gcTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
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

  /** Called at activation: cheap, then continues in the background. */
  async initialize(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) await this.addFolder(f, false);
    // background: resume/auto-start each folder
    void (async () => {
      for (const g of this.guards.values()) {
        try {
          await g.activate();
        } catch (e) {
          log(`[${g.folder.name}] activate failed: ${String(e)}`);
        }
      }
      this.fire();
      this.scheduleGc();
    })();
  }

  private async addFolder(f: vscode.WorkspaceFolder, activate: boolean): Promise<void> {
    if (this.guards.has(f.uri.toString())) return;
    try {
      const g = await FolderGuard.create(f, this.context.globalStorageUri);
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
    // fall back to prefix match (uris coming from our own schemes)
    for (const g of this.guards.values()) if (uri.toString().startsWith(g.folder.uri.toString())) return g;
    return undefined;
  }

  guardByFolderUri(folder: vscode.Uri): FolderGuard | undefined {
    return this.guards.get(folder.toString());
  }

  /** The guard to act on when a command has no explicit target: the only one, or a pick. */
  async pickGuard(): Promise<FolderGuard | undefined> {
    const all = this.all();
    if (all.length === 0) return undefined;
    if (all.length === 1) return all[0];
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) {
      const g = this.guardFor(active);
      if (g) return g;
    }
    const pick = await vscode.window.showQuickPick(
      all.map((g) => ({ label: g.folder.name, description: g.hasSession ? vscode.l10n.t('guarded') : vscode.l10n.t('not guarded'), g })),
      { placeHolder: vscode.l10n.t('Which folder?') },
    );
    return pick?.g;
  }

  hasAnySession(): boolean {
    return this.all().some((g) => g.hasSession);
  }

  allChanges(): { guard: FolderGuard; change: FileChange }[] {
    const out: { guard: FolderGuard; change: FileChange }[] = [];
    for (const g of this.all()) for (const c of g.engine.changes()) out.push({ guard: g, change: c });
    return out;
  }

  private fire(): void {
    const hasSession = this.hasAnySession();
    const hasChanges = this.all().some((g) => g.engine.changes().length > 0);
    const canUndo = this.all().some((g) => !!g.engine.lastUndoableRestore());
    void vscode.commands.executeCommand('setContext', 'changekeeper.hasSession', hasSession);
    void vscode.commands.executeCommand('setContext', 'changekeeper.hasChanges', hasChanges);
    void vscode.commands.executeCommand('setContext', 'changekeeper.canUndoRestore', canUndo);
    this._onDidChange.fire();
  }

  private scheduleGc(): void {
    // GC runs a while after activation, never during it, and never touches the active session
    if (this.gcTimer) clearTimeout(this.gcTimer);
    this.gcTimer = setTimeout(async () => {
      const r = readRetention();
      for (const g of this.all()) {
        try {
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
