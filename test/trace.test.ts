import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readTrace, renderTrace, traceFrom, traceWarnings, type ReviewTrace } from '../src/trace.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/execution.json', import.meta.url));

const toolUse = (id: string, name: string, input: unknown, parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});

const trace = (over: Partial<ReviewTrace> = {}): ReviewTrace => ({
  model: 'claude-sonnet-5-5',
  turns: 10,
  durationMs: 61000,
  costUsd: 0.5,
  subagents: { 'scope-reviewer': 1, verifier: 1 },
  denials: [],
  planChecks: 1,
  planFallback: false,
  ...over,
});

describe('readTrace', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cura-trace-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('parses the fixture execution file', () => {
    expect(readTrace(FIXTURE)).toEqual({
      model: 'claude-sonnet-5-5',
      turns: 38,
      durationMs: 252000,
      costUsd: 1.2345,
      subagents: { 'scope-reviewer': 2, verifier: 1 },
      denials: [{ tool: 'Bash', input: { command: 'git log --oneline -20 && git diff origin/main...HEAD --stat', description: 'Inspect history' } }],
      planChecks: 2,
      planFallback: true,
    });
  });

  test.each([
    ['a missing file', null],
    ['invalid JSON', '{not json'],
    ['a non-array', '{"type":"result"}'],
  ])('%s gives no trace', (_label, content) => {
    const file = join(root, 'execution.json');
    if (content !== null) writeFileSync(file, content);
    expect(readTrace(file)).toBeNull();
  });
});

describe('traceFrom', () => {
  test('counts legacy Task dispatches alongside Agent ones', () => {
    const t = traceFrom([toolUse('a', 'Task', { subagent_type: 'verifier' }), toolUse('b', 'Agent', { subagent_type: 'verifier' })]);
    expect(t.subagents).toEqual({ verifier: 2 });
  });

  test('a review check is not a plan check', () => {
    const t = traceFrom([toolUse('a', 'Bash', { command: 'node /cura/src/cli.ts check --ctx /tmp/cura' })]);
    expect(t.planChecks).toBe(0);
  });

  test('the fallback line only counts in a plan check result', () => {
    const t = traceFrom([
      toolUse('a', 'Read', { file_path: 'src/cli.ts' }),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: "const FALLBACK_PREFIX = 'FALLBACK PLAN (use this):';" }] } },
    ]);
    expect(t.planFallback).toBe(false);
  });

  test('tolerates junk messages and a missing result', () => {
    const t = traceFrom([null, 7, { type: 'assistant' }, { type: 'assistant', message: { content: 'text' } }, { type: 'user', message: { content: [null] } }]);
    expect(t).toEqual({ model: null, turns: null, durationMs: null, costUsd: null, subagents: {}, denials: [], planChecks: 0, planFallback: false });
  });
});

describe('traceWarnings', () => {
  test('none when the reviewers and the verifier ran', () => {
    expect(traceWarnings(trace(), { mode: 'full', reviewable: true })).toEqual([]);
  });

  test('warns when the verifier never ran', () => {
    expect(traceWarnings(trace({ subagents: { 'scope-reviewer': 2 } }), { mode: 'full', reviewable: true })).toEqual([
      'the verifier never ran, so no finding was verified',
    ]);
  });

  test('warns when a full review ran no scope-reviewer', () => {
    expect(traceWarnings(trace({ subagents: { verifier: 1 } }), { mode: 'full', reviewable: true })).toEqual(['no scope-reviewer ran on this full review']);
  });

  test.each([
    ['an incremental review', { mode: 'incremental' as const, reviewable: true }],
    ['a deletion-only review', { mode: 'full' as const, reviewable: false }],
  ])('%s without a scope-reviewer is not warned about', (_label, review) => {
    expect(traceWarnings(trace({ subagents: { verifier: 1 } }), review)).toEqual([]);
  });
});

describe('renderTrace', () => {
  test('renders the fixture trace', () => {
    const md = renderTrace(readTrace(FIXTURE)!);
    expect(md).toContain('### Cura: review trace');
    expect(md).toContain('`claude-sonnet-5-5` · 38 turns · 4m 12s · $1.23');
    expect(md).toContain('scope-reviewer ×2, verifier ×1');
    expect(md).toContain('Plan checks: 2 (fallback plan used)');
    expect(md).toContain('Permission denials: 1');
    expect(md).toContain('- `Bash` `{"command":"git log --oneline -20 && git diff origin/main...HEAD --stat"');
  });

  test('says when nothing was dispatched or checked and nothing is known', () => {
    const md = renderTrace(trace({ model: null, turns: null, durationMs: null, costUsd: null, subagents: {}, planChecks: 0 }));
    expect(md).toContain('Subagents: none');
    expect(md).toContain('Plan checks: 0');
    expect(md).toContain('Permission denials: 0');
    expect(md).not.toContain('turns');
  });

  test('trims a long denial input to one line without backticks', () => {
    const md = renderTrace(trace({ denials: [{ tool: 'Bash', input: { command: `echo \`x\`\n${'y'.repeat(500)}` } }] }));
    const line = md.split('\n').find((l) => l.startsWith('  - `Bash`'))!;
    expect(line.length).toBeLessThan(200);
    expect(line).toMatch(/…`$/);
    expect(line.slice('  - `Bash` `'.length, -1)).not.toContain('`');
  });
});
