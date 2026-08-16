import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { Engine, EngineError } from '../core/engine';
import { NodeFs } from '../core/nodeAdapters';
import { toRelPosix, workspaceKey } from '../core/paths';
import { PathRules } from '../core/rules/exclude';
import { WorkspaceStore } from '../core/store';
import { FolderConfig, log, readFolderConfig } from './env';
import { detectGit, GitContext } from './git';

/**
 * One guarded workspace folder: owns the engine, the file-system/document watchers and the event
 * queue. Watchers are created *before* the baseline is computed and drained afterwards, so nothing
 * that happens during the baseline window is lost (it is flagged "uncertain" by the engine).
 */
export class FolderGuard implements vscode.Disposable {
  readonly engine: Engine;
  readonly store: WorkspaceStore;
  private disposables: vscode.Disposable[] = [];
  private watching = false;
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private queue: string[] = [];
  private draining = false;
  private queueUntilStarted: string[] | undefined;
  private lastHead: string | undefined;
  private headTimer: ReturnType<typeof setTimeout> | undefined;
  private lastHeadNotice = 0;
  private burstNoticeShown = false;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  config: FolderConfig;
  gitCtx: GitContext | undefined;
  starting: Promise<void> | undefined;

  private constructor(readonly folder: vscode.WorkspaceFolder, readonly storageRoot: vscode.Uri, config: FolderConfig, gitCtx: GitContext | undefined) {
    this.config = config;
    this.gitCtx = gitCtx;
    const key = workspaceKey(folder.uri.fsPath);
    const storeDir = path.join(storageRoot.fsPath, 'workspaces', key);
    this.store = new WorkspaceStore(storeDir, folder.uri.fsPath);
    this.engine = new Engine(folder.uri.fsPath, {
      store: this.store,
      git: gitCtx?.runner,
      gitPrefix: gitCtx?.prefix,
      fs: new NodeFs(),
      openDoc: (rel) => this.openDoc(rel),
      rules: new PathRules(config.rules),
      limits: config.limits,
      log: (m) => log(`[${folder.name}] ${m}`),
      onChanged: () => this.fireChanged(),
    });
  }

  static async create(folder: vscode.WorkspaceFolder, storageRoot: vscode.Uri): Promise<FolderGuard> {
    const config = readFolderConfig(folder);
    const gitCtx = folder.uri.scheme === 'file' ? await detectGit(folder.uri) : undefined;
    return new FolderGuard(folder, storageRoot, config, gitCtx);
  }

  get isGit(): boolean {
    return !!this.gitCtx;
  }

  get hasSession(): boolean {
    return !!this.engine.session && !this.engine.session.stoppedAt;
  }

  // ------------------------------------------------------------------------------------------

