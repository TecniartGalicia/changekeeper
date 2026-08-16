import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { Hunk } from '../../core/hunks';
import { firstChangedLine } from '../../core/session';
import { GuardManager } from '../guardManager';
import { FileNode, HunkNode } from './tree';

/**
 * Inline review in the normal editor (stable API, no proposed `editorInsets`):
 *  - one CodeLens above each hunk: Accept · Discard · Diff (+ status)
 *  - one summary CodeLens at the top of the file
 *  - decorations: added lines highlighted, deletions marked with a top border + hover showing what was removed
 */
export class HunkCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly manager: GuardManager) {
    this.sub = manager.onDidChange(() => this._onDidChangeCodeLenses.fire());
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChangeCodeLenses.dispose();
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (document.uri.scheme !== 'file') return [];
    const guard = this.manager.guardFor(document.uri);
    if (!guard || !guard.hasSession || !guard.config.codeLens) return [];
    const rel = guard.engine.relOf(document.uri.fsPath);
    if (!rel) return [];
    const view = await guard.engine.view(rel);
    if (!view || !view.hunks || !view.hunks.length) return [];
    const change = view.change;
    const lenses: vscode.CodeLens[] = [];
    const pending = view.hunks.filter((h) => change.hunks[h.id] === 'pending').length;
    const fileNode = new FileNode(guard, change);
    lenses.push(
      new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: `$(shield) ChangeKeeper: ${l10n.t('{0} hunks, {1} pending', view.hunks.length, pending)}${change.critical ? ' · ' + l10n.t('critical file') : ''}`,
        command: 'changekeeper.openDiff',
        arguments: [fileNode],
      }),
      new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), { title: l10n.t('Accept file'), command: 'changekeeper.acceptFile', arguments: [fileNode] }),
      new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), { title: l10n.t('Restore file'), command: 'changekeeper.restoreFile', arguments: [fileNode] }),
    );
    for (const h of view.hunks) {
      // the lens sits on the first changed line (not on the context above it), like the tree and the diff selection
      const line = Math.min(Math.max(0, firstChangedLine(h)), Math.max(0, document.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      const node = new HunkNode(guard, change, h.id);
      const status = change.hunks[h.id];
      const label = status === 'accepted' ? l10n.t('accepted') : status === 'discarded' ? l10n.t('discarded') : l10n.t('pending');
      lenses.push(new vscode.CodeLens(range, { title: `$(diff) ${l10n.t('Hunk')} +${h.added} −${h.removed} · ${label}`, command: 'changekeeper.openDiff', arguments: [node] }));
      if (status === 'pending') lenses.push(new vscode.CodeLens(range, { title: `$(check) ${l10n.t('Accept')}`, command: 'changekeeper.acceptHunk', arguments: [node] }));
      lenses.push(new vscode.CodeLens(range, { title: `$(discard) ${l10n.t('Discard')}`, command: 'changekeeper.discardHunk', arguments: [node] }));
    }
    return lenses;
  }
}

/** 0-based line of the first *current* line a hunk covers (for a pure deletion: the line after it). */
export function hunkFirstLine(h: Hunk): number {
  return h.newLines === 0 ? h.newStart : h.newStart - 1;
}

export class HunkDecorations implements vscode.Disposable {
  private readonly added: vscode.TextEditorDecorationType;
  private readonly removed: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly manager: GuardManager) {
    this.added = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.removed = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: '2px 0 0 0',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.disposables.push(
      manager.onDidChange(() => this.schedule()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) this.schedule();
      }),
    );
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 200);
  }

  async refresh(): Promise<void> {
    for (const editor of vscode.window.visibleTextEditors) {
      const doc = editor.document;
      if (doc.uri.scheme !== 'file') continue;
      const guard = this.manager.guardFor(doc.uri);
      const rel = guard?.engine.relOf(doc.uri.fsPath);
      if (!guard || !rel || !guard.hasSession || !guard.config.decorations) {
        editor.setDecorations(this.added, []);
        editor.setDecorations(this.removed, []);
        continue;
      }
      const view = await guard.engine.view(rel);
      if (!view || !view.hunks) {
        editor.setDecorations(this.added, []);
        editor.setDecorations(this.removed, []);
        continue;
      }
      const addedRanges: vscode.Range[] = [];
      const removedRanges: vscode.DecorationOptions[] = [];
      for (const h of view.hunks) {
        if (view.change.hunks[h.id] === 'discarded') continue;
        let line = h.newLines === 0 ? h.newStart : h.newStart - 1; // current 0-based line cursor
        let pendingRemoved: string[] = [];
        for (const l of h.lines) {
          if (l.type === '-') {
            pendingRemoved.push(l.text);
            continue;
          }
          if (pendingRemoved.length) {
            removedRanges.push(deletionMarker(doc, line, pendingRemoved));
            pendingRemoved = [];
          }
          if (l.type === '+') addedRanges.push(new vscode.Range(line, 0, line, 0));
          line++;
        }
        if (pendingRemoved.length) removedRanges.push(deletionMarker(doc, line, pendingRemoved));
      }
      editor.setDecorations(this.added, addedRanges);
      editor.setDecorations(this.removed, removedRanges);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
    this.added.dispose();
    this.removed.dispose();
  }
}

function deletionMarker(doc: vscode.TextDocument, line: number, removed: string[]): vscode.DecorationOptions {
  const l = Math.min(Math.max(0, line), Math.max(0, doc.lineCount - 1));
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**ChangeKeeper — ${l10n.t('{0} line(s) removed here', removed.length)}**\n\n`);
  md.appendCodeblock(removed.slice(0, 40).join('\n') + (removed.length > 40 ? '\n…' : ''), 'text');
  return { range: new vscode.Range(l, 0, l, 0), hoverMessage: md };
}
