/**
 * Pure helpers to add/remove ChangeKeeper's HTTP hooks in a Claude Code settings object
 * (`~/.claude/settings.json` or `<project>/.claude/settings.local.json`). Never touches other
 * people's hooks: our entries are recognised by their URL. Documented schema (code.claude.com/docs/en/hooks):
 *   settings.hooks[EventName] = [{ matcher?: string, hooks: [{ type: 'http', url, headers?, timeout? }] }]
 */

export interface HttpHookEntry {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  statusMessage?: string;
}

export interface HookGroup {
  matcher?: string;
  hooks: any[];
}

export type ClaudeSettings = Record<string, any> & { hooks?: Record<string, HookGroup[]>; allowedHttpHookUrls?: string[] };

/**
 * Only the events we act on: fewer POSTs, and fewer visible "hook error" lines in Claude when VS Code
 * is closed. Verified against Claude Code 2.1.233 (`-p` mode): `UserPromptSubmit`, `PostToolUse`,
 * `Stop` and `SessionEnd` do reach an HTTP hook; `SessionStart` did NOT (a `command` hook on the same
 * event did), so `UserPromptSubmit` (once per prompt, before any edit) is the reliable "agent is active
 * here" signal and `SessionStart` is kept only for versions/modes where it fires.
 */
export const CK_HOOK_EVENTS: { event: string; matcher?: string }[] = [
  { event: 'SessionStart', matcher: 'startup|resume|clear|compact|fork' },
  { event: 'UserPromptSubmit' },
  { event: 'PostToolUse', matcher: 'Edit|Write|NotebookEdit' },
];

export function hookUrl(port: number): string {
  return `http://127.0.0.1:${port}/hook`;
}

export function isOurHook(h: any, port?: number): boolean {
  if (!h || typeof h !== 'object' || h.type !== 'http' || typeof h.url !== 'string') return false;
  return port === undefined ? /^http:\/\/127\.0\.0\.1:\d+\/hook$/.test(h.url) : h.url === hookUrl(port);
}

/**
 * Adds (idempotently) our hooks. Returns a NEW settings object and whether anything changed
 * (`changed` is false when the file already holds exactly this configuration, so a re-run neither
 * asks for consent again nor writes a backup). Malformed groups (`null`, no `hooks` array) are kept as they are.
 */
export function addChangeKeeperHooks(settings: ClaudeSettings, port: number, token: string): { next: ClaudeSettings; changed: boolean } {
  const before = JSON.stringify(settings ?? {});
  const next: ClaudeSettings = JSON.parse(before);
  const entry: HttpHookEntry = { type: 'http', url: hookUrl(port), headers: { 'X-CK-Token': token }, timeout: 3, statusMessage: 'ChangeKeeper' };
  next.hooks = next.hooks && typeof next.hooks === 'object' && !Array.isArray(next.hooks) ? next.hooks : {};
  for (const { event, matcher } of CK_HOOK_EVENTS) {
    const groups: HookGroup[] = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    // remove stale copies of ours (other port / old token) before adding the current one
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) continue;
      g.hooks = g.hooks.filter((h) => !isOurHook(h));
    }
    const cleaned = groups.filter((g) => !g || !Array.isArray(g.hooks) || g.hooks.length > 0);
    cleaned.push(matcher ? { matcher, hooks: [entry] } : { hooks: [entry] });
    next.hooks[event] = cleaned;
  }
  // events we no longer install (older versions did): drop our stale entries there too
  for (const event of Object.keys(next.hooks)) {
    if (CK_HOOK_EVENTS.some((e) => e.event === event)) continue;
    const groups = next.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept: HookGroup[] = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const filtered = g.hooks.filter((h) => !isOurHook(h));
      if (filtered.length || g.hooks.length === 0) kept.push({ ...g, hooks: filtered });
    }
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  // an allowlist, when the user has one, must include us or Claude will silently drop the hook
  if (Array.isArray(next.allowedHttpHookUrls) && !next.allowedHttpHookUrls.includes(hookUrl(port))) {
    next.allowedHttpHookUrls.push(hookUrl(port));
  }
  return { next, changed: JSON.stringify(next) !== before };
}

/** Removes every hook of ours (any port). Empty groups/keys are dropped; nothing else is touched. */
export function removeChangeKeeperHooks(settings: ClaudeSettings): { next: ClaudeSettings; changed: boolean } {
  const next: ClaudeSettings = JSON.parse(JSON.stringify(settings ?? {}));
  let changed = false;
  if (next.hooks && typeof next.hooks === 'object') {
    for (const event of Object.keys(next.hooks)) {
      const groups = next.hooks[event];
      if (!Array.isArray(groups)) continue;
      const kept: HookGroup[] = [];
      for (const g of groups) {
        if (!g || !Array.isArray(g.hooks)) {
          kept.push(g);
          continue;
        }
        const filtered = g.hooks.filter((h) => !isOurHook(h));
        if (filtered.length !== g.hooks.length) changed = true;
        if (filtered.length) kept.push({ ...g, hooks: filtered });
        else if (g.hooks.length === 0) kept.push(g);
      }
      if (kept.length) next.hooks[event] = kept;
      else {
        delete next.hooks[event];
        changed = true;
      }
    }
    if (Object.keys(next.hooks).length === 0) delete next.hooks;
  }
  if (Array.isArray(next.allowedHttpHookUrls)) {
    const before = next.allowedHttpHookUrls.length;
    next.allowedHttpHookUrls = next.allowedHttpHookUrls.filter((u: string) => !/^http:\/\/127\.0\.0\.1:\d+\/hook$/.test(u));
    if (next.allowedHttpHookUrls.length !== before) changed = true;
    if (next.allowedHttpHookUrls.length === 0) delete next.allowedHttpHookUrls;
  }
  return { next, changed };
}

/** Which of our events are installed (with which port and token), for the doctor. */
export function installedHooks(settings: ClaudeSettings): { event: string; port: number; token?: string }[] {
  const out: { event: string; port: number; token?: string }[] = [];
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) {
        if (!isOurHook(h)) continue;
        const token = h.headers && typeof h.headers === 'object' ? h.headers['X-CK-Token'] ?? h.headers['x-ck-token'] : undefined;
        out.push({ event, port: Number(/:(\d+)\/hook$/.exec(h.url)?.[1]), token: typeof token === 'string' ? token : undefined });
      }
    }
  }
  return out;
}

/**
 * Serialises a settings object the way Claude Code writes it (2-space JSON + newline). We only ever
 * rewrite a file we read as valid JSON; a byte-exact backup is taken by the caller first.
 */
export function serialiseSettings(s: ClaudeSettings): string {
  return JSON.stringify(s, null, 2) + '\n';
}
