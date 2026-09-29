import { describe, expect, test } from 'vitest';
import { checkPlan, fallbackPlan, matchGlob } from '../src/plan.ts';
import type { ConfigScope, FileFact } from '../src/types.ts';

const fact = (path: string, added = 1, removed = 0, status: FileFact['status'] = 'modified'): FileFact => ({
  path,
  status,
  language: 'typescript',
  added,
  removed,
  dir: path.includes('/') ? path.slice(0, path.indexOf('/')) : 'root',
});

const scope = (name: string, files: string[]) => ({ name, files, focus: `Review ${name}`, context: [] });

const caps = { configScopes: [] as ConfigScope[], maxFiles: 12, maxLines: 1500 };
const codes = (errors: { code: string }[]) => errors.map((e) => e.code);

describe('checkPlan', () => {
  const facts = [fact('src/a.ts'), fact('src/b.ts'), fact('README.md'), fact('old.ts', 0, 5, 'deleted')];

  test('valid plan passes', () => {
    const plan = { scopes: [scope('src', ['src/a.ts', 'src/b.ts']), scope('root', ['README.md'])] };
    expect(checkPlan(plan, { ...caps, facts })).toEqual([]);
  });

  test('schema-invalid plan returns only schema errors', () => {
    const errors = checkPlan({ scopes: [{ name: 'x', files: [] }] }, { ...caps, facts });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.code.startsWith('schema.'))).toBe(true);
  });

  test('missing reviewable file is reported by name', () => {
    const errors = checkPlan({ scopes: [scope('src', ['src/a.ts', 'src/b.ts'])] }, { ...caps, facts });
    expect(codes(errors)).toEqual(['plan.missing']);
    expect(errors[0].message).toContain('README.md');
    expect(errors[0].path).toBe('README.md');
  });

  test('duplicate and unknown files are reported', () => {
    const plan = { scopes: [scope('a', ['src/a.ts', 'src/b.ts', 'old.ts']), scope('b', ['src/a.ts', 'README.md', 'nope.ts'])] };
    const errors = checkPlan(plan, { ...caps, facts });
    expect(codes(errors).sort()).toEqual(['plan.duplicate', 'plan.unknown', 'plan.unknown']);
    expect(errors.find((e) => e.code === 'plan.duplicate')?.path).toBe('src/a.ts');
  });

  test('scope over the file cap is rejected', () => {
    const many = Array.from({ length: 13 }, (_, i) => fact(`src/f${i}.ts`));
    const plan = { scopes: [scope('src', many.map((f) => f.path))] };
    expect(codes(checkPlan(plan, { ...caps, facts: many }))).toEqual(['plan.too_many_files']);
  });

  test('scope over the line cap (added + removed) is rejected', () => {
    const big = [fact('src/a.ts', 800, 0), fact('src/b.ts', 400, 301)];
    const plan = { scopes: [scope('src', ['src/a.ts', 'src/b.ts'])] };
    expect(codes(checkPlan(plan, { ...caps, facts: big }))).toEqual(['plan.too_many_lines']);
  });

  test('a single file over the line cap is allowed as a one-file scope', () => {
    const huge = [fact('src/huge.ts', 5000, 10)];
    expect(checkPlan({ scopes: [scope('huge', ['src/huge.ts'])] }, { ...caps, facts: huge })).toEqual([]);
  });

  test('file matching a config scope placed in a different-named scope is rejected', () => {
    const configScopes: ConfigScope[] = [{ name: 'api', paths: ['src/api/**'] }];
    const f = [fact('src/api/users.ts'), fact('src/ui.ts')];
    const bad = { scopes: [scope('src', ['src/api/users.ts', 'src/ui.ts'])] };
    const errors = checkPlan(bad, { ...caps, configScopes, facts: f });
    expect(codes(errors)).toEqual(['plan.config_scope']);
    expect(errors[0].path).toBe('src/api/users.ts');

    const good = { scopes: [scope('api', ['src/api/users.ts']), scope('src', ['src/ui.ts'])] };
    expect(checkPlan(good, { ...caps, configScopes, facts: f })).toEqual([]);
  });

  test('split parts of a config scope keep its name', () => {
    const configScopes: ConfigScope[] = [{ name: 'api', paths: ['src/api/**'] }];
    const f = [fact('src/api/a.ts'), fact('src/api/b.ts')];
    const plan = { scopes: [scope('api (1)', ['src/api/a.ts']), scope('api (2)', ['src/api/b.ts'])] };
    expect(checkPlan(plan, { ...caps, configScopes, facts: f })).toEqual([]);
  });

  test('empty reviewable list yields empty plan that passes', () => {
    expect(fallbackPlan([], caps)).toEqual({ scopes: [] });
    expect(checkPlan({ scopes: [] }, { ...caps, facts: [] })).toEqual([]);
  });
});

