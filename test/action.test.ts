import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runBlocks } from './yaml-lines.ts';

const root = join(import.meta.dirname, '..');
const action = readFileSync(join(root, 'action.yml'), 'utf8');
const lines = action.split('\n');
const cliSource = readFileSync(join(root, 'src', 'cli.ts'), 'utf8');

// CURA_* vars the CLI reads but the action deliberately leaves unset: the CLI's default applies.
// CURA_MIN_SEVERITY: no action input; the consumer config's `min_severity` (else P2) is the default.
const OPTIONAL_ENV = new Set(['CURA_MIN_SEVERITY']);

/** Keys of a top-level YAML map (`inputs:` / `outputs:`), read from its two-space-indented children. */
function topLevelKeys(section: string): string[] {
  const start = lines.indexOf(`${section}:`);
  expect(start, `${section}: block`).toBeGreaterThanOrEqual(0);
  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const key = /^ {2}([a-z_]+):/.exec(line)?.[1];
    if (key) keys.push(key);
  }
  return keys;
}

/** Each composite step's text, keyed by its `id:` (or its name when it has none), in file order. */
function steps(): { key: string; text: string }[] {
  const starts = lines.flatMap((line, i) => (/^ {4}- name: /.test(line) ? [i] : []));
  return starts.map((start, n) => {
    const text = lines.slice(start, starts[n + 1] ?? lines.length).join('\n');
    const key = /^ {6}id: (\S+)$/m.exec(text)?.[1] ?? /- name: (.+)/.exec(text)![1]!;
    return { key, text };
  });
}

function step(key: string): string {
  const found = steps().find((s) => s.key === key);
  expect(found, `step ${key}`).toBeDefined();
  return found!.text;
}

