import * as crypto from 'crypto';

/**
 * Validation rules (Pro): commands the user configures to run after a review (lint, tests, build…).
 * Pure part: schema, normalisation, the "approval fingerprint" and the preset detection from a
 * package.json / project files. Execution lives in the VS Code layer (Task API).
 *
 * Security model (PLAN §4.5): a command runs only after the user approved *this exact command with this
 * exact resolved script* in this workspace. The fingerprint covers the command string and, for
 * `npm run <script>`-style presets, the script body — so an agent editing package.json#scripts forces a
 * new confirmation.
 */

export type RunOn = 'manual' | 'afterReview' | 'onSessionEnd';

export interface ValidationRule {
  name: string;
  command: string;
  cwd?: string;
  runOn?: RunOn;
  timeoutSec?: number;
}

export interface NormalisedRule extends ValidationRule {
  runOn: RunOn;
  timeoutSec: number;
}

export function normaliseRules(raw: unknown): NormalisedRule[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalisedRule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const command = typeof o.command === 'string' ? o.command.trim() : '';
    if (!command) continue;
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : command.slice(0, 40);
    const runOn: RunOn = o.runOn === 'afterReview' || o.runOn === 'onSessionEnd' ? o.runOn : 'manual';
    const timeoutSec = typeof o.timeoutSec === 'number' && o.timeoutSec > 0 ? Math.min(o.timeoutSec, 3600) : 600;
    const cwd = typeof o.cwd === 'string' && o.cwd.trim() ? o.cwd.trim() : undefined;
    out.push({ name, command, cwd, runOn, timeoutSec });
  }
  return out;
}

/** `npm run x`, `pnpm run x`, `yarn x`, `npm test` → the package.json script name it resolves to. */
export function packageScriptOf(command: string): string | undefined {
  const c = command.trim();
  let m = /^(?:npm|pnpm|bun)\s+(?:run|run-script)\s+([A-Za-z0-9:_.-]+)/.exec(c);
  if (m) return m[1];
  m = /^(?:npm|pnpm|bun)\s+(test|start|build|lint)\b/.exec(c);
  if (m) return m[1];
  m = /^yarn\s+(?:run\s+)?([A-Za-z0-9:_.-]+)/.exec(c);
  if (m && !['add', 'install', 'remove'].includes(m[1])) return m[1];
  return undefined;
}

/**
 * Fingerprint the user approves. `resolvedScript` is the package.json script body when the command
 * is a package script (undefined otherwise). Changing either invalidates the approval.
 */
export function approvalFingerprint(rule: NormalisedRule, resolvedScript: string | undefined, folderKey: string): string {
  const h = crypto.createHash('sha256');
  // every field that changes *what* runs or *when* it runs invalidates the approval
  h.update(JSON.stringify([folderKey, rule.command, rule.cwd ?? '', rule.runOn, resolvedScript ?? '']));
  return h.digest('hex').slice(0, 32);
}

/**
 * The scripts npm/pnpm/yarn actually run for `<name>`: the script itself plus its `pre`/`post` hooks.
 * Returned as a stable JSON string (used in the fingerprint and shown in the confirmation dialog).
 */
export function resolvedScripts(scripts: Record<string, unknown> | undefined, name: string): string {
  const s = scripts ?? {};
  const pick = (k: string) => (typeof s[k] === 'string' ? (s[k] as string) : undefined);
  const out: Record<string, string> = {};
  for (const k of [`pre${name}`, name, `post${name}`]) {
    const v = pick(k);
    if (v !== undefined) out[k] = v;
  }
  return out[name] === undefined ? `<missing script ${name}>` : JSON.stringify(out);
}

/** A rule's working directory must stay inside the workspace folder ("../" escapes are refused). */
export function safeCwd(folder: string, cwd: string | undefined, join: (...p: string[]) => string, isInside: (base: string, p: string) => boolean): string | undefined {
  if (!cwd) return folder;
  const resolved = join(folder, ...cwd.split('/').filter(Boolean));
  return isInside(folder, resolved) ? resolved : undefined;
}

export interface Preset {
  name: string;
  command: string;
  why: string;
}

/** Suggests validations from project files (names only; nothing runs). */
export function detectPresets(input: { packageJson?: any; files: string[] }): Preset[] {
  const out: Preset[] = [];
  const has = (f: string) => input.files.some((x) => x === f || x.endsWith('/' + f));
  const scripts = (input.packageJson && typeof input.packageJson === 'object' && input.packageJson.scripts) || {};
  for (const s of ['lint', 'typecheck', 'test', 'build', 'check']) if (typeof scripts[s] === 'string') out.push({ name: s, command: `npm run ${s}`, why: `package.json script "${s}"` });
  if (has('tsconfig.json') && !scripts.typecheck) out.push({ name: 'tsc', command: 'npx tsc --noEmit -p tsconfig.json', why: 'tsconfig.json' });
  if (has('pyproject.toml') || has('pytest.ini') || has('setup.cfg')) out.push({ name: 'pytest', command: 'python -m pytest -q', why: 'python project' });
  if (has('Cargo.toml')) out.push({ name: 'cargo check', command: 'cargo check', why: 'Cargo.toml' });
  if (has('go.mod')) out.push({ name: 'go vet', command: 'go vet ./...', why: 'go.mod' });
  if (has('Makefile')) out.push({ name: 'make test', command: 'make test', why: 'Makefile' });
  return out;
}
