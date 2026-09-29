import { describe, expect, test } from 'vitest';
import {
  findingMarker,
  parseFindingMarker,
  renderFailure,
  renderFindingComment,
  renderSummary,
} from '../src/render.ts';
import { fingerprint, score } from '../src/score.ts';
import type { Category, Finding, FindingMeta, Review, Severity } from '../src/types.ts';

const SHA = 'a'.repeat(40);
const PREV = 'b'.repeat(40);

const finding = (over: Partial<Finding> = {}): Finding => ({
  status: 'new',
  severity: 'P1',
  category: 'correctness',
  path: 'src/a.ts',
  line: 10,
  title: 'Null deref in parser',
  body: 'SECRET-BODY-TEXT explains the bug',
  ...over,
});

const review = (over: Partial<Review> = {}): Review => ({
  summary: 'Adds a parser.',
  risk_note: 'parser edge cases',
  scopes: [{ name: 'core', files: ['src/a.ts', 'src/b.ts'], reviewer_notes: 'looked at parsing' }],
  files: [
    { path: 'src/a.ts', overview: 'new parser | with pipes\nand newline' },
    { path: 'src/b.ts', overview: 'helpers' },
  ],
  diagram: '',
  findings: [],
  resolved: [],
  dismissed: [],
  discarded: [],
  ...over,
});

type Open = Parameters<typeof renderSummary>[0]['open'][number];

const summaryInput = (open: Open[], over: Partial<Parameters<typeof renderSummary>[0]> = {}) => ({
  review: review(),
  score: score(open),
  open,
  resolved: [],
  dismissed: [],
  unanchored: 0,
  headSha: SHA,
  base: 'staging',
  mode: 'full' as const,
  runUrl: 'https://github.com/o/r/actions/runs/1',
  version: '1.2.3',
  rerun: '/cura',
  ...over,
});

describe('finding marker', () => {
  const meta: FindingMeta = { v: 1, severity: 'P0', category: 'security', fingerprint: 'abc123def456' };

  test('renders the exact marker with keys in order', () => {
    expect(findingMarker(meta)).toBe(
      '<!-- cura:finding {"v":1,"severity":"P0","category":"security","fingerprint":"abc123def456"} -->',
    );
  });

  test('round-trips from anywhere in a body', () => {
    expect(parseFindingMarker(`intro\n\n${findingMarker(meta)}\n\ntrailing`)).toEqual(meta);
  });

  test.each([
    ['missing', 'no marker here'],
    ['malformed json', '<!-- cura:finding {"v":1, -->'],
    ['wrong version', '<!-- cura:finding {"v":2,"severity":"P0","category":"security","fingerprint":"x"} -->'],
    ['bad severity', '<!-- cura:finding {"v":1,"severity":"P9","category":"security","fingerprint":"x"} -->'],
    ['bad category', '<!-- cura:finding {"v":1,"severity":"P0","category":"style","fingerprint":"x"} -->'],
    ['non-string fingerprint', '<!-- cura:finding {"v":1,"severity":"P0","category":"security","fingerprint":1} -->'],
    ['not an object', '<!-- cura:finding [1] -->'],
  ])('returns null when %s', (_label, body) => {
    expect(parseFindingMarker(body)).toBeNull();
  });
});

