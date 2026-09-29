import { describe, expect, test, vi } from 'vitest';
import { createGitHub, GitHubError } from '../src/github.ts';

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

function fakeFetch(replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected fetch');
    const text = reply.body === undefined ? null : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status, headers: reply.headers });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function setup(replies: Reply[]) {
  const { fetch, calls } = fakeFetch(replies);
  const sleep = vi.fn(async (_ms: number) => {});
  const gh = createGitHub({ token: 't0k', apiUrl: 'https://api.test', fetch, sleep });
  return { gh, calls, sleep };
}

describe('rest', () => {
  test('sends auth and JSON headers and parses the response', async () => {
    const { gh, calls } = setup([{ status: 201, body: { id: 7 } }]);
    const result = await gh.rest<{ id: number }>('POST', '/repos/o/r/issues', { title: 'x' });
    expect(result).toEqual({ id: 7 });
    expect(calls[0].url).toBe('https://api.test/repos/o/r/issues');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe('{"title":"x"}');
    expect(calls[0].init.headers).toMatchObject({
      Authorization: 'Bearer t0k',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cura',
      'Content-Type': 'application/json',
    });
  });

  test('omits Content-Type without a body and returns undefined for 204', async () => {
    const { gh, calls } = setup([{ status: 204 }]);
    expect(await gh.rest('PATCH', '/x')).toBeUndefined();
    expect(calls[0].init.headers).not.toHaveProperty('Content-Type');
  });

  test('retries 502 then succeeds', async () => {
    const { gh, sleep } = setup([{ status: 502 }, { status: 200, body: { ok: true } }]);
    expect(await gh.rest('GET', '/x')).toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  test('gives up after 4 attempts with 1s, 2s, 4s backoff', async () => {
    const { gh, calls, sleep } = setup([
      { status: 500, body: { m: 1 } },
      { status: 500, body: { m: 2 } },
      { status: 500, body: { m: 3 } },
      { status: 503, body: { m: 4 } },
    ]);
    const err = await gh.rest('GET', '/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err).toMatchObject({ status: 503, body: { m: 4 } });
    expect(calls).toHaveLength(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000]);
  });

  test('honours retry-after over the backoff schedule', async () => {
    const { gh, sleep } = setup([{ status: 429, headers: { 'retry-after': '3' } }, { status: 200, body: {} }]);
    await gh.rest('GET', '/x');
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  test('retries 403 when the rate limit is exhausted', async () => {
    const { gh, sleep } = setup([
      { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
      { status: 200, body: { ok: 1 } },
    ]);
    expect(await gh.rest('GET', '/x')).toEqual({ ok: 1 });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  test('plain 403 throws without retry', async () => {
    const { gh, calls } = setup([{ status: 403, body: { message: 'nope' } }]);
    await expect(gh.rest('GET', '/x')).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(1);
  });

  test('422 throws immediately with the body', async () => {
    const { gh, calls, sleep } = setup([{ status: 422, body: { message: 'Validation Failed' } }]);
    const err = await gh.rest('POST', '/x', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err).toMatchObject({ status: 422, body: { message: 'Validation Failed' } });
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('paginate', () => {
  test('follows Link rel="next" and concatenates pages', async () => {
    const { gh, calls } = setup([
      {
        status: 200,
        body: [1, 2],
        headers: { link: '<https://api.test/x?per_page=100&page=2>; rel="next", <https://api.test/x?per_page=100&page=2>; rel="last"' },
      },
      { status: 200, body: [3] },
    ]);
    expect(await gh.paginate<number>('/x')).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.url)).toEqual(['https://api.test/x?per_page=100', 'https://api.test/x?per_page=100&page=2']);
  });

  test('appends per_page with & when the path has a query', async () => {
    const { gh, calls } = setup([{ status: 200, body: [] }]);
    await gh.paginate('/x?state=open');
    expect(calls[0].url).toBe('https://api.test/x?state=open&per_page=100');
  });
});

describe('graphql', () => {
  test('posts query and variables and returns data', async () => {
    const { gh, calls } = setup([{ status: 200, body: { data: { viewer: { login: 'me' } } } }]);
    expect(await gh.graphql('query { viewer { login } }', { a: 1 })).toEqual({ viewer: { login: 'me' } });
    expect(calls[0].url).toBe('https://api.test/graphql');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ query: 'query { viewer { login } }', variables: { a: 1 } });
  });

  test('errors array throws GitHubError with status 200', async () => {
    const errors = [{ message: 'Could not resolve' }];
    const { gh } = setup([{ status: 200, body: { data: null, errors } }]);
    const err = await gh.graphql('q', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err).toMatchObject({ status: 200, body: { errors } });
  });
});
