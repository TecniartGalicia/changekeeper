/**
 * Parsers for the git plumbing output the engine relies on. Pure (Buffer/string in, objects out).
 * Formats verified against git 2.55 (see docs/AUDITORIA.md, F1a).
 */

export interface IndexEntry {
  mode: string;
  oid: string;
  stage: number;
  path: string;
}

/** `git ls-files -s -z [--recurse-submodules]` → entries. Gitlinks (160000) are kept; callers skip them. */
export function parseLsFilesStage(out: Buffer | string): IndexEntry[] {
  const s = typeof out === 'string' ? out : out.toString('utf8');
  const entries: IndexEntry[] = [];
  for (const rec of s.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, oid, stage] = rec.slice(0, tab).split(' ');
    entries.push({ mode, oid, stage: Number(stage), path: rec.slice(tab + 1) });
  }
  return entries;
}

export interface StatusEntry {
  path: string;
  /** staged (index vs HEAD) status char, '.' = none */
  x: string;
  /** worktree (vs index) status char, '.' = none */
  y: string;
  kind: 'changed' | 'renamed' | 'unmerged' | 'untracked' | 'ignored';
  origPath?: string;
  /** index blob oid when present (changed/renamed) */
  indexOid?: string;
}

/** `git status --porcelain=v2 -z --untracked-files=all` → entries. */
export function parseStatusV2(out: Buffer | string): StatusEntry[] {
  const s = typeof out === 'string' ? out : out.toString('utf8');
  const tokens = s.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    const type = t[0];
    if (type === '#') continue;
    if (type === '?' || type === '!') {
      entries.push({ path: t.slice(2), x: '.', y: '.', kind: type === '?' ? 'untracked' : 'ignored' });
      continue;
    }
    if (type === '1') {
      // 1 XY sub mH mI mW hH hI path
      const parts = t.split(' ');
      const xy = parts[1] ?? '..';
      const path = parts.slice(8).join(' ');
      entries.push({ path, x: xy[0], y: xy[1], kind: 'changed', indexOid: parts[7] });
      continue;
    }
    if (type === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path NUL origPath
      const parts = t.split(' ');
      const xy = parts[1] ?? '..';
      const path = parts.slice(9).join(' ');
      const orig = tokens[++i] ?? '';
      entries.push({ path, x: xy[0], y: xy[1], kind: 'renamed', origPath: orig, indexOid: parts[7] });
      continue;
    }
    if (type === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = t.split(' ');
      const xy = parts[1] ?? '..';
      const path = parts.slice(10).join(' ');
      entries.push({ path, x: xy[0], y: xy[1], kind: 'unmerged' });
      continue;
    }
  }
  return entries;
}

/** `git check-ignore --stdin -z` prints only the ignored paths, NUL-separated. */
export function parseCheckIgnore(out: Buffer | string): Set<string> {
  const s = typeof out === 'string' ? out : out.toString('utf8');
  return new Set(s.split('\0').filter(Boolean));
}

/** `git check-attr <attr...> -z --stdin` → path → { attr → value } */
export function parseCheckAttr(out: Buffer | string): Map<string, Record<string, string>> {
  const s = typeof out === 'string' ? out : out.toString('utf8');
  const tokens = s.split('\0');
  const map = new Map<string, Record<string, string>>();
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const [p, attr, value] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    if (!p) continue;
    const rec = map.get(p) ?? {};
    rec[attr] = value;
    map.set(p, rec);
  }
  return map;
}

export interface CatFileRecord {
  oid: string;
  /** undefined when the object is missing/ambiguous */
  content?: Buffer;
  size?: number;
}

/**
 * `git cat-file --batch [--filters]` output: `<oid> blob <size>\n<bytes>\n` per object, or
 * `<oid> missing\n`. Returns records in input order.
 */
export function parseCatFileBatch(out: Buffer): CatFileRecord[] {
  const recs: CatFileRecord[] = [];
  let pos = 0;
  while (pos < out.length) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = out.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const parts = header.split(' ');
    const oid = parts[0];
    if (parts[1] === 'missing' || parts[1] === 'ambiguous' || parts.length < 3) {
      recs.push({ oid });
      continue;
    }
    const size = Number(parts[2]);
    if (!Number.isFinite(size) || pos + size > out.length) {
      recs.push({ oid });
      break;
    }
    recs.push({ oid, content: Buffer.from(out.subarray(pos, pos + size)), size });
    pos += size + 1; // trailing LF
  }
  return recs;
}

/**
 * Output of `git cat-file --batch [--filters]` for exactly ONE requested object. With `--filters` the
 * header advertises the size of the *raw* blob while the body is the *filtered* content (verified with
 * git 2.55: LF blob + autocrlf → header 14, body 17 bytes), so the size cannot be trusted: take
 * everything after the header line, minus the trailing LF.
 */
export function parseCatFileSingle(out: Buffer): CatFileRecord | undefined {
  const nl = out.indexOf(0x0a);
  if (nl < 0) return undefined;
  const header = out.subarray(0, nl).toString('utf8');
  const parts = header.split(' ');
  const oid = parts[0];
  if (parts[1] === 'missing' || parts[1] === 'ambiguous' || parts.length < 3) return { oid };
  let end = out.length;
  if (end > nl + 1 && out[end - 1] === 0x0a) end--; // record terminator
  const content = Buffer.from(out.subarray(nl + 1, end));
  return { oid, content, size: content.length };
}

/** `git rev-parse HEAD` may fail on an unborn branch: treat as undefined. */
export function parseHead(out: string | undefined): string | undefined {
  const s = (out ?? '').trim();
  return /^[0-9a-f]{40,64}$/.test(s) ? s : undefined;
}
