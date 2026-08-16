import { Hunk } from './hunks';

/**
 * Session model (pure types + small pure helpers). Persisted as JSON by the store.
 */

export type BaselineSource =
  /** clean tracked file at session start: the index blob (oid) is the baseline */
  | 'git-blob'
  /** bytes copied into the object store (dirty/untracked at start, non-git folder, or materialised blob) */
  | 'store'
  /** the file did not exist at session start */
  | 'missing'
  /** touched during the baseline window: we cannot be sure this is the pre-agent content */
  | 'uncertain'
  /** exists but no usable baseline (LFS pointer, too large, unreadable) */
  | 'unavailable';

export interface FileBaseline {
  /** workspace-relative POSIX path (original casing) */
  path: string;
  source: BaselineSource;
  /** git index blob object id (40 or 64 hex) when source is git-blob */
  oid?: string;
  /** git mode string (100644, 100755, 120000, 160000) when known */
  mode?: string;
  /** sha256 of the baseline bytes when they live in the store */
  sha256?: string;
  size?: number;
  reason?: string;
}

/** Compact on-disk form: [path, source, oid|sha256|reason|'', mode|previousSource|''] */
export type BaselineRow = [string, BaselineSource, string, string];

export interface BaselineManifest {
  version: 1;
  sessionId: string;
  createdAt: string;
  kind: 'git' | 'plain';
  /** git HEAD at start (for information / re-baseline hints) */
  head?: string;
  rows: BaselineRow[];
  /** number of files that could not be baselined (limits) */
  skipped?: number;
}

export type ChangeKind = 'A' | 'M' | 'D' | 'R';
export type HunkStatus = 'pending' | 'accepted' | 'discarded';

export interface FileChange {
  path: string;
  kind: ChangeKind;
  renamedFrom?: string;
  critical: boolean;
  /** sha256 of the current bytes when last inspected ('' when deleted) */
  currentSha?: string;
  binary?: boolean;
  tooLarge?: boolean;
  /** baseline could not be produced (reason: large, limit, lfs filter, lost…) */
  baselineUnavailable?: string;
  /** the file was touched during the baseline window: the baseline may not be the pre-agent content */
  baselineUncertain?: boolean;
  /** bytes differ from the baseline but no line does: line endings, BOM or encoding only */
  eolOnly?: boolean;
  /** hunk id → status; hunks that vanished are removed on recompute */
  hunks: Record<string, HunkStatus>;
  /** ids of hunks that were accepted and later disappeared (kept for the report) */
  archivedAccepted?: number;
  archivedDiscarded?: number;
  /** cached hunk headers for the tree/report (id → summary) */
  /** cached hunk headers for the tree/report (id → summary); firstLine = 0-based current line of the first changed line */
  hunkMeta?: Record<string, { header: string; added: number; removed: number; newStart: number; newLines: number; firstLine: number }>;
  fileAccepted?: boolean;
  firstSeenAt: string;
  lastChangeAt: string;
  /** Pro: possible secrets in added lines (redacted; label + line) */
  secrets?: { label: string; line: number; redacted: string }[];
}

export interface RestoreRecord {
  at: string;
  kind: 'file' | 'session' | 'hunk';
  /** path → sha256 of the bytes that were overwritten ('' = did not exist) */
  before: Record<string, string>;
  /** path → sha256 of what the operation wrote (undo checks the file still holds it); baseline sha when absent */
  after?: Record<string, string>;
  paths: string[];
  /** true when every path was put back */
  undone?: boolean;
  /** paths already put back (partial undo) */
  undonePaths?: string[];
}

export interface Session {
  version: 1;
  id: string;
  /** absolute folder path as VS Code reports it */
  folder: string;
  startedAt: string;
  stoppedAt?: string;
  agent?: string;
  label?: string;
  kind: 'git' | 'plain';
  changes: Record<string, FileChange>;
  restores: RestoreRecord[];
  reviewedAt?: string;
  /** paths silently dropped by the burst guard (for the report) */
  burstIgnored?: number;
  notes?: string[];
  /** Pro: validation runs of this session (newest last) */
  validations?: ValidationRun[];
}

