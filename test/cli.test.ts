import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseShell } from 'shell-quote';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { main, shellQuote, type Deps } from '../src/cli.ts';
import { GitHubError, type GitHub } from '../src/github.ts';
import { assetName } from '../src/install.ts';
import type { Finding, Review } from '../src/types.ts';
import { makeIo } from './io.ts';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** Recording fake GitHub: REST writes return an html_url, thread fetches return no threads. */
function fakeGitHub(opts: { pr?: unknown; comments?: unknown[]; graphqlError?: GitHubError } = {}) {
  const calls: Call[] = [];
  let nextId = 500;
  const gh: GitHub = {
    async rest<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      if (method === 'GET' && path.includes('/pulls/')) return opts.pr as T;
      if (method === 'GET') return { body: '' } as T;
      const id = path.match(/\/issues\/comments\/(\d+)$/)?.[1] ?? String(nextId++);
      return { id: Number(id), html_url: `https://github.com/o/r/pull/7#issuecomment-${id}` } as T;
    },
    async paginate<T>(path: string): Promise<T[]> {
      calls.push({ method: 'PAGINATE', path });
      return (opts.comments ?? []) as T[];
    },
    async graphql<T>(): Promise<T> {
      calls.push({ method: 'GRAPHQL', path: 'reviewThreads' });
      if (opts.graphqlError) throw opts.graphqlError;
      return { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } as T;
    },
  };
  return { gh, calls };
}

let root: string;
let ctx: string;
let outputFile: string;
let summaryFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cura-cli-'));
  ctx = join(root, 'ctx');
  mkdirSync(ctx);
  outputFile = join(root, 'output');
  summaryFile = join(root, 'step-summary');
  writeFileSync(outputFile, '');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const writeCtx = (name: string, value: unknown) => writeFileSync(join(ctx, name), JSON.stringify(value));

/** Lays down the ctx files `context` would produce for a one-file PR (src/a.ts, lines 1–20 added). */
function seedCtx(
  over: { reviewableCount?: number; deletedCount?: number; facts?: unknown[]; config?: unknown; maxFiles?: number; reviewLines?: number; threads?: unknown[] } = {},
) {
  const facts = over.facts ?? [{ path: 'src/a.ts', status: 'modified', language: 'typescript', added: 20, removed: 0, dir: 'src' }];
  writeCtx('context.json', {
    mode: 'full',
    prevSha: null,
    summaryId: null,
    reviewableCount: over.reviewableCount ?? 1,
    deletedCount: over.deletedCount ?? 0,
    base: 'main',
    headSha: HEAD,
    maxFiles: over.maxFiles ?? 12,
    maxLines: 1500,
    reviewLines: over.reviewLines ?? 20,
  });
  writeCtx('facts.json', facts);
  writeCtx('preview.json', {
    reviewable_files: [{ path: 'src/a.ts', status: 'modified', insertions: 20, deletions: 0 }],
    excluded_files: [{ path: 'pnpm-lock.yaml', status: 'modified', insertions: 5, deletions: 5, exclude_reason: 'lockfile' }],
  });
  const lines = Array.from({ length: 20 }, (_, i) => i + 1);
  writeCtx('hunks.json', { 'src/a.ts': [{ start: 1, end: 20 }] });
  writeCtx('added-lines.json', { 'src/a.ts': lines });
  writeCtx('threads.json', over.threads ?? []);
  writeCtx('summary-comment.json', {});
  writeCtx('config.json', over.config ?? {});
}

const finding = (over: Partial<Finding> = {}): Finding => ({
  status: 'new',
  severity: 'P2',
  category: 'correctness',
  path: 'src/a.ts',
  line: 5,
  title: 'Off by one',
  body: 'Loop skips the last item.',
  ...over,
});

const review = (over: Partial<Review> = {}): Review => ({
  summary: 'Adds a parser.',
  risk_note: '',
  scopes: [{ name: 'src', files: ['src/a.ts'], reviewer_notes: 'parsing' }],
  files: [{ path: 'src/a.ts', overview: 'parser' }],
  diagram: '',
  findings: [],
  resolved: [],
  dismissed: [],
  discarded: [],
  ...over,
});

const outputs = () => readFileSync(outputFile, 'utf8');

/** Body text of the one REST call matching method and path; fails the test when absent. */
function sentBody(calls: Call[], method: string, path: string): string {
  const call = calls.find((c) => c.method === method && c.path === path);
  if (!call) throw new Error(`no ${method} ${path} call`);
  return (call.body as { body: string }).body;
}

