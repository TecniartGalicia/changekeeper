import { diffArrays } from 'diff';
import * as crypto from 'crypto';
import { TextLine } from './textfile';

/**
 * Hunk model. Pure, no I/O.
 *
 * A hunk is a group of nearby line changes plus `context` unchanged lines on each side, in the
 * style of unified diffs. Line numbers are 1-based. `oldStart/oldLines` address the *baseline*
 * (immutable for the whole session), `newStart/newLines` address the *current* text.
 *
 * The id only depends on the baseline range and on the removed/added lines, so it survives
 * recomputation while other hunks are accepted or discarded (discarding hunk #1 shifts `newStart`
 * of hunk #2 but not its id).
 */
export interface HunkLine {
  type: ' ' | '+' | '-';
  text: string;
}

export interface Hunk {
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: HunkLine[];
  /** number of '+' lines */
  added: number;
  /** number of '-' lines */
  removed: number;
}

export interface HunkOptions {
  /** unchanged lines kept around each change (default 3) */
  context?: number;
  /** abort the Myers search after this many ms (default 500: the diff runs on the extension host thread) and fall back to a single whole-file hunk */
  timeoutMs?: number;
}

/** Diffs two plain-line arrays and groups the changes into hunks. */
export function computeHunks(oldLines: readonly string[], newLines: readonly string[], opts: HunkOptions = {}): Hunk[] {
  const context = opts.context ?? 3;
  let changes = diffArrays(oldLines as string[], newLines as string[], { timeout: opts.timeoutMs ?? 500 } as any) as
    | { value: string[]; added: boolean; removed: boolean }[]
    | undefined;
  if (!changes) {
    // too expensive to diff: present the whole file as one replacement
    changes = [];
    if (oldLines.length) changes.push({ value: [...oldLines], added: false, removed: true });
    if (newLines.length) changes.push({ value: [...newLines], added: true, removed: false });
  }
  // Flatten to a stream of tagged lines with old/new positions.
  type Tagged = { type: ' ' | '+' | '-'; text: string; oldNo: number; newNo: number };
  const stream: Tagged[] = [];
  let o = 1;
  let n = 1;
  for (const c of changes) {
    for (const text of c.value) {
      if (c.added) stream.push({ type: '+', text, oldNo: o, newNo: n++ });
      else if (c.removed) stream.push({ type: '-', text, oldNo: o++, newNo: n });
      else stream.push({ type: ' ', text, oldNo: o++, newNo: n++ });
    }
  }
  const hunks: Hunk[] = [];
  const changed: number[] = [];
  for (let idx = 0; idx < stream.length; idx++) if (stream[idx].type !== ' ') changed.push(idx);
  let g = 0;
  while (g < changed.length) {
    const first = changed[g];
    let last = first;
    let k = g + 1;
    // merge following change runs while the unchanged gap between them fits inside 2*context
    while (k < changed.length && changed[k] - last - 1 <= 2 * context) {
      last = changed[k];
      k++;
    }
    const start = Math.max(0, first - context);
    const end = Math.min(stream.length, last + context + 1);
    hunks.push(makeHunk(stream.slice(start, end)));
    g = k;
  }
  return hunks;
}

function makeHunk(slice: { type: ' ' | '+' | '-'; text: string; oldNo: number; newNo: number }[]): Hunk {
  let oldLines = 0;
  let newLines = 0;
  let added = 0;
  let removed = 0;
  for (const l of slice) {
    if (l.type !== '+') oldLines++;
    if (l.type !== '-') newLines++;
    if (l.type === '+') added++;
    if (l.type === '-') removed++;
  }
  const first = slice[0];
  // For a pure insertion at the very start, oldStart is 0 in unified-diff convention when oldLines === 0.
  const oldStart = oldLines === 0 ? first.oldNo - 1 : first.oldNo;
  const newStart = newLines === 0 ? first.newNo - 1 : first.newNo;
  const h = crypto.createHash('sha1');
  h.update(`${oldStart}:${oldLines}\n`);
  for (const l of slice) if (l.type !== ' ') h.update(`${l.type}${l.text}\n`);
  return {
    id: h.digest('hex').slice(0, 16),
    oldStart,
    oldLines,
    newStart,
    newLines,
    lines: slice.map((l) => ({ type: l.type, text: l.text })),
    added,
    removed,
  };
}

/** The baseline lines this hunk covers (context + removed), i.e. what "discard" writes back. */
export function hunkOldLines(h: Hunk): string[] {
  return h.lines.filter((l) => l.type !== '+').map((l) => l.text);
}

/** The current lines this hunk covers (context + added), i.e. what must be present to discard safely. */
export function hunkNewLines(h: Hunk): string[] {
  return h.lines.filter((l) => l.type !== '-').map((l) => l.text);
}

/**
 * Discards one hunk on the current line array: replaces the hunk's current range with the
 * corresponding *baseline* lines (taken from `baseline`, so each keeps its real terminator, including
 * the baseline's end-of-file state). Every other line is untouched. Returns undefined when the current
 * text no longer matches the hunk (stale hunk) or the baseline slice does not match the hunk.
 */
export function discardHunkOnLines(
  current: readonly TextLine[],
  baseline: readonly TextLine[],
  h: Hunk,
  newEol: '\n' | '\r\n',
): TextLine[] | undefined {
  const startIdx = h.newLines === 0 ? h.newStart : h.newStart - 1; // 0-based index where the range starts
  const expect = hunkNewLines(h);
  if (startIdx < 0 || startIdx + expect.length > current.length) return undefined;
  for (let i = 0; i < expect.length; i++) if (current[startIdx + i].text !== expect[i]) return undefined;
  const oldIdx = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
  const oldTexts = hunkOldLines(h);
  if (oldIdx < 0 || oldIdx + oldTexts.length > baseline.length) return undefined;
  const replacement: TextLine[] = [];
  for (let i = 0; i < oldTexts.length; i++) {
    const b = baseline[oldIdx + i];
    if (b.text !== oldTexts[i]) return undefined;
    replacement.push({ text: b.text, eol: b.eol });
  }
  const afterExists = startIdx + expect.length < current.length;
  if (afterExists && replacement.length && replacement[replacement.length - 1].eol === '') {
    replacement[replacement.length - 1] = { ...replacement[replacement.length - 1], eol: newEol };
  }
  const out: TextLine[] = current.slice(0, startIdx);
  if (!afterExists && replacement.length === 0 && out.length) {
    // the tail was pure insertion in a baseline that ended here: restore the baseline's ending
    const lastBase = baseline[oldIdx - 1];
    if (lastBase) out[out.length - 1] = { ...out[out.length - 1], eol: lastBase.eol };
  }
  out.push(...replacement);
  if (afterExists) out.push(...current.slice(startIdx + expect.length));
  return out;
}

/** Summary line for UI: "@@ -12,4 +12,6 @@ first changed line". */
export function hunkHeader(h: Hunk): string {
  const firstChanged = h.lines.find((l) => l.type !== ' ')?.text.trim() ?? '';
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ ${firstChanged}`.trimEnd();
}
