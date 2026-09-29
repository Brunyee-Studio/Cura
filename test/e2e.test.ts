import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { main, type Deps } from '../src/cli.ts';
import type { GitHub } from '../src/github.ts';
import { matchGlob } from '../src/plan.ts';
import type { FileFact, Finding, Review, Thread } from '../src/types.ts';
import { makeIo } from './io.ts';

// End-to-end dry run: a real git repo and the real CLI steps (context → check → publish);
// only `ocr` and GitHub are faked.

const BOT = 'github-actions[bot]';
// Keeps the user's global/system git config (hooks, signing, diff settings) out of the run.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

interface FakeComment {
  databaseId: number;
  url: string;
  body: string;
  author: { login: string };
}

interface FakeThread {
  id: string;
  path: string;
  line: number;
  isResolved: boolean;
  comments: FakeComment[];
}

/**
 * Stateful fake GitHub for PR o/r#7: a posted review creates one review thread per comment
 * (authored by the bot, so the next run's thread fetch sees them as Cura threads), replies and
 * resolves mutate those threads, and issue comments are created and PATCHed in place.
 */
function fakeGitHub(headSha: string) {
  const calls: Call[] = [];
  const threads: FakeThread[] = [];
  const issueComments: { id: number; body: string; user: { login: string } }[] = [];
  let nextId = 100;
  const pull = {
    title: 'Double n10',
    body: 'Changes calc, adds new, removes old.',
    user: { login: 'alice' },
    labels: [],
    base: { ref: 'main', repo: { full_name: 'o/r' } },
    head: { sha: headSha, repo: { full_name: 'o/r' } },
  };

  const gh: GitHub = {
    async rest<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      const payload = body as { body: string; comments?: { path: string; line: number; body: string }[] };
      if (method === 'GET' && path === '/repos/o/r/pulls/7') return pull as T;

      if (method === 'POST' && path === '/repos/o/r/pulls/7/reviews') {
        const reviewId = nextId++;
        for (const c of payload.comments ?? []) {
          const id = nextId++;
          const url = `https://github.com/o/r/pull/7#discussion_r${id}`;
          threads.push({ id: `PRRT_${id}`, path: c.path, line: c.line, isResolved: false, comments: [{ databaseId: id, url, body: c.body, author: { login: BOT } }] });
        }
        return { id: reviewId, html_url: `https://github.com/o/r/pull/7#pullrequestreview-${reviewId}` } as T;
      }

      const reply = /^\/repos\/o\/r\/pulls\/7\/comments\/(\d+)\/replies$/.exec(path);
      if (method === 'POST' && reply) {
        const thread = threads.find((t) => t.comments[0].databaseId === Number(reply[1]));
        if (!thread) throw new Error(`reply to unknown comment ${reply[1]}`);
        const id = nextId++;
        thread.comments.push({ databaseId: id, url: `https://github.com/o/r/pull/7#discussion_r${id}`, body: payload.body, author: { login: BOT } });
        return { id } as T;
      }

      if (method === 'POST' && path === '/repos/o/r/issues/7/comments') {
        const id = nextId++;
        issueComments.push({ id, body: payload.body, user: { login: BOT } });
        return { id, html_url: `https://github.com/o/r/pull/7#issuecomment-${id}` } as T;
      }

      const patch = /^\/repos\/o\/r\/issues\/comments\/(\d+)$/.exec(path);
      if (method === 'PATCH' && patch) {
        const comment = issueComments.find((c) => c.id === Number(patch[1]));
        if (!comment) throw new Error(`PATCH of unknown issue comment ${patch[1]}`);
        comment.body = payload.body;
        return { id: comment.id, html_url: `https://github.com/o/r/pull/7#issuecomment-${comment.id}` } as T;
      }

      throw new Error(`unexpected REST call: ${method} ${path}`);
    },

    async paginate<T>(path: string): Promise<T[]> {
      calls.push({ method: 'PAGINATE', path });
      if (path === '/repos/o/r/issues/7/comments') return issueComments.map((c) => ({ ...c })) as T[];
      throw new Error(`unexpected paginate: ${path}`);
    },

    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      if (query.includes('resolveReviewThread')) {
        calls.push({ method: 'GRAPHQL', path: 'resolveReviewThread', body: variables });
        const thread = threads.find((t) => t.id === variables.threadId);
        if (!thread) throw new Error(`resolve of unknown thread ${String(variables.threadId)}`);
        thread.isResolved = true;
        return { resolveReviewThread: { thread: { id: thread.id } } } as T;
      }
      calls.push({ method: 'GRAPHQL', path: 'reviewThreads', body: variables });
      const nodes = threads.map((t) => ({
        ...t,
        isOutdated: false,
        originalLine: t.line,
        subjectType: 'LINE',
        comments: { nodes: t.comments.map((c) => ({ ...c })) },
      }));
      return { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } as T;
    },
  };
  return { gh, calls, issueComments };
}

