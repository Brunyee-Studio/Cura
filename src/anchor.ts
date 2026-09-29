import { inHunk, nearestChangedLine } from './diff.ts';
import type { Anchor, Finding, HunkMap } from './types.ts';

/** How far (in lines) a finding outside every hunk may be moved onto an added line. */
export const SNAP_DISTANCE = 5;

export interface AnchorDiff {
  hunks: HunkMap;
  addedLines: Record<string, number[]>;
  /** Every head path in the PR (reviewable + excluded, not deleted). */
  prFiles: Set<string>;
}

/** Decides where a finding's comment goes: in-hunk line → snapped line → file-level → unanchorable. */
export function anchorFinding(f: Finding, diff: AnchorDiff): Anchor {
  const hunk = inHunk(diff.hunks, f.path, f.line);
  if (hunk) {
    const keepStart = f.start_line !== undefined && f.start_line < f.line && inHunk(diff.hunks, f.path, f.start_line) === hunk;
    return keepStart
      ? { kind: 'line', path: f.path, line: f.line, start_line: f.start_line, snapped: false }
      : { kind: 'line', path: f.path, line: f.line, snapped: false };
  }

  const snappedLine = nearestChangedLine(diff.addedLines, f.path, f.line, SNAP_DISTANCE);
  if (snappedLine !== undefined) return { kind: 'line', path: f.path, line: snappedLine, snapped: true };

  if (diff.prFiles.has(f.path)) return { kind: 'file', path: f.path };
  return { kind: 'none', reason: 'path not in PR' };
}
