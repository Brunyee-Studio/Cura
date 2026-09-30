import { describe, expect, test } from 'vitest';
import { GitHubError, type GitHub } from '../src/github.ts';
import { publish, publishFailure } from '../src/publish.ts';
import { renderFindingComment } from '../src/render.ts';
import { fingerprint } from '../src/score.ts';
import type { Finding, Review, Severity } from '../src/types.ts';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const repo = { owner: 'o', name: 'r' };
const BOT = 'github-actions[bot]';
const RUN_URL = 'https://github.com/o/r/actions/runs/1';

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

interface ThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  subjectType: 'LINE' | 'FILE';
  comments: { nodes: { databaseId: number; url: string; body: string; author: { login: string } | null }[] };
}

function threadNode(
  id: string,
  commentId: number,
  f: Finding,
  over: { isResolved?: boolean; isOutdated?: boolean; line?: number | null; originalLine?: number | null; subjectType?: 'LINE' | 'FILE'; body?: string } = {},
): ThreadNode {
  const body = over.body ?? renderFindingComment(f, { anchor: { kind: 'line', path: f.path, line: f.line, snapped: false } });
  return {
    id,
    isResolved: over.isResolved ?? false,
    isOutdated: over.isOutdated ?? false,
    path: f.path,
    line: over.line === undefined ? f.line : over.line,
    originalLine: over.originalLine === undefined ? f.line : over.originalLine,
    subjectType: over.subjectType ?? 'LINE',
    comments: { nodes: [{ databaseId: commentId, url: `https://github.com/o/r/pull/7#discussion_r${commentId}`, body, author: { login: 'github-actions' } }] },
  };
}

/**
 * Recording fake: every REST call and GraphQL mutation is logged as {method, path, body}.
 * `threads` is the sequence of thread lists returned by successive thread fetches (the last one repeats).
 * `fail422` makes matching REST calls throw a 422; `refuseResolve` makes the resolve mutation return GraphQL errors.
 */
function fakeGitHub(opts: { threads?: ThreadNode[][]; fail422?: (call: Call) => boolean; refuseResolve?: boolean; previousSummary?: string } = {}) {
  const calls: Call[] = [];
  const threadPages = [...(opts.threads ?? [[]])];
  let nextId = 1000;
  const gh: GitHub = {
    async rest<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
      const call = { method, path, body };
      calls.push(call);
      if (opts.fail422?.(call)) throw new GitHubError(`GitHub ${method} ${path} failed with 422`, 422, {});
      if (method === 'GET') return { body: opts.previousSummary ?? '' } as T;
      const id = path.match(/\/issues\/comments\/(\d+)$/)?.[1] ?? String(nextId++);
      const kind = path.includes('/issues/') ? 'issuecomment' : 'discussion_r';
      return { id: Number(id), html_url: `https://github.com/o/r/pull/7#${kind}-${id}` } as T;
    },
    async paginate<T>(): Promise<T[]> {
      throw new Error('unexpected paginate');
    },
    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      if (query.includes('resolveReviewThread')) {
        calls.push({ method: 'GRAPHQL', path: 'resolveReviewThread', body: variables });
        if (opts.refuseResolve) throw new GitHubError('GitHub GraphQL request returned errors: Resource not accessible by integration', 200, {});
        return { resolveReviewThread: { thread: { id: variables.threadId } } } as T;
      }
      calls.push({ method: 'GRAPHQL', path: 'reviewThreads' });
      const nodes = threadPages.length > 1 ? threadPages.shift()! : threadPages[0];
      return { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } as T;
    },
  };
  const rest = (method: string, pathPart: string) => calls.filter((c) => c.method === method && c.path.includes(pathPart));
  return { gh, calls, rest };
}

const finding = (over: Partial<Finding> = {}): Finding => ({
  status: 'new',
  severity: 'P1',
  category: 'correctness',
  path: 'src/a.ts',
  line: 12,
  title: 'Off by one',
  body: 'Loop skips the last item.',
  ...over,
});

const review = (over: Partial<Review> = {}): Review => ({
  summary: 'Adds a parser.',
  risk_note: '',
  scopes: [{ name: 'core', files: ['src/a.ts'], reviewer_notes: 'parsing' }],
  files: [{ path: 'src/a.ts', overview: 'parser' }],
  diagram: '',
  findings: [],
  resolved: [],
  dismissed: [],
  discarded: [],
  ...over,
});

