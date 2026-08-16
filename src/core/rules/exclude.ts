import { Minimatch } from 'minimatch';

/**
 * Exclusion and critical-file rules (globs over workspace-relative POSIX paths). Pure.
 *
 * Precedence, decided once per path for the whole session:
 *   1. our own temp files / .git internals → never watched
 *   2. heavy dependency trees (node_modules, .venv…) → not watched (unless excludeDefaults is off)
 *   3. matches a *critical* glob → always watched (even if ignored by .gitignore or excluded)
 *   4. matches an exclusion (defaults + user) or is git-ignored → not watched
 *   5. otherwise watched
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

/** Always excluded, not overridable (git internals, our own temp files). */
export const HARD_EXCLUDES: readonly string[] = ['**/.git/**', '**/.git', '**/*.ck-tmp'];

// "Heavy" dependency/vendor trees: excluded and — unlike the rest of the defaults — NOT overridden by
// critical globs (a package.json inside node_modules is not the user's manifest). Overridable only
// through `excludeDefaults: false`.
export const HEAVY_EXCLUDES: readonly string[] = ['**/node_modules/**', '**/.venv/**', '**/venv/**', '**/vendor/**', '**/.pnpm-store/**', '**/site-packages/**', '**/.gradle/**', '**/.vscode-test/**'];

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
  heavy: readonly string[];
  critical: readonly string[];
}

export function buildRuleSet(opts: { userExcludes?: readonly string[]; excludeDefaults?: boolean; userCritical?: readonly string[] }): RuleSet {
  const excludes = [...HARD_EXCLUDES, ...(opts.excludeDefaults === false ? [] : DEFAULT_EXCLUDES), ...(opts.userExcludes ?? [])];
  const heavy = opts.excludeDefaults === false ? [] : [...HEAVY_EXCLUDES];
  const critical = [...DEFAULT_CRITICAL, ...(opts.userCritical ?? [])];
  return { excludes: dedupe(excludes), heavy: dedupe(heavy), critical: dedupe(critical) };
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
  reason: 'hard' | 'heavy' | 'critical' | 'excluded' | 'ignored' | 'ok';
}

export class PathRules {
  private readonly hard = new GlobMatcher(HARD_EXCLUDES);
  private readonly heavy: GlobMatcher;
  private readonly excluded: GlobMatcher;
  private readonly critical: GlobMatcher;
  constructor(rules: RuleSet) {
    this.heavy = new GlobMatcher(rules.heavy ?? []);
    this.excluded = new GlobMatcher(rules.excludes);
    this.critical = new GlobMatcher(rules.critical);
  }
  /** `ignored` = decided by git (check-ignore) for paths not tracked; pass false when unknown/tracked. */
  decide(relPosix: string, ignored: boolean): PathDecision {
    if (this.hard.test(relPosix)) return { watch: false, critical: false, reason: 'hard' };
    if (this.heavy.test(relPosix)) return { watch: false, critical: false, reason: 'heavy' };
    if (this.critical.test(relPosix)) return { watch: true, critical: true, reason: 'critical' };
    if (this.excluded.test(relPosix)) return { watch: false, critical: false, reason: 'excluded' };
    if (ignored) return { watch: false, critical: false, reason: 'ignored' };
    return { watch: true, critical: false, reason: 'ok' };
  }
  isCritical(relPosix: string): boolean {
    return !this.hard.test(relPosix) && !this.heavy.test(relPosix) && this.critical.test(relPosix);
  }
  /** Directories the baseline walk may skip entirely: hard/heavy ones. Excluded-but-not-heavy dirs are walked (critical files may live inside). */
  skipDir(relDir: string): boolean {
    const probe = relDir + '/x';
    return this.hard.test(probe) || this.heavy.test(probe);
  }
}