const lines = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => `${line(i + 1)}\n`).join('');
const BASE_CALC = lines(20, (i) => `export const n${i} = ${i};`);
// Only line 10 changes, so git's 3-line context puts the RIGHT-side hunk at 7–13.
const HEAD_CALC = BASE_CALC.replace('export const n10 = 10;', 'export const n10 = 10 * 2;');
const NEW_FILE = lines(3, (i) => `export const added${i} = ${i};`);
const OLD_FILE = lines(4, (i) => `export const old${i} = ${i};`);
// The PR tries to exclude every file from review through ocr's project rules.
const HEAD_OCR_RULES = '{"exclude":["**"]}\n';

let root: string;
let repo: string;
let ctx: string;
let outputFile: string;
let stepSummaryFile: string;
let headSha: string;
const ocrCalls: { args: string[]; cwd: string; projectRules: string | null }[] = [];

function git(...args: string[]): string {
  const identity = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
  return execFileSync('git', [...identity, ...args], { cwd: repo, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(path: string, content: string): void {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), content);
}

const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });

const STATUS: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted' };

/**
 * `ocr` stand-in with ocr's real behaviour and output shapes: it diffs the range in its cwd, applies the
 * `exclude` of the project rules it finds at `<cwd>/.opencodereview/rule.json`, and lists deleted files
 * under `excluded_files` with exclude_reason "deleted".
 */
function fakeOcr(args: string[], cwd: string): string {
  const rulesFile = join(cwd, '.opencodereview', 'rule.json');
  const projectRules = existsSync(rulesFile) ? readFileSync(rulesFile, 'utf8') : null;
  ocrCalls.push({ args, cwd, projectRules });
  const exclude: string[] = projectRules === null ? [] : ((JSON.parse(projectRules) as { exclude?: string[] }).exclude ?? []);

  if (args[0] === 'delegate' && args[1] === 'preview') {
    const range = [args[args.indexOf('--from') + 1]!, args[args.indexOf('--to') + 1]!].join('...');
    const numstat = new Map(
      gitIn(cwd, 'diff', '--no-renames', '--numstat', range).trim().split('\n').map((l) => {
        const [added, removed, path] = l.split('\t');
        return [path!, { insertions: Number(added), deletions: Number(removed) }];
      }),
    );
    const reviewable: unknown[] = [];
    const excluded: unknown[] = [];
    for (const line of gitIn(cwd, 'diff', '--no-renames', '--name-status', range).trim().split('\n')) {
      const [code, path] = line.split('\t') as [string, string];
      const file = { path, status: STATUS[code], ...numstat.get(path)! };
      if (exclude.some((pattern) => matchGlob(pattern, path))) excluded.push({ ...file, exclude_reason: 'user_exclude' });
      else if (code === 'D') excluded.push({ ...file, exclude_reason: 'deleted' });
      else reviewable.push(file);
    }
    return JSON.stringify({ reviewable_count: reviewable.length, excluded_count: excluded.length, reviewable_files: reviewable, excluded_files: excluded });
  }
  if (args[0] === 'delegate' && args[1] === 'rule') {
    const files = args.slice(args.indexOf('json') + 1);
    return JSON.stringify({ groups: [{ group_id: 1, source: 'system', pattern: '**', files, rule: 'Keep exported constants stable.' }] });
  }
  throw new Error(`unexpected ocr call: ${args.join(' ')}`);
}