export interface ValidationRun {
  name: string;
  command: string;
  startedAt: string;
  durationMs?: number;
  /** undefined while running / when killed */
  exitCode?: number;
  status: 'running' | 'passed' | 'failed' | 'timeout' | 'error';
  trigger: 'manual' | 'afterReview' | 'onSessionEnd';
  /** last lines of output (kept short; for the report) */
  outputTail?: string[];
}

export interface SessionCounters {
  files: number;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  critical: number;
  hunks: number;
  pending: number;
  accepted: number;
  discarded: number;
  reviewedFiles: number;
}

export function newSession(input: { id: string; folder: string; kind: 'git' | 'plain'; now?: Date; agent?: string; label?: string }): Session {
  return {
    version: 1,
    id: input.id,
    folder: input.folder,
    startedAt: (input.now ?? new Date()).toISOString(),
    agent: input.agent,
    label: input.label,
    kind: input.kind,
    changes: {},
    restores: [],
  };
}

export function counters(s: Session): SessionCounters {
  const c: SessionCounters = { files: 0, added: 0, modified: 0, deleted: 0, renamed: 0, critical: 0, hunks: 0, pending: 0, accepted: 0, discarded: 0, reviewedFiles: 0 };
  const renameSources = new Set<string>();
  for (const f of Object.values(s.changes)) if (f.kind === 'R' && f.renamedFrom) renameSources.add(f.renamedFrom.toLowerCase());
  for (const f of Object.values(s.changes)) {
    // the deleted half of a rename is not counted twice (it stays listed so it can be restored)
    if (f.kind === 'D' && renameSources.has(f.path.toLowerCase())) continue;
    c.files++;
    if (f.kind === 'A') c.added++;
    else if (f.kind === 'M') c.modified++;
    else if (f.kind === 'D') c.deleted++;
    else c.renamed++;
    if (f.critical) c.critical++;
    let filePending = 0;
    for (const st of Object.values(f.hunks)) {
      c.hunks++;
      if (st === 'pending') {
        c.pending++;
        filePending++;
      } else if (st === 'accepted') c.accepted++;
      else c.discarded++;
    }
    if (f.fileAccepted || (Object.keys(f.hunks).length > 0 && filePending === 0)) c.reviewedFiles++;
  }
  return c;
}

/**
 * Re-associates hunk states after a recompute: states of hunks that still exist are kept, new hunks
 * start pending, vanished accepted/discarded hunks are counted as archived (so the report can still
 * say "3 hunks discarded" after they disappear from the diff).
 */
export function reconcileHunks(f: FileChange, hunks: Hunk[]): void {
  const next: Record<string, HunkStatus> = {};
  const meta: FileChange['hunkMeta'] = {};
  const seen = new Set<string>();
  for (const h of hunks) {
    seen.add(h.id);
    next[h.id] = f.hunks[h.id] ?? (f.fileAccepted ? 'accepted' : 'pending');
    meta[h.id] = { header: headerOf(h), added: h.added, removed: h.removed, newStart: h.newStart, newLines: h.newLines, firstLine: firstChangedLine(h) };
  }
  for (const [id, st] of Object.entries(f.hunks)) {
    if (seen.has(id)) continue;
    if (st === 'accepted') f.archivedAccepted = (f.archivedAccepted ?? 0) + 1;
    else if (st === 'discarded') f.archivedDiscarded = (f.archivedDiscarded ?? 0) + 1;
  }
  f.hunks = next;
  f.hunkMeta = meta;
}

/** 0-based line in the *current* text of the first added/removed line (for deletions: the line after them). */
export function firstChangedLine(h: Hunk): number {
  let line = h.newLines === 0 ? h.newStart : h.newStart - 1;
  for (const l of h.lines) {
    if (l.type !== ' ') return Math.max(0, line);
    line++;
  }
  return Math.max(0, h.newLines === 0 ? h.newStart : h.newStart - 1);
}

function headerOf(h: Hunk): string {
  let firstChanged = h.lines.find((l) => l.type !== ' ')?.text.trim() ?? '';
  if (firstChanged.length > 100) firstChanged = firstChanged.slice(0, 100) + '…';
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ ${firstChanged}`.trimEnd();
}

export function isFileReviewed(f: FileChange): boolean {
  if (f.fileAccepted) return true;
  const st = Object.values(f.hunks);
  return st.length > 0 && st.every((x) => x !== 'pending');
}
