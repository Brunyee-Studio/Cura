import { readFileSync } from 'node:fs';
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
    expect(reviewInputs.get('timeout_minutes')).toBe('45');
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

  test('validates the version in bash and moves the major tag', () => {
    expect(release).toContain('VERSION: ${{ inputs.version }}');
    expect(release).toContain('[[ ! "$VERSION" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]');
    expect(release).toContain('git push --force origin "refs/tags/$MAJOR"');
    expect(release).toContain('gh release create "$VERSION" --verify-tag --generate-notes');
  });
});