describe('fallbackPlan', () => {
  test('groups by top-level dir, root files under root, deleted files excluded', () => {
    const facts = [fact('src/b.ts'), fact('README.md'), fact('src/a.ts'), fact('gone.ts', 0, 3, 'deleted'), fact('docs/x.md')];
    const plan = fallbackPlan(facts, caps);
    expect(plan.scopes).toEqual([
      { name: 'docs', files: ['docs/x.md'], focus: 'General review of docs', context: [] },
      { name: 'root', files: ['README.md'], focus: 'General review of root', context: [] },
      { name: 'src', files: ['src/a.ts', 'src/b.ts'], focus: 'General review of src', context: [] },
    ]);
    expect(checkPlan(plan, { ...caps, facts })).toEqual([]);
  });

  test('config scopes come first, first match wins, with config focus and context', () => {
    const configScopes: ConfigScope[] = [
      { name: 'api', paths: ['src/api/**'], focus: 'Auth checks', context: ['docs/api.md'] },
      { name: 'all-src', paths: ['src/**'] },
    ];
    const facts = [fact('src/api/u.ts'), fact('src/ui.ts'), fact('lib/x.ts')];
    const plan = fallbackPlan(facts, { ...caps, configScopes });
    expect(plan.scopes).toEqual([
      { name: 'api', files: ['src/api/u.ts'], focus: 'Auth checks', context: ['docs/api.md'] },
      { name: 'all-src', files: ['src/ui.ts'], focus: 'General review of all-src', context: [] },
      { name: 'lib', files: ['lib/x.ts'], focus: 'General review of lib', context: [] },
    ]);
    expect(checkPlan(plan, { ...caps, configScopes, facts })).toEqual([]);
  });

  test('splits a 30-file dir into 3 chunks of at most 12 in path order', () => {
    const facts = Array.from({ length: 30 }, (_, i) => fact(`src/f${String(i).padStart(2, '0')}.ts`));
    const plan = fallbackPlan(facts, caps);
    expect(plan.scopes.map((s) => s.name)).toEqual(['src (1)', 'src (2)', 'src (3)']);
    expect(plan.scopes.map((s) => s.files.length)).toEqual([12, 12, 6]);
    expect(plan.scopes[0].files[0]).toBe('src/f00.ts');
    expect(plan.scopes[2].files[5]).toBe('src/f29.ts');
    expect(plan.scopes.every((s) => s.focus === 'General review of src')).toBe(true);
    expect(checkPlan(plan, { ...caps, facts })).toEqual([]);
  });

  test('splits by line cap and puts an oversize file alone', () => {
    const facts = [fact('src/a.ts', 600, 0), fact('src/b.ts', 600, 0), fact('src/c.ts', 2000, 0), fact('src/d.ts', 400, 0)];
    const plan = fallbackPlan(facts, caps);
    expect(plan.scopes.map((s) => s.files)).toEqual([['src/a.ts', 'src/b.ts'], ['src/c.ts'], ['src/d.ts']]);
    expect(checkPlan(plan, { ...caps, facts })).toEqual([]);
  });
});

describe('matchGlob', () => {
  test.each([
    ['src/**/*.{ts,tsx}', 'src/a/b.tsx', true],
    ['src/**/*.{ts,tsx}', 'src/b.ts', true],
    ['src/**/*.{ts,tsx}', 'src/b.js', false],
    ['src/*.ts', 'src/a/b.ts', false],
    ['src/*.ts', 'src/b.ts', true],
    ['**/*.md', 'README.md', true],
    ['**/*.md', 'docs/deep/x.md', true],
    ['src/**', 'src/a/b/c.ts', true],
    ['src/**', 'srcx/a.ts', false],
    ['file?.ts', 'file1.ts', true],
    ['file?.ts', 'file10.ts', false],
    ['a.b', 'axb', false],
  ])('%s vs %s → %s', (pattern, path, expected) => {
    expect(matchGlob(pattern, path)).toBe(expected);
  });
});
