export class GitHubError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

export interface GitHub {
  rest<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T>;
  paginate<T>(path: string): Promise<T[]>;
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

export interface GitHubOptions {
  token: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [1000, 2000, 4000];

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRetryable(res: Response): boolean {
  if (res.status >= 500 || res.status === 429) return true;
  return res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after'));
}

function retryDelay(res: Response, attempt: number): number {
  const retryAfter = Number(res.headers.get('retry-after'));
  if (res.headers.has('retry-after') && Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1000;
  return BACKOFF_MS[attempt - 1];
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function nextLink(res: Response): string | null {
  const header = res.headers.get('link');
  if (!header) return null;
  const match = /<([^>]+)>;\s*rel="next"/.exec(header);
  return match ? match[1] : null;
}

export function createGitHub(opts: GitHubOptions): GitHub {
  const apiUrl = (opts.apiUrl ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;

  async function request(method: string, url: string, body?: unknown): Promise<{ res: Response; data: unknown }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cura',
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    for (let attempt = 1; ; attempt++) {
      const res = await doFetch(url, init);
      if (res.ok) return { res, data: await readBody(res) };
      const data = await readBody(res);
      if (attempt >= MAX_ATTEMPTS || !isRetryable(res)) {
        throw new GitHubError(`GitHub ${method} ${url} failed with ${res.status}`, res.status, data);
      }
      await sleep(retryDelay(res, attempt));
    }
  }

  return {
    async rest<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
      const { data } = await request(method, `${apiUrl}${path}`, body);
      return data as T;
    },

    async paginate<T>(path: string): Promise<T[]> {
      const items: T[] = [];
      let url: string | null = `${apiUrl}${path}${path.includes('?') ? '&' : '?'}per_page=100`;
      while (url) {
        const { res, data }: { res: Response; data: unknown } = await request('GET', url);
        items.push(...(data as T[]));
        url = nextLink(res);
      }
      return items;
    },

    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      const { data } = await request('POST', `${apiUrl}/graphql`, { query, variables });
      const payload = data as { data?: T; errors?: unknown[] };
      if (Array.isArray(payload.errors) && payload.errors.length > 0) {
        throw new GitHubError('GitHub GraphQL request returned errors', 200, payload);
      }
      return payload.data as T;
    },
  };
}
