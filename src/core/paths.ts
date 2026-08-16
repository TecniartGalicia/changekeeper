import * as crypto from 'crypto';
import * as path from 'path';

/**
 * Path and hashing helpers shared by the whole engine. Pure: no vscode, no I/O.
 *
 * Every path stored in a session is a *workspace-relative POSIX path* ("src/a.ts"), never absolute
 * and never with backslashes, so manifests are portable and comparable across platforms.
 */

/** Relative POSIX path of `abs` inside `root` (both absolute, same platform). `undefined` if outside. */
export function toRelPosix(root: string, abs: string, platformPath: typeof path = path): string | undefined {
  const rel = platformPath.relative(root, abs);
  if (!rel || rel.startsWith('..') || platformPath.isAbsolute(rel)) return rel === '' ? '' : undefined;
  return rel.split(platformPath.sep).join('/');
}

/** Absolute platform path for a stored relative POSIX path. */
export function fromRelPosix(root: string, rel: string, platformPath: typeof path = path): string {
  return platformPath.join(root, ...rel.split('/'));
}

/**
 * Stable key for a workspace folder: lower-cases the drive letter, forces forward slashes and drops
 * the trailing separator, so "C:\Repo\" and "c:/repo" (same folder on Windows) map to the same store.
 * On POSIX the path is case-sensitive and only the trailing slash is dropped.
 */
export function workspaceKey(fsPath: string, platform: NodeJS.Platform = process.platform): string {
  let p = fsPath.replace(/\\/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  if (platform === 'win32') {
    p = p.replace(/^([a-zA-Z]):/, (_, d: string) => `${d.toLowerCase()}:`);
    p = p.toLowerCase();
  }
  return sha256(Buffer.from(p, 'utf8')).slice(0, 32);
}

export function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** SHA-1 of a git blob object with these bytes ("blob <len>\0<bytes>"): comparable with index OIDs. */
export function gitBlobSha1(data: Buffer): string {
  const h = crypto.createHash('sha1');
  h.update(`blob ${data.length}\0`);
  h.update(data);
  return h.digest('hex');
}

/** Short, human-friendly id (time-ordered prefix + random). */
export function newId(now: Date = new Date()): string {
  const t = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${t}-${crypto.randomBytes(3).toString('hex')}`;
}

/** Same-path comparison rules for the host platform (Windows/macOS file systems are case-insensitive by default). */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32' || platform === 'darwin') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** Normalises a relative POSIX path for map keys on case-insensitive platforms. */
export function pathKey(rel: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' || platform === 'darwin' ? rel.toLowerCase() : rel;
}