describe('--help', () => {
  test('lists every subcommand and exits 0', async () => {
    const { io, text, code } = makeIo();
    await main(['--help'], {}, io);
    for (const cmd of ['install', 'context', 'prompt', 'check', 'publish']) expect(text()).toContain(cmd);
    expect(code()).toBe(0);
  });

  test('unknown subcommand is a usage error', async () => {
    const { io, code } = makeIo();
    await main(['frobnicate'], {}, io);
    expect(code()).toBe(2);
  });
});

describe('check', () => {
  const draftIo = (draft: string, file = 'review.json') => {
    mkdirSync(join(ctx, 'drafts'), { recursive: true });
    writeFileSync(join(ctx, 'drafts', file), draft);
    return makeIo();
  };

  test('prints OK and exits 0 for a valid review', async () => {
    seedCtx();
    const { io, text, code } = draftIo(JSON.stringify(review()));
    await main(['check', '--ctx', ctx], {}, io);
    expect(text()).toBe('OK');
    expect(code()).toBe(0);
  });

  test('prints errors and exits 1 for an invalid review', async () => {
    seedCtx();
    const { io, text, code } = draftIo(JSON.stringify(review({ findings: [finding({ line: 400 })] })));
    await main(['check', '--ctx', ctx], {}, io);
    expect(text()).toContain('/findings/0');
    expect(code()).toBe(1);
  });

  test('reports a malformed draft', async () => {
    seedCtx();
    const { io, text, code } = draftIo('{not json');
    await main(['check', '--ctx', ctx], {}, io);
    expect(text()).toMatch(/^json\.invalid/);
    expect(code()).toBe(1);
  });

  test('reports a missing draft', async () => {
    seedCtx();
    const { io, text, code } = makeIo();
    await main(['check', '--ctx', ctx], {}, io);
    expect(text()).toMatch(/^json\.invalid drafts\/review\.json/);
    expect(code()).toBe(1);
  });

  test('falls back to CURA_CTX when --ctx is absent', async () => {
    seedCtx();
    const { io, code } = draftIo(JSON.stringify(review()));
    await main(['check'], { CURA_CTX: ctx }, io);
    expect(code()).toBe(0);
  });

  test.each([
    [['check', '--ctx', 'CTX', 'extra']],
    [['check', '--ctx', 'CTX', '--plan', '--plan']],
    [['check', '--ctx']],
    [['check', '--ctx', 'CTX', '--ctx', 'CTX']],
    [['check', '--ctx=CTX']],
    [['check', '--ctx', 'relative/dir']],
    [['check']],
    [['check', '--ctx', 'CTX/../ctx']],
    [['check', '--ctx', 'CTX/']],
  ])('rejects %j with a usage error (exit 2)', async (argv) => {
    seedCtx();
    const { io, text, code } = draftIo(JSON.stringify(review()));
    await main(argv.map((a) => a.replace('CTX', ctx)), {}, io);
    expect(text()).toContain('usage');
    expect(code()).toBe(2);
  });

  test('rejects --ctx that differs from CURA_CTX (exit 2)', async () => {
    seedCtx();
    const other = join(root, 'other');
    mkdirSync(other);
    const { io, text, code } = draftIo(JSON.stringify(review()));
    await main(['check', '--ctx', other], { CURA_CTX: ctx }, io);
    expect(text()).toContain('usage');
    expect(code()).toBe(2);
  });

  test('accepts --ctx equal to CURA_CTX', async () => {
    seedCtx();
    const { io, code } = draftIo(JSON.stringify(review()));
    await main(['check', '--ctx', ctx], { CURA_CTX: ctx }, io);
    expect(code()).toBe(0);
  });

  test('--plan may come before --ctx', async () => {
    seedCtx();
    const plan = { scopes: [{ name: 'src', files: ['src/a.ts'], focus: 'x', context: [] }] };
    const { io, text, code } = draftIo(JSON.stringify(plan), 'plan.json');
    await main(['check', '--plan', '--ctx', ctx], {}, io);
    expect(text()).toBe('OK');
    expect(code()).toBe(0);
  });

  test('plan fallback is printed on the second failure only', async () => {
    seedCtx();
    const bad = JSON.stringify({ scopes: [{ name: 'x', files: ['nope.ts'], focus: 'x', context: [] }] });

    const first = draftIo(bad, 'plan.json');
    await main(['check', '--ctx', ctx, '--plan'], {}, first.io);
    expect(first.code()).toBe(1);
    expect(first.text()).toContain('plan.missing');
    expect(first.text()).not.toContain('FALLBACK PLAN');

    const second = draftIo(bad, 'plan.json');
    await main(['check', '--ctx', ctx, '--plan'], {}, second.io);
    expect(second.code()).toBe(1);
    const line = second.text().split('\n').find((l) => l.startsWith('FALLBACK PLAN (use this):'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice('FALLBACK PLAN (use this):'.length))).toEqual({
      scopes: [{ name: 'src', files: ['src/a.ts'], focus: 'General review of src', context: [] }],
    });
  });

  test('plan caps come from context.json, not env', async () => {
    seedCtx({
      maxFiles: 1,
      facts: [
        { path: 'src/a.ts', status: 'modified', language: 'typescript', added: 1, removed: 0, dir: 'src' },
        { path: 'src/b.ts', status: 'modified', language: 'typescript', added: 1, removed: 0, dir: 'src' },
      ],
    });
    const plan = { scopes: [{ name: 'src', files: ['src/a.ts', 'src/b.ts'], focus: 'x', context: [] }] };
    const { io, text, code } = draftIo(JSON.stringify(plan), 'plan.json');
    await main(['check', '--ctx', ctx, '--plan'], { CURA_MAX_FILES: '50' }, io);
    expect(text()).toContain('plan.too_many_files');
    expect(code()).toBe(1);
  });
});

