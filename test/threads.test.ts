import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import type { GitHub } from '../src/github.ts';
import { fetchThreads, isBot, replyToComment, resolveThread } from '../src/threads.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/review-threads.json', import.meta.url), 'utf8'));
const repo = { owner: 'o', name: 'r' };

function fakeGitHub(pages: unknown[]) {
  const graphql = vi.fn(async (_query: string, _variables: Record<string, unknown>) => pages.shift());
  const rest = vi.fn(async () => undefined);
  const gh = { graphql, rest, paginate: vi.fn() } as unknown as GitHub;
  return { gh, graphql, rest };
}

function page(nodes: unknown[], hasNextPage: boolean, endCursor: string | null) {
  return { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage, endCursor }, nodes } } } };
}

describe('isBot', () => {
  test.each([
    ['github-actions', 'github-actions[bot]', true],
    ['github-actions[bot]', 'github-actions', true],
    ['github-actions', 'github-actions', true],
    ['alice', 'github-actions[bot]', false],
  ])('%s vs %s → %s', (login, botLogin, expected) => {
    expect(isBot(login, botLogin)).toBe(expected);
  });
});

describe('fetchThreads', () => {
  test('parses the fixture into Cura threads with meta', async () => {
    const { gh, graphql } = fakeGitHub([fixture]);
    const threads = await fetchThreads(gh, repo, 7, 'github-actions[bot]');
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(graphql.mock.calls[0][1]).toEqual({ owner: 'o', name: 'r', pr: 7, after: null });
    expect(graphql.mock.calls[0][0]).toMatch(/\bline originalLine subjectType\b/);
    expect(threads).toEqual([
      {
        id: 'RT_1',
        commentId: 101,
        url: 'https://github.com/o/r/pull/7#discussion_r101',
        path: 'src/a.ts',
        line: 12,
        originalLine: 12,
        subjectType: 'LINE',
        isResolved: false,
        isOutdated: false,
        body: '**[P1 · correctness] Off by one**\n\nLoop skips the last item.',
        meta: { v: 1, severity: 'P1', category: 'correctness', fingerprint: 'aaaa1111' },
        replies: [{ author: 'alice', body: 'Intentional, see the caller.' }],
      },
      {
        id: 'RT_2',
        commentId: 201,
        url: 'https://github.com/o/r/pull/7#discussion_r201',
        path: 'README.md',
        line: null,
        originalLine: 3,
        subjectType: 'LINE',
        isResolved: true,
        isOutdated: true,
        body: '**[P2 · docs] Typo**\n\nSpelling.',
        meta: { v: 1, severity: 'P2', category: 'docs', fingerprint: 'bbbb2222' },
        replies: [],
      },
    ]);
  });

  test('ignores threads whose root lacks marker or is not bot-authored', async () => {
    const { gh } = fakeGitHub([fixture]);
    const ids = (await fetchThreads(gh, repo, 7, 'github-actions')).map((t) => t.id);
    expect(ids).not.toContain('RT_3'); // human root carrying a marker
    expect(ids).not.toContain('RT_4'); // bot root without a marker
    expect(ids).not.toContain('RT_5'); // marker only in a human reply
  });

  test('paginates by pageInfo', async () => {
    const [first, second] = fixture.repository.pullRequest.reviewThreads.nodes;
    const { gh, graphql } = fakeGitHub([page([first], true, 'CUR1'), page([second], false, null)]);
    const threads = await fetchThreads(gh, repo, 7, 'github-actions');
    expect(threads.map((t) => t.id)).toEqual(['RT_1', 'RT_2']);
    expect(graphql.mock.calls.map((c) => c[1].after)).toEqual([null, 'CUR1']);
  });
});

describe('resolveThread', () => {
  test('sends the resolve mutation with the thread id', async () => {
    const { gh, graphql } = fakeGitHub([{ resolveReviewThread: { thread: { id: 'RT_1' } } }]);
    await resolveThread(gh, 'RT_1');
    expect(graphql.mock.calls[0][0]).toContain('resolveReviewThread(input: { threadId: $threadId })');
    expect(graphql.mock.calls[0][1]).toEqual({ threadId: 'RT_1' });
  });
});

describe('replyToComment', () => {
  test('posts a reply to the review comment', async () => {
    const { gh, rest } = fakeGitHub([]);
    await replyToComment(gh, repo, 7, 101, 'Fixed, thanks.');
    expect(rest).toHaveBeenCalledWith('POST', '/repos/o/r/pulls/7/comments/101/replies', { body: 'Fixed, thanks.' });
  });
});
