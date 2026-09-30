import { describe, expect, test } from 'vitest';
import type { GitHub } from '../src/github.ts';
import { renderFailure, renderFindingComment, renderSummary, type OpenFindingLink } from '../src/render.ts';
import { rescore } from '../src/rescore.ts';
import { score } from '../src/score.ts';
import type { Finding, Review } from '../src/types.ts';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const repo = { owner: 'o', name: 'r' };
const BOT = 'github-actions[bot]';

const p1: Finding = { status: 'new', severity: 'P1', category: 'correctness', path: 'src/a.ts', line: 12, title: 'Off by one', body: 'Loop skips the last item.' };
const p2: Finding = { ...p1, severity: 'P2', category: 'docs', line: 20, title: 'Stale comment', body: 'The comment describes the old loop.' };

const review: Review = {
  summary: 'Adds a parser.',
  risk_note: 'parser edge cases',
  scopes: [],
  files: [{ path: 'src/a.ts', overview: 'parser' }],
  diagram: '',
  findings: [],
  resolved: [],
  dismissed: [],
  discarded: [],
};

const url = (f: Finding) => `https://github.com/o/r/pull/7#discussion_r${f.line}`;

function threadNode(f: Finding, isResolved: boolean) {
  const body = renderFindingComment(f, { anchor: { kind: 'line', path: f.path, line: f.line, snapped: false } });
  return {
    id: `T${f.line}`,
    isResolved,
    isOutdated: false,
    path: f.path,
    line: f.line,
    originalLine: f.line,
    subjectType: 'LINE',
    comments: { nodes: [{ databaseId: f.line, url: url(f), body, author: { login: 'github-actions' } }] },
  };
}

function summary(open: Finding[]): string {
  const links: OpenFindingLink[] = open.map((f) => ({ severity: f.severity, category: f.category, title: f.title, path: f.path, line: f.line, url: url(f) }));
  return renderSummary({
    review,
    score: score(links),
    open: links,
    resolved: [],
    dismissed: [],
    unresolved: [],
    unanchored: 0,
    headSha: HEAD,
    base: 'main',
    mode: 'full',
    runUrl: 'https://github.com/o/r/actions/runs/1',
    version: '1.0.0',
    rerun: '/cura',
  });
}

function fakeGitHub(opts: { comments: { id: number; body: string; user: { login: string } | null }[]; threads: ReturnType<typeof threadNode>[] }) {
  const patches: { path: string; body: string }[] = [];
  const gh: GitHub = {
    async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
      if (method !== 'PATCH') throw new Error(`unexpected ${method} ${path}`);
      patches.push({ path, body: (body as { body: string }).body });
      return {} as T;
    },
    async paginate<T>(): Promise<T[]> {
      return opts.comments as T[];
    },
    async graphql<T>(): Promise<T> {
      return { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: opts.threads } } } } as T;
    },
  };
  return { gh, patches };
}

const summaryComment = (body: string) => ({ id: 42, body, user: { login: BOT } });
const run = (gh: GitHub) => rescore({ gh, repo, pr: 7, botLogin: BOT });

describe('rescore', () => {
  test('a human resolve raises the score and drops the link, keeping the rest of the summary', async () => {
    const { gh, patches } = fakeGitHub({ comments: [summaryComment(summary([p1, p2]))], threads: [threadNode(p1, true), threadNode(p2, false)] });
    const result = await run(gh);
    expect(result).toEqual({ status: 'updated', score: 4, findings: 1 });
    expect(patches).toHaveLength(1);
    expect(patches[0]!.path).toBe('/repos/o/r/issues/comments/42');
    expect(patches[0]!.body).toBe(summary([p2]));
    expect(patches[0]!.body).toContain('**Confidence 4/5** — 1 P2 · parser edge cases');
    expect(patches[0]!.body).toContain(`<!-- cura:reviewed-sha=${HEAD} -->`);
  });

  test('an unresolve lowers the score and brings the link back', async () => {
    const { gh, patches } = fakeGitHub({ comments: [summaryComment(summary([p2]))], threads: [threadNode(p1, false), threadNode(p2, false)] });
    expect(await run(gh)).toEqual({ status: 'updated', score: 3, findings: 2 });
    expect(patches[0]!.body).toBe(summary([p1, p2]));
  });

  test('no summary comment is a no-op', async () => {
    const { gh, patches } = fakeGitHub({ comments: [{ id: 1, body: summary([p1]), user: { login: 'alice' } }], threads: [threadNode(p1, true)] });
    expect(await run(gh)).toEqual({ status: 'no-summary' });
    expect(patches).toEqual([]);
  });

  test('a failed review summary is left alone', async () => {
    const failed = renderFailure({ previousBody: summary([p1]), runUrl: 'https://run/2', headSha: HEAD });
    const { gh, patches } = fakeGitHub({ comments: [summaryComment(failed)], threads: [threadNode(p1, true)] });
    expect(await run(gh)).toEqual({ status: 'failed-review' });
    expect(patches).toEqual([]);
  });

  test('an unchanged score and link list is not edited', async () => {
    const { gh, patches } = fakeGitHub({ comments: [summaryComment(summary([p2]))], threads: [threadNode(p1, true), threadNode(p2, false)] });
    expect(await run(gh)).toEqual({ status: 'unchanged', score: 4, findings: 1 });
    expect(patches).toEqual([]);
  });
});
