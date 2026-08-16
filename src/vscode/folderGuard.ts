import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { Engine, EngineDeps, EngineError } from '../core/engine';
import { NodeFs } from '../core/nodeAdapters';
import { toRelPosix, workspaceKey } from '../core/paths';
import { PathRules } from '../core/rules/exclude';
import { WorkspaceStore } from '../core/store';
import { FolderConfig, log, readFolderConfig, WORKSPACE_SENSITIVE_KEYS } from './env';
import { detectGit, GitContext } from './git';

/** Small persistence hook for "workspace settings approved" (backed by workspaceState). */
export interface Approvals {
  isApproved(hash: string): boolean;
  approve(hash: string): Promise<void>;
}

type EventKind = 'create' | 'change' | 'delete' | 'doc';

/**
 * One guarded workspace folder: owns the engine, the file-system/document watchers and the event
 * queue. Watchers are created *before* the baseline is computed and drained afterwards, so nothing
 * that happens during the baseline window is lost (it is flagged "uncertain" by the engine).
 * Git detection is lazy (done in `activate()`, in the background) so activation stays cheap.
 */
export class FolderGuard implements vscode.Disposable {
  readonly engine: Engine;
  readonly store: WorkspaceStore;
  private readonly deps: EngineDeps;
  private disposables: vscode.Disposable[] = [];
  private watching = false;
  private pending = new Map<string, { timer: ReturnType<typeof setTimeout>; kind: EventKind }>();
  private queue: { rel: string; kind: EventKind }[] = [];
  private draining = false;
  private queueUntilStarted: Map<string, EventKind> | undefined;
  private lastHead: string | undefined;
  private headTimer: ReturnType<typeof setTimeout> | undefined;
  private lastHeadNotice = 0;
  private burstNoticeShown = false;
  private configNoticeShown = false;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  config: FolderConfig;
  gitCtx: GitContext | undefined;
  starting: Promise<void> | undefined;
  activated = false;
  /** true while this window owns the folder's session lock (start/resume succeeded) */
  ownsLock = false;
  private readonly fsAdapter = new NodeFs();

  constructor(readonly folder: vscode.WorkspaceFolder, readonly storageRoot: vscode.Uri, private readonly approvals: Approvals) {
    this.config = this.loadConfig();
    const key = workspaceKey(folder.uri.fsPath);
    const storeDir = path.join(storageRoot.fsPath, 'workspaces', key);
    this.store = new WorkspaceStore(storeDir, folder.uri.fsPath);
    this.deps = {
      store: this.store,
      git: undefined,
      gitPrefix: undefined,
      fs: this.fsAdapter,
      openDoc: (rel) => this.openDoc(rel),
      rules: new PathRules(this.config.rules),
      limits: this.config.limits,
      log: (m) => log(`[${folder.name}] ${m}`),
      onChanged: () => this.fireChanged(),
    };
    this.engine = new Engine(folder.uri.fsPath, this.deps);
  }

  get isGit(): boolean {
    return !!this.gitCtx;
  }

  get hasSession(): boolean {
    return !!this.engine.session && !this.engine.session.stoppedAt;
  }

  // ------------------------------------------------------------------------------------------
  // configuration
  // ------------------------------------------------------------------------------------------

  /**
   * Reads the folder configuration. Values that come from workspace/folder settings (which an agent
   * can edit) only apply after the user approved that exact set once; until then user-level values apply.
   */
  private loadConfig(): FolderConfig {
    const cfg = readFolderConfig(this.folder);
    if (cfg.workspaceOverrides.length && cfg.userOnly && !this.approvals.isApproved(cfg.overridesHash)) {
      return { ...cfg.userOnly, workspaceOverrides: cfg.workspaceOverrides, overridesHash: cfg.overridesHash, pendingApproval: true };
    }
    return cfg;
  }