describe('publish', () => {
  const env = (over: Record<string, string> = {}) => ({
    CURA_CTX: ctx,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_TOKEN: 't',
    GITHUB_REPOSITORY: 'o/r',
    CURA_PR: '7',
    RUN_URL: 'https://github.com/o/r/actions/runs/1',
    CURA_VERSION: 'v1.0.0',
    AGENT_OUTCOME: 'success',
    ...over,
  });

  test('publishes the review and sets outputs', async () => {
    seedCtx();
    const { gh, calls } = fakeGitHub();
    const { io, code } = makeIo();
    await main(['publish'], env({ REVIEW: JSON.stringify(review()) }), io, { createGitHub: () => gh });
    expect(code()).toBe(0);
    expect(outputs()).toContain('score=5\n');
    expect(outputs()).toContain('findings=0\n');
    expect(outputs()).toMatch(/summary_url=https:\/\/github\.com\/o\/r\/pull\/7#issuecomment-\d+\n/);
    expect(sentBody(calls, 'POST', '/repos/o/r/issues/7/comments')).toContain('Adds a parser.');
  });

  describe('structured output from the execution file', () => {
    // claude-code-action's execution file: the SDK message list; structured_output rides on the result message.
    const writeExecution = (result: Record<string, unknown>) => {
      const file = join(root, 'claude-execution-output.json');
      const messages = [{ type: 'system', subtype: 'init', session_id: 's' }, { type: 'assistant', message: {} }, { type: 'result', ...result }];
      writeFileSync(file, JSON.stringify(messages));
      return file;
    };

    test('publishes a review larger than the 128 KiB env limit read from the file', async () => {
      seedCtx();
      const big = `BIG-${'x'.repeat(140 * 1024)}`;
      const file = writeExecution({ subtype: 'success', is_error: false, structured_output: review({ summary: big }) });
      const { gh, calls } = fakeGitHub();
      const { io, code } = makeIo();
      await main(['publish'], env({ CURA_EXECUTION_FILE: file }), io, { createGitHub: () => gh });
      expect(code()).toBe(0);
      expect(sentBody(calls, 'POST', '/repos/o/r/issues/7/comments')).toContain(big);
    });

    test('the file wins over REVIEW when both are present', async () => {
      seedCtx();
      const file = writeExecution({ subtype: 'success', is_error: false, structured_output: review({ summary: 'FROM-FILE' }) });
      const { gh, calls } = fakeGitHub();
      const { io, code } = makeIo();
      await main(['publish'], env({ CURA_EXECUTION_FILE: file, REVIEW: JSON.stringify(review({ summary: 'FROM-ENV' })) }), io, { createGitHub: () => gh });
      expect(code()).toBe(0);
      expect(sentBody(calls, 'POST', '/repos/o/r/issues/7/comments')).toContain('FROM-FILE');
    });

    test.each([
      ['an error result', { subtype: 'error_max_turns', is_error: true }],
      ['a success result flagged is_error', { subtype: 'success', is_error: true, structured_output: review() }],
      ['a success result without structured_output', { subtype: 'success', is_error: false }],
    ])('%s publishes a failure', async (_label, result) => {
      seedCtx();
      const file = writeExecution(result);
      const { gh, calls } = fakeGitHub();
      const { io, code } = makeIo();
      await main(['publish'], env({ CURA_EXECUTION_FILE: file }), io, { createGitHub: () => gh });
      expect(code()).toBe(1);
      expect(sentBody(calls, 'POST', '/repos/o/r/issues/7/comments')).toContain('Review failed');
    });

    test('a missing file falls back to REVIEW', async () => {
      seedCtx();
      const { gh, calls } = fakeGitHub();
      const { io, code } = makeIo();
      await main(['publish'], env({ CURA_EXECUTION_FILE: join(root, 'absent.json'), REVIEW: JSON.stringify(review()) }), io, { createGitHub: () => gh });
      expect(code()).toBe(0);
      expect(sentBody(calls, 'POST', '/repos/o/r/issues/7/comments')).toContain('Adds a parser.');
    });
  });

  describe('review trace', () => {
    const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/execution.json', import.meta.url), 'utf8')) as Record<string, unknown>[];
    const summary = () => (existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : '');
    /** The fixture run carrying a publishable review, minus the messages `drop` matches. */
    const writeExecution = (drop: (m: Record<string, unknown>) => boolean = () => false, output: Review = review()) => {
      const file = join(root, 'claude-execution-output.json');
      const messages = fixture()
        .filter((m) => !drop(m))
        .map((m) => (m.type === 'result' ? { ...m, structured_output: output } : m));
      writeFileSync(file, JSON.stringify(messages));
      return file;
    };
    const dispatches = (type: string) => (m: Record<string, unknown>) => JSON.stringify(m).includes(`"subagent_type":"${type}"`);
    const noSubagents = (m: Record<string, unknown>) => JSON.stringify(m).includes('"subagent_type"');

    test('writes the trace to the job summary without warnings', async () => {
      seedCtx();
      const { gh, calls } = fakeGitHub();
      const { io, text, code } = makeIo();
      await main(['publish'], env({ CURA_EXECUTION_FILE: writeExecution() }), io, { createGitHub: () => gh });
      expect(code()).toBe(0);
      expect(summary()).toContain('### Cura: review trace');
      expect(summary()).toContain('scope-reviewer ×2, verifier ×1');
      expect(summary()).toContain('Plan checks: 2 (fallback plan used)');
      expect(text()).not.toContain('::warning::');
      expect(sentBody(calls, 'POST', '/repos/o/r/issues/7/comments')).not.toContain('review trace');
    });

    test('warns when the verifier never ran on a candidate', async () => {
      seedCtx();
      const { gh } = fakeGitHub();
      const { io, text, code } = makeIo();
      const output = review({ discarded: [{ location: 'src/a.ts:3', candidate: 'maybe', reason: 'not reachable' }] });
      await main(['publish'], env({ CURA_EXECUTION_FILE: writeExecution(dispatches('verifier'), output) }), io, { createGitHub: () => gh });
      expect(code()).toBe(0);
      expect(text()).toContain('::warning::Cura: the verifier never ran, so no finding was verified');
    });

    test('warns when the verifier never ran on an open thread', async () => {
      seedCtx({ threads: [{ id: 'T1', isResolved: false }, { id: 'T2', isResolved: true }] });
      const { gh } = fakeGitHub();
      const { io, text } = makeIo();
      await main(['publish'], env({ CURA_EXECUTION_FILE: writeExecution(dispatches('verifier')) }), io, { createGitHub: () => gh });
      expect(text()).toContain('::warning::Cura: the verifier never ran, so no finding was verified');
    });

    test('a small direct review with nothing to verify is not warned about', async () => {
      seedCtx({ threads: [{ id: 'T2', isResolved: true }] });
      const { gh } = fakeGitHub();
      const { io, text, code } = makeIo();
      await main(['publish'], env({ CURA_EXECUTION_FILE: writeExecution(noSubagents) }), io, { createGitHub: () => gh });
      expect(code()).toBe(0);
      expect(text()).not.toContain('::warning::');
    });

    test('warns when no scope-reviewer ran on a review too large to review directly', async () => {
      seedCtx({ reviewLines: 500 });
      const { gh } = fakeGitHub();
      const { io, text, code } = makeIo();
      await main(['publish'], env({ CURA_EXECUTION_FILE: writeExecution(dispatches('scope-reviewer')) }), io, { createGitHub: () => gh });
      expect(code()).toBe(0);
      expect(text()).toContain('::warning::Cura: no scope-reviewer ran although the review has 500 changed lines');
    });

    test('REVIEW without an execution file publishes with no trace', async () => {
      seedCtx();
      const { gh } = fakeGitHub();
      const { io, text, code } = makeIo();
      await main(['publish'], env({ REVIEW: JSON.stringify(review()) }), io, { createGitHub: () => gh });
      expect(code()).toBe(0);
      expect(summary()).not.toContain('review trace');
      expect(text()).not.toContain('::warning::');
    });
  });

  test('fail_on P1 fails the step on an open P1 finding', async () => {
    seedCtx();
    const { gh } = fakeGitHub();
    const { io, code } = makeIo();
    const REVIEW = JSON.stringify(review({ findings: [finding({ severity: 'P1' })] }));
    await main(['publish'], env({ REVIEW, CURA_FAIL_ON: 'P1' }), io, { createGitHub: () => gh });
    expect(outputs()).toContain('score=3\n');
    expect(outputs()).toContain('findings=1\n');
    expect(code()).toBe(1);
  });

  test('fail_on P1 passes when only P2 findings are open; fail_on P0 passes on P1', async () => {
    seedCtx();
    const p2 = makeIo();
    await main(['publish'], env({ REVIEW: JSON.stringify(review({ findings: [finding()] })), CURA_FAIL_ON: 'P1' }), p2.io, {
      createGitHub: () => fakeGitHub().gh,
    });
    expect(p2.code()).toBe(0);

    const p1 = makeIo();
    const REVIEW = JSON.stringify(review({ findings: [finding({ severity: 'P1' })] }));
    await main(['publish'], env({ REVIEW, CURA_FAIL_ON: 'P0' }), p1.io, { createGitHub: () => fakeGitHub().gh });
    expect(p1.code()).toBe(0);
  });

  test('writes check warnings and unanchored findings to the step summary without blocking', async () => {
    seedCtx();
    const { gh } = fakeGitHub();
    const { io, code } = makeIo();
    const REVIEW = JSON.stringify(review({ findings: [finding({ path: 'src/elsewhere.ts', line: 3, title: 'Stray' })] }));
    await main(['publish'], env({ REVIEW }), io, { createGitHub: () => gh });
    expect(code()).toBe(0);
    const summary = readFileSync(summaryFile, 'utf8');
    expect(summary).toContain('/findings/0');
    expect(summary).toContain('Stray');
    expect(summary).toContain('src/elsewhere.ts:3');
  });

  test('empty REVIEW without skip marks the summary failed and exits 1', async () => {
    seedCtx();
    writeCtx('context.json', { mode: 'full', prevSha: null, summaryId: 42, reviewableCount: 1, base: 'main', headSha: HEAD });
    writeCtx('summary-comment.json', { id: 42, body: '<!-- cura:summary -->\n## Cura review\n\nold result' });
    const { gh, calls } = fakeGitHub();
    const { io, code } = makeIo();
    await main(['publish'], env({ REVIEW: '' }), io, { createGitHub: () => gh });
    expect(code()).toBe(1);
    const body = sentBody(calls, 'PATCH', '/repos/o/r/issues/comments/42');
    expect(body).toContain('Review failed');
    expect(body).toContain('old result');
  });

  test('a publish that throws marks the summary failed and rethrows', async () => {
    seedCtx();
    const { gh, calls } = fakeGitHub({ graphqlError: new GitHubError('GitHub GraphQL request returned errors: boom', 200, {}) });
    const { io } = makeIo();
    await expect(main(['publish'], env({ REVIEW: JSON.stringify(review()) }), io, { createGitHub: () => gh })).rejects.toThrow('boom');
    expect(sentBody(calls, 'POST', '/repos/o/r/issues/7/comments')).toContain('Review failed');
  });

  test('agent outcome other than success marks the summary failed', async () => {
    seedCtx();
    const { gh, calls } = fakeGitHub();
    const { io, code } = makeIo();
    await main(['publish'], env({ REVIEW: JSON.stringify(review()), AGENT_OUTCOME: 'failure' }), io, { createGitHub: () => gh });
    expect(code()).toBe(1);
    expect(sentBody(calls, 'POST', '/repos/o/r/issues/7/comments')).toContain('Review failed');
  });

  test('unset AGENT_OUTCOME fails closed even with a valid REVIEW', async () => {
    seedCtx();
    const { gh, calls } = fakeGitHub();
    const { io, code } = makeIo();
    const { AGENT_OUTCOME: _omit, ...rest } = env({ REVIEW: JSON.stringify(review()) });
    await main(['publish'], rest, io, { createGitHub: () => gh });
    expect(code()).toBe(1);
    expect(sentBody(calls, 'POST', '/repos/o/r/issues/7/comments')).toContain('Review failed');
  });

  test('non-JSON REVIEW marks the summary failed', async () => {
    seedCtx();
    const { gh, calls } = fakeGitHub();
    const { io, code } = makeIo();
    await main(['publish'], env({ REVIEW: 'not json {' }), io, { createGitHub: () => gh });
    expect(code()).toBe(1);
    expect(outputs()).toContain('score=0\n');
    expect(sentBody(calls, 'POST', '/repos/o/r/issues/7/comments')).toContain('Review failed');
  });

  test('skips agent when nothing reviewable: empty REVIEW publishes a 5/5 summary', async () => {
    seedCtx({ reviewableCount: 0, facts: [] });
    const { gh, calls } = fakeGitHub();
    const { io, code } = makeIo();
    await main(['publish'], env({ REVIEW: '', AGENT_OUTCOME: 'skipped' }), io, { createGitHub: () => gh });
    expect(code()).toBe(0);
    expect(outputs()).toContain('score=5\n');
    const body = sentBody(calls, 'POST', '/repos/o/r/issues/7/comments');
    expect(body).toContain('No reviewable files in this PR.');
    expect(body).toContain('5/5');
    expect(body).not.toContain('Review failed');
  });

  test('deletion-only PR does not skip the agent: an empty REVIEW is a failure', async () => {
    seedCtx({ reviewableCount: 0, deletedCount: 1, facts: [{ path: 'src/gone.ts', status: 'deleted', language: 'typescript', added: 0, removed: 9, dir: 'src' }] });
    const { gh, calls } = fakeGitHub();
    const { io, code } = makeIo();
    await main(['publish'], env({ REVIEW: '', AGENT_OUTCOME: 'skipped' }), io, { createGitHub: () => gh });
    expect(code()).toBe(1);
    expect(sentBody(calls, 'POST', '/repos/o/r/issues/7/comments')).toContain('Review failed');
  });
});

describe('context', () => {
  const PR = {
    title: 'Docs only',
    body: null,
    user: { login: 'alice' },
    labels: [],
    base: { ref: 'main', repo: { full_name: 'o/r' } },
    head: { sha: HEAD, repo: { full_name: 'fork/r' } },
  };
  const PREVIEW = {
    reviewable_count: 0,
    excluded_count: 1,
    reviewable_files: [],
    excluded_files: [{ path: 'pnpm-lock.yaml', status: 'modified', insertions: 1, deletions: 1, exclude_reason: 'lockfile' }],
  };
  let preview: unknown = PREVIEW;
  beforeEach(() => {
    preview = PREVIEW;
  });

  function exec(cmd: string, args: string[], cwd: string): string {
    // ocr runs in the base-rules worktree under the ctx dir; everything else in the workspace.
    expect(cwd).toBe(cmd === 'ocr' ? join(ctx, 'ocr-worktree') : root);
    if (cmd === 'git' && args[0] === 'show') throw new Error('missing');
    if (cmd === 'ocr' && args[1] === 'preview') return JSON.stringify(preview);
    if (cmd === 'git') return '';
    throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
  }

  test('skips agent when nothing reviewable: sets skip_agent=true and writes context.json', async () => {
    const { gh } = fakeGitHub({ pr: PR, comments: [] });
    const { io, code } = makeIo();
    const env = {
      CURA_CTX: ctx,
      GITHUB_OUTPUT: outputFile,
      GITHUB_WORKSPACE: root,
      GITHUB_TOKEN: 't',
      GITHUB_REPOSITORY: 'o/r',
      CURA_PR: '7',
      CURA_BASE: 'main',
      CURA_HEAD_SHA: HEAD,
    };
    await main(['context'], env, io, { createGitHub: () => gh, exec });
    expect(code()).toBe(0);
    expect(outputs().split('\n')).toEqual(
      expect.arrayContaining(['mode=full', 'prev_sha=', 'summary_id=', 'reviewable_count=0', 'cross_repo=true', 'skip_agent=true']),
    );
    expect(JSON.parse(readFileSync(join(ctx, 'context.json'), 'utf8'))).toEqual({
      mode: 'full',
      prevSha: null,
      summaryId: null,
      reviewableCount: 0,
      deletedCount: 0,
      reviewLines: 0,
      base: 'main',
      headSha: HEAD,
      maxFiles: 12,
      maxLines: 1500,
    });
  });

  test('deletion-only PR runs the agent: skip_agent=false with deletedCount persisted', async () => {
    preview = { ...PREVIEW, excluded_files: [{ path: 'src/gone.ts', status: 'deleted', insertions: 0, deletions: 9, exclude_reason: 'deleted' }] };
    const { gh } = fakeGitHub({ pr: PR, comments: [] });
    const { io, code } = makeIo();
    const env = {
      CURA_CTX: ctx,
      GITHUB_OUTPUT: outputFile,
      GITHUB_WORKSPACE: root,
      GITHUB_TOKEN: 't',
      GITHUB_REPOSITORY: 'o/r',
      CURA_PR: '7',
      CURA_BASE: 'main',
      CURA_HEAD_SHA: HEAD,
    };
    await main(['context'], env, io, { createGitHub: () => gh, exec });
    expect(code()).toBe(0);
    expect(outputs().split('\n')).toEqual(expect.arrayContaining(['reviewable_count=0', 'skip_agent=false']));
    expect(JSON.parse(readFileSync(join(ctx, 'context.json'), 'utf8'))).toMatchObject({ reviewableCount: 0, deletedCount: 1 });
  });

  test('persists plan caps from CURA_MAX_FILES / CURA_MAX_LINES into context.json', async () => {
    const { gh } = fakeGitHub({ pr: PR, comments: [] });
    const { io } = makeIo();
    const env = {
      CURA_CTX: ctx,
      GITHUB_OUTPUT: outputFile,
      GITHUB_WORKSPACE: root,
      GITHUB_TOKEN: 't',
      GITHUB_REPOSITORY: 'o/r',
      CURA_PR: '7',
      CURA_BASE: 'main',
      CURA_HEAD_SHA: HEAD,
      CURA_MAX_FILES: '4',
      CURA_MAX_LINES: '300',
    };
    await main(['context'], env, io, { createGitHub: () => gh, exec });
    expect(JSON.parse(readFileSync(join(ctx, 'context.json'), 'utf8'))).toMatchObject({ maxFiles: 4, maxLines: 300 });
  });

  test('rejects a relative CURA_CTX', async () => {
    const { io } = makeIo();
    await expect(main(['context'], { CURA_CTX: 'rel' }, io, { createGitHub: () => fakeGitHub().gh })).rejects.toThrow(/CURA_CTX/);
  });

  test('rejects a non-canonical CURA_CTX', async () => {
    for (const bad of [`${ctx}/`, `${ctx}/../ctx`, `${ctx}/.`]) {
      const { io } = makeIo();
      await expect(main(['prompt'], { CURA_CTX: bad }, io)).rejects.toThrow(/CURA_CTX must be a canonical absolute path/);
    }
  });
});

describe('prompt', () => {
  test('requires the scope reviewers when the diff to review is above the direct-review threshold', async () => {
    seedCtx({ reviewLines: 500 });
    const { io } = makeIo();
    await main(['prompt'], { CURA_CTX: ctx, GITHUB_OUTPUT: outputFile, GITHUB_REPOSITORY: 'o/r', CURA_PR: '7' }, io);
    expect(readFileSync(join(ctx, 'lead-prompt.md'), 'utf8')).toContain('DIRECT REVIEW: not allowed');
  });

  test('writes the lead prompt and agents, and emits multi-line outputs with a delimiter', async () => {
    seedCtx();
    const { io, code } = makeIo();
    await main(['prompt'], { CURA_CTX: ctx, GITHUB_OUTPUT: outputFile, GITHUB_REPOSITORY: 'o/r', CURA_PR: '7', CURA_MAX_FILES: '99' }, io);
    expect(code()).toBe(0);

    const prompt = readFileSync(join(ctx, 'lead-prompt.md'), 'utf8');
    expect(prompt).toContain('PR NUMBER: 7');
    expect(prompt).toContain(`CONTEXT DIR: ${ctx}`);
    expect(prompt).toContain('at most 12 files and at most 1500 changed lines');
    expect(prompt).toContain('DIRECT REVIEW: allowed');
    expect(Object.keys(JSON.parse(readFileSync(join(ctx, 'agents.json'), 'utf8')))).toEqual(['scope-reviewer', 'verifier']);

    const out = outputs();
    const heredoc = /^prompt<<(CURA_[0-9a-f]{32})\n([\s\S]*?)\n\1\n/m.exec(out);
    expect(heredoc).not.toBeNull();
    expect(heredoc![2]).toBe(prompt);
    expect(out).toContain(`agents_file=${join(ctx, 'agents.json')}\n`);
    expect(out).toMatch(/^allowed_tools=Bash\(git diff origin\/main\.\.\.HEAD --:\*\),/m);
    expect(out).toMatch(/^disallowed_tools=.+$/m);
    const schemaLine = out.split('\n').find((l) => l.startsWith('schema='));
    const schema = JSON.parse(schemaLine!.slice('schema='.length));
    expect(schema).toHaveProperty('properties.findings');
    // Claude Code's --json-schema validator rejects the draft 2020-12 meta-schema URI.
    expect(schema).not.toHaveProperty('$schema');
  });

  test('emits claude_args that shell-quote and a POSIX shell split back into the exact arguments', async () => {
    seedCtx();
    // Quotes, backslashes, `$` and spaces: everything a shell-style parser could misread.
    const model = "it's \\'a\\ $HOME $(id) `x` \\\\'";
    const { io, code } = makeIo();
    await main(['prompt'], { CURA_CTX: ctx, GITHUB_OUTPUT: outputFile, GITHUB_REPOSITORY: 'o/r', CURA_PR: '7', CURA_MODEL: model }, io);
    expect(code()).toBe(0);

    const out = outputs();
    const value = (name: string) => out.split('\n').find((l) => l.startsWith(`${name}=`))!.slice(name.length + 1);
    const claudeArgs = value('claude_args');
    const agents = readFileSync(join(ctx, 'agents.json'), 'utf8');
    expect(agents).toContain("'");
    const expected = [
      '--json-schema',
      value('schema'),
      '--agents',
      agents,
      '--allowedTools',
      value('allowed_tools'),
      '--disallowedTools',
      value('disallowed_tools'),
      '--model',
      model,
    ];

    // claude-code-action splits claude_args with the shell-quote package.
    expect(parseShell(claudeArgs)).toEqual(expected);
    const split = execFileSync('sh', ['-c', `printf '%s\\0' ${claudeArgs}`], { encoding: 'utf8' }).split('\0').slice(0, -1);
    expect(split).toEqual(expected);
  });

  test('shellQuote round-trips quotes and backslashes through shell-quote and sh', () => {
    const values = ["'", "''", "\\'", "\\\\'x", "a\\b", "x\\'y", "it's", '', ' ', '$HOME $(id) `x` #c', '{"a":"b\\"c\\n"}', 'Bash(git diff:*)', "\\'\\'"];
    const joined = values.map(shellQuote).join(' ');
    expect(parseShell(joined)).toEqual(values);
    const split = execFileSync('sh', ['-c', `printf '%s\\0' ${joined}`], { encoding: 'utf8' }).split('\0').slice(0, -1);
    expect(split).toEqual(values);
  });

  test('shellQuote refuses a value ending in a backslash', () => {
    expect(() => shellQuote('model\\')).toThrow(/backslash/);
  });

  test('omits --model from claude_args when CURA_MODEL is unset', async () => {
    seedCtx();
    const { io } = makeIo();
    await main(['prompt'], { CURA_CTX: ctx, GITHUB_OUTPUT: outputFile, GITHUB_REPOSITORY: 'o/r', CURA_PR: '7' }, io);
    const line = outputs().split('\n').find((l) => l.startsWith('claude_args='))!;
    expect(line).not.toContain('--model');
  });

  test('prints outputs to stdout when GITHUB_OUTPUT is unset', async () => {
    seedCtx();
    const { io, text } = makeIo();
    await main(['prompt'], { CURA_CTX: ctx, GITHUB_REPOSITORY: 'o/r', CURA_PR: '7' }, io);
    expect(text()).toContain(`agents_file=${join(ctx, 'agents.json')}`);
  });
});

describe('install', () => {
  const binary = new TextEncoder().encode('#!/bin/sh\necho ocr\n');
  const sums = `${createHash('sha256').update(binary).digest('hex')}  ${assetName(process.platform, process.arch)}\n`;
  const fakeFetch = (async (url: string) =>
    new Response(url.endsWith('sha256sum.txt') ? sums : binary, { status: 200 })) as unknown as typeof fetch;

  test('downloads ocr into RUNNER_TEMP/cura-bin and appends it to GITHUB_PATH', async () => {
    const pathFile = join(root, 'path');
    const emptyDir = join(root, 'empty');
    mkdirSync(emptyDir);
    const { io, code } = makeIo();
    await main(['install'], { RUNNER_TEMP: root, GITHUB_PATH: pathFile, PATH: emptyDir }, io, { fetch: fakeFetch });
    expect(code()).toBe(0);
    const binDir = join(root, 'cura-bin');
    expect(existsSync(join(binDir, process.platform === 'win32' ? 'ocr.exe' : 'ocr'))).toBe(true);
    expect(readFileSync(pathFile, 'utf8')).toBe(`${binDir}\n`);
  });

  test('uses an ocr already on PATH without touching GITHUB_PATH', async () => {
    const pathFile = join(root, 'path');
    const found = join(root, 'tools');
    mkdirSync(found);
    writeFileSync(join(found, 'ocr'), '#!/bin/sh\n');
    chmodSync(join(found, 'ocr'), 0o755);
    const fetchNever = (async () => {
      throw new Error('should not download');
    }) as unknown as typeof fetch;
    const { io, text, code } = makeIo();
    await main(['install'], { RUNNER_TEMP: root, GITHUB_PATH: pathFile, PATH: found }, io, { fetch: fetchNever } satisfies Partial<Deps>);
    expect(code()).toBe(0);
    expect(text()).toContain(join(found, 'ocr'));
    expect(existsSync(pathFile)).toBe(false);
  });
});
