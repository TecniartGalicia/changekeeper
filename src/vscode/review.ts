import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { DiscardPlan } from '../core/engine';
import { FileChange } from '../core/session';
import { BASELINE_SCHEME, baselineUri, emptyUri } from './env';
import { FolderGuard } from './folderGuard';
import { GuardManager } from './guardManager';
import { FileNode, HunkNode, Node, SessionNode } from './views/tree';

/**
 * Command implementations. Every command accepts the tree node it was invoked on, or falls back
 * to the active editor / a folder pick.
 */
export class ReviewCommands {
  /** hook run before a session is stopped (Pro: onSessionEnd validations) */
  beforeStop: ((guard: FolderGuard) => Promise<void>) | undefined;
  constructor(private readonly manager: GuardManager) {}

  // ---- helpers ------------------------------------------------------------------------------

  private async target(arg: unknown): Promise<{ guard: FolderGuard; change: FileChange; hunkId?: string } | undefined> {
    if (arg instanceof FileNode) return { guard: arg.guard, change: arg.change };
    if (arg instanceof HunkNode) return { guard: arg.guard, change: arg.change, hunkId: arg.hunkId };
    if (arg && typeof arg === 'object' && 'guard' in (arg as any) && 'change' in (arg as any)) return arg as any;
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (!uri) return undefined;
    const guard = this.manager.guardFor(uri);
    if (!guard) return undefined;
    const rel = guard.engine.relOf(uri.fsPath);
    if (!rel) return undefined;
    const view = await guard.engine.view(rel);
    return view ? { guard, change: view.change } : undefined;
  }

  private fileUri(guard: FolderGuard, rel: string): vscode.Uri {
    return vscode.Uri.joinPath(guard.folder.uri, ...rel.split('/'));
  }

  // ---- diff / navigation --------------------------------------------------------------------

  async openDiff(arg?: unknown): Promise<void> {
    const t = await this.target(arg);
    if (!t) {
      void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: this file has no tracked changes.'));
      return;
    }
    const { guard, change } = t;
    const session = guard.engine.session!;
    // a rename diffs against the baseline of its source; an addition against nothing
    const leftPath = change.kind === 'R' && change.renamedFrom ? change.renamedFrom : change.path;
    const left = change.kind === 'A' ? emptyUri(change.path) : baselineUri(guard.folder.uri, leftPath, session.id);
    const right = change.kind === 'D' ? emptyUri(change.path) : this.fileUri(guard, change.path);
    const title = `${path.posix.basename(change.path)} (${l10n.t('baseline')} ↔ ${l10n.t('now')})`;
    const opts: vscode.TextDocumentShowOptions = { preview: true };
    if (t.hunkId) {
      const meta = change.hunkMeta?.[t.hunkId];
      if (meta) {
        const line = Math.max(0, meta.firstLine ?? (meta.newLines === 0 ? meta.newStart : meta.newStart - 1));
        opts.selection = new vscode.Range(line, 0, line, 0);
      }
    }
    if (change.binary || (change.tooLarge && !change.hunks)) {
      void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: {0} is binary or too large to diff. You can still restore it.', change.path));
    }
    await vscode.commands.executeCommand('vscode.diff', left, right, title, opts);
  }

  async openFile(arg?: unknown): Promise<void> {
    const t = await this.target(arg);
    if (!t) return;
    await vscode.window.showTextDocument(this.fileUri(t.guard, t.change.path));
  }

  async reviewAll(): Promise<void> {
    const guards = this.manager.all().filter((g) => g.hasSession);
    const resources: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = [];
    for (const g of guards) {
      const sid = g.engine.session!.id;
      for (const c of g.engine.changes()) {
        const file = this.fileUri(g, c.path);
        const left = c.kind === 'A' ? emptyUri(c.path) : baselineUri(g.folder.uri, c.path, sid);
        const right = c.kind === 'D' ? emptyUri(c.path) : file;
        resources.push([file, left, right]);
      }
    }
    if (!resources.length) {
      void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: no changes to review.'));
      return;
    }
    await vscode.commands.executeCommand('vscode.changes', l10n.t('ChangeKeeper: {0} changed files', resources.length), resources);
  }

  // ---- hunk / file actions ------------------------------------------------------------------

  async acceptHunk(arg?: unknown): Promise<void> {
    const t = await this.target(arg);
    if (!t || !t.hunkId) return;
    t.guard.engine.setHunkStatus(t.change.path, t.hunkId, 'accepted');
  }

