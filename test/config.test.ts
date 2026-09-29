import { describe, expect, test } from 'vitest';
import { parseConfig } from '../src/config.ts';
import type { CuraConfig } from '../src/types.ts';

describe('parseConfig', () => {
  test('null or empty input yields an empty config', () => {
    expect(parseConfig(null)).toEqual({ config: {}, errors: [] });
    expect(parseConfig('  ')).toEqual({ config: {}, errors: [] });
  });

  test('invalid JSON yields config.parse and an empty config', () => {
    const { config, errors } = parseConfig('{nope');
    expect(config).toEqual({});
    expect(errors).toEqual([expect.objectContaining({ code: 'config.parse' })]);
  });

  test('unknown min_severity yields an enum error', () => {
    const { config, errors } = parseConfig('{"min_severity":"P9"}');
    expect(config).toEqual({});
    expect(errors).toEqual([expect.objectContaining({ code: 'schema.enum', path: '/min_severity' })]);
  });

  test('a valid config is returned as-is', () => {
    const raw: CuraConfig = {
      instructions: 'Be strict.',
      scopes: [{ name: 'db', paths: ['supabase/**'], focus: 'RLS', context: ['src/lib/db'] }],
      ignore: ['**/*.snap'],
      min_severity: 'P1',
    };
    expect(parseConfig(JSON.stringify(raw))).toEqual({ config: raw, errors: [] });
  });
});
