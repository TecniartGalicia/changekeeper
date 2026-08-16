/**
 * Text-file helpers: binary sniffing, BOM, per-line EOL preservation. Pure, no I/O.
 *
 * The engine never normalises a file it did not change: hunks are applied as *line-range
 * replacements* on the original line array (each line keeps its own terminator), so a CRLF file
 * stays CRLF, a mixed file stays mixed and a missing final newline stays missing.
 */

export type Eol = 'lf' | 'crlf' | 'mixed' | 'none';

export interface TextLine {
  /** line content without terminator */
  text: string;
  /** '' for the last line without newline, otherwise '\n' or '\r\n' */
  eol: '' | '\n' | '\r\n';
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Heuristic used by git: a NUL byte in the first 8000 bytes means binary. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function hasUtf8Bom(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

/** Decodes UTF-8 (BOM stripped). Non-UTF-8 files are decoded lossily; the engine only *writes back* bytes it read. */
export function decodeText(buf: Buffer): { text: string; bom: boolean } {
  const bom = hasUtf8Bom(buf);
  return { text: (bom ? buf.subarray(3) : buf).toString('utf8'), bom };
}

export function encodeText(text: string, bom: boolean): Buffer {
  const body = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([UTF8_BOM, body]) : body;
}

/** Splits into lines keeping each line's own terminator. "" → [] ; "a" → [a/''] ; "a\n" → [a/\n]. */
export function splitLines(text: string): TextLine[] {
  const out: TextLine[] = [];
  let start = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      // \n
      const crlf = i > 0 && text.charCodeAt(i - 1) === 13;
      out.push({ text: text.slice(start, crlf ? i - 1 : i), eol: crlf ? '\r\n' : '\n' });
      start = i + 1;
    }
  }
  if (start < n) out.push({ text: text.slice(start), eol: '' });
  return out;
}

export function joinLines(lines: readonly TextLine[]): string {
  let s = '';
  for (const l of lines) s += l.text + l.eol;
  return s;
}

export function detectEol(lines: readonly TextLine[]): Eol {
  let lf = 0;
  let crlf = 0;
  for (const l of lines) {
    if (l.eol === '\n') lf++;
    else if (l.eol === '\r\n') crlf++;
  }
  if (lf && crlf) return 'mixed';
  if (crlf) return 'crlf';
  if (lf) return 'lf';
  return 'none';
}

/** The terminator to use for *new* lines in a file: its dominant one, or `fallback` when it has none. */
export function dominantEol(lines: readonly TextLine[], fallback: '\n' | '\r\n' = '\n'): '\n' | '\r\n' {
  let lf = 0;
  let crlf = 0;
  for (const l of lines) {
    if (l.eol === '\n') lf++;
    else if (l.eol === '\r\n') crlf++;
  }
  if (lf === 0 && crlf === 0) return fallback;
  return crlf > lf ? '\r\n' : '\n';
}

/** Plain string lines (no terminators) — the unit the differ works on. */
export function plainLines(lines: readonly TextLine[]): string[] {
  return lines.map((l) => l.text);
}
