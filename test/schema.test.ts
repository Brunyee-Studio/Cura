import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { loadSchema, validate } from '../src/schema.ts';

const reviewSchema = loadSchema('review');
const validReview = (): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL('./fixtures/review.valid.json', import.meta.url), 'utf8'));

describe('validate against review schema', () => {
  test('valid fixture has no errors', () => {
    expect(validate(reviewSchema, validReview())).toEqual([]);
  });

  test('missing summary is schema.required at /', () => {
    const review = validReview();
    delete review.summary;
    const errors = validate(reviewSchema, review);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'schema.required', path: '/' });
    expect(errors[0]?.message).toContain('summary');
  });

  test('bad severity is schema.enum at the finding pointer', () => {
    const review = validReview();
    (review.findings as Record<string, unknown>[])[0]!.severity = 'P3';
    const errors = validate(reviewSchema, review);
    expect(errors).toEqual([
      expect.objectContaining({ code: 'schema.enum', path: '/findings/0/severity' }),
    ]);
    expect(errors[0]?.message).toContain('/findings/0/severity');
  });

  test('unknown key is schema.additional', () => {
    const review = validReview();
    review.score = 5;
    const errors = validate(reviewSchema, review);
    expect(errors).toEqual([expect.objectContaining({ code: 'schema.additional', path: '/score' })]);
  });

  test('line below 1 is schema.min', () => {
    const review = validReview();
    (review.findings as Record<string, unknown>[])[0]!.line = 0;
    expect(validate(reviewSchema, review)).toEqual([
      expect.objectContaining({ code: 'schema.min', path: '/findings/0/line' }),
    ]);
  });

  test('non-integer line is schema.type', () => {
    const review = validReview();
    (review.findings as Record<string, unknown>[])[0]!.line = 1.5;
    expect(validate(reviewSchema, review)).toEqual([
      expect.objectContaining({ code: 'schema.type', path: '/findings/0/line' }),
    ]);
  });
});

describe('validate keywords', () => {
  test('type mismatches, including array vs object and null', () => {
    expect(validate({ type: 'object' }, [])[0]?.code).toBe('schema.type');
    expect(validate({ type: 'array' }, {})[0]?.code).toBe('schema.type');
    expect(validate({ type: 'string' }, null)[0]?.code).toBe('schema.type');
    expect(validate({ type: 'integer' }, 3)).toEqual([]);
  });

  test('maximum reports schema.max', () => {
    expect(validate({ type: 'number', maximum: 2 }, 3)).toEqual([
      expect.objectContaining({ code: 'schema.max', path: '/' }),
    ]);
  });

  test('minItems reports schema.min', () => {
    expect(validate({ type: 'array', minItems: 1 }, [])).toEqual([
      expect.objectContaining({ code: 'schema.min', path: '/' }),
    ]);
  });

  test('base path prefixes pointers', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    expect(validate(schema, { a: 1 }, '/root')[0]?.path).toBe('/root/a');
  });
});

describe('plan and candidate schemas', () => {
  test('plan requires at least one file per scope', () => {
    const plan = { scopes: [{ name: 'api', files: [], focus: 'contract', context: [] }] };
    expect(validate(loadSchema('plan'), plan)).toEqual([
      expect.objectContaining({ code: 'schema.min', path: '/scopes/0/files' }),
    ]);
  });

  test('candidate accepts a well-formed candidate', () => {
    const candidate = {
      candidates: [
        {
          severity: 'P1',
          category: 'correctness',
          path: 'src/a.ts',
          line: 3,
          title: 't',
          body: 'b',
          evidence: [{ location: 'src/b.ts:4', note: 'caller' }],
        },
      ],
      consulted: ['src/b.ts'],
    };
    expect(validate(loadSchema('candidate'), candidate)).toEqual([]);
  });
});
