import { readFileSync } from 'node:fs';
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

  test('publish fails closed on the agent outcome and reads its structured output', () => {
    const publish = step('publish');
    expect(publish).toContain('AGENT_OUTCOME: ${{ steps.claude.outcome }}');
    expect(publish).toContain('REVIEW: ${{ steps.claude.outputs.structured_output }}');
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

  test('pins third-party actions by commit SHA', () => {
    const uses = [...action.matchAll(/uses: (\S+)/g)].map((m) => m[1]!);
    expect(uses).toHaveLength(2);
    for (const ref of uses) expect(ref).toMatch(/@[0-9a-f]{40}$/);
    expect(uses).toContain('anthropics/claude-code-action@8ce9314fa9a404564fa7e954cd84f25bcba2b829');
  });
});