describe('renderFindingComment', () => {
  test('line anchor: header, body, suggestion, marker', () => {
    const f = finding({ suggestion: 'const x = y ?? 0;' });
    const out = renderFindingComment(f, { anchor: { kind: 'line', path: f.path, line: 10, snapped: false } });
    expect(out.startsWith('**[P1 · correctness] Null deref in parser**\n\nSECRET-BODY-TEXT')).toBe(true);
    expect(out).toContain('```suggestion\nconst x = y ?? 0;\n```');
    expect(out.trimEnd().endsWith(findingMarker({ v: 1, severity: 'P1', category: 'correctness', fingerprint: fingerprint(f) }))).toBe(true);
    expect(parseFindingMarker(out)?.fingerprint).toBe(fingerprint(f));
  });

  test('snapped line anchor omits the suggestion', () => {
    const f = finding({ suggestion: 'x' });
    const out = renderFindingComment(f, { anchor: { kind: 'line', path: f.path, line: 12, snapped: true } });
    expect(out).not.toContain('```suggestion');
  });

  test('file-level anchor cites the location and omits the suggestion', () => {
    const f = finding({ suggestion: 'x', line: 42 });
    const out = renderFindingComment(f, { anchor: { kind: 'file', path: f.path } });
    expect(out).toContain('`src/a.ts:42` — SECRET-BODY-TEXT');
    expect(out).not.toContain('```suggestion');
    expect(parseFindingMarker(out)).not.toBeNull();
  });
});

