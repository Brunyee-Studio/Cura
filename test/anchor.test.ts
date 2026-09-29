import { describe, expect, test } from 'vitest';
import { anchorFinding } from '../src/anchor.ts';
import { parseDiff } from '../src/diff.ts';
import type { Finding, HunkMap } from '../src/types.ts';

const finding = (over: Partial<Finding>): Finding => ({
  status: 'new',
  severity: 'P1',
  category: 'correctness',
  path: 'src/a.ts',
  line: 1,
  title: 't',
  body: 'b',
  ...over,
});

const hunks: HunkMap = { 'src/a.ts': [{ start: 10, end: 20 }, { start: 40, end: 45 }] };
const addedLines = { 'src/a.ts': [12, 15, 42] };
const prFiles = new Set(['src/a.ts', 'src/excluded.lock']);
const diff = { hunks, addedLines, prFiles };

describe('anchorFinding', () => {
  test('in hunk: anchors to the line and keeps start_line from the same hunk', () => {
    expect(anchorFinding(finding({ line: 18, start_line: 11 }), diff)).toEqual({
      kind: 'line',
      path: 'src/a.ts',
      line: 18,
      start_line: 11,
      snapped: false,
    });
  });

  test('in hunk without start_line: plain line anchor', () => {
    expect(anchorFinding(finding({ line: 10 }), diff)).toEqual({ kind: 'line', path: 'src/a.ts', line: 10, snapped: false });
  });

  test('start_line dropped when spanning hunks', () => {
    expect(anchorFinding(finding({ line: 42, start_line: 15 }), diff)).toEqual({
      kind: 'line',
      path: 'src/a.ts',
      line: 42,
      snapped: false,
    });
  });

  test('start_line dropped when not before line', () => {
    expect(anchorFinding(finding({ line: 12, start_line: 12 }), diff)).toEqual({
      kind: 'line',
      path: 'src/a.ts',
      line: 12,
      snapped: false,
    });
  });

  test('outside hunk: snaps to nearest added line within 5 and drops start_line', () => {
    expect(anchorFinding(finding({ line: 47, start_line: 43 }), diff)).toEqual({
      kind: 'line',
      path: 'src/a.ts',
      line: 42,
      snapped: true,
    });
  });

  test('outside hunk beyond snap distance: file-level anchor', () => {
    expect(anchorFinding(finding({ line: 48 }), diff)).toEqual({ kind: 'file', path: 'src/a.ts' });
  });

  test('path in hunks with no added lines (pure deletion) falls through to file', () => {
    const pureDeletion = {
      hunks: { 'src/b.ts': [{ start: 5, end: 7 }] },
      addedLines: {},
      prFiles: new Set(['src/b.ts']),
    };
    expect(anchorFinding(finding({ path: 'src/b.ts', line: 30 }), pureDeletion)).toEqual({ kind: 'file', path: 'src/b.ts' });
  });

  test('file in PR without hunks (excluded path): file-level anchor', () => {
    expect(anchorFinding(finding({ path: 'src/excluded.lock', line: 3 }), diff)).toEqual({
      kind: 'file',
      path: 'src/excluded.lock',
    });
  });

  test('path not in PR: unanchorable', () => {
    expect(anchorFinding(finding({ path: 'src/other.ts', line: 3 }), diff)).toEqual({
      kind: 'none',
      reason: 'path not in PR',
    });
  });

  test('deleted file is unanchorable', () => {
    // Real `git diff` and `ocr delegate preview` output for a PR that modifies src/a.ts and deletes src/gone.ts.
    const realDiff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index cc798ff..72ab60e 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1,2 @@',
      ' export const a = 1;',
      '+export const b = 2;',
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      'index bafc5d9..0000000',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-x=1',
      '',
    ].join('\n');
    const preview = {
      reviewable_files: [{ path: 'src/a.ts', status: 'modified' }],
      excluded_files: [{ path: 'src/gone.ts', status: 'deleted', exclude_reason: 'deleted' }],
    };
    const { hunks: realHunks, addedLines: realAdded } = parseDiff(realDiff);
    const realPrFiles = new Set([...preview.reviewable_files, ...preview.excluded_files].filter((f) => f.status !== 'deleted').map((f) => f.path));
    expect(realHunks['src/gone.ts']).toBeUndefined();
    expect(realPrFiles.has('src/gone.ts')).toBe(false);
    expect(anchorFinding(finding({ path: 'src/gone.ts', line: 1 }), { hunks: realHunks, addedLines: realAdded, prFiles: realPrFiles })).toEqual({
      kind: 'none',
      reason: 'path not in PR',
    });
  });
});
