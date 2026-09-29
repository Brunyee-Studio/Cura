import { describe, expect, test } from 'vitest';
import { anchorFinding } from '../src/anchor.ts';
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
    expect(anchorFinding(finding({ path: 'src/gone.ts', line: 1 }), diff)).toEqual({
      kind: 'none',
      reason: 'path not in PR',
    });
  });
});