  async discardHunk(arg?: unknown): Promise<void> {
    const t = await this.target(arg);
    if (!t || !t.hunkId) return;
    await this.discard(t.guard, t.change.path, t.hunkId);
  }

  /** Discards a hunk through a WorkspaceEdit when the document is open (undoable), else on disk. */
  async discard(guard: FolderGuard, rel: string, hunkId: string): Promise<boolean> {
    const plan = await guard.engine.planDiscard(rel, hunkId);
    if (!plan.ok) {
      const why = plan.reason === 'stale' ? l10n.t('the file changed since this hunk was computed — the view has been refreshed') : plan.reason === 'binary' ? l10n.t('binary file') : plan.reason === 'no-baseline' ? l10n.t('no baseline available') : l10n.t('no tracked change');
      void vscode.window.showWarningMessage(l10n.t('ChangeKeeper: cannot discard this hunk: {0}.', why));
      return false;
    }
    if (!plan.isOpen) {
      const r = await guard.engine.applyDiscardToDisk(plan, hunkId);
      if (!r.ok) void vscode.window.showWarningMessage(l10n.t('ChangeKeeper: cannot discard this hunk: {0}.', l10n.t('the file changed since this hunk was computed — the view has been refreshed')));
      return r.ok;
    }
    return this.applyPlanToDocument(guard, plan, hunkId);
  }

