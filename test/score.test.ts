import { describe, expect, test } from 'vitest';
import { countBySeverity, fingerprint, score } from '../src/score.ts';
import type { Category, Severity } from '../src/types.ts';

const f = (severity: Severity, category: Category = 'correctness') => ({ severity, category });

describe('score', () => {
  test.each([
    ['empty', [], 5],
    ['[P2]', [f('P2')], 4],
    ['[P2, P1]', [f('P2'), f('P1')], 3],
    ['[P0 correctness]', [f('P0', 'correctness')], 2],
    ['[P0 security]', [f('P0', 'security')], 1],
    ['[P0 data-loss, P2]', [f('P0', 'data-loss'), f('P2')], 1],
    ['[P1 security] is not critical without P0', [f('P1', 'security')], 3],
  ] as const)('%s → %i', (_label, open, expected) => {
    expect(score([...open])).toBe(expected);
  });
});

describe('countBySeverity', () => {
  test('counts every severity, zeros included', () => {
    expect(countBySeverity([])).toEqual({ P0: 0, P1: 0, P2: 0 });
    expect(countBySeverity([f('P1'), f('P2'), f('P1')])).toEqual({ P0: 0, P1: 2, P2: 1 });
  });
});

describe('fingerprint', () => {
  const base = { path: 'src/a.ts', category: 'correctness' as const, title: 'Null deref in parser' };

  test('is the first 12 hex of sha1(path|category|normalized title)', () => {
    // sha1('src/a.ts|correctness|null deref in parser')
    expect(fingerprint(base)).toBe('a1e4917b97d5');
  });

  test('stable across title case and surrounding whitespace', () => {
    expect(fingerprint({ ...base, title: '  NULL DEREF IN PARSER \n' })).toBe(fingerprint(base));
  });

  test('differs by path and category', () => {
    expect(fingerprint({ ...base, path: 'src/b.ts' })).not.toBe(fingerprint(base));
    expect(fingerprint({ ...base, category: 'security' })).not.toBe(fingerprint(base));
  });
});
