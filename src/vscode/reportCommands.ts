import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { buildReport, suggestCommitMessage } from '../core/report';
import { FolderGuard } from './folderGuard';
import { GuardManager } from './guardManager';

/** Session report: show as a Markdown preview, export to a file, copy the commit message. */
export class ReportCommands {
  constructor(private readonly manager: GuardManager) {}

  /** Only folders with a session can produce a report: picking any other one answers "nothing to report" wrongly (audit V8). */
  private async pick(): Promise<FolderGuard | undefined> {
    const g = await this.manager.pickGuard((x) => !!x.engine.session);
    if (!g || !g.engine.session) {
      void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: no session to report on.'));
      return undefined;
    }
    return g;
  }

  /** Extra sections hook (Pro modules append validations/secrets); kept as a list of providers. */
  readonly extraSections: ((guard: FolderGuard) => Promise<string[]>)[] = [];

  async build(guard: FolderGuard): Promise<string> {
    const extra: string[] = [];
    for (const p of this.extraSections) extra.push(...(await p(guard)));
    return buildReport(guard.engine.session!, { folderName: guard.folder.name, extraSections: extra });
  }

  async show(): Promise<void> {
    const guard = await this.pick();
    if (!guard) return;
    const md = await this.build(guard);
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
    await vscode.window.showTextDocument(doc, { preview: true });
    const copy = l10n.t('Copy commit message');
    const save = l10n.t('Save as file…');
    void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: session report opened (unsaved document).'), copy, save).then(async (p) => {
      if (p === copy) await this.copyCommitMessage(guard);
      else if (p === save) await this.export(guard);
    });
  }

  async export(guardArg?: FolderGuard): Promise<void> {
    const guard = guardArg ?? (await this.pick());
    if (!guard) return;
    const md = await this.build(guard);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = await vscode.window.showSaveDialog({
      title: l10n.t('Export ChangeKeeper report'),
      defaultUri: vscode.Uri.file(path.join(os.homedir(), `changekeeper-${guard.folder.name}-${stamp}.md`)),
      filters: { Markdown: ['md'] },
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(md, 'utf8'));
    const open = l10n.t('Open');
    void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: report saved to {0}', target.fsPath), open).then((p) => (p === open ? vscode.window.showTextDocument(target) : undefined));
  }

  async copyCommitMessage(guardArg?: FolderGuard): Promise<void> {
    const guard = guardArg ?? (await this.pick());
    if (!guard) return;
    await vscode.env.clipboard.writeText(suggestCommitMessage(guard.engine.session!));
    void vscode.window.setStatusBarMessage(l10n.t('ChangeKeeper: commit message copied'), 3000);
  }
}
