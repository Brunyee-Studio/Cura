import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runBlocks } from './yaml-lines.ts';

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const review = read('.github/workflows/review.yml');
const example = read('examples/cura.yml');
const action = read('action.yml');

// The composite-action alternative in the example, uncommented.
const exampleAlternative = example
  .split('\n')
  .slice(example.split('\n').indexOf('#   review:'))
  .map((line) => line.replace(/^# ?/, ''));

const WORKFLOWS = ['.github/workflows/review.yml', '.github/workflows/cura.yml', '.github/workflows/release.yml', 'examples/cura.yml'];

/** name → default (quotes stripped) of the map entries indented `indent` spaces under the `header` line. */
function inputDefaults(text: string, header: string, indent: number): Map<string, string> {
  const lines = text.split('\n');
  const start = lines.indexOf(header);
  expect(start, header).toBeGreaterThanOrEqual(0);
  const headerIndent = header.length - header.trimStart().length;
  const defaults = new Map<string, string>();
  let current: string | undefined;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.length - line.trimStart().length <= headerIndent) break;
    const key = new RegExp(`^ {${indent}}([a-z_]+):`).exec(line)?.[1];
    if (key) {
      current = key;
      defaults.set(key, '');
      continue;
    }
    const value = new RegExp(`^ {${indent + 2}}default: (.*)$`).exec(line)?.[1];
    if (current && value !== undefined) defaults.set(current, value.replace(/^'(.*)'$/, '$1'));
  }
  return defaults;
}

const reviewInputs = inputDefaults(review, '    inputs:', 6);