describe('renderSummary', () => {
  test('score 5 has no severity sections and says No open findings', () => {
    const out = renderSummary(summaryInput([]));
    expect(out.startsWith('<!-- cura:summary -->\n## Cura review\n')).toBe(true);
    expect(out).toContain('**Confidence 5/5** — No open findings');
    expect(out).not.toMatch(/### P[012]/);
    expect(out.trimEnd().endsWith(`<!-- cura:reviewed-sha=${SHA} -->`)).toBe(true);
  });

  test('layout: counts, scopes, escaped file table, diagram, footer', () => {
    const open: Open[] = [
      { severity: 'P1', category: 'correctness', title: 'T1', path: 'src/a.ts', line: 3, url: 'https://x/1' },
      { severity: 'P2', category: 'docs', title: 'T2', path: 'src/b.ts', line: null, url: 'https://x/2' },
      { severity: 'P2', category: 'docs', title: 'T3', path: 'src/b.ts', line: 7, url: 'https://x/3' },
    ];
    const out = renderSummary(
      summaryInput(open, {
        review: review({ diagram: 'sequenceDiagram\nA->>B: hi', discarded: [{ location: 'src/a.ts:1', candidate: 'maybe', reason: 'speculative' }] }),
        mode: 'incremental',
        prevSha: PREV,
        resolved: [{ url: 'https://x/r', path: 'src/c.ts', note: 'fixed' }],
        dismissed: [{ url: 'https://x/d', reason: 'intended' }],
        unanchored: 2,
      }),
    );
    expect(out).toContain('**Confidence 3/5** — 1 P1 · 2 P2 · parser edge cases');
    expect(out).not.toContain('0 P0');
    expect(out).toContain('### Scopes reviewed\n- **core** — 2 files — looked at parsing');
    expect(out).toContain('| `src/a.ts` | new parser \\| with pipes and newline |');
    expect(out).toContain('### Sequence diagram\n```mermaid\nsequenceDiagram\nA->>B: hi\n```');
    expect(out).toContain('### P1 — fix before release\n- [`src/a.ts:3`](https://x/1) — **T1**');
    expect(out).toContain('- [`src/b.ts`](https://x/2) — **T2**');
    expect(out).toContain('- [`src/b.ts:7`](https://x/3) — **T3**');
    expect(out).not.toContain('### P0');
    expect(out).toContain('### Resolved since last review\n- [`src/c.ts`](https://x/r) — fixed');
    expect(out).toContain('### Dismissed\n- [thread](https://x/d) — intended');
    expect(out).toContain('src/a.ts:1');
    expect(out).toMatch(/⚠️ 2 findings could not be anchored/);
    expect(out).toContain(
      `<sub>Reviewed \`${SHA.slice(0, 7)}\` against \`staging\` · incremental since \`${PREV.slice(0, 7)}\` · 2 files · [run](https://github.com/o/r/actions/runs/1) · comment \`/cura\` to re-run · Cura v1.2.3</sub>`,
    );
    const order = ['## Cura review', '**Confidence', 'Adds a parser.', '### Scopes reviewed', '<details>', '### Sequence diagram', '### P1', '### P2', '### Resolved', '### Dismissed', 'Discarded', '⚠️', '\n---\n', '<sub>', '<!-- cura:reviewed-sha'];
    const idx = order.map((s) => out.indexOf(s));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  test('full mode footer and omitted empty sections', () => {
    const out = renderSummary(summaryInput([]));
    expect(out).toContain('· full PR ·');
    expect(out).not.toContain('### Sequence diagram');
    expect(out).not.toContain('### Resolved');
    expect(out).not.toContain('### Dismissed');
    expect(out).not.toContain('Discarded');
    expect(out).not.toContain('⚠️');
  });

  describe('invariant: open findings lower the score and appear only as links', () => {
    const severities: Severity[] = ['P0', 'P1', 'P2'];
    const categories: Category[] = ['correctness', 'security', 'data-loss', 'performance', 'contract', 'convention', 'test', 'docs'];
    const cases: Finding[][] = [];
    for (const s of severities)
      for (const c of categories) cases.push([finding({ severity: s, category: c, title: `${s} ${c}`, body: `BODY-${s}-${c}` })]);
    cases.push(severities.map((s, i) => finding({ severity: s, line: i + 1, title: `mix ${s}`, body: `BODY-mix-${s}` })));

    test.each(cases.map((c) => [c.map((f) => `${f.severity}/${f.category}`).join(','), c] as const))('%s', (_label, findings) => {
      const open: Open[] = findings.map((f, i) => ({ ...f, line: i % 2 ? null : f.line, url: `https://x/${i}` }));
      const input = summaryInput(open, { review: review({ findings }) });
      expect(input.score).toBeLessThan(5);
      const out = renderSummary(input);
      expect(out).toContain(`**Confidence ${input.score}/5**`);
      for (const o of open) {
        const loc = o.line === null ? o.path : `${o.path}:${o.line}`;
        expect(out).toContain(`- [\`${loc}\`](${o.url}) — **${o.title}**`);
      }
      for (const f of findings) expect(out).not.toContain(f.body);
    });
  });
});

describe('renderFailure', () => {
  test('keeps the previous confidence line and prefixes the failure notice', () => {
    const previous = renderSummary(summaryInput([{ severity: 'P1', category: 'correctness', title: 'T', path: 'a', line: 1, url: 'u' }]));
    const out = renderFailure({ previousBody: previous, runUrl: 'https://run/2', headSha: PREV });
    const notice = `> ⚠️ Review failed for \`${PREV.slice(0, 7)}\` — [run](https://run/2). Showing the previous result.`;
    expect(out.startsWith('<!-- cura:summary -->\n')).toBe(true);
    expect(out).toContain(notice);
    expect(out).toContain('**Confidence 3/5** — 1 P1');
    expect(out.indexOf(notice)).toBeLessThan(out.indexOf('**Confidence'));
  });

  test('repeated failures do not stack notices', () => {
    const previous = renderSummary(summaryInput([]));
    const once = renderFailure({ previousBody: previous, runUrl: 'https://run/2', headSha: SHA });
    const twice = renderFailure({ previousBody: once, runUrl: 'https://run/3', headSha: PREV });
    expect(twice.match(/Review failed/g)).toHaveLength(1);
    expect(twice).toContain('[run](https://run/3)');
    expect(twice).toContain('**Confidence 5/5**');
  });

  test('without a previous body renders a minimal summary with the marker', () => {
    const out = renderFailure({ previousBody: null, runUrl: 'https://run/2', headSha: SHA });
    expect(out.startsWith('<!-- cura:summary -->\n## Cura review\n')).toBe(true);
    expect(out).toContain(`Review failed for \`${SHA.slice(0, 7)}\` — [run](https://run/2)`);
    expect(out).not.toContain('Confidence');
  });
});
