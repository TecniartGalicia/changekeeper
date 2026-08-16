import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { parseBaselineUri } from '../env';
import { GuardManager } from '../guardManager';

/** `ck-baseline:` → the file's content at session start; `ck-empty:` → nothing (absent side of a diff). */
export class BaselineContentProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly manager: GuardManager) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const p = parseBaselineUri(uri);
    if (!p) return '';
    const guard = this.manager.guardByFolderUri(p.folder);
    if (!guard || !guard.engine.session) return '';
    if (guard.engine.session.id !== p.sessionId) return l10n.t('// ChangeKeeper: this baseline belongs to a previous session.');
    const b = await guard.engine.baselineText(p.rel);
    if (!b.available) return l10n.t('// ChangeKeeper: no baseline for this file ({0}).', b.reason ?? '');
    return b.text;
  }

  invalidate(uri: vscode.Uri): void {
    this._onDidChange.fire(uri);
  }
}

export class EmptyContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(): string {
    return '';
  }
}
