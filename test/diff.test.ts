import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { inHunk, nearestChangedLine, parseDiff } from '../src/diff.ts';

const fixture = (name: string): string => readFileSync(new URL(`fixtures/diffs/${name}.diff`, import.meta.url), 'utf8');

describe('parseDiff', () => {
  test('basic: hunk range is the +start,count of the header', () => {
    const { hunks, addedLines, stats } = parseDiff(fixture('basic'));
    expect(hunks).toEqual({ 'src/basic.ts': [{ start: 10, end: 15 }] });
    expect(addedLines).toEqual({ 'src/basic.ts': [11, 12, 13, 14] });
    expect(stats).toEqual({ 'src/basic.ts': { added: 4, removed: 2, status: 'modified' } });
  });

  test('rename: keyed by the new path; a pure rename has stats but no hunks', () => {
    const { hunks, addedLines, stats } = parseDiff(fixture('rename'));
    expect(hunks).toEqual({ 'lib/new-name.ts': [{ start: 12, end: 18 }] });
    expect(addedLines).toEqual({ 'lib/new-name.ts': [15] });
    expect(stats).toEqual({
      'lib/new-name.ts': { added: 1, removed: 1, status: 'renamed' },
      'src/multi2.ts': { added: 0, removed: 0, status: 'renamed' },
    });
  });

  test('parses rename and no-newline marker without shifting counts', () => {
    const { hunks, addedLines, stats } = parseDiff(fixture('rename') + fixture('nonewline'));
    expect(hunks['lib/new-name.ts']).toEqual([{ start: 12, end: 18 }]);
    expect(hunks['src/nonl.txt']).toEqual([{ start: 1, end: 4 }]);
    expect(addedLines['src/nonl.txt']).toEqual([2, 3, 4]);
    expect(stats['src/nonl.txt']).toEqual({ added: 3, removed: 2, status: 'modified' });
  });

  test('deleted: stats only, status deleted, absent from hunks and addedLines', () => {
    const { hunks, addedLines, stats } = parseDiff(fixture('deleted'));
    expect(hunks).toEqual({});
    expect(addedLines).toEqual({});
    expect(stats).toEqual({ 'src/gone.ts': { added: 0, removed: 5, status: 'deleted' } });
  });

  test('binary: stats with status from header, no hunks', () => {
    const { hunks, addedLines, stats } = parseDiff(fixture('binary'));
    expect(hunks).toEqual({});
    expect(addedLines).toEqual({});
    expect(stats).toEqual({
      'assets/logo.png': { added: 0, removed: 0, status: 'modified' },
      'assets/new.bin': { added: 0, removed: 0, status: 'added' },
      'assets/old.bin': { added: 0, removed: 0, status: 'deleted' },
    });
  });

  test('multi-hunk: one range per hunk, pure-removal hunks keep their context range', () => {
    const { hunks, addedLines, stats } = parseDiff(fixture('multi-hunk'));
    expect(hunks['src/multi.ts']).toEqual([
      { start: 2, end: 8 },
      { start: 27, end: 33 },
      { start: 47, end: 52 },
    ]);
    expect(addedLines['src/multi.ts']).toEqual([5, 30]);
    expect(stats['src/multi.ts']).toEqual({ added: 2, removed: 3, status: 'modified' });
  });

  test('all fixtures concatenated parse the same as each alone', () => {
    const names = ['basic', 'rename', 'deleted', 'binary', 'nonewline', 'multi-hunk'];
    const merged = parseDiff(names.map(fixture).join(''));
    const separate = names.map((n) => parseDiff(fixture(n)));
    expect(merged.hunks).toEqual(Object.assign({}, ...separate.map((p) => p.hunks)));
    expect(merged.addedLines).toEqual(Object.assign({}, ...separate.map((p) => p.addedLines)));
    expect(merged.stats).toEqual(Object.assign({}, ...separate.map((p) => p.stats)));
  });

  test('new file: range and added lines cover the whole file', () => {
    const diff = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..b77b4eb',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+x',
      '+y',
      '',
    ].join('\n');
    expect(parseDiff(diff)).toEqual({
      hunks: { 'src/new.ts': [{ start: 1, end: 2 }] },
      addedLines: { 'src/new.ts': [1, 2] },
      stats: { 'src/new.ts': { added: 2, removed: 0, status: 'added' } },
    });
  });

  test('omitted counts default to 1 and a zero new count yields no range', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      'index 1111111..2222222 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/b.txt b/b.txt',
      'index 3333333..4444444 100644',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -1,2 +0,0 @@',
      '-one',
      '-two',
      '',
    ].join('\n');
    const { hunks, addedLines, stats } = parseDiff(diff);
    expect(hunks).toEqual({ 'a.txt': [{ start: 1, end: 1 }] });
    expect(addedLines).toEqual({ 'a.txt': [1] });
    expect(stats['b.txt']).toEqual({ added: 0, removed: 2, status: 'modified' });
  });

  test('content lines that look like headers are counted as content', () => {
    const diff = [
      'diff --git a/notes.md b/notes.md',
      'index 1111111..2222222 100644',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,3 +1,3 @@',
      '--- a/old',
      '+++ b/evil',
      ' diff --git a/x b/x',
      '-@@ -9,9 +9,9 @@',
      '+@@ -1 +1 @@',
      '',
    ].join('\n');
    const { hunks, addedLines, stats } = parseDiff(diff);
    expect(hunks).toEqual({ 'notes.md': [{ start: 1, end: 3 }] });
    expect(addedLines).toEqual({ 'notes.md': [1, 3] });
    expect(stats).toEqual({ 'notes.md': { added: 2, removed: 2, status: 'modified' } });
  });

  test('paths with spaces (trailing tab) and C-quoted non-ASCII paths', () => {
    const diff = [
      'diff --git a/docs/a b.md b/docs/a b.md',
      'new file mode 100644',
      'index 0000000..b77b4eb',
      '--- /dev/null',
      '+++ b/docs/a b.md\t',
      '@@ -0,0 +1,2 @@',
      '+x',
      '+y',
      'diff --git "a/docs/caf\\303\\251.md" "b/docs/caf\\303\\251.md"',
      'new file mode 100644',
      'index 0000000..bca70f3',
      '--- /dev/null',
      '+++ "b/docs/caf\\303\\251.md"',
      '@@ -0,0 +1 @@',
      '+q',
      'diff --git a/old dir/x.bin b/old dir/x.bin',
      'deleted file mode 100644',
      'index 00ffac9..0000000',
      'Binary files a/old dir/x.bin and /dev/null differ',
      'diff --git "a/img/\\342\\234\\223.png" "b/img/\\342\\234\\223.png"',
      'deleted file mode 100644',
      'index 00ffac9..0000000',
      'Binary files "a/img/\\342\\234\\223.png" and /dev/null differ',
      '',
    ].join('\n');
    const { hunks, stats } = parseDiff(diff);
    expect(hunks).toEqual({ 'docs/a b.md': [{ start: 1, end: 2 }], 'docs/café.md': [{ start: 1, end: 1 }] });
    expect(stats['old dir/x.bin']).toEqual({ added: 0, removed: 0, status: 'deleted' });
    expect(stats['img/✓.png']).toEqual({ added: 0, removed: 0, status: 'deleted' });
  });

  test('empty input yields empty maps', () => {
    expect(parseDiff('')).toEqual({ hunks: {}, addedLines: {}, stats: {} });
  });
});