  /** Resumes a persisted session or auto-starts one according to the configuration. */
  async activate(): Promise<void> {
    if (this.folder.uri.scheme !== 'file') return;
    let resumed = false;
    try {
      this.startWatching();
      this.queueUntilStarted = [];
      resumed = await this.engine.resume();
    } catch (e) {
      if (e instanceof EngineError && e.code === 'locked') {
        log(`[${this.folder.name}] ${e.message}`);
        void vscode.window.showWarningMessage(l10n.t('ChangeKeeper: this folder is already guarded by another VS Code window; this window will not track changes.'));
        this.stopWatching();
        this.queueUntilStarted = undefined;
        return;
      }
      log(`[${this.folder.name}] resume failed: ${String(e)}`);
    }
    if (resumed) {
      log(`[${this.folder.name}] resumed session ${this.engine.session!.id}`);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: l10n.t('ChangeKeeper: catching up…') }, async (p) => {
        try {
          const n = await this.engine.reconcile((m) => p.report({ message: m }));
          log(`[${this.folder.name}] reconciled ${n} candidates`);
        } catch (e) {
          log(`[${this.folder.name}] reconcile failed: ${String(e)}`);
        }
      });
      this.releaseStartQueue();
      return;
    }
    const auto = this.config.autoStart === 'always' || (this.config.autoStart === 'git' && this.isGit);
    if (auto) {
      await this.start({ silent: true });
    } else {
      this.stopWatching();
      this.queueUntilStarted = undefined;
    }
  }

  /** Starts (or restarts = re-baseline) a session. */
  async start(opts: { silent?: boolean; agent?: string; label?: string } = {}): Promise<boolean> {
    if (this.starting) await this.starting;
    let ok = false;
    this.starting = (async () => {
      this.startWatching();
      this.queueUntilStarted = this.queueUntilStarted ?? [];
      const run = async (progress?: vscode.Progress<{ message?: string }>, token?: vscode.CancellationToken) => {
        await this.engine.start({ agent: opts.agent, label: opts.label, progress: (m) => progress?.report({ message: m }), cancelled: () => !!token?.isCancellationRequested });
      };
      try {
        if (opts.silent) await run();
        else await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: l10n.t('ChangeKeeper: taking a baseline of {0}…', this.folder.name), cancellable: true }, run);
        ok = true;
        this.lastHead = this.engine.baseline?.head;
        log(`[${this.folder.name}] session ${this.engine.session!.id} started (${this.engine.baseline!.rows.length} baseline rows, ${this.engine.baseline!.skipped ?? 0} skipped)`);
        if ((this.engine.baseline?.skipped ?? 0) > 0 && !opts.silent) {
          void vscode.window.showWarningMessage(l10n.t('ChangeKeeper: {0} file(s) have no baseline (too large or over the copy limits). Their changes will be listed but cannot be diffed or restored.', this.engine.baseline!.skipped!));
        }
      } catch (e) {
        if (e instanceof EngineError && e.code === 'cancelled') {
          log(`[${this.folder.name}] baseline cancelled`);
        } else if (e instanceof EngineError && e.code === 'locked') {
          void vscode.window.showWarningMessage(l10n.t('ChangeKeeper: this folder is already guarded by another VS Code window; this window will not track changes.'));
        } else {
          log(`[${this.folder.name}] start failed: ${String(e)}`);
          if (!opts.silent) void vscode.window.showErrorMessage(l10n.t('ChangeKeeper could not start a session: {0}', e instanceof Error ? e.message : String(e)));
        }
        if (!this.hasSession) {
          this.stopWatching();
          this.queueUntilStarted = undefined;
        }
      }
      this.releaseStartQueue();
      this.fireChanged();
    })();
    await this.starting;
    this.starting = undefined;
    return ok;
  }

  async stop(): Promise<void> {
    await this.engine.stop();
    this.stopWatching();
    this.fireChanged();
  }

  /** Window closing / folder removed: keep the session on disk, release the lock. */
  async detach(): Promise<void> {
    this.stopWatching();
    await this.engine.detach().catch(() => undefined);
  }

  reconfigure(): void {
    this.config = readFolderConfig(this.folder);
    // rules and limits are frozen for the running session by design (see PLAN §4.2); they apply to the next one
  }

  // ------------------------------------------------------------------------------------------
  // watchers
  // ------------------------------------------------------------------------------------------

  private startWatching(): void {
    if (this.watching) return;
    this.watching = true;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, '**/*'));
    this.disposables.push(
      w,
      w.onDidCreate((u) => this.enqueueUri(u)),
      w.onDidChange((u) => this.enqueueUri(u)),
      w.onDidDelete((u) => this.enqueueUri(u)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme === 'file' && e.contentChanges.length) this.enqueueUri(e.document.uri, 400);
      }),
      vscode.workspace.onDidSaveTextDocument((d) => this.enqueueUri(d.uri)),
      vscode.workspace.onDidCloseTextDocument((d) => this.enqueueUri(d.uri)),
      vscode.workspace.onDidRenameFiles((e) => {
        for (const f of e.files) {
          this.enqueueUri(f.oldUri);
          this.enqueueUri(f.newUri);
        }
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const f of e.files) this.enqueueUri(f);
      }),
    );
    if (this.isGit) {
      // git operations by the agent (commit/checkout/reset/stash) move HEAD/index; we do not exclude .git for these
      const gw = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(this.gitCtx!.root), '.git/{HEAD,ORIG_HEAD,index}'));
      this.disposables.push(gw, gw.onDidChange(() => this.onGitHeadTouched()), gw.onDidCreate(() => this.onGitHeadTouched()));
    }
  }

  private stopWatching(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    this.queue = [];
    this.watching = false;
  }

  private enqueueUri(uri: vscode.Uri, delay = 250): void {
    if (uri.scheme !== 'file') return;
    const rel = toRelPosix(this.folder.uri.fsPath, uri.fsPath);
    if (rel === undefined || rel === '') return;
    // directories produce events too; the engine treats "not a file" as deleted, so cheap to let through
    if (this.queueUntilStarted) {
      if (!this.queueUntilStarted.includes(rel)) this.queueUntilStarted.push(rel);
      return;
    }
    this.enqueueRel(rel, delay);
  }

  enqueueRel(rel: string, delay = 250): void {
    const prev = this.pending.get(rel);
    if (prev) clearTimeout(prev);
    this.pending.set(
      rel,
      setTimeout(() => {
        this.pending.delete(rel);
        this.queue.push(rel);
        void this.drain();
      }, delay),
    );
  }

  private releaseStartQueue(): void {
    const q = this.queueUntilStarted ?? [];
    this.queueUntilStarted = undefined;
    if (!this.hasSession) return;
    for (const rel of q) this.enqueueRel(rel, 0);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const batch = this.queue.splice(0, 50);
        await Promise.all(
          batch.map(async (rel) => {
            try {
              await this.engine.handlePath(rel);
            } catch (e) {
              log(`[${this.folder.name}] ${rel}: ${String(e)}`);
            }
          }),
        );
        if (this.engine.burst.paused && !this.burstNoticeShown) void this.showBurstNotice();
      }
    } finally {
      this.draining = false;
      this.fireChanged();
    }
  }

  private async showBurstNotice(): Promise<void> {
    this.burstNoticeShown = true;
    await vscode.commands.executeCommand('setContext', 'changekeeper.burstPaused', true);
    const track = l10n.t('Track anyway');
    const ignore = l10n.t('Ignore this burst');
    const rebase = l10n.t('New session (re-baseline)');
    const exclude = l10n.t('Add exclusions…');
    const pick = await vscode.window.showWarningMessage(
      l10n.t('ChangeKeeper: {0} new files changed at once in {1} (npm install? build? checkout?). New files are paused until you decide.', this.engine.burst.windowCount, this.folder.name),
      track,
      ignore,
      rebase,
      exclude,
    );
    await this.resolveBurst(pick === track ? 'track' : pick === ignore ? 'ignore' : pick === rebase ? 'rebase' : pick === exclude ? 'exclude' : undefined);
  }

  async resolveBurst(choice: 'track' | 'ignore' | 'rebase' | 'exclude' | undefined): Promise<void> {
    this.burstNoticeShown = false;
    await vscode.commands.executeCommand('setContext', 'changekeeper.burstPaused', false);
    if (choice === 'track') await this.engine.resumeBurst('track');
    else if (choice === 'ignore') await this.engine.resumeBurst('ignore');
    else if (choice === 'rebase') await this.start();
    else if (choice === 'exclude') {
      await this.engine.resumeBurst('ignore');
      await vscode.commands.executeCommand('workbench.action.openSettings', 'changekeeper.exclude');
    } else {
      // dismissed: keep paused but let the palette command resume later
      await vscode.commands.executeCommand('setContext', 'changekeeper.burstPaused', true);
      this.burstNoticeShown = false;
      return;
    }
    this.fireChanged();
  }

  private onGitHeadTouched(): void {
    if (!this.hasSession || !this.gitCtx) return;
    if (this.headTimer) clearTimeout(this.headTimer);
    this.headTimer = setTimeout(async () => {
      this.headTimer = undefined;
      try {
        const r = await this.gitCtx!.runner.run(['rev-parse', 'HEAD']);
        const head = r.stdout.toString('utf8').trim();
        if (!head || head === this.lastHead) return;
        const changedFromBaseline = head !== this.engine.baseline?.head;
        this.lastHead = head;
        const now = Date.now();
        if (!changedFromBaseline || now - this.lastHeadNotice < 120_000) return;
        this.lastHeadNotice = now;
        const rebase = l10n.t('New session (re-baseline)');
        const keep = l10n.t('Keep this baseline');
        const pick = await vscode.window.showInformationMessage(l10n.t('ChangeKeeper: HEAD moved in {0} (commit, checkout or reset). The current baseline still points at the state when the session started.', this.folder.name), rebase, keep);
        if (pick === rebase) await this.start();
      } catch {
        /* ignore */
      }
    }, 1500);
  }

  // ------------------------------------------------------------------------------------------

  private openDoc(rel: string): { text: string; dirty: boolean } | undefined {
    const abs = path.join(this.folder.uri.fsPath, ...rel.split('/'));
    for (const d of vscode.workspace.textDocuments) {
      if (d.uri.scheme !== 'file' || d.isClosed) continue;
      if (samePathCI(d.uri.fsPath, abs)) return { text: d.getText(), dirty: d.isDirty };
    }
    return undefined;
  }

  private fireChanged(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      this._onDidChange.fire();
    }, 150);
  }

  dispose(): void {
    this.stopWatching();
    this._onDidChange.dispose();
  }
}

function samePathCI(a: string, b: string): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}