describe('action.yml', () => {
  test('every declared input is used', () => {
    const inputs = topLevelKeys('inputs');
    expect(inputs).toContain('claude_code_oauth_token');
    expect(inputs).toContain('bot_login');
    expect(inputs).not.toContain('timeout_minutes');
    for (const name of inputs) expect(action, `inputs.${name}`).toMatch(new RegExp(`inputs\\.${name}\\b`));
  });

  test('every CURA_* env var the CLI reads is set by some step', () => {
    const read = new Set([...cliSource.matchAll(/\b(CURA_[A-Z_]+)\b/g)].map((m) => m[1]!));
    expect(read.size).toBeGreaterThan(5);
    for (const name of read) {
      if (OPTIONAL_ENV.has(name)) continue;
      expect(action, name).toMatch(new RegExp(`^\\s+${name}:`, 'm'));
    }
  });

  test('outputs come from the publish step', () => {
    const outputs = topLevelKeys('outputs');
    expect(outputs).toEqual(['score', 'findings', 'summary_url']);
    for (const name of outputs) expect(action).toContain(`\${{ steps.publish.outputs.${name} }}`);
  });

  test('run scripts take no ${{ }} expressions; untrusted data goes through env', () => {
    const blocks = runBlocks(lines);
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    for (const body of blocks) {
      for (const line of body) expect(line).not.toContain('${{');
    }
    expect(action).not.toMatch(/^\s*(?:- )?run: [^|\n]*\$\{\{/m);
  });

  test('publish fails closed on the agent outcome and reads its structured output from the execution file', () => {
    const publish = step('publish');
    expect(publish).toContain('AGENT_OUTCOME: ${{ steps.claude.outcome }}');
    expect(publish).toContain('CURA_EXECUTION_FILE: ${{ steps.claude.outputs.execution_file }}');
    // REVIEW is only a fallback: a large structured_output in env would exceed Linux's 128 KiB per-string limit.
    expect(publish).toContain("REVIEW: ${{ steps.claude.outputs.execution_file == '' && steps.claude.outputs.structured_output || '' }}");
  });

  // Under `claude -p` subagents run in the background by default, and the lead
  // returned its review while its reviewers were still running. claude-code-action's
  // step env shadows only the vars it lists, so the setting goes through $GITHUB_ENV.
  test('runs subagents in the foreground so the lead cannot return before them', () => {
    const keys = steps().map((s) => s.key);
    const setter = steps().findIndex((s) => s.text.includes('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'));
    expect(setter, 'step setting CLAUDE_CODE_DISABLE_BACKGROUND_TASKS').toBeGreaterThanOrEqual(0);
    expect(setter).toBeLessThan(keys.indexOf('claude'));
    expect(steps()[setter]!.text).toContain('echo "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1" >> "$GITHUB_ENV"');
  });

  test('passes allowed_bots through to claude-code-action', () => {
    expect(step('claude')).toContain('allowed_bots: ${{ inputs.allowed_bots }}');
  });

  test("removes claude-code-action's git credentials right after the Claude step, always", () => {
    const keys = steps().map((s) => s.key);
    const cleanup = steps()[keys.indexOf('claude') + 1]!;
    expect(cleanup.key).toBe('Remove Claude Code git credentials');
    expect(cleanup.text).toMatch(/^ {6}if: always\(\)$/m);
    expect(cleanup.text).toContain('git remote set-url origin "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY.git"');
    expect(cleanup.text).toContain('--unset-all credential.helper');
    expect(cleanup.text).toContain('extraheader');
  });

  test('the credential cleanup removes plain and URL-scoped extraheaders, helpers and the token URL', () => {
    const cleanup = steps().find((s) => s.key === 'Remove Claude Code git credentials')!.text.split('\n');
    const script = runBlocks(cleanup)[0]!.map((l) => l.trim()).join('\n');
    const repo = mkdtempSync(join(tmpdir(), 'cura-action-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    try {
      git('init', '-q');
      git('remote', 'add', 'origin', 'https://x-access-token:SECRET@github.com/o/r.git');
      git('config', '--local', 'http.extraheader', 'AUTHORIZATION: basic SECRET');
      git('config', '--local', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic SECRET');
      git('config', '--local', 'credential.helper', 'store');
      git('config', '--local', 'http.sslVerify', 'true');
      execFileSync('bash', ['-c', script], {
        cwd: repo,
        env: { ...process.env, GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r' },
      });
      const config = git('config', '--local', '--list');
      expect(config).not.toContain('SECRET');
      expect(config).not.toMatch(/extraheader|credential\.helper/);
      expect(config).toContain('http.sslverify=true');
      expect(git('remote', 'get-url', 'origin').trim()).toBe('https://github.com/o/r.git');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  describe('rescore mode', () => {
    test('re-scores with the CLI and no model, token or checkout', () => {
      expect(action).toMatch(/^ {2}mode:\n(?: {4}.*\n)* {4}default: review$/m);
      const rescore = step('rescore');
      expect(rescore).toMatch(/^ {6}if: inputs\.mode == 'rescore'$/m);
      expect(rescore).toContain('node "$GITHUB_ACTION_PATH/src/cli.ts" rescore');
      expect(rescore).toContain('CURA_PR: ${{ inputs.pr || github.event.pull_request.number }}');
      expect(rescore).toContain('CURA_BOT_LOGIN: ${{ inputs.bot_login }}');
      expect(rescore).not.toContain('claude_code_oauth_token');
    });

    test('skips the review steps', () => {
      for (const key of ['pr', 'Install OpenCodeReview', 'context']) expect(step(key), key).toMatch(/^ {6}if: inputs\.mode != 'rescore'$/m);
      // A skipped context step has no outputs, so these must not run on `!= 'true'`.
      for (const key of ['prompt', 'claude']) expect(step(key), key).toMatch(/^ {6}if: steps\.context\.outputs\.skip_agent == 'false'$/m);
      expect(step('publish')).toContain("steps.context.outcome == 'success'");
    });

    test('a mode other than review or rescore fails the run', () => {
      const pr = step('pr');
      expect(pr).toContain('MODE: ${{ inputs.mode }}');
      expect(pr).toContain('if [[ "$MODE" != review ]]; then');
    });
  });

  test('pins third-party actions by commit SHA', () => {
    const uses = [...action.matchAll(/uses: (\S+)/g)].map((m) => m[1]!);
    expect(uses).toHaveLength(2);
    for (const ref of uses) expect(ref).toMatch(/@[0-9a-f]{40}$/);
    expect(uses).toContain('anthropics/claude-code-action@8ce9314fa9a404564fa7e954cd84f25bcba2b829');
  });
});