const exec: Deps['exec'] = (cmd, args, cwd) => {
  // ocr runs in the base-rules worktree Cura creates under the ctx dir; git in the PR checkout.
  expect(cwd).toBe(cmd === 'ocr' ? join(ctx, 'ocr-worktree') : repo);
  if (cmd === 'git') return gitIn(cwd, ...args);
  if (cmd === 'ocr') return fakeOcr(args, cwd);
  throw new Error(`unexpected exec: ${cmd}`);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cura-e2e-'));
  repo = join(root, 'repo');
  ctx = join(root, 'ctx');
  outputFile = join(root, 'output');
  stepSummaryFile = join(root, 'step-summary');
  mkdirSync(repo);

  git('init', '-q', '-b', 'main');
  write('src/calc.ts', BASE_CALC);
  write('src/old.ts', OLD_FILE);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));

  git('switch', '-q', '-c', 'feature');
  write('src/calc.ts', HEAD_CALC);
  write('src/new.ts', NEW_FILE);
  write('.opencodereview/rule.json', HEAD_OCR_RULES);
  unlinkSync(join(repo, 'src/old.ts'));
  git('add', '-A');
  git('commit', '-q', '-m', 'double n10');
  headSha = git('rev-parse', 'HEAD');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function env(over: Record<string, string> = {}): Record<string, string> {
  return {
    CURA_CTX: ctx,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: stepSummaryFile,
    GITHUB_WORKSPACE: repo,
    GITHUB_TOKEN: 't',
    GITHUB_REPOSITORY: 'o/r',
    CURA_PR: '7',
    CURA_BASE: 'main',
    CURA_HEAD_SHA: headSha,
    RUN_URL: 'https://github.com/o/r/actions/runs/1',
    CURA_VERSION: 'v1.0.0',
    ...over,
  };
}