  private async maybeAskWorkspaceSettings(): Promise<void> {
    if (!this.config.pendingApproval || this.configNoticeShown) return;
    this.configNoticeShown = true;
    const apply = l10n.t('Apply them (next session)');
    const keep = l10n.t('Keep user settings');
    const pick = await vscode.window.showWarningMessage(
      l10n.t('ChangeKeeper: this workspace defines ChangeKeeper settings ({0}). Workspace settings can be edited by an agent, so they are ignored until you approve them.', this.config.workspaceOverrides.join(', ')),
      apply,
      keep,
    );
    if (pick === apply) {
      await this.approvals.approve(this.config.overridesHash);
      this.reconfigure();
      if (this.hasSession) {
        const restart = l10n.t('New session (re-baseline)');
        const p2 = await vscode.window.showInformationMessage(l10n.t('ChangeKeeper: workspace settings approved. They apply to the next session.'), restart);
        if (p2 === restart) await this.start();
      }
    }
  }

  reconfigure(): void {
    const next = this.loadConfig();
    // codeLens/decorations apply live; only session-frozen settings (rules, limits, autoStart) warrant the notice
    const frozen = (c: FolderConfig) => JSON.stringify({ a: c.autoStart, r: c.rules, l: c.limits });
    const changed = frozen(next) !== frozen(this.config);
    this.config = next;
    // rules and limits are frozen for the running session by design (PLAN §4.2); they apply to the next one
    if (changed && this.hasSession && !this.configNoticeShown) {
      this.configNoticeShown = true;
      const restart = l10n.t('New session (re-baseline)');
      void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: settings changed. Exclusions, critical files and limits apply to the next session.'), restart).then((p) => {
        this.configNoticeShown = false;
        if (p === restart) return this.start();
        return undefined;
      });
    }
    void this.maybeAskWorkspaceSettings();
  }

  // ------------------------------------------------------------------------------------------
  // lifecycle
  // ------------------------------------------------------------------------------------------

  private gitDetection: Promise<void> | undefined;
  /** Detects git once; concurrent callers (activate + a user's Start) share the same promise. */
  private ensureGit(): Promise<void> {
    if (!this.gitDetection) {
      this.gitDetection = (async () => {
        if (this.folder.uri.scheme !== 'file') return;
        try {
          this.gitCtx = await detectGit(this.folder.uri);
        } catch (e) {
          log(`[${this.folder.name}] git detection failed: ${String(e)}`);
        }
        this.deps.git = this.gitCtx?.runner;
        this.deps.gitPrefix = this.gitCtx?.prefix;
      })();
    }
    return this.gitDetection;
  }

  private activating: Promise<void> | undefined;

  /** Resumes a persisted session or auto-starts one according to the configuration. Runs in the background. */
  async activate(): Promise<void> {
    if (this.activated) return this.activating;
    this.activated = true;
    this.activating = this.doActivate();
    return this.activating;
  }

  private async doActivate(): Promise<void> {
    if (this.folder.uri.scheme !== 'file') return;
    await this.ensureGit();
    let resumed = false;
    try {
      this.startWatching();
      this.queueUntilStarted = new Map();
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
      this.ownsLock = true;
      log(`[${this.folder.name}] resumed session ${this.engine.session!.id}`);
      await this.refreshHead();
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: l10n.t('ChangeKeeper: catching up…') }, async (p) => {
        try {
          const n = await this.engine.reconcile((m) => p.report({ message: this.progressText(m) }));
          log(`[${this.folder.name}] reconciled ${n} candidates`);
        } catch (e) {
          log(`[${this.folder.name}] reconcile failed: ${String(e)}`);
        }
      });
      this.releaseStartQueue();
      void this.maybeAskWorkspaceSettings();
      return;
    }
    const auto = this.config.autoStart === 'always' || (this.config.autoStart === 'git' && this.isGit);
    if (auto) {
      this.inActivation = true;
      try {
        await this.startInternal({ silent: true });
      } finally {
        this.inActivation = false;
      }
    } else {
      this.stopWatching();
      this.queueUntilStarted = undefined;
    }
    void this.maybeAskWorkspaceSettings();
  }

  /** Engine progress codes → localised text. */
  private progressText(code: string): string {
    if (code === 'index') return l10n.t('reading git index…');
    if (code === 'status') return l10n.t('reading working tree status…');
    if (code === 'scan') return l10n.t('scanning folder…');
    if (code.startsWith('copy')) return l10n.t('copying baseline {0}', code.slice(5));
    if (code.startsWith('recheck')) return l10n.t('re-checking {0}', code.slice(8));
    return code;
  }

  /** Starts (or restarts = re-baseline) a session. Waits for the background activation first (never races it). */
  async start(opts: { silent?: boolean; agent?: string; label?: string } = {}): Promise<boolean> {
    if (this.activating && !this.inActivation) await this.activating.catch(() => undefined);
    return this.startInternal(opts);
  }

  private inActivation = false;

  private async startInternal(opts: { silent?: boolean; agent?: string; label?: string } = {}): Promise<boolean> {
    if (this.starting) await this.starting;
    let ok = false;
    this.starting = (async () => {
      await this.ensureGit();
      // a fresh session takes the *current* configuration (rules/limits are frozen per session)
      this.deps.rules = new PathRules(this.config.rules);
      this.deps.limits = this.config.limits;
      this.startWatching();
      this.queueUntilStarted = this.queueUntilStarted ?? new Map();
      const run = async (progress?: vscode.Progress<{ message?: string }>, token?: vscode.CancellationToken) => {
        await this.engine.start({ agent: opts.agent, label: opts.label, progress: (m) => progress?.report({ message: this.progressText(m) }), cancelled: () => !!token?.isCancellationRequested });
      };
      try {
        if (opts.silent) await run();
        else await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: l10n.t('ChangeKeeper: taking a baseline of {0}…', this.folder.name), cancellable: true }, run);
        ok = true;
        this.ownsLock = true;
        this.lastHead = this.engine.baseline?.head;
        this.burstNoticeShown = false;
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
    this.ownsLock = false;
    this.stopWatching();
    this.fireChanged();
  }

  /** Window closing / folder removed: keep the session on disk, release the lock. */
  async detach(): Promise<void> {
    this.stopWatching();
    await this.engine.detach().catch(() => undefined);
    this.ownsLock = false;
  }

  /** Pro: install/remove the secret scanner (applies to files inspected from now on). */
  setSecretScanner(scanner: EngineDeps['secretScanner']): void {
    this.deps.secretScanner = scanner;
  }

  /** Whether purge/GC may touch this folder's store: we own the session, or nobody alive does. */
  async mayTouchStore(): Promise<boolean> {
    if (this.ownsLock) return true;
    const owner = await this.store.lockOwner();
    return owner === undefined || owner === process.pid;
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
      w.onDidCreate((u) => this.enqueueUri(u, 'create')),
      w.onDidChange((u) => this.enqueueUri(u, 'change')),
      w.onDidDelete((u) => this.enqueueUri(u, 'delete')),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme === 'file' && e.contentChanges.length) this.enqueueUri(e.document.uri, 'doc', 400);
      }),
      vscode.workspace.onDidSaveTextDocument((d) => this.enqueueUri(d.uri, 'change')),
      vscode.workspace.onDidCloseTextDocument((d) => this.enqueueUri(d.uri, 'change')),
      vscode.workspace.onDidRenameFiles((e) => {
        for (const f of e.files) {
          this.enqueueUri(f.oldUri, 'delete');
          this.enqueueUri(f.newUri, 'create');
        }
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const f of e.files) this.enqueueUri(f, 'delete');
      }),
    );
    if (this.gitCtx?.gitDir) {
      // git operations by the agent (commit/checkout/reset/stash/rebase) touch these; a non-recursive
      // pattern on the git dir itself (works for worktrees/submodules whose .git is a file)
      const gw = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(this.gitCtx.gitDir), '{HEAD,ORIG_HEAD,MERGE_HEAD,REBASE_HEAD,index}'));
      this.disposables.push(gw, gw.onDidChange(() => this.onGitHeadTouched()), gw.onDidCreate(() => this.onGitHeadTouched()));
    }
  }

  private stopWatching(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    for (const t of this.pending.values()) clearTimeout(t.timer);
    this.pending.clear();
    this.queue = [];
    if (this.headTimer) clearTimeout(this.headTimer);
    this.headTimer = undefined;
    this.watching = false;
  }

  private enqueueUri(uri: vscode.Uri, kind: EventKind, delay = 250): void {
    if (uri.scheme !== 'file') return;
    const rel = toRelPosix(this.folder.uri.fsPath, uri.fsPath);
    if (rel === undefined || rel === '') return;
    if (rel.endsWith('.ck-tmp')) return; // our own atomic-write temp files
    if (this.queueUntilStarted) {
      const prev = this.queueUntilStarted.get(rel);
      this.queueUntilStarted.set(rel, prev === 'create' || prev === 'delete' ? prev : kind);
      return;
    }
    this.enqueueRel(rel, delay, kind);
  }

  enqueueRel(rel: string, delay = 250, kind: EventKind = 'change'): void {
    const prev = this.pending.get(rel);
    if (prev) {
      clearTimeout(prev.timer);
      // a create/delete outranks a plain change for the directory expansion decision
      if (prev.kind === 'create' || prev.kind === 'delete') kind = prev.kind;
    }
    this.pending.set(rel, {
      kind,
      timer: setTimeout(() => {
        this.pending.delete(rel);
        this.queue.push({ rel, kind });
        void this.drain();
      }, delay),
    });
  }

  private releaseStartQueue(): void {
    const q = this.queueUntilStarted ?? new Map<string, EventKind>();
    this.queueUntilStarted = undefined;
    if (!this.hasSession) return;
    for (const [rel, kind] of q) this.enqueueRel(rel, 0, kind);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const batch = this.queue.splice(0, 200);
        // directories: a moved-in directory yields no events for its children; a moved-away one leaves
        // its old children as ghosts. Expand both cases into file paths.
        const rels: string[] = [];
        for (const item of batch) rels.push(...(await this.expand(item)));
        await this.engine.prefetchIgnore(rels);
        // bounded concurrency: each new path may cost a git process
        for (let i = 0; i < rels.length; i += 8) {
          await Promise.all(
            rels.slice(i, i + 8).map(async (rel) => {
              try {
                await this.engine.handlePath(rel);
              } catch (e) {
                log(`[${this.folder.name}] ${rel}: ${String(e)}`);
              }
            }),
          );
        }
        if (this.engine.burst.paused && !this.burstNoticeShown) void this.showBurstNotice();
      }
    } finally {
      this.draining = false;
      this.fireChanged();
    }
  }

  private async expand(item: { rel: string; kind: EventKind }): Promise<string[]> {
    const abs = path.join(this.folder.uri.fsPath, ...item.rel.split('/'));
    const st = await this.fsAdapter.stat(abs);
    if (st?.isDirectory) {
      if (item.kind !== 'create') return []; // change events on existing dirs: children report themselves
      const out = new Set<string>(this.engine.knownPathsUnder(item.rel));
      let n = 0;
      for await (const f of this.fsAdapter.walk(abs, (d) => this.deps.rules.skipDir(item.rel + '/' + d))) {
        out.add(item.rel + '/' + f.rel);
        if (++n > this.deps.limits.maxFilesPerSession) break;
      }
      return [...out];
    }
    if (!st) {
      // gone: a file, or a directory whose children must now be re-checked (they will show as deleted/renamed)
      const under = this.engine.knownPathsUnder(item.rel);
      return under.length ? [item.rel, ...under] : [item.rel];
    }
    return [item.rel];
  }

  private async showBurstNotice(): Promise<void> {
    this.burstNoticeShown = true; // stays true until the user decides (tree, status bar and palette also show the pause)
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
    if (pick === undefined) return; // dismissed: keep paused; the palette / tree node resolve it later
    await this.resolveBurst(pick === track ? 'track' : pick === ignore ? 'ignore' : pick === rebase ? 'rebase' : 'exclude');
  }

  async resolveBurst(choice: 'track' | 'ignore' | 'rebase' | 'exclude'): Promise<void> {
    this.burstNoticeShown = false;
    await vscode.commands.executeCommand('setContext', 'changekeeper.burstPaused', false);
    if (choice === 'track') await this.engine.resumeBurst('track');
    else if (choice === 'ignore') await this.engine.resumeBurst('ignore');
    else if (choice === 'rebase') await this.start();
    else {
      await this.engine.resumeBurst('ignore');
      await vscode.commands.executeCommand('workbench.action.openSettings', 'changekeeper.exclude');
    }
    this.fireChanged();
  }

  private async refreshHead(): Promise<void> {
    if (!this.gitCtx) return;
    try {
      const r = await this.gitCtx.runner.run(['rev-parse', 'HEAD']);
      this.lastHead = r.code === 0 ? r.stdout.toString('utf8').trim() || undefined : undefined;
    } catch {
      /* ignore */
    }
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
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this._onDidChange.dispose();
  }
}

export { WORKSPACE_SENSITIVE_KEYS };

function samePathCI(a: string, b: string): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}
