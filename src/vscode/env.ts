import * as vscode from 'vscode';
import { DEFAULT_LIMITS, Limits } from '../core/guardrails';
import { buildRuleSet, RuleSet } from '../core/rules/exclude';

export const OUTPUT_NAME = 'ChangeKeeper';
export const BASELINE_SCHEME = 'ck-baseline';
export const EMPTY_SCHEME = 'ck-empty';

let channel: vscode.OutputChannel | undefined;

export function output(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel(OUTPUT_NAME);
  return channel;
}

export function log(line: string): void {
  output().appendLine(`[${new Date().toISOString()}] ${line}`);
}

export type AutoStart = 'git' | 'always' | 'off';

export interface FolderConfig {
  autoStart: AutoStart;
  rules: RuleSet;
  limits: Limits;
  codeLens: boolean;
  decorations: boolean;
}

export function readFolderConfig(folder: vscode.WorkspaceFolder): FolderConfig {
  const cfg = vscode.workspace.getConfiguration('changekeeper', folder.uri);
  const autoStart = cfg.get<AutoStart>('autoStart', 'git');
  const rules = buildRuleSet({
    userExcludes: cfg.get<string[]>('exclude', []),
    excludeDefaults: cfg.get<boolean>('excludeDefaults', true),
    userCritical: cfg.get<string[]>('criticalGlobs', []),
  });
  const limits: Limits = {
    ...DEFAULT_LIMITS,
    maxFileBytes: Math.max(16, cfg.get<number>('maxFileSizeKB', 2048)) * 1024,
    burstThreshold: Math.max(20, cfg.get<number>('burstThreshold', 500)),
  };
  return { autoStart, rules, limits, codeLens: cfg.get<boolean>('codeLens', true), decorations: cfg.get<boolean>('decorations', true) };
}

export function readRetention(): { days: number; maxBytes: number } {
  const cfg = vscode.workspace.getConfiguration('changekeeper');
  return { days: Math.max(1, cfg.get<number>('retentionDays', 30)), maxBytes: Math.max(50, cfg.get<number>('retentionMaxMB', 500)) * 1024 * 1024 };
}

/** Builds the left-side URI of a diff for a baseline file. */
export function baselineUri(folder: vscode.Uri, rel: string, sessionId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: BASELINE_SCHEME, path: '/' + rel, query: new URLSearchParams({ folder: folder.toString(), session: sessionId }).toString() });
}

export function emptyUri(rel: string): vscode.Uri {
  return vscode.Uri.from({ scheme: EMPTY_SCHEME, path: '/' + rel });
}

export function parseBaselineUri(uri: vscode.Uri): { folder: vscode.Uri; rel: string; sessionId: string } | undefined {
  if (uri.scheme !== BASELINE_SCHEME) return undefined;
  const q = new URLSearchParams(uri.query);
  const folder = q.get('folder');
  const session = q.get('session');
  if (!folder || !session) return undefined;
  return { folder: vscode.Uri.parse(folder), rel: uri.path.replace(/^\//, ''), sessionId: session };
}