const facts = {
  reviewable: ['src/a.ts', 'src/b.ts'],
  deleted: [],
  hunks: { 'src/a.ts': [{ start: 10, end: 30 }], 'src/b.ts': [{ start: 1, end: 5 }] },
  addedLines: { 'src/a.ts': [10, 11, 12, 20, 30], 'src/b.ts': [1, 2, 3, 4, 5] },
  prFiles: new Set(['src/a.ts', 'src/b.ts']),
  threads: [],
};

function run(gh: GitHub, over: { review?: unknown; summaryId?: number | null; minSeverity?: Severity } = {}) {
  return publish({
    gh,
    repo,
    pr: 7,
    headSha: HEAD,
    base: 'main',
    mode: 'full',
    prevSha: null,
    summaryId: over.summaryId ?? null,
    review: over.review ?? review(),
    facts,
    runUrl: RUN_URL,
    version: '1.0.0',
    minSeverity: over.minSeverity ?? 'P2',
    botLogin: BOT,
  });
}

const summaryBody = (calls: Call[]) => {
  const call = calls.find((c) => c.path.includes('/issues/'))!;
  return (call.body as { body: string }).body;
};

describe('publish', () => {
  test('single review call carries all line comments', async () => {
    const a = finding();
    const b = finding({ path: 'src/b.ts', line: 3, start_line: 1, severity: 'P2', title: 'Rename', category: 'convention' });
    const { gh, calls, rest } = fakeGitHub({ threads: [[], [threadNode('RT_A', 1, a), threadNode('RT_B', 2, b)]] });

    const result = await run(gh, { review: review({ findings: [a, b] }) });

    const reviews = rest('POST', '/pulls/7/reviews');
    expect(reviews).toHaveLength(1);
    expect(reviews[0].path).toBe('/repos/o/r/pulls/7/reviews');
    expect(reviews[0].body).toEqual({
      commit_id: HEAD,
      event: 'COMMENT',
      body: 'Cura found 2 new issue(s). See the summary comment.',
      comments: [
        { path: 'src/a.ts', line: 12, side: 'RIGHT', body: renderFindingComment(a, { anchor: { kind: 'line', path: 'src/a.ts', line: 12, snapped: false } }) },
        {
          path: 'src/b.ts',
          line: 3,
          side: 'RIGHT',
          start_line: 1,
          start_side: 'RIGHT',
          body: renderFindingComment(b, { anchor: { kind: 'line', path: 'src/b.ts', line: 3, start_line: 1, snapped: false } }),
        },
      ],
    });
    expect(rest('POST', '/pulls/7/comments')).toHaveLength(0);
    expect(calls.filter((c) => c.path === 'reviewThreads')).toHaveLength(2);
    expect(result).toMatchObject({ score: 3, findings: 2, failed: false, unanchored: [] });
    expect(summaryBody(calls)).toContain('https://github.com/o/r/pull/7#discussion_r1');
  });

  test('422 fallback posts individually and demotes a bad one to file-level', async () => {
    const good = finding();
    const bad = finding({ path: 'src/b.ts', line: 2, title: 'Bad anchor' });
    const { gh, rest } = fakeGitHub({
      fail422: (c) =>
        c.path.endsWith('/pulls/7/reviews') ||
        (c.path.endsWith('/pulls/7/comments') && (c.body as { line?: number }).line === 2),
    });

    const result = await run(gh, { review: review({ findings: [good, bad] }) });

    const individual = rest('POST', '/pulls/7/comments');
    expect(individual.map((c) => c.body)).toEqual([
      { body: renderFindingComment(good, { anchor: { kind: 'line', path: 'src/a.ts', line: 12, snapped: false } }), commit_id: HEAD, path: 'src/a.ts', line: 12, side: 'RIGHT' },
      { body: renderFindingComment(bad, { anchor: { kind: 'line', path: 'src/b.ts', line: 2, snapped: false } }), commit_id: HEAD, path: 'src/b.ts', line: 2, side: 'RIGHT' },
      { body: renderFindingComment(bad, { anchor: { kind: 'file', path: 'src/b.ts' } }), commit_id: HEAD, path: 'src/b.ts', subject_type: 'file' },
    ]);
    expect((individual[2].body as { body: string }).body).toContain('`src/b.ts:2` — ');
    expect(result.unanchored).toEqual([]);
  });

  test('a 422 on the file-level fallback records the finding as unanchored', async () => {
    const bad = finding({ path: 'src/b.ts', line: 2 });
    const { gh, calls } = fakeGitHub({ fail422: (c) => c.method === 'POST' && c.path.includes('/pulls/7/') });

    const result = await run(gh, { review: review({ findings: [bad] }) });

    expect(result.unanchored).toEqual([bad]);
    expect(result.score).toBe(5);
    expect(summaryBody(calls)).toContain('1 finding could not be anchored');
  });

  test('file-level anchor uses subject_type file and skips the review call', async () => {
    const far = finding({ line: 200 });
    const { gh, rest } = fakeGitHub();

    await run(gh, { review: review({ findings: [far] }) });

    expect(rest('POST', '/pulls/7/reviews')).toHaveLength(0);
    expect(rest('POST', '/pulls/7/comments').map((c) => c.body)).toEqual([
      { body: renderFindingComment(far, { anchor: { kind: 'file', path: 'src/a.ts' } }), commit_id: HEAD, path: 'src/a.ts', subject_type: 'file' },
    ]);
  });

  test('finding outside the PR is unanchored, never posted and never scored', async () => {
    const outside = finding({ path: 'src/elsewhere.ts', severity: 'P0' });
    const { gh, rest } = fakeGitHub();

    const result = await run(gh, { review: review({ findings: [outside] }) });

    expect(rest('POST', '/pulls/7/')).toHaveLength(0);
    expect(result).toMatchObject({ score: 5, findings: 0, unanchored: [outside] });
  });

  test('resolved thread gets the resolve mutation, then a reply', async () => {
    const old = finding();
    const { gh, calls } = fakeGitHub({ threads: [[threadNode('RT_1', 101, old)], [threadNode('RT_1', 101, old, { isResolved: true })]] });

    const result = await run(gh, { review: review({ resolved: [{ thread_id: 'RT_1', note: 'bounds fixed' }] }) });

    const lifecycle = calls.filter((c) => c.path.endsWith('/replies') || c.path === 'resolveReviewThread');
    expect(lifecycle).toEqual([
      { method: 'GRAPHQL', path: 'resolveReviewThread', body: { threadId: 'RT_1' } },
      { method: 'POST', path: '/repos/o/r/pulls/7/comments/101/replies', body: { body: 'Resolved in `abcdef1`: bounds fixed' } },
    ]);
    expect(result.score).toBe(5);
    expect(summaryBody(calls)).toContain('### Resolved since last review');
  });

  test('dismissed thread gets the resolve mutation, then a Dismissed reply', async () => {
    const old = finding();
    const { gh, calls } = fakeGitHub({ threads: [[threadNode('RT_1', 101, old)]] });

    const result = await run(gh, { review: review({ dismissed: [{ thread_id: 'RT_1', reason: 'intentional' }] }) });

    const lifecycle = calls.filter((c) => c.path.endsWith('/replies') || c.path === 'resolveReviewThread');
    expect(lifecycle).toEqual([
      { method: 'GRAPHQL', path: 'resolveReviewThread', body: { threadId: 'RT_1' } },
      { method: 'POST', path: '/repos/o/r/pulls/7/comments/101/replies', body: { body: 'Dismissed: intentional' } },
    ]);
    expect(result.score).toBe(5);
    expect(summaryBody(calls)).toContain('### Dismissed');
  });

  test('a refused resolve leaves the thread open without a reply and still writes the summary', async () => {
    const old = finding();
    const { gh, calls } = fakeGitHub({ threads: [[threadNode('RT_1', 101, old)]], refuseResolve: true });

    const result = await run(gh, { review: review({ resolved: [{ thread_id: 'RT_1', note: 'bounds fixed' }] }) });

    expect(calls.filter((c) => c.path.endsWith('/replies'))).toEqual([]);
    expect(result.unresolved).toEqual([
      { url: 'https://github.com/o/r/pull/7#discussion_r101', error: 'GitHub GraphQL request returned errors: Resource not accessible by integration' },
    ]);
    expect(result).toMatchObject({ findings: 1, failed: false });
    expect(summaryBody(calls)).not.toContain('### Resolved since last review');
    expect(summaryBody(calls)).toContain('1 thread Cura closed could not be resolved on GitHub and still counts toward the score: [thread](https://github.com/o/r/pull/7#discussion_r101)');
  });

  test.each([
    ['Fixed in dddf436f. `recordConsent` now checks consent.'],
    ['Resolved in `dddf436`: `recordConsent` now checks consent.'],
  ])('a note that restates a commit SHA is posted without it: %s', async (note) => {
    const old = finding();
    const { gh, calls } = fakeGitHub({ threads: [[threadNode('RT_1', 101, old)], [threadNode('RT_1', 101, old, { isResolved: true })]] });

    await run(gh, { review: review({ resolved: [{ thread_id: 'RT_1', note }] }) });

    const reply = calls.find((c) => c.path.endsWith('/replies'));
    expect(reply?.body).toEqual({ body: 'Resolved in `abcdef1`: `recordConsent` now checks consent.' });
    expect(summaryBody(calls)).toContain('— `recordConsent` now checks consent.');
  });

  test('human-resolved thread is untouched and not scored', async () => {
    const old = finding({ severity: 'P0' });
    const { gh, calls } = fakeGitHub({ threads: [[threadNode('RT_2', 201, old, { isResolved: true })]] });

    const result = await run(gh, { review: review({ resolved: [{ thread_id: 'RT_2', note: 'fixed' }] }) });

    expect(calls.filter((c) => c.path.endsWith('/replies') || c.path === 'resolveReviewThread')).toEqual([]);
    expect(result.score).toBe(5);
  });

  test('a thread id in both resolved and dismissed is resolved once', async () => {
    const old = finding();
    const { gh, calls } = fakeGitHub({ threads: [[threadNode('RT_1', 101, old)]] });

    await run(gh, {
      review: review({ resolved: [{ thread_id: 'RT_1', note: 'fixed' }], dismissed: [{ thread_id: 'RT_1', reason: 'moot' }, { thread_id: 'RT_404', reason: '?' }] }),
    });

    expect(calls.filter((c) => c.path.endsWith('/replies'))).toHaveLength(1);
    expect(calls.filter((c) => c.path === 'resolveReviewThread')).toHaveLength(1);
  });

  test('re-run on same head edits summary and posts no duplicates', async () => {
    const a = finding({ status: 'existing', thread_id: 'RT_1' });
    const b = finding({ status: 'existing', thread_id: 'RT_2', path: 'src/b.ts', line: 3, severity: 'P2', title: 'Rename' });
    const threads = [threadNode('RT_1', 101, a), threadNode('RT_2', 102, b)];
    const { gh, calls } = fakeGitHub({ threads: [threads] });

    const result = await run(gh, { review: review({ findings: [a, b] }), summaryId: 55 });

    const writes = calls.filter((c) => c.method === 'POST' || c.method === 'PATCH' || c.path === 'resolveReviewThread');
    expect(writes).toEqual([{ method: 'PATCH', path: '/repos/o/r/issues/comments/55', body: { body: expect.any(String) } }]);
    expect(result).toMatchObject({ score: 3, findings: 2, summaryUrl: 'https://github.com/o/r/pull/7#issuecomment-55', failed: false });
  });

  test('existing snapped finding with a suggestion is not re-posted with the suggestion', async () => {
    const f = finding({ status: 'existing', thread_id: 'RT_1', line: 35, suggestion: 'return items.length;' });
    const postedBody = renderFindingComment(f, { anchor: { kind: 'line', path: f.path, line: 30, snapped: true } });
    const { gh, rest } = fakeGitHub({ threads: [[threadNode('RT_1', 101, f, { line: 30, body: postedBody })]] });

    await run(gh, { review: review({ findings: [f] }) });

    expect(rest('PATCH', '/pulls/comments/')).toEqual([]);
  });

  test('existing finding on its own line with a changed suggestion is edited with the suggestion', async () => {
    const before = finding({ status: 'existing', thread_id: 'RT_1', suggestion: 'old();' });
    const after = { ...before, suggestion: 'fixed();' };
    const { gh, rest } = fakeGitHub({ threads: [[threadNode('RT_1', 101, before)]] });

    await run(gh, { review: review({ findings: [after] }) });

    const patches = rest('PATCH', '/pulls/comments/');
    expect(patches).toHaveLength(1);
    expect((patches[0].body as { body: string }).body).toContain('```suggestion\nfixed();\n```');
  });

  describe('existing threads without a current line', () => {
    // A file-level comment posted for a finding then at line 42; the lead now reports it at originalLine / 1.
    const posted = finding({ status: 'existing', thread_id: 'RT_F', line: 42, suggestion: 'fix();' });
    const fileBody = renderFindingComment(posted, { anchor: { kind: 'file', path: posted.path } });
    const fileThread = () => threadNode('RT_F', 301, posted, { line: null, originalLine: null, subjectType: 'FILE', body: fileBody });

    test('unchanged finding on a FILE thread is not edited', async () => {
      const { gh, rest } = fakeGitHub({ threads: [[fileThread()]] });
      await run(gh, { review: review({ findings: [{ ...posted, line: 1 }] }) });
      expect(rest('PATCH', '/pulls/comments/')).toEqual([]);
    });

    test('changed finding on a FILE thread is edited, keeping the original cite', async () => {
      const { gh, rest } = fakeGitHub({ threads: [[fileThread()]] });
      await run(gh, { review: review({ findings: [{ ...posted, line: 1, body: 'Now worse.' }] }) });
      const patches = rest('PATCH', '/pulls/comments/');
      expect(patches).toHaveLength(1);
      expect(patches[0].path).toBe('/repos/o/r/pulls/comments/301');
      const body = (patches[0].body as { body: string }).body;
      expect(body).toContain('`src/a.ts:42` — Now worse.');
      expect(body).not.toContain('suggestion');
    });

    // A line comment posted at line 12 with a suggestion; later commits made it outdated.
    const onLine = finding({ status: 'existing', thread_id: 'RT_O', suggestion: 'return items.length;' });
    const lineBody = renderFindingComment(onLine, { anchor: { kind: 'line', path: onLine.path, line: 12, snapped: false } });
    const outdated = () => threadNode('RT_O', 401, onLine, { line: null, originalLine: 12, isOutdated: true, body: lineBody });

    test('unchanged finding on an outdated LINE thread is not edited', async () => {
      const { gh, rest } = fakeGitHub({ threads: [[outdated()]] });
      await run(gh, { review: review({ findings: [onLine] }) });
      expect(rest('PATCH', '/pulls/comments/')).toEqual([]);
    });

    test('changed finding on an outdated LINE thread is edited as a snapped line comment (no suggestion, no cite)', async () => {
      const { gh, rest } = fakeGitHub({ threads: [[outdated()]] });
      const changed = { ...onLine, body: 'Still skips the last item.' };
      await run(gh, { review: review({ findings: [changed] }) });
      expect(rest('PATCH', '/pulls/comments/')).toEqual([
        {
          method: 'PATCH',
          path: '/repos/o/r/pulls/comments/401',
          body: { body: renderFindingComment(changed, { anchor: { kind: 'line', path: 'src/a.ts', line: 12, snapped: true } }) },
        },
      ]);
    });
  });

  test('existing finding with a changed severity edits its root comment', async () => {
    const before = finding({ status: 'existing', thread_id: 'RT_1' });
    const after = { ...before, severity: 'P0' as const, body: 'Worse than thought.' };
    const { gh, rest } = fakeGitHub({
      threads: [[threadNode('RT_1', 101, before)], [threadNode('RT_1', 101, after)]],
    });

    const result = await run(gh, { review: review({ findings: [after] }) });

    expect(rest('PATCH', '/pulls/comments/')).toEqual([
      {
        method: 'PATCH',
        path: '/repos/o/r/pulls/comments/101',
        body: { body: renderFindingComment(after, { anchor: { kind: 'line', path: 'src/a.ts', line: 12, snapped: false } }) },
      },
    ]);
    expect(result.score).toBe(2);
  });

  test('score covers open Cura threads the review did not mention', async () => {
    const unmentioned = finding({ severity: 'P0', category: 'security', title: 'SQL injection', path: 'src/b.ts', line: 4 });
    const { gh, calls } = fakeGitHub({ threads: [[threadNode('RT_9', 909, unmentioned)]] });

    const result = await run(gh);

    expect(result).toMatchObject({ score: 1, findings: 1 });
    const summary = summaryBody(calls);
    expect(summary).toContain('**Confidence 1/5** — 1 P0');
    expect(summary).toContain('[`src/b.ts:4`](https://github.com/o/r/pull/7#discussion_r909) — **SQL injection**');
  });

  test('score 5 when no findings and the summary is created', async () => {
    const { gh, rest } = fakeGitHub();

    const result = await run(gh);

    const created = rest('POST', '/issues/7/comments');
    expect(created).toHaveLength(1);
    expect(created[0].path).toBe('/repos/o/r/issues/7/comments');
    const body = (created[0].body as { body: string }).body;
    expect(body).toContain('**Confidence 5/5** — No open findings');
    expect(body).toContain('`/cura` to re-run');
    expect(body).toContain(`<!-- cura:reviewed-sha=${HEAD} -->`);
    expect(result).toEqual({ score: 5, findings: 0, summaryUrl: 'https://github.com/o/r/pull/7#issuecomment-1000', unanchored: [], unresolved: [], failed: false });
  });

  test('invalid review publishes a failure summary and reports failed', async () => {
    const previous = '<!-- cura:summary -->\n## Cura review\n\n**Confidence 3/5** — 1 P1\n';
    const { gh, calls } = fakeGitHub({ previousSummary: previous });

    const result = await run(gh, { review: { summary: 42 }, summaryId: 55 });

    expect(calls.filter((c) => c.path.includes('/pulls/') || c.method === 'GRAPHQL')).toEqual([]);
    const edit = calls.find((c) => c.method === 'PATCH')!;
    expect(edit.path).toBe('/repos/o/r/issues/comments/55');
    const body = (edit.body as { body: string }).body;
    expect(body).toContain('> ⚠️ Review failed for `abcdef1`');
    expect(body).toContain('**Confidence 3/5** — 1 P1');
    expect(result).toMatchObject({ failed: true, findings: 0, unanchored: [], summaryUrl: 'https://github.com/o/r/pull/7#issuecomment-55' });
  });

  test("minSeverity 'P1' drops P2 findings", async () => {
    const p1 = finding();
    const p2 = finding({ severity: 'P2', title: 'Nit', line: 20 });
    const { gh, rest } = fakeGitHub();

    await run(gh, { review: review({ findings: [p1, p2] }), minSeverity: 'P1' });

    const comments = (rest('POST', '/pulls/7/reviews')[0].body as { comments: { body: string }[] }).comments;
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(fingerprint(p1));
  });

  test('a new comment missing from the refetch is still scored', async () => {
    const a = finding({ severity: 'P0' });
    const { gh } = fakeGitHub();

    const result = await run(gh, { review: review({ findings: [a] }) });

    expect(result).toMatchObject({ score: 2, findings: 1 });
  });
});

describe('publishFailure', () => {
  test('creates a failure summary when there is none', async () => {
    const { gh, calls } = fakeGitHub();

    const url = await publishFailure({ gh, repo, pr: 7, summaryId: null, previousBody: null, runUrl: RUN_URL, headSha: HEAD });

    expect(calls).toEqual([
      { method: 'POST', path: '/repos/o/r/issues/7/comments', body: { body: `<!-- cura:summary -->\n## Cura review\n\n> ⚠️ Review failed for \`abcdef1\` — [run](${RUN_URL}).\n` } },
    ]);
    expect(url).toBe('https://github.com/o/r/pull/7#issuecomment-1000');
  });

  test('edits the existing summary in place', async () => {
    const { gh, calls } = fakeGitHub();

    const url = await publishFailure({ gh, repo, pr: 7, summaryId: 55, previousBody: 'old', runUrl: RUN_URL, headSha: HEAD });

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['PATCH /repos/o/r/issues/comments/55']);
    expect(url).toBe('https://github.com/o/r/pull/7#issuecomment-55');
  });
});
