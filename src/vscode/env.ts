import * as crypto from 'crypto';
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

export type AutoStart = 'git' | 'always' | 'whenAgentDetected' | 'off';

/** Keys an agent could set in `.vscode/settings.json` to blind or cripple the next session (PLAN §4.5 / audit T5). */
export const WORKSPACE_SENSITIVE_KEYS = ['autoStart', 'exclude', 'excludeDefaults', 'criticalGlobs', 'maxFileSizeKB', 'burstThreshold'] as const;

export interface FolderConfig {
  autoStart: AutoStart;
  rules: RuleSet;
  limits: Limits;
  codeLens: boolean;
  decorations: boolean;
  /** sensitive keys that have a workspace/folder value */
  workspaceOverrides: string[];
  /** stable hash of those workspace values (approval token) */
  overridesHash: string;
  /** the same configuration computed from user-level values only (used until approval) */
  userOnly?: FolderConfig;
  pendingApproval?: boolean;
}

function fromValues(v: { autoStart: AutoStart; exclude: string[]; excludeDefaults: boolean; criticalGlobs: string[]; maxFileSizeKB: number; burstThreshold: number; codeLens: boolean; decorations: boolean }): Omit<FolderConfig, 'workspaceOverrides' | 'overridesHash'> {
  const rules = buildRuleSet({ userExcludes: v.exclude, excludeDefaults: v.excludeDefaults, userCritical: v.criticalGlobs });
  const limits: Limits = { ...DEFAULT_LIMITS, maxFileBytes: Math.max(16, v.maxFileSizeKB) * 1024, burstThreshold: Math.max(20, v.burstThreshold) };
  return { autoStart: v.autoStart, rules, limits, codeLens: v.codeLens, decorations: v.decorations };
}

export function readFolderConfig(folder: vscode.WorkspaceFolder): FolderConfig {
  const cfg = vscode.workspace.getConfiguration('changekeeper', folder.uri);
  const effective = {
    autoStart: cfg.get<AutoStart>('autoStart', 'git'),
    exclude: cfg.get<string[]>('exclude', []),
    excludeDefaults: cfg.get<boolean>('excludeDefaults', true),
    criticalGlobs: cfg.get<string[]>('criticalGlobs', []),
    maxFileSizeKB: cfg.get<number>('maxFileSizeKB', 2048),
    burstThreshold: cfg.get<number>('burstThreshold', 500),
    codeLens: cfg.get<boolean>('codeLens', true),
    decorations: cfg.get<boolean>('decorations', true),
  };
  const overrides: string[] = [];
  const overrideValues: Record<string, unknown> = {};
  const userOnlyValues: any = { ...effective };
  for (const key of WORKSPACE_SENSITIVE_KEYS) {
    const insp = cfg.inspect<any>(key);
    const wsValue = insp?.workspaceFolderValue !== undefined ? insp.workspaceFolderValue : insp?.workspaceValue;
    if (wsValue !== undefined) {
      overrides.push(key);
      overrideValues[key] = wsValue;
      userOnlyValues[key] = insp?.globalValue !== undefined ? insp.globalValue : insp?.defaultValue;
    }
  }
  const overridesHash = overrides.length ? crypto.createHash('sha256').update(JSON.stringify(overrideValues)).digest('hex').slice(0, 24) : '';
  const base = fromValues(effective);
  const userOnly = overrides.length ? { ...fromValues(userOnlyValues), workspaceOverrides: [], overridesHash: '' } : undefined;
  return { ...base, workspaceOverrides: overrides, overridesHash, userOnly };
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