/** A job's lines under `jobs:`, from its `  name:` key to the next job or the end. */
function job(lines: string[], name: string): string {
  const start = lines.indexOf(`  ${name}:`);
  expect(start, `job ${name}`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, i) => i > start && /^ {0,2}\S/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

describe('workflows', () => {
  test.each(WORKFLOWS)('%s: run scripts take no ${{ }} expressions', (path) => {
    const lines = read(path).split('\n');
    for (const body of runBlocks(lines)) {
      for (const line of body) expect(line).not.toContain('${{');
    }
    expect(read(path)).not.toMatch(/^\s*(?:- )?run: [^|\n]*\$\{\{/m);
  });

  test("the example's composite alternative takes no ${{ }} in run scripts and uses the action by tag", () => {
    const blocks = runBlocks(exampleAlternative);
    expect(blocks).toHaveLength(1);
    for (const line of blocks[0]!) expect(line).not.toContain('${{');
    expect(exampleAlternative).toContain('      - uses: Brunyee-Studio/cura@v1');
    expect(exampleAlternative.join('\n')).toContain('persist-credentials: false');
  });

  test.each(WORKFLOWS)('%s: third-party actions are pinned by commit SHA', (path) => {
    const uses = [...read(path).matchAll(/^[\s#]*(?:- )?uses: (\S+)/gm)].map((m) => m[1]!);
    for (const ref of uses) {
      if (ref === './' || ref.startsWith('Brunyee-Studio/cura')) continue;
      expect(ref).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  test.each(['.github/workflows/review.yml', '.github/workflows/cura.yml'])('%s: checks out the PR head for the action', (path) => {
    const text = read(path);
    expect(text).toContain('ref: ${{ steps.pr.outputs.head_sha }}');
    expect(text).toContain('fetch-depth: 0');
    expect(text).toContain('persist-credentials: false');
    expect(text).toContain("startsWith(github.event.comment.body, '/cura')");
    expect(text).toContain('group: cura-${{ github.event.pull_request.number || github.event.issue.number }}');
    expect(text).toContain('content=eyes');
  });

  test('the dogfood workflow runs the action from the checkout', () => {
    expect(read('.github/workflows/cura.yml')).toMatch(/^ {8}uses: \.\/$/m);
  });

  test('the example calls the reusable workflow at v1 with the token secret', () => {
    expect(example).toContain('uses: Brunyee-Studio/cura/.github/workflows/review.yml@v1');
    expect(example).toContain('claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}');
  });

  test('the example lists every reusable-workflow input with its default', () => {
    const listed = new Map(
      [...example.matchAll(/^ {4}# {3}([a-z_]+): (.*)$/gm)].map((m) => [m[1]!, m[2]!.replace(/^'(.*)'$/, '$1')]),
    );
    expect(listed).toEqual(reviewInputs);
  });
});

// https://docs.github.com/actions/reference/events-that-trigger-workflows: a webhook-only event
// (e.g. pull_request_review_thread) makes the whole workflow file invalid.
const ACTIONS_EVENTS = new Set([
  'branch_protection_rule', 'check_run', 'check_suite', 'create', 'delete', 'deployment', 'deployment_status', 'discussion',
  'discussion_comment', 'fork', 'gollum', 'issue_comment', 'issues', 'label', 'merge_group', 'milestone', 'page_build', 'public',
  'pull_request', 'pull_request_review', 'pull_request_review_comment', 'pull_request_target', 'push', 'registry_package',
  'release', 'repository_dispatch', 'schedule', 'status', 'watch', 'workflow_call', 'workflow_dispatch', 'workflow_run',
]);

describe('triggers', () => {
  test.each(WORKFLOWS)('%s: every `on:` event is a GitHub Actions event', (path) => {
    const lines = read(path).split('\n');
    const start = lines.indexOf('on:');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, i) => i > start && /^\S/.test(line));
    const events = lines.slice(start + 1, end).flatMap((line) => /^ {2}([a-z_]+):/.exec(line)?.[1] ?? []);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(ACTIONS_EVENTS, event).toContain(event);
  });
});

describe('rescore', () => {
  test.each(['examples/cura.yml', '.github/workflows/cura.yml'])('%s: triggers on PR close and on a submitted review', (path) => {
    expect(read(path)).toMatch(/^ {2}pull_request:\n(?: {4}#.*\n)* {4}types: \[opened, reopened, ready_for_review, synchronize, edited, closed\]$/m);
    expect(read(path)).toMatch(/^ {2}pull_request_review:\n {4}types: \[submitted\]$/m);
  });

  const reviewJobs: [string, string][] = [
    ['review.yml', job(review.split('\n'), 'review')],
    ['cura.yml', job(read('.github/workflows/cura.yml').split('\n'), 'review')],
    ["the example's composite alternative", job(exampleAlternative, 'review')],
  ];
  const rescoreJobs: [string, string][] = [
    ['review.yml', job(review.split('\n'), 'rescore')],
    ['cura.yml', job(read('.github/workflows/cura.yml').split('\n'), 'rescore')],
    ["the example's composite alternative", job(exampleAlternative, 'rescore')],
  ];

  test.each(reviewJobs)('%s: the review skips closed PRs and review events', (_name, text) => {
    expect(text).toContain("&& github.event.action != 'closed'");
    expect(text).not.toContain('pull_request_review');
  });

  test.each(rescoreJobs)('%s: re-scores same-repository PRs on close or a review, without a model, in its own group', (_name, text) => {
    expect(text).toContain("(github.event_name == 'pull_request' && github.event.action == 'closed')");
    expect(text).toContain("|| github.event_name == 'pull_request_review'");
    expect(text).toContain('&& github.event.pull_request.head.repo.full_name == github.repository');
    expect(text).toContain('group: cura-rescore-${{ github.event.pull_request.number }}');
    expect(text).not.toContain('cancel-in-progress');
    expect(text).toMatch(/^ {6}pull-requests: write$/m);
    expect(text).not.toMatch(/^ {6}(issues|contents): write$/m);
    expect(text).toMatch(/^ {10}mode: rescore$/m);
    expect(text).not.toContain('claude_code_oauth_token');
  });
});

describe('review.yml', () => {
  test('uses the action by its major tag', () => {
    expect(review).toMatch(/^ {8}uses: Brunyee-Studio\/cura@v1$/m);
  });

  test('declares the expected inputs', () => {
    expect([...reviewInputs.keys()]).toEqual([
      'runs_on',
      'rules',
      'config',
      'model',
      'fail_on',
      'max_files_per_scope',
      'max_lines_per_scope',
      'timeout_minutes',
      'allowed_bots',
      'allow_forks',
    ]);
    expect(reviewInputs.get('timeout_minutes')).toBe('20');
  });

  test('every input is forwarded to the action or used by the job', () => {
    const actionInputs = inputDefaults(action, 'inputs:', 2);
    for (const [name, value] of reviewInputs) {
      if (name === 'runs_on') expect(review).toContain('runs-on: ${{ inputs.runs_on }}');
      else if (name === 'timeout_minutes') expect(review).toContain('timeout-minutes: ${{ inputs.timeout_minutes }}');
      else {
        expect(review, name).toContain(`          ${name}: \${{ inputs.${name} }}`);
        expect(actionInputs.get(name), `action default for ${name}`).toBe(value);
      }
    }
  });

  test('passes the token secret to the action', () => {
    expect(review).toContain('claude_code_oauth_token: ${{ secrets.claude_code_oauth_token }}');
  });
});

describe('release.yml', () => {
  const release = read('.github/workflows/release.yml');
  const releaserc = JSON.parse(read('.releaserc.json'));

  test('releases every push to main with semantic-release and commits nothing back', () => {
    expect(release).toMatch(/^on:\n  push:\n    branches: \[main\]\n  workflow_dispatch:\n/m);
    expect(release).toContain('if [[ "$GITHUB_REF" != "refs/heads/main" ]]; then');
    expect(release).toContain('run: pnpm exec semantic-release');
    expect(releaserc.branches).toEqual(['main']);
    expect(releaserc.tagFormat).toBe('v${version}');
    const plugins = releaserc.plugins.map((p: string | [string]) => (Array.isArray(p) ? p[0] : p));
    expect(plugins).toEqual([
      '@semantic-release/commit-analyzer',
      '@semantic-release/release-notes-generator',
      '@semantic-release/github',
    ]);
  });

  describe('the tag move', () => {
    const lines = release.split('\n');
    const script = runBlocks(lines.slice(lines.indexOf('      - name: Move major and latest tags')))[0]!
      .map((l) => l.slice(10))
      .join('\n');

    function withRepo(fn: (git: (...args: string[]) => string, move: () => string) => void) {
      const dir = mkdtempSync(join(tmpdir(), 'cura-release-'));
      const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
      const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: join(dir, 'repo'), env, encoding: 'utf8' }).trim();
      try {
        execFileSync('git', ['init', '-q', '--bare', 'origin.git'], { cwd: dir, env });
        execFileSync('git', ['init', '-q', 'repo'], { cwd: dir, env });
        git('remote', 'add', 'origin', join(dir, 'origin.git'));
        fn(git, () => execFileSync('bash', ['-c', script], { cwd: join(dir, 'repo'), env, encoding: 'utf8' }).trim().split('\n').at(-1)!);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const remoteTarget = (git: (...args: string[]) => string, tag: string) =>
      git('ls-remote', 'origin', `refs/tags/${tag}^{}`).split('\t')[0];

    test('moves the major tag and latest to a new release and pushes them', () => {
      withRepo((git, move) => {
        git('commit', '-q', '--allow-empty', '-m', 'feat: a');
        git('tag', 'v1.0.0');
        git('commit', '-q', '--allow-empty', '-m', 'fix: b');
        git('tag', 'v1.0.1');
        expect(move()).toBe('Moved v1 and latest to v1.0.1.');
        const head = git('rev-parse', 'HEAD');
        expect(remoteTarget(git, 'v1')).toBe(head);
        expect(remoteTarget(git, 'latest')).toBe(head);
        expect(move()).toBe('v1 and latest already point at v1.0.1.');
      });
    });

    test('never moves the tags backwards when an older commit is checked out', () => {
      withRepo((git, move) => {
        git('commit', '-q', '--allow-empty', '-m', 'feat: a');
        git('tag', 'v1.0.9');
        git('commit', '-q', '--allow-empty', '-m', 'fix: b');
        git('tag', 'v1.0.10');
        const newest = git('rev-parse', 'HEAD');
        git('checkout', '-q', 'v1.0.9');
        expect(move()).toBe('Moved v1 and latest to v1.0.10.');
        expect(remoteTarget(git, 'v1')).toBe(newest);
      });
    });

    test('a major release creates the new major tag and leaves the old one', () => {
      withRepo((git, move) => {
        git('commit', '-q', '--allow-empty', '-m', 'feat: a');
        git('tag', 'v1.2.0');
        move();
        const v1 = git('rev-parse', 'HEAD');
        git('commit', '-q', '--allow-empty', '-m', 'feat!: b');
        git('tag', 'v2.0.0');
        expect(move()).toBe('Moved v2 and latest to v2.0.0.');
        expect(remoteTarget(git, 'v1')).toBe(v1);
        expect(remoteTarget(git, 'v2')).toBe(git('rev-parse', 'HEAD'));
        expect(remoteTarget(git, 'latest')).toBe(git('rev-parse', 'HEAD'));
      });
    });
  });
});
