import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { gatherContext } from '../src/context.ts';
import type { GitHub } from '../src/github.ts';

const HEAD = 'h'.repeat(40);
const PREV = 'a'.repeat(40);
const BOT = 'github-actions[bot]';
const DIFF_FLAGS = ['--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'];

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,3 @@',
  ' one',
  '+two',
  ' three',
  '',
].join('\n');

const PREVIEW = {
  schema_version: 1,
  mode: 'range',
  from: 'origin/main',
  to: 'HEAD',
  merge_base: 'b'.repeat(40),
  total_files: 5,
  reviewable_count: 4,
  excluded_count: 1,
  reviewable_files: [
    { path: 'src/app.ts', status: 'modified', insertions: 1, deletions: 0 },
    { path: 'README.md', status: 'added', insertions: 10, deletions: 0 },
    { path: 'old/gone.py', status: 'deleted', insertions: 0, deletions: 7 },
    { path: 'dist/bundle.js', status: 'modified', insertions: 3, deletions: 3 },
  ],
  excluded_files: [{ path: 'pnpm-lock.yaml', status: 'modified', insertions: 50, deletions: 20, exclude_reason: 'lockfile' }],
};

const RULES = { schema_version: 1, groups: [{ group_id: 'g1', source: 'rules', pattern: 'src/**', files: ['src/app.ts'], rule: 'Be careful.' }] };

interface Setup {
  rules?: string | null;
  config?: string | null;
  ancestor?: boolean;
  preview?: typeof PREVIEW;
}

function fakeExec(setup: Setup = {}) {
  const exec = vi.fn((cmd: string, args: string[]): string => {
    const key = [cmd, ...args].join(' ');
    if (key === 'git log --format=%h %s origin/main..HEAD') return 'abc123 feat: thing\n';
    if (key === 'git show origin/main:.cura/rules.json') {
      if (setup.rules == null) throw new Error('fatal: path does not exist');
      return setup.rules;
    }
    if (key === 'git show origin/main:.cura/config.json') {
      if (setup.config == null) throw new Error('fatal: path does not exist');
      return setup.config;
    }
    if (cmd === 'ocr' && args[1] === 'preview') return JSON.stringify(setup.preview ?? PREVIEW);
    if (cmd === 'ocr' && args[1] === 'rule') return JSON.stringify(RULES);
    if (key === ['git', 'diff', ...DIFF_FLAGS, 'origin/main...HEAD'].join(' ')) return DIFF;
    if (key === ['git', 'diff', ...DIFF_FLAGS, PREV, 'HEAD'].join(' ')) return 'INCREMENTAL';
    if (key === `git merge-base --is-ancestor ${PREV} HEAD`) {
      if (!setup.ancestor) throw new Error('exit 1');
      return '';
    }
    throw new Error(`unexpected exec: ${key}`);
  });
  return exec;
}

const PR = {
  title: 'Add thing',
  body: 'Does the thing.',
  user: { login: 'alice' },
  labels: [{ name: 'bug' }, { name: 'ui' }],
  base: { ref: 'main', repo: { full_name: 'o/r' } },
  head: { sha: HEAD, repo: { full_name: 'o/r' } },
};

function fakeGitHub(opts: { pr?: unknown; comments?: unknown[] } = {}) {
  const rest = vi.fn(async (_method: string, _path: string) => opts.pr ?? PR);
  const paginate = vi.fn(async (_path: string) => opts.comments ?? []);
  const graphql = vi.fn(async () => ({
    repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
  }));
  return { gh: { rest, paginate, graphql } as unknown as GitHub, rest, paginate, graphql };
}

let root: string;
let ctxDir: string;
let workspace: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cura-context-'));
  ctxDir = join(root, 'ctx');
  workspace = join(root, 'ws');
  mkdirSync(workspace);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function run(exec: ReturnType<typeof fakeExec>, gh: GitHub) {
  return gatherContext({
    gh,
    exec,
    repo: { owner: 'o', name: 'r' },
    pr: 7,
    base: 'main',
    headSha: HEAD,
    ctxDir,
    workspace,
    rulesPath: '.cura/rules.json',
    configPath: '.cura/config.json',
    botLogin: BOT,
  });
}

const read = (name: string) => readFileSync(join(ctxDir, name), 'utf8');
const readJson = (name: string) => JSON.parse(read(name));
const summaryComment = (id: number, sha: string, login = 'github-actions[bot]') => ({
  id,
  user: { login },
  body: `<!-- cura:summary -->\n## Cura\n<!-- cura:reviewed-sha=${sha} -->`,
});

