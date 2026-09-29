import type { FileFact, Hunk, HunkMap } from './types.ts';

export interface FileStats { added: number; removed: number; status: FileFact['status'] }

export interface ParsedDiff {
  hunks: HunkMap;
  /** Ascending RIGHT-side line numbers of `+` lines, keyed by head path. */
  addedLines: Record<string, number[]>;
  stats: Record<string, FileStats>;
}

interface FileState {
  path: string;
  status: FileFact['status'];
  added: number;
  removed: number;
  hunks: Hunk[];
  addedLines: number[];
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Decodes a git C-quoted path (`"caf\303\251.md"`), whose octal escapes are UTF-8 bytes. */
function unquote(quoted: string): string {
  const bytes: number[] = [];
  for (let i = 1; i < quoted.length - 1; i++) {
    if (quoted[i] !== '\\') {
      const char = String.fromCodePoint(quoted.codePointAt(i) ?? 0);
      bytes.push(...Buffer.from(char, 'utf8'));
      i += char.length - 1;
      continue;
    }
    const next = quoted[++i];
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(quoted.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Path from a `---`/`+++`/`rename to` value: unquotes, drops git's trailing tab and the `a/`/`b/` prefix. */
function cleanPath(raw: string, prefix: string): string {
  const trimmed = raw.replace(/\t$/, '');
  const path = trimmed.startsWith('"') ? unquote(trimmed) : trimmed;
  return prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Head path from `diff --git a/X b/Y`. Only a fallback: `rename to` and `+++ b/`
 * lines override it. Unquoted names with spaces are ambiguous, so prefer the
 * symmetric split (X === Y), which covers every non-rename.
 */
function headerPath(rest: string): string {
  const quotedB = rest.match(/ ("b\/(?:[^"\\]|\\.)*")$/);
  if (quotedB) return cleanPath(quotedB[1], 'b/');
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.slice(2, half) === rest.slice(half + 3)) return rest.slice(half + 3);
  const split = rest.lastIndexOf(' b/');
  return split === -1 ? rest : rest.slice(split + 3);
}

/** Parses `git diff` unified output into RIGHT-side hunk ranges, added lines and per-file counts. */
export function parseDiff(unified: string): ParsedDiff {
  const result: ParsedDiff = { hunks: {}, addedLines: {}, stats: {} };
  let file: FileState | undefined;
  let oldRemaining = 0;
  let newRemaining = 0;
  let newLine = 0;

  const finish = (): void => {
    if (!file) return;
    result.stats[file.path] = { added: file.added, removed: file.removed, status: file.status };
    if (file.status !== 'deleted' && file.hunks.length > 0) {
      result.hunks[file.path] = file.hunks;
      if (file.addedLines.length > 0) result.addedLines[file.path] = file.addedLines;
    }
  };

  for (const line of unified.split('\n')) {
    if (file && (oldRemaining > 0 || newRemaining > 0)) {
      const marker = line[0];
      if (marker === '+') {
        file.added++;
        file.addedLines.push(newLine++);
        newRemaining--;
      } else if (marker === '-') {
        file.removed++;
        oldRemaining--;
      } else if (marker === ' ' || line === '') {
        newLine++;
        oldRemaining--;
        newRemaining--;
      }
      // `\ No newline at end of file` belongs to no side and consumes no count.
      continue;
    }

    if (line.startsWith('diff --git ')) {
      finish();
      file = { path: headerPath(line.slice('diff --git '.length)), status: 'modified', added: 0, removed: 0, hunks: [], addedLines: [] };
      continue;
    }
    if (!file) continue;

    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      oldRemaining = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLine = Number(hunk[2]);
      newRemaining = hunk[3] === undefined ? 1 : Number(hunk[3]);
      if (newRemaining > 0) file.hunks.push({ start: newLine, end: newLine + newRemaining - 1 });
    } else if (line.startsWith('new file mode')) {
      file.status = 'added';
    } else if (line.startsWith('deleted file mode') || line === '+++ /dev/null') {
      file.status = 'deleted';
    } else if (line.startsWith('rename to ')) {
      file.path = cleanPath(line.slice('rename to '.length), '');
      file.status = 'renamed';
    } else if (line.startsWith('+++ ')) {
      file.path = cleanPath(line.slice('+++ '.length), 'b/');
    }
  }
  finish();
  return result;
}

/** The hunk containing `line` on the RIGHT side of `path` (bounds inclusive). */
export function inHunk(hunks: HunkMap, path: string, line: number): Hunk | undefined {
  return hunks[path]?.find((h) => line >= h.start && line <= h.end);
}

/** The added (`+`) line of `path` closest to `line` within `maxDistance`; ties go to the lower line. */
export function nearestChangedLine(
  addedLines: Record<string, number[]>,
  path: string,
  line: number,
  maxDistance: number,
): number | undefined {
  let best: number | undefined;
  let bestDistance = maxDistance + 1;
  for (const candidate of addedLines[path] ?? []) {
    const distance = Math.abs(candidate - line);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
