import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { FileChange, isFileReviewed } from '../../core/session';
import { FolderGuard } from '../folderGuard';
import { GuardManager } from '../guardManager';

export type Node = SessionNode | FileNode | HunkNode | InfoNode;

export class SessionNode {
  readonly type = 'session';
  constructor(readonly guard: FolderGuard) {}
}
export class FileNode {
  readonly type = 'file';
  constructor(readonly guard: FolderGuard, readonly change: FileChange) {}
  get uri(): vscode.Uri {
    return vscode.Uri.joinPath(this.guard.folder.uri, ...this.change.path.split('/'));
  }
}
export class HunkNode {
  readonly type = 'hunk';
  constructor(readonly guard: FolderGuard, readonly change: FileChange, readonly hunkId: string) {}
  get uri(): vscode.Uri {
    return vscode.Uri.joinPath(this.guard.folder.uri, ...this.change.path.split('/'));
  }
}
export class InfoNode {
  readonly type = 'info';
  constructor(readonly label: string, readonly icon: string, readonly command?: vscode.Command) {}
}

const KIND_ICON: Record<FileChange['kind'], [string, string]> = {
  A: ['diff-added', 'gitDecoration.addedResourceForeground'],
  M: ['diff-modified', 'gitDecoration.modifiedResourceForeground'],
  D: ['diff-removed', 'gitDecoration.deletedResourceForeground'],
  R: ['diff-renamed', 'gitDecoration.renamedResourceForeground'],
};