describe('inHunk', () => {
  const { hunks } = parseDiff(fixture('basic'));

  test('boundaries are inclusive', () => {
    expect(inHunk(hunks, 'src/basic.ts', 10)).toEqual({ start: 10, end: 15 });
    expect(inHunk(hunks, 'src/basic.ts', 15)).toEqual({ start: 10, end: 15 });
    expect(inHunk(hunks, 'src/basic.ts', 9)).toBeUndefined();
    expect(inHunk(hunks, 'src/basic.ts', 16)).toBeUndefined();
  });

  test('unknown path yields undefined', () => {
    expect(inHunk(hunks, 'nope.ts', 10)).toBeUndefined();
  });
});

describe('nearestChangedLine', () => {
  const { addedLines } = parseDiff(fixture('multi-hunk'));

  test('returns the closest + line within the max distance', () => {
    expect(nearestChangedLine(addedLines, 'src/multi.ts', 10, 5)).toBe(5);
    expect(nearestChangedLine(addedLines, 'src/multi.ts', 35, 5)).toBe(30);
    expect(nearestChangedLine(addedLines, 'src/multi.ts', 30, 5)).toBe(30);
  });

  test('undefined at distance 6', () => {
    expect(nearestChangedLine(addedLines, 'src/multi.ts', 11, 5)).toBeUndefined();
    expect(nearestChangedLine(addedLines, 'src/multi.ts', 36, 5)).toBeUndefined();
  });

  test('ties resolve to the lower line', () => {
    expect(nearestChangedLine({ 'f.ts': [10, 14] }, 'f.ts', 12, 5)).toBe(10);
  });

  test('unknown path yields undefined', () => {
    expect(nearestChangedLine(addedLines, 'nope.ts', 5, 5)).toBeUndefined();
  });
});