/** Runs one CLI step with fresh step-output files; returns its stdout, exit code and outputs. */
async function step(argv: string[], deps: Partial<Deps>, over: Record<string, string> = {}, stdin = '') {
  writeFileSync(outputFile, '');
  writeFileSync(stepSummaryFile, '');
  const { io, text, code } = makeIo(stdin);
  await main(argv, env(over), io, deps);
  const outputs = Object.fromEntries(
    readFileSync(outputFile, 'utf8').split('\n').filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { text: text(), code: code(), outputs };
}

const readCtx = <T>(name: string): T => JSON.parse(readFileSync(join(ctx, name), 'utf8')) as T;

const IN_HUNK: Finding = {
  status: 'new',
  severity: 'P1',
  category: 'correctness',
  path: 'src/calc.ts',
  line: 10,
  title: 'n10 no longer equals 10',
  body: 'BODY-ONE: callers index a table by n10, so doubling it reads past the end.',
  suggestion: 'export const n10 = 10;',
};

// Two lines past the hunk end (13): outside every hunk, yet five lines from the added line 10,
// the farthest a finding may snap (SNAP_DISTANCE). Git's 3-line context means any line outside a
// hunk is ≥4 from an added line, so "3 lines outside" could never snap; 2 outside is the boundary.
const NEAR_HUNK: Finding = {
  status: 'new',
  severity: 'P2',
  category: 'convention',
  path: 'src/calc.ts',
  line: 15,
  title: 'Constants should be derived',
  body: 'BODY-TWO: derive n15 from n10 so the table stays consistent.',
  suggestion: 'export const n15 = n10 + 5;',
};

function review(over: Partial<Review>): Review {
  return {
    summary: 'Doubles n10, adds new constants and removes the old module.',
    risk_note: '',
    scopes: [{ name: 'src', files: ['.opencodereview/rule.json', 'src/calc.ts', 'src/new.ts'], reviewer_notes: 'Checked every n10 caller.' }],
    files: [
      { path: '.opencodereview/rule.json', overview: 'Tries to exclude everything from review.' },
      { path: 'src/calc.ts', overview: 'n10 doubled.' },
      { path: 'src/new.ts', overview: 'New constants.' },
      { path: 'src/old.ts', overview: 'Removed.' },
    ],
    diagram: '',
    findings: [],
    resolved: [],
    dismissed: [],
    discarded: [],
    ...over,
  };
}

const FINDING_BODIES = [IN_HUNK.body, NEAR_HUNK.body];

describe('end-to-end dry run', () => {
  let github: ReturnType<typeof fakeGitHub>;
  let summaryId: number;

  beforeAll(() => {
    github = fakeGitHub(headSha);
  });

  test('run 1: context → check → publish posts one review with an exact and a snapped comment', async () => {
    const deps: Partial<Deps> = { createGitHub: () => github.gh, exec };

    const context = await step(['context'], deps);
    expect(context.code).toBe(0);
    expect(context.outputs).toMatchObject({ mode: 'full', prev_sha: '', summary_id: '', reviewable_count: '3', cross_repo: 'false', skip_agent: 'false' });
    expect(readCtx('hunks.json')).toEqual({
      '.opencodereview/rule.json': [{ start: 1, end: 1 }],
      'src/calc.ts': [{ start: 7, end: 13 }],
      'src/new.ts': [{ start: 1, end: 3 }],
    });
    expect(readCtx<FileFact[]>('facts.json').map((f) => [f.path, f.status])).toEqual([
      ['.opencodereview/rule.json', 'added'],
      ['src/calc.ts', 'modified'],
      ['src/new.ts', 'added'],
      ['src/old.ts', 'deleted'],
    ]);
    // The head's `{"exclude":["**"]}` never reached ocr: it ran in a worktree without the base-absent rule file.
    expect(ocrCalls.map((c) => c.projectRules)).toEqual([null, null]);
    expect(ocrCalls.find((c) => c.args[1] === 'rule')?.args.slice(-3)).toEqual(['.opencodereview/rule.json', 'src/calc.ts', 'src/new.ts']);
    expect(existsSync(join(ctx, 'ocr-worktree'))).toBe(false);
    expect(git('worktree', 'list').split('\n')).toHaveLength(1);
    expect(readFileSync(join(ctx, 'commits.txt'), 'utf8')).toContain('double n10');

    const draft = JSON.stringify(review({ findings: [IN_HUNK, NEAR_HUNK] }));
    const check = await step(['check', '--ctx', ctx], {}, {}, draft);
    expect(check.code).toBe(1);
    expect(check.text).toBe('anchor.line /findings/1/line: src/calc.ts:15 is not inside a diff hunk');

    const mark = github.calls.length;
    const publish = await step(['publish'], deps, { REVIEW: draft, AGENT_OUTCOME: 'success' });
    expect(publish.code).toBe(0);
    expect(publish.outputs).toMatchObject({ score: '3', findings: '2' });

    const calls = github.calls.slice(mark);
    const reviews = calls.filter((c) => c.method === 'POST' && c.path === '/repos/o/r/pulls/7/reviews');
    expect(reviews).toHaveLength(1);
    const { commit_id, comments } = reviews[0].body as { commit_id: string; comments: { path: string; line: number; side: string; body: string }[] };
    expect(commit_id).toBe(headSha);
    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({ path: 'src/calc.ts', line: 10, side: 'RIGHT' });
    expect(comments[0].body).toContain('```suggestion\nexport const n10 = 10;\n```');
    expect(comments[1]).toMatchObject({ path: 'src/calc.ts', line: 10, side: 'RIGHT' });
    expect(comments[1].body).toContain(NEAR_HUNK.body);
    expect(comments[1].body).not.toContain('```suggestion');
    expect(calls.some((c) => c.method === 'POST' && c.path === '/repos/o/r/pulls/7/comments')).toBe(false);

    const created = calls.filter((c) => c.method === 'POST' && c.path === '/repos/o/r/issues/7/comments');
    expect(created).toHaveLength(1);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    const summary = (created[0].body as { body: string }).body;
    expect(summary).toContain('**Confidence 3/5** — 1 P1 · 1 P2');
    expect(summary).toContain(`<!-- cura:reviewed-sha=${headSha} -->`);
    for (const body of FINDING_BODIES) expect(summary).not.toContain(body);
    summaryId = github.issueComments[0].id;
  });

  test('run 2: same head keeps the P2, resolves the P1 and PATCHes the summary to 4/5', async () => {
    const deps: Partial<Deps> = { createGitHub: () => github.gh, exec };

    const context = await step(['context'], deps);
    expect(context.code).toBe(0);
    expect(context.outputs).toMatchObject({ mode: 'full', prev_sha: headSha, summary_id: String(summaryId), reviewable_count: '3' });

    // Thread ids come from what context wrote, as the lead agent would read them.
    const threads = readCtx<Thread[]>('threads.json');
    expect(threads.map((t) => [t.path, t.line, t.meta.severity])).toEqual([
      ['src/calc.ts', 10, 'P1'],
      ['src/calc.ts', 10, 'P2'],
    ]);
    const [p1Thread, p2Thread] = threads;

    const draft = JSON.stringify(
      review({
        findings: [{ ...NEAR_HUNK, status: 'existing', thread_id: p2Thread.id }],
        resolved: [{ thread_id: p1Thread.id, note: 'n10 is back to 10.' }],
      }),
    );
    const check = await step(['check', '--ctx', ctx], {}, {}, draft);
    expect(check.text).toBe('OK');
    expect(check.code).toBe(0);

    // This run's review arrives the way the action delivers it: in claude-code-action's execution file.
    const executionFile = join(root, 'claude-execution-output.json');
    writeFileSync(executionFile, JSON.stringify([{ type: 'result', subtype: 'success', is_error: false, structured_output: JSON.parse(draft) }]));
    const mark = github.calls.length;
    const publish = await step(['publish'], deps, { CURA_EXECUTION_FILE: executionFile, AGENT_OUTCOME: 'success' });
    expect(publish.code).toBe(0);
    expect(publish.outputs).toMatchObject({ score: '4', findings: '1' });

    const calls = github.calls.slice(mark);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/repos/o/r/pulls/7/reviews')).toBe(false);
    expect(calls.some((c) => c.method === 'PATCH' && c.path.startsWith('/repos/o/r/pulls/'))).toBe(false);

    const replies = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/replies'));
    expect(replies).toEqual([
      { method: 'POST', path: `/repos/o/r/pulls/7/comments/${p1Thread.commentId}/replies`, body: { body: `Resolved in \`${headSha.slice(0, 7)}\`: n10 is back to 10.` } },
    ]);
    expect(calls.filter((c) => c.path === 'resolveReviewThread')).toEqual([{ method: 'GRAPHQL', path: 'resolveReviewThread', body: { threadId: p1Thread.id } }]);

    expect(calls.some((c) => c.method === 'POST' && c.path === '/repos/o/r/issues/7/comments')).toBe(false);
    const patched = calls.filter((c) => c.method === 'PATCH' && c.path === `/repos/o/r/issues/comments/${summaryId}`);
    expect(patched).toHaveLength(1);
    const summary = (patched[0].body as { body: string }).body;
    expect(summary).toContain('**Confidence 4/5** — 1 P2');
    expect(summary).toContain('### Resolved since last review');
    for (const body of FINDING_BODIES) expect(summary).not.toContain(body);
    expect(github.issueComments).toHaveLength(1);
  });
});