export class ChangesTree implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly manager: GuardManager) {
    manager.onDidChange(() => this._onDidChangeTreeData.fire(undefined));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      const guards = this.manager.all().filter((g) => g.hasSession);
      if (guards.length === 0) return [];
      if (guards.length === 1) return this.fileNodes(guards[0]);
      return guards.map((g) => new SessionNode(g));
    }
    if (element.type === 'session') return this.fileNodes(element.guard);
    if (element.type === 'file') {
      const meta = element.change.hunkMeta ?? {};
      const ids = Object.keys(element.change.hunks).sort((a, b) => (meta[a]?.newStart ?? 0) - (meta[b]?.newStart ?? 0));
      return ids.map((id) => new HunkNode(element.guard, element.change, id));
    }
    return [];
  }

  private fileNodes(g: FolderGuard): Node[] {
    const changes = g.engine.changes();
    const nodes: Node[] = [];
    if (g.engine.burst.paused) nodes.push(new InfoNode(l10n.t('{0} new files paused by the burst guard — click to decide', g.engine.burstQueue.length), 'debug-pause', { command: 'changekeeper.resumeBurst', title: '', arguments: [g] }));
    const sorted = [...changes].sort((a, b) => {
      if (a.critical !== b.critical) return a.critical ? -1 : 1;
      const ra = isFileReviewed(a) ? 1 : 0;
      const rb = isFileReviewed(b) ? 1 : 0;
      if (ra !== rb) return ra - rb;
      return a.path.localeCompare(b.path);
    });
    for (const c of sorted) nodes.push(new FileNode(g, c));
    return nodes;
  }

  getTreeItem(element: Node): vscode.TreeItem {
    if (element.type === 'session') {
      const g = element.guard;
      const c = g.engine.counters!;
      const item = new vscode.TreeItem(g.folder.name, vscode.TreeItemCollapsibleState.Expanded);
      item.description = l10n.t('{0} files · {1} hunks · {2} pending', c.files, c.hunks, c.pending);
      item.iconPath = new vscode.ThemeIcon('shield');
      item.contextValue = 'ck.session';
      item.tooltip = new vscode.MarkdownString(`**${g.folder.name}**\n\n${l10n.t('Session started {0}', new Date(g.engine.session!.startedAt).toLocaleString())}\n\n${g.isGit ? l10n.t('Baseline: git index') : l10n.t('Baseline: folder copy')}`);
      return item;
    }
    if (element.type === 'file') return this.fileItem(element);
    if (element.type === 'hunk') return this.hunkItem(element);
    const info = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    info.iconPath = new vscode.ThemeIcon(element.icon);
    info.command = element.command;
    info.contextValue = 'ck.info';
    return info;
  }

  private fileItem(n: FileNode): vscode.TreeItem {
    const c = n.change;
    const hunkIds = Object.keys(c.hunks);
    const pending = hunkIds.filter((id) => c.hunks[id] === 'pending').length;
    const reviewed = isFileReviewed(c);
    const item = new vscode.TreeItem(path.posix.basename(c.path), hunkIds.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = `${n.guard.folder.uri.toString()}|${c.path}`;
    const dir = path.posix.dirname(c.path);
    const parts: string[] = [];
    if (dir !== '.') parts.push(dir);
    parts.push(c.kind === 'R' ? l10n.t('renamed from {0}', c.renamedFrom ?? '?') : c.kind);
    if (hunkIds.length) parts.push(pending ? l10n.t('{0}/{1} pending', pending, hunkIds.length) : l10n.t('{0} hunks reviewed', hunkIds.length));
    if (c.binary) parts.push(l10n.t('binary'));
    if (c.tooLarge) parts.push(l10n.t('too large'));
    if (c.baselineUnavailable) parts.push(l10n.t('no baseline'));
    if (c.baselineUncertain) parts.push(l10n.t('baseline uncertain'));
    if (c.eolOnly) parts.push(l10n.t('line endings only'));
    if (c.secrets?.length) parts.push(l10n.t('{0} possible secret(s)', c.secrets.length));
    item.description = parts.join(' · ');
    const [icon, color] = KIND_ICON[c.kind];
    item.iconPath = c.secrets?.length && !reviewed ? new vscode.ThemeIcon('key', new vscode.ThemeColor('list.errorForeground')) : c.critical && !reviewed ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground')) : new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    item.resourceUri = n.uri;
    item.contextValue = `ck.file${c.critical ? '.critical' : ''}${reviewed ? '.reviewed' : ''}`;
    item.command = { command: 'changekeeper.openDiff', title: l10n.t('Open diff'), arguments: [n] };
    const md = new vscode.MarkdownString();
    // paths may contain markdown metacharacters (__init__.py, *.md): append them as text
    md.appendMarkdown('**');
    md.appendText(c.path);
    md.appendMarkdown('**\n\n');
    md.appendMarkdown(`${l10n.t('Kind')}: ${c.kind}`);
    if (c.renamedFrom) md.appendText(` (${c.renamedFrom})`);
    md.appendMarkdown('  \n');
    if (c.critical) md.appendMarkdown(`$(warning) ${l10n.t('Critical file: review carefully')}  \n`);
    if (c.eolOnly) md.appendMarkdown(`${l10n.t('Only line endings, BOM or encoding differ from the baseline (no line changed).')}  \n`);
    if (c.secrets?.length) {
      md.appendMarkdown(`$(key) ${l10n.t('Possible secrets in added lines (Pro, heuristic):')}  \n`);
      for (const sec of c.secrets.slice(0, 5)) {
        md.appendText(`  · line ${sec.line}: ${sec.label} — ${sec.redacted}`);
        md.appendMarkdown('  \n');
      }
    }
    if (hunkIds.length) md.appendMarkdown(`${l10n.t('Hunks')}: ${hunkIds.length} (${l10n.t('{0} pending', pending)})  \n`);
    if (c.baselineUnavailable) md.appendMarkdown(`${l10n.t('Baseline unavailable')}: ${c.baselineUnavailable}  \n`);
    if (c.baselineUncertain) md.appendMarkdown(`${l10n.t('The file changed while the baseline was being taken; the baseline may not be the pre-agent content.')}  \n`);
    md.appendMarkdown(`${l10n.t('Last change')}: ${new Date(c.lastChangeAt).toLocaleTimeString()}`);
    md.supportThemeIcons = true;
    item.tooltip = md;
    return item;
  }

  private hunkItem(n: HunkNode): vscode.TreeItem {
    const status = n.change.hunks[n.hunkId];
    const meta = n.change.hunkMeta?.[n.hunkId];
    const item = new vscode.TreeItem(meta?.header ?? n.hunkId, vscode.TreeItemCollapsibleState.None);
    item.description = `+${meta?.added ?? 0} −${meta?.removed ?? 0}${status === 'accepted' ? ' · ' + l10n.t('accepted') : ''}`;
    item.iconPath = status === 'accepted' ? new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed')) : new vscode.ThemeIcon('circle-outline');
    item.contextValue = `ck.hunk.${status}`;
    item.command = { command: 'changekeeper.openDiff', title: l10n.t('Open diff'), arguments: [n] };
    return item;
  }

  getParent(element: Node): Node | undefined {
    if (element.type === 'hunk') return new FileNode(element.guard, element.change);
    if (element.type === 'file' && this.manager.all().filter((g) => g.hasSession).length > 1) return new SessionNode(element.guard);
    return undefined;
  }
}
