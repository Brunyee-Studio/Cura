import { loadSchema, validate } from './schema.ts';
import type { CheckError, CuraConfig } from './types.ts';

// Returns `{}` whenever the raw config is missing, unparsable or schema-invalid,
// so a broken consumer config degrades to defaults instead of aborting the review.
export function parseConfig(raw: string | null): { config: CuraConfig; errors: CheckError[] } {
  if (raw === null || raw.trim() === '') return { config: {}, errors: [] };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { config: {}, errors: [{ code: 'config.parse', message: `config is not valid JSON: ${(err as Error).message}` }] };
  }

  const errors = validate(loadSchema('config'), value);
  return { config: errors.length === 0 ? (value as CuraConfig) : {}, errors };
}
