import { Minimatch } from 'minimatch';

/**
 * Exclusion and critical-file rules (globs over workspace-relative POSIX paths). Pure.
 *
 * Precedence, decided once per path for the whole session:
 *   1. our own storage / .git internals → never watched
 *   2. matches a *critical* glob → always watched (even if ignored by .gitignore or excluded)
 *   3. matches an exclusion (defaults + user) or is git-ignored → not watched
 *   4. otherwise watched
 */

export const DEFAULT_EXCLUDES: readonly string[] = [
  '**/.git/**',
  '**/node_modules/**',
  '**/.vscode-test/**',
  '**/dist/**',
  '**/out/**',
  '**/build/**',
  '**/target/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.cache/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',
  '**/.gradle/**',
  '**/.idea/**',
  '**/*.log',
  '**/.DS_Store',
  '**/Thumbs.db',
];

/** Always excluded, not overridable (git internals and our own data). */
export const HARD_EXCLUDES: readonly string[] = ['**/.git/**', '**/.git'];

export const DEFAULT_CRITICAL: readonly string[] = [
  '**/migrations/**',
  '**/migrate/**',
  '**/*.sql',
  '.github/**',
  '**/.github/workflows/**',
  '**/Dockerfile*',
  '**/docker-compose*',
  '**/compose*.y?(a)ml',
  '**/.env*',
  '**/auth/**',
  '**/security/**',
  '**/package.json',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/requirements*.txt',
  '**/pyproject.toml',
  '**/Pipfile*',
  '**/*.csproj',
  '**/*.sln',
  '**/*.tf',
  '**/*.tfvars',
  '.vscode/**',
  '.claude/**',
  '.cursor/**',
  '.codex/**',
  '**/.gitignore',
  '**/.gitattributes',
  '**/*.pem',
  '**/*.key',
];

export interface RuleSet {
  excludes: readonly string[];
  critical: readonly string[];
}

export function buildRuleSet(opts: { userExcludes?: readonly string[]; excludeDefaults?: boolean; userCritical?: readonly string[] }): RuleSet {
  const excludes = [...HARD_EXCLUDES, ...(opts.excludeDefaults === false ? [] : DEFAULT_EXCLUDES), ...(opts.userExcludes ?? [])];
  const critical = [...DEFAULT_CRITICAL, ...(opts.userCritical ?? [])];
  return { excludes: dedupe(excludes), critical: dedupe(critical) };
}

function dedupe(a: readonly string[]): string[] {
  return [...new Set(a.map((s) => s.trim()).filter(Boolean))];
}

export class GlobMatcher {
  private readonly matchers: Minimatch[];
  constructor(globs: readonly string[]) {
    this.matchers = globs.map((g) => new Minimatch(g, { dot: true, nocase: true, matchBase: false }));
  }
  test(relPosix: string): boolean {
    for (const m of this.matchers) if (m.match(relPosix)) return true;
    return false;
  }
}

export interface PathDecision {
  watch: boolean;
  critical: boolean;
  reason: 'hard' | 'critical' | 'excluded' | 'ignored' | 'ok';
}

export class PathRules {
  private readonly hard = new GlobMatcher(HARD_EXCLUDES);
  private readonly excluded: GlobMatcher;
  private readonly critical: GlobMatcher;
  constructor(rules: RuleSet) {
    this.excluded = new GlobMatcher(rules.excludes);
    this.critical = new GlobMatcher(rules.critical);
  }
  /** `ignored` = decided by git (check-ignore) for paths not tracked; pass false when unknown/tracked. */
  decide(relPosix: string, ignored: boolean): PathDecision {
    if (this.hard.test(relPosix)) return { watch: false, critical: false, reason: 'hard' };
    if (this.critical.test(relPosix)) return { watch: true, critical: true, reason: 'critical' };
    if (this.excluded.test(relPosix)) return { watch: false, critical: false, reason: 'excluded' };
    if (ignored) return { watch: false, critical: false, reason: 'ignored' };
    return { watch: true, critical: false, reason: 'ok' };
  }
  isCritical(relPosix: string): boolean {
    return this.critical.test(relPosix);
  }
}
