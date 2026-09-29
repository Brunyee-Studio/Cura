import { createHash } from 'node:crypto';
import type { Category, Severity } from './types.ts';

type OpenFinding = { severity: Severity; category: Category };

const CRITICAL_CATEGORIES: ReadonlySet<Category> = new Set(['security', 'data-loss']);

/** Confidence score derived only from open findings: 5 none · 4 only P2 · 3 any P1 · 2 any P0 · 1 P0 security/data-loss. */
export function score(open: OpenFinding[]): 1 | 2 | 3 | 4 | 5 {
  const p0 = open.filter((f) => f.severity === 'P0');
  if (p0.some((f) => CRITICAL_CATEGORIES.has(f.category))) return 1;
  if (p0.length > 0) return 2;
  if (open.some((f) => f.severity === 'P1')) return 3;
  if (open.length > 0) return 4;
  return 5;
}

export function countBySeverity(open: { severity: Severity }[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { P0: 0, P1: 0, P2: 0 };
  for (const f of open) counts[f.severity] += 1;
  return counts;
}

/** Stable id for a finding across runs: insensitive to title case and surrounding whitespace. */
export function fingerprint(f: { path: string; category: Category; title: string }): string {
  const key = `${f.path}|${f.category}|${f.title.trim().toLowerCase()}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}