  private async applyPlanToDocument(guard: FolderGuard, plan: DiscardPlan, hunkId: string): Promise<boolean> {
    const uri = this.fileUri(guard, plan.rel);
    const doc = await vscode.workspace.openTextDocument(uri);
    const wasDirty = doc.isDirty;
    // the buffer must still be what the plan was computed on (the agent may have written meanwhile)
    const fresh = await guard.engine.view(plan.rel);
    if (!fresh || fresh.currentSha !== plan.currentSha) {
      void vscode.window.showWarningMessage(l10n.t('ChangeKeeper: cannot discard this hunk: {0}.', l10n.t('the file changed since this hunk was computed — the view has been refreshed')));
      return false;
    }
    const start = new vscode.Position(plan.startLine, 0);
    const end = plan.endLine >= doc.lineCount ? doc.lineAt(doc.lineCount - 1).range.end : new vscode.Position(plan.endLine, 0);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(start, end), plan.replacement, { needsConfirmation: false, label: l10n.t('ChangeKeeper: discard hunk') });
    let ok = await vscode.workspace.applyEdit(edit, { isRefactoring: true });
    if (ok && doc.getText() !== plan.newText) {
      // EOL normalisation or an edge at end-of-file made the range edit inexact: replace the whole text
      const full = new vscode.WorkspaceEdit();
      full.replace(uri, doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0)), plan.newText);
      ok = await vscode.workspace.applyEdit(full, { isRefactoring: true });
    }
    if (!ok) {
      void vscode.window.showWarningMessage(l10n.t('ChangeKeeper: the editor refused the edit.'));
      return false;
    }
    if (!wasDirty) await doc.save();
    guard.engine.markDiscarded(plan.rel, hunkId);
    guard.enqueueRel(plan.rel, 0);
    return true;
  }

  async acceptFile(arg?: unknown): Promise<void> {
    const t = await this.target(arg);
    if (!t) return;
    t.guard.engine.acceptFile(t.change.path);
  }

  async acceptAll(): Promise<void> {
    for (const g of this.manager.all()) if (g.hasSession) g.engine.acceptAll();
    void vscode.window.setStatusBarMessage(l10n.t('ChangeKeeper: all changes marked as reviewed'), 3000);
  }

  async restoreFile(arg?: unknown): Promise<void> {
    const t = await this.target(arg);
    if (!t) return;
    const { guard, change } = t;
    const what = change.kind === 'A' ? l10n.t('delete {0} (it did not exist when the session started)', change.path) : l10n.t('restore {0} to its baseline', change.path);
    const yes = l10n.t('Restore');
    const pick = await vscode.window.showWarningMessage(l10n.t('ChangeKeeper will {0}. The current version is kept so you can undo.', what), { modal: true }, yes);
    if (pick !== yes) return;
    await this.closeDirtyIfOpen(guard, change.path);
    const r = await guard.engine.restore([change.path], 'file');
    this.reportRestore(r.results);
  }

  async restoreSession(): Promise<void> {
    const guard = await this.manager.pickGuard((g) => g.hasSession && g.engine.changes().length > 0);
    if (!guard || !guard.hasSession) {
      void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: no changes to restore.'));
      return;
    }
    const changes = guard.engine.changes();
    if (!changes.length) return;
    const yes = l10n.t('Restore all');
    const pick = await vscode.window.showWarningMessage(l10n.t('ChangeKeeper will restore {0} file(s) in {1} to the session baseline (created files are deleted). Every current version is kept so you can undo.', changes.length, guard.folder.name), { modal: true }, yes);
    if (pick !== yes) return;
    for (const c of changes) await this.closeDirtyIfOpen(guard, c.path);
    const r = await guard.engine.restore(
      changes.map((c) => c.path),
      'session',
    );
    this.reportRestore(r.results);
  }

  private async closeDirtyIfOpen(guard: FolderGuard, rel: string): Promise<void> {
    const uri = this.fileUri(guard, rel);
    for (const d of vscode.workspace.textDocuments) {
      if (d.uri.toString() === uri.toString() && d.isDirty) {
        // the restore writes to disk; a dirty buffer would hide it. Save first so nothing is lost.
        await d.save();
      }
    }
  }

  private reportRestore(results: { rel: string; status: string; reason?: string }[]): void {
    const restored = results.filter((r) => r.status === 'restored').length;
    const deleted = results.filter((r) => r.status === 'deleted').length;
    const skipped = results.filter((r) => r.status === 'skipped');
    let msg = l10n.t('ChangeKeeper: {0} restored, {1} deleted', restored, deleted);
    if (skipped.length) msg += ' · ' + l10n.t('{0} skipped ({1})', skipped.length, skipped.map((s) => `${s.rel}: ${s.reason ?? '?'}`).join('; '));
    const undo = l10n.t('Undo');
    void vscode.window.showInformationMessage(msg, undo).then((p) => (p === undo ? this.undoRestore() : undefined));
  }

  async undoRestore(): Promise<void> {
    const guards = this.manager.all().filter((g) => g.hasSession && g.engine.lastUndoableRestore());
    if (!guards.length) {
      void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: nothing to undo.'));
      return;
    }
    const guard = guards.length === 1 ? guards[0] : await this.manager.pickGuard((g) => guards.includes(g));
    if (!guard) return;
    const rec = guard.engine.lastUndoableRestore();
    if (!rec) return;
    let res = await guard.engine.undoRestore(rec);
    const skipped = res.filter((r) => r.status === 'skipped' && r.reason === 'changed-since');
    if (skipped.length) {
      const force = l10n.t('Overwrite anyway');
      const pick = await vscode.window.showWarningMessage(l10n.t('ChangeKeeper: {0} file(s) changed after the restore and were not touched: {1}', skipped.length, skipped.map((s) => s.rel).join(', ')), { modal: true }, force);
      if (pick === force) res = await guard.engine.undoRestore(rec, true);
    }
    void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: undo — {0} file(s) put back.', res.filter((r) => r.status === 'undone').length));
  }

  /**
   * "Accept / discard hunk at cursor": from the diff editor (right side) or the normal editor. The
   * diff-gutter menu contribution is a proposed API (`contribDiffEditorGutterToolBarMenus`), so these
   * commands live in the editor title/context menus and use the cursor line.
   */
  private async hunkAtCursor(arg?: any): Promise<{ guard: FolderGuard; rel: string; ids: string[] } | undefined> {
    const editor = vscode.window.activeTextEditor;
    const modifiedUri: vscode.Uri | undefined = arg instanceof vscode.Uri ? arg : arg?.modifiedUri ?? editor?.document.uri;
    if (!modifiedUri || modifiedUri.scheme !== 'file') return undefined;
    const guard = this.manager.guardFor(modifiedUri);
    const rel = guard?.engine.relOf(modifiedUri.fsPath);
    if (!guard || !rel) return undefined;
    const view = await guard.engine.view(rel);
    if (!view || !view.hunks) return undefined;
    const startLine: number | undefined = arg?.mapping?.modified?.startLineNumber;
    const endLine: number | undefined = arg?.mapping?.modified?.endLineNumberExclusive;
    let ids: string[];
    if (typeof startLine === 'number' && typeof endLine === 'number') {
      // VS Code's blocks and our hunks are computed by different differs: take every hunk that overlaps
      ids = view.hunks.filter((h) => h.newStart <= endLine && h.newStart + Math.max(1, h.newLines) > startLine).map((h) => h.id);
    } else if (editor && editor.document.uri.scheme === BASELINE_SCHEME) {
      // cursor on the baseline side of the diff: map through the baseline line numbers
      const line = editor.selection.active.line + 1;
      ids = view.hunks.filter((h) => line >= h.oldStart && line < h.oldStart + Math.max(1, h.oldLines)).map((h) => h.id);
    } else {
      // prefer the editor that shows the modified file (the right side of the diff, or the plain editor)
      const target = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === modifiedUri.toString()) ?? editor;
      const line = (target?.selection.active.line ?? 0) + 1;
      ids = view.hunks.filter((h) => line >= h.newStart && line < h.newStart + Math.max(1, h.newLines)).map((h) => h.id);
    }
    return { guard, rel, ids };
  }

  async acceptHunkAtCursor(arg?: any): Promise<void> {
    const t = await this.hunkAtCursor(arg);
    if (!t || !t.ids.length) {
      void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: no tracked hunk at this position.'));
      return;
    }
    for (const id of t.ids) t.guard.engine.setHunkStatus(t.rel, id, 'accepted');
  }

  async discardHunkAtCursor(arg?: any): Promise<void> {
    const t = await this.hunkAtCursor(arg);
    if (!t || !t.ids.length) {
      void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: no tracked hunk at this position.'));
      return;
    }
    // hunks are independent; discard from the bottom so earlier line numbers stay valid
    const view = await t.guard.engine.view(t.rel);
    const ordered = (view?.hunks ?? []).filter((h) => t.ids.includes(h.id)).sort((a, b) => b.newStart - a.newStart);
    for (const h of ordered) await this.discard(t.guard, t.rel, h.id);
  }

  // ---- session lifecycle --------------------------------------------------------------------

  async startSession(arg?: unknown): Promise<void> {
    const guard = arg instanceof SessionNode ? arg.guard : await this.manager.pickGuard();
    if (!guard) {
      void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: open a folder first.'));
      return;
    }
    if (guard.hasSession) {
      const yes = l10n.t('New session');
      const pick = await vscode.window.showWarningMessage(l10n.t('ChangeKeeper: start a new session for {0}? The current one is closed (its data stays available for the retention period) and a fresh baseline is taken now.', guard.folder.name), { modal: true }, yes);
      if (pick !== yes) return;
    }
    await guard.start();
  }

  async stopSession(arg?: unknown): Promise<void> {
    const guard = arg instanceof SessionNode ? arg.guard : await this.manager.pickGuard((g) => g.hasSession);
    if (!guard || !guard.hasSession) {
      void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: no running session.'));
      return;
    }
    if (this.beforeStop) await this.beforeStop(guard).catch(() => undefined);
    await guard.stop();
    void vscode.window.setStatusBarMessage(l10n.t('ChangeKeeper: session stopped for {0}', guard.folder.name), 3000);
  }

  async resumeBurst(arg?: unknown): Promise<void> {
    const guard = arg instanceof FolderGuard ? arg : this.manager.all().find((g) => g.engine.burst.paused) ?? (await this.manager.pickGuard((g) => g.hasSession));
    if (!guard) return;
    const items: { label: string; choice: 'track' | 'ignore' | 'rebase' | 'exclude' }[] = [
      { label: l10n.t('Track the paused files'), choice: 'track' },
      { label: l10n.t('Ignore this burst'), choice: 'ignore' },
      { label: l10n.t('New session (re-baseline)'), choice: 'rebase' },
      { label: l10n.t('Ignore and add exclusions…'), choice: 'exclude' },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: l10n.t('{0} new files are paused', guard.engine.burstQueue.length) });
    if (pick) await guard.resolveBurst(pick.choice);
  }

  async purgeData(): Promise<void> {
    const yes = l10n.t('Purge');
    const pick = await vscode.window.showWarningMessage(l10n.t('ChangeKeeper: delete ALL stored sessions and baselines of the open folders? Running sessions are stopped. This cannot be undone.'), { modal: true }, yes);
    if (pick !== yes) return;
    let skipped = 0;
    for (const g of this.manager.all()) {
      if (!(await g.mayTouchStore())) {
        skipped++;
        continue; // another live window owns this folder's session: never destroy its data from here
      }
      await g.stop();
      await g.store.purge();
    }
    if (skipped) void vscode.window.showWarningMessage(l10n.t('ChangeKeeper: {0} folder(s) were skipped because another VS Code window is guarding them.', skipped));
    else void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: data purged.'));
  }

  static nodeOf(arg: unknown): Node | undefined {
    return arg instanceof FileNode || arg instanceof HunkNode || arg instanceof SessionNode ? arg : undefined;
  }
}
