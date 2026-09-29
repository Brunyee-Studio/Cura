import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { checkReview, formatErrors } from '../src/check.ts';
import type { Review, ReviewFacts, Thread } from '../src/types.ts';

const validReview = (): Review =>
  JSON.parse(readFileSync(new URL('./fixtures/review.valid.json', import.meta.url), 'utf8')) as Review;

const thread = (id: string, isResolved = false): Thread => ({
  id,
  commentId: 1,
  url: `https://github.com/o/r/pull/1#${id}`,
  path: 'src/github.ts',
  line: 10,
  originalLine: 10,
  subjectType: 'LINE',
  isResolved,
  isOutdated: false,
  body: 'body',
  meta: { v: 1, severity: 'P2', category: 'docs', fingerprint: 'abc' },
  replies: [],
});

// Agrees with test/fixtures/review.valid.json: finding 0 spans 40–42 inside the first hunk,
// finding 1 is an existing comment at line 10 (outside the hunks), PRRT_old is open until resolved.
const facts = (): ReviewFacts => ({
  reviewable: ['src/github.ts'],
  deleted: [],
  hunks: { 'src/github.ts': [{ start: 38, end: 45 }, { start: 60, end: 70 }] },
  threads: [thread('PRRT_abc'), thread('PRRT_old'), thread('PRRT_done', true)],
});

const codes = (review: unknown, f: ReviewFacts = facts()) => checkReview(review, f).map((e) => e.code);

describe('checkReview', () => {
  test('valid fixture passes', () => {
    expect(checkReview(validReview(), facts())).toEqual([]);
  });

  test('schema-invalid review returns only schema errors', () => {
    const review = { ...validReview(), findings: [{ status: 'new' }] };
    const errors = checkReview(review, facts());
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.code.startsWith('schema.'))).toBe(true);
  });

  test('anchor.path: new finding on a file not in the diff', () => {
    const review = validReview();
    review.findings[0].path = 'src/other.ts';
    const errors = checkReview(review, facts());
    expect(errors.map((e) => e.code)).toEqual(['anchor.path']);
    expect(errors[0].path).toBe('/findings/0/path');
    expect(errors[0].message).toContain('src/other.ts');
  });

  test('rejects finding on deleted file', () => {
    const review = validReview();
    review.findings[0].path = 'old.ts';
    review.files.push({ path: 'old.ts', overview: 'Removed.' });
    const f = { ...facts(), deleted: ['old.ts'] };
    expect(codes(review, f)).toEqual(['anchor.path']);
  });

  test('anchor.line: new finding line outside every hunk', () => {
    const review = validReview();
    review.findings[0].line = 50;
    delete review.findings[0].start_line;
    expect(codes(review)).toEqual(['anchor.line']);
  });

  test('anchor.range: start_line not before line', () => {
    const review = validReview();
    review.findings[0].start_line = 42;
    expect(codes(review)).toEqual(['anchor.range']);
  });

  test('anchor.range: start_line in a different hunk', () => {
    const review = validReview();
    review.findings[0].line = 62;
    review.findings[0].start_line = 40;
    expect(codes(review)).toEqual(['anchor.range']);
  });

  test('existing finding outside hunks is not an anchor error', () => {
    const review = validReview();
    review.findings[1].line = 999;
    review.findings[1].path = 'src/elsewhere.ts';
    expect(codes(review)).toEqual([]);
  });

  test('thread.unknown: existing finding with an unknown id', () => {
    const review = validReview();
    review.findings[1].thread_id = 'PRRT_nope';
    expect(codes(review)).toEqual(['thread.unknown']);
  });

  test('thread.unknown: existing finding without a thread_id', () => {
    const review = validReview();
    delete review.findings[1].thread_id;
    expect(codes(review)).toEqual(['thread.unknown']);
  });

  test('thread_id on a new finding is ignored', () => {
    const review = validReview();
    review.findings[0].thread_id = 'PRRT_nope';
    expect(codes(review)).toEqual([]);
  });

  test('thread.unknown: resolved and dismissed ids not in threads', () => {
    const review = validReview();
    review.resolved[0].thread_id = 'PRRT_x';
    review.dismissed.push({ thread_id: 'PRRT_y', reason: 'False positive.' });
    expect(codes(review)).toEqual(['thread.unknown', 'thread.unknown']);
  });

  test('thread.closed: resolved, dismissed or existing pointing at a resolved thread', () => {
    const review = validReview();
    review.resolved[0].thread_id = 'PRRT_done';
    expect(codes(review)).toEqual(['thread.closed']);

    const dismissed = validReview();
    dismissed.dismissed.push({ thread_id: 'PRRT_done', reason: 'Not a bug.' });
    expect(codes(dismissed)).toEqual(['thread.closed']);

    const existing = validReview();
    existing.findings[1].thread_id = 'PRRT_done';
    expect(codes(existing)).toEqual(['thread.closed']);
  });

  test('thread.conflict: id both in findings and in resolved/dismissed', () => {
    const review = validReview();
    review.resolved[0].thread_id = 'PRRT_abc';
    expect(codes(review)).toEqual(['thread.conflict']);

    const dismissed = validReview();
    dismissed.dismissed.push({ thread_id: 'PRRT_abc', reason: 'Accepted risk.' });
    expect(codes(dismissed)).toEqual(['thread.conflict']);
  });

  test('files.missing: reviewable or deleted file without an overview', () => {
    const review = validReview();
    const f = { ...facts(), reviewable: ['src/github.ts', 'src/new.ts'], deleted: ['old.ts'] };
    review.scopes[0].files.push('src/new.ts');
    const errors = checkReview(review, f);
    expect(errors.map((e) => e.code)).toEqual(['files.missing', 'files.missing']);
    expect(errors.map((e) => e.message).join('\n')).toMatch(/src\/new\.ts[\s\S]*old\.ts/);
  });

  test('scopes.missing: reviewable file absent from every scope; deleted files exempt', () => {
    const review = validReview();
    review.scopes[0].files = [];
    review.files.push({ path: 'old.ts', overview: 'Removed.' });
    const errors = checkReview(review, { ...facts(), deleted: ['old.ts'] });
    expect(errors.map((e) => e.code)).toEqual(['scopes.missing']);
    expect(errors[0].message).toContain('src/github.ts');
  });
});

describe('formatErrors', () => {
  test('empty list prints exactly OK', () => {
    expect(formatErrors([])).toBe('OK');
  });

  test('one line per error as `code path: message`', () => {
    const review = validReview();
    review.findings[0].path = 'src/other.ts';
    review.resolved[0].thread_id = 'PRRT_x';
    const out = formatErrors(checkReview(review, facts()));
    expect(out.split('\n')).toEqual([
      'anchor.path /findings/0/path: src/other.ts is not changed in this PR',
      'thread.unknown /resolved/0/thread_id: PRRT_x is not a Cura thread on this PR',
    ]);
  });
});
