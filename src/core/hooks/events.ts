/**
 * Normalises hook payloads (Claude Code's documented shape; other agents that reuse the same
 * settings file, e.g. Copilot, send similar JSON) into what the engine needs. Pure.
 */

export type AgentTag = 'claude-code' | 'copilot' | 'codex' | 'cursor' | 'agent';

export interface HookEvent {
  kind: 'session-start' | 'tool-done' | 'stop' | 'session-end' | 'other';
  agent: AgentTag;
  /** absolute path of the file the tool touched, when the payload says so */
  filePath?: string;
  cwd?: string;
  sessionId?: string;
  toolName?: string;
  raw: Record<string, unknown>;
}

export function parseHookPayload(body: unknown): HookEvent | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, any>;
  const name = String(b.hook_event_name ?? b.event ?? '').trim();
  const kind: HookEvent['kind'] = name === 'SessionStart' ? 'session-start' : name === 'PostToolUse' ? 'tool-done' : name === 'Stop' ? 'stop' : name === 'SessionEnd' ? 'session-end' : 'other';
  const input = b.tool_input && typeof b.tool_input === 'object' ? b.tool_input : {};
  const filePath = firstString(input.file_path, input.filePath, input.path, input.notebook_path, b.file_path);
  return {
    kind,
    agent: detectAgent(b),
    filePath,
    cwd: typeof b.cwd === 'string' ? b.cwd : undefined,
    sessionId: typeof b.session_id === 'string' ? b.session_id : undefined,
    toolName: typeof b.tool_name === 'string' ? b.tool_name : undefined,
    raw: b,
  };
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v;
  return undefined;
}

export function detectAgent(b: Record<string, any>): AgentTag {
  const t = String(b.transcript_path ?? '').replace(/\\/g, '/').toLowerCase();
  if (t.includes('/.claude/') || 'permission_mode' in b) return 'claude-code';
  if (t.includes('copilot') || 'copilot' in b) return 'copilot';
  if (t.includes('/.codex/') || 'codex' in b) return 'codex';
  if (t.includes('/.cursor/') || 'cursor' in b) return 'cursor';
  return 'agent';
}

/** Longest folder (absolute, platform paths) that contains `p`; case-insensitive on Windows/macOS. */
export function pickFolder(p: string, folders: readonly string[], platform: NodeJS.Platform = process.platform): string | undefined {
  const norm = (x: string) => {
    let s = x.replace(/\\/g, '/');
    if (s.length > 1) s = s.replace(/\/+$/, '');
    return platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s;
  };
  const target = norm(p);
  let best: string | undefined;
  for (const f of folders) {
    const nf = norm(f);
    if (target === nf || target.startsWith(nf + '/')) {
      if (!best || nf.length > norm(best).length) best = f;
    }
  }
  return best;
}