describe('gatherContext', () => {
  test('writes every context file in full mode when there is no summary', async () => {
    const exec = fakeExec({ rules: '{"rules":[]}', config: '{"ignore":["dist/**"]}' });
    const { gh, rest, paginate } = fakeGitHub();
    const result = await run(exec, gh);

    expect(result).toEqual({ mode: 'full', prevSha: null, summaryId: null, reviewableCount: 2 });
    expect(rest).toHaveBeenCalledWith('GET', '/repos/o/r/pulls/7');
    expect(paginate).toHaveBeenCalledWith('/repos/o/r/issues/7/comments');

    expect(readJson('pr.json')).toEqual({
      title: 'Add thing',
      body: 'Does the thing.',
      author: 'alice',
      labels: ['bug', 'ui'],
      baseRef: 'main',
      headSha: HEAD,
      isCrossRepository: false,
    });
    expect(read('commits.txt')).toBe('abc123 feat: thing\n');
    expect(read('rules.base.json')).toBe('{"rules":[]}');
    expect(readJson('config.json')).toEqual({ ignore: ['dist/**'] });
    expect(existsSync(join(ctxDir, 'config-errors.txt'))).toBe(false);
    expect(read('diff.patch')).toBe(DIFF);
    expect(readJson('hunks.json')).toEqual({ 'src/app.ts': [{ start: 1, end: 3 }] });
    expect(readJson('added-lines.json')).toEqual({ 'src/app.ts': [2] });
    expect(readJson('rules.json')).toEqual(RULES);
    expect(readJson('threads.json')).toEqual([]);
    expect(readJson('summary-comment.json')).toEqual({});
    expect(existsSync(join(ctxDir, 'incremental.diff'))).toBe(false);

    expect(readJson('facts.json')).toEqual([
      { path: 'src/app.ts', status: 'modified', language: 'typescript', added: 1, removed: 0, dir: 'src' },
      { path: 'README.md', status: 'added', language: 'markdown', added: 10, removed: 0, dir: 'root' },
      { path: 'old/gone.py', status: 'deleted', language: 'python', added: 0, removed: 7, dir: 'old' },
    ]);

    const rulesFlag = ['--rule', join(ctxDir, 'rules.base.json')];
    expect(exec).toHaveBeenCalledWith('ocr', ['delegate', 'preview', '--from', 'origin/main', '--to', 'HEAD', '-f', 'json', ...rulesFlag]);
    expect(exec).toHaveBeenCalledWith('ocr', ['delegate', 'rule', ...rulesFlag, '-f', 'json', 'src/app.ts', 'README.md']);
  });

  test('config ignore moves matching files from reviewable to excluded in preview.json', async () => {
    const { gh } = fakeGitHub();
    await run(fakeExec({ config: '{"ignore":["dist/**"]}' }), gh);
    const preview = readJson('preview.json');
    expect(preview.reviewable_files.map((f: { path: string }) => f.path)).toEqual(['src/app.ts', 'README.md', 'old/gone.py']);
    expect(preview.excluded_files).toContainEqual({
      path: 'dist/bundle.js',
      status: 'modified',
      insertions: 3,
      deletions: 3,
      exclude_reason: 'cura_ignore',
    });
    expect(preview.excluded_files).toHaveLength(2);
    expect(preview.reviewable_count).toBe(3);
    expect(preview.excluded_count).toBe(2);
  });

  test('missing rules file → no --rule flag and no rules.base.json', async () => {
    const exec = fakeExec();
    const { gh } = fakeGitHub();
    const result = await run(exec, gh);
    expect(existsSync(join(ctxDir, 'rules.base.json'))).toBe(false);
    expect(exec).toHaveBeenCalledWith('ocr', ['delegate', 'preview', '--from', 'origin/main', '--to', 'HEAD', '-f', 'json']);
    expect(exec).toHaveBeenCalledWith('ocr', ['delegate', 'rule', '-f', 'json', 'src/app.ts', 'README.md', 'dist/bundle.js']);
    expect(readJson('config.json')).toEqual({});
    expect(result.reviewableCount).toBe(3);
  });

  test('invalid config falls back to {} and writes config-errors.txt', async () => {
    const { gh } = fakeGitHub();
    await run(fakeExec({ config: '{not json' }), gh);
    expect(readJson('config.json')).toEqual({});
    expect(read('config-errors.txt')).toMatch(/^config\.parse: /);
  });

  test('skips ocr rule when no non-deleted reviewable files remain', async () => {
    const exec = fakeExec({
      preview: { ...PREVIEW, reviewable_files: [{ path: 'old/gone.py', status: 'deleted', insertions: 0, deletions: 7 }] },
    });
    const { gh } = fakeGitHub();
    const result = await run(exec, gh);
    expect(result.reviewableCount).toBe(0);
    expect(exec.mock.calls.some(([cmd, args]) => cmd === 'ocr' && args[1] === 'rule')).toBe(false);
    expect(existsSync(join(ctxDir, 'rules.json'))).toBe(false);
  });

  test('incremental when the previous reviewed SHA is an ancestor of HEAD', async () => {
    const { gh } = fakeGitHub({
      comments: [
        summaryComment(10, 'c'.repeat(40)),
        { id: 11, user: { login: 'alice' }, body: `<!-- cura:summary --> <!-- cura:reviewed-sha=${'d'.repeat(40)} -->` },
        summaryComment(12, PREV, 'github-actions'),
        { id: 13, user: { login: 'github-actions[bot]' }, body: 'unrelated bot comment' },
      ],
    });
    const result = await run(fakeExec({ ancestor: true }), gh);
    expect(result).toEqual({ mode: 'incremental', prevSha: PREV, summaryId: 12, reviewableCount: 3 });
    expect(readJson('summary-comment.json')).toEqual({ id: 12, body: summaryComment(12, PREV).body });
    expect(read('incremental.diff')).toBe('INCREMENTAL');
  });

  test('full when merge-base --is-ancestor exits non-zero', async () => {
    const { gh } = fakeGitHub({ comments: [summaryComment(12, PREV)] });
    const result = await run(fakeExec({ ancestor: false }), gh);
    expect(result).toEqual({ mode: 'full', prevSha: PREV, summaryId: 12, reviewableCount: 3 });
    expect(existsSync(join(ctxDir, 'incremental.diff'))).toBe(false);
  });

  test('full when the previous reviewed SHA is HEAD itself', async () => {
    const exec = fakeExec({ ancestor: true });
    const { gh } = fakeGitHub({ comments: [summaryComment(12, HEAD)] });
    const result = await run(exec, gh);
    expect(result.mode).toBe('full');
    expect(exec.mock.calls.some(([, args]) => args[0] === 'merge-base')).toBe(false);
  });

  test('isCrossRepository is true when head and base repos differ', async () => {
    const { gh } = fakeGitHub({ pr: { ...PR, head: { sha: HEAD, repo: { full_name: 'fork/r' } } } });
    await run(fakeExec(), gh);
    expect(readJson('pr.json').isCrossRepository).toBe(true);
  });

  test('copies existing guidance files, truncated to 64 KiB', async () => {
    writeFileSync(join(workspace, 'AGENTS.md'), 'x'.repeat(70 * 1024));
    writeFileSync(join(workspace, 'CONTRIBUTING.md'), 'contrib');
    writeFileSync(join(workspace, 'README.rst'), 'readme');
    writeFileSync(join(workspace, 'NOTES.md'), 'not guidance');
    mkdirSync(join(workspace, 'README.d'));
    mkdirSync(join(workspace, '.github'));
    writeFileSync(join(workspace, '.github', 'copilot-instructions.md'), 'copilot');
    const { gh } = fakeGitHub();
    await run(fakeExec(), gh);
    const guidance = join(ctxDir, 'guidance');
    expect(readFileSync(join(guidance, 'AGENTS.md')).length).toBe(64 * 1024);
    expect(read('guidance/CONTRIBUTING.md')).toBe('contrib');
    expect(read('guidance/README.rst')).toBe('readme');
    expect(read('guidance/copilot-instructions.md')).toBe('copilot');
    expect(existsSync(join(guidance, 'NOTES.md'))).toBe(false);
    expect(existsSync(join(guidance, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(guidance, 'README.d'))).toBe(false);
  });
  test('never copies symlinked guidance files or a symlinked .github dir', async () => {
    const secrets = join(root, 'secrets');
    mkdirSync(secrets);
    writeFileSync(join(secrets, 'config'), 'token=secret');
    writeFileSync(join(secrets, 'copilot-instructions.md'), 'secret');
    symlinkSync(join(secrets, 'config'), join(workspace, 'AGENTS.md'));
    symlinkSync(join(secrets, 'config'), join(workspace, 'README.md'));
    symlinkSync(secrets, join(workspace, '.github'));
    writeFileSync(join(workspace, 'CLAUDE.md'), 'real');
    const { gh } = fakeGitHub();
    await run(fakeExec(), gh);
    const guidance = join(ctxDir, 'guidance');
    expect(read('guidance/CLAUDE.md')).toBe('real');
    expect(existsSync(join(guidance, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(guidance, 'README.md'))).toBe(false);
    expect(existsSync(join(guidance, 'copilot-instructions.md'))).toBe(false);
  });

  test('invalid ocr JSON fails with an error naming the command', async () => {
    const exec = fakeExec();
    const base = exec.getMockImplementation()!;
    exec.mockImplementation((cmd, args) => (cmd === 'ocr' && args[1] === 'preview' ? 'oops' : base(cmd, args)));
    const { gh } = fakeGitHub();
    await expect(run(exec, gh)).rejects.toThrow(/^ocr delegate preview returned invalid JSON/);
  });
});
