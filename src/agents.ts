import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { loadSchema } from './schema.ts';

export interface LeadPromptVars {
  repo: string;
  pr: number;
  base: string;
  headSha: string;
  mode: string;
  prevSha: string | null;
  ctxDir: string;
  curaDir: string;
  maxFiles: number;
  maxLines: number;
}

export interface AgentDefinition {
  description: string;
  prompt: string;
  tools: string[];
  model?: string;
}

/** Subdirectory of the context dir the lead writes its drafts to for the checker. */
export const DRAFTS_DIR = 'drafts';

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

function readTemplate(name: string): string {
  return readFileSync(join(import.meta.dirname, '..', 'agents', `${name}.md`), 'utf8');
}

// A leftover placeholder means the template and its caller drifted; fail loudly
// rather than hand the model a prompt with holes in it.
function render(template: string, vars: Record<string, string>): string {
  const rendered = template.replace(PLACEHOLDER, (match, name: string) => (Object.hasOwn(vars, name) ? vars[name]! : match));
  const leftover = [...rendered.matchAll(PLACEHOLDER)].map((m) => m[1]);
  if (leftover.length > 0) throw new Error(`Unreplaced prompt placeholder(s): ${[...new Set(leftover)].join(', ')}`);
  return rendered;
}

const SAFE_BASE = /^[A-Za-z0-9._/-]+$/;
const UNSAFE_DIR_CHARS = /[,()*\s]/;

// These values are interpolated into comma-joined permission rules; a branch
// such as `x),Bash,Read(` is a valid git ref and would otherwise grant bare Bash.
export function assertSafeRuleValues(vars: { base?: string; ctxDir?: string; curaDir?: string }): void {
  const { base, ctxDir, curaDir } = vars;
  if (base !== undefined && (!SAFE_BASE.test(base) || base.startsWith('-') || base.includes('..'))) {
    throw new Error(`Unsafe base branch name for tool rules: ${JSON.stringify(base)}`);
  }
  for (const [name, dir] of [['ctxDir', ctxDir], ['curaDir', curaDir]] as const) {
    if (dir !== undefined && (!isAbsolute(dir) || UNSAFE_DIR_CHARS.test(dir))) {
      throw new Error(`Unsafe ${name} for tool rules: ${JSON.stringify(dir)}`);
    }
  }
}

export function renderLeadPrompt(vars: LeadPromptVars): string {
  assertSafeRuleValues(vars);
  return render(readTemplate('lead'), {
    ...vars,
    pr: String(vars.pr),
    prevSha: vars.prevSha ?? 'none',
    maxFiles: String(vars.maxFiles),
    maxLines: String(vars.maxLines),
  });
}

function gitDiffTool(base: string): string {
  return `Bash(git diff origin/${base}...HEAD --:*)`;
}

export function buildAgents(vars: { base: string; model?: string }): Record<string, AgentDefinition> {
  assertSafeRuleValues({ base: vars.base });
  const tools = ['Read', 'Grep', 'Glob', gitDiffTool(vars.base)];
  const model = vars.model ? { model: vars.model } : {};
  const candidateSchema = JSON.stringify(loadSchema('candidate'), null, 2);
  return {
    'scope-reviewer': {
      description:
        'Reviews one scope of the PR against its diff and the wider codebase (callers, consumers, sibling implementations); returns candidate findings as JSON.',
      prompt: render(readTemplate('scope-reviewer'), { base: vars.base, candidateSchema }),
      tools,
      ...model,
    },
    verifier: {
      description:
        'Verifies candidate findings against the code, discards unproven, pre-existing or duplicate ones, and gives a verdict on each open Cura thread; returns JSON.',
      prompt: render(readTemplate('verifier'), { base: vars.base }),
      tools,
      ...model,
    },
  };
}

// The lead reads untrusted PR content, so Bash is pinned to the exact command
// forms the prompt uses, bound to this PR's base and Cura's own dirs. File
// writes (Edit rules cover Write) are limited to the drafts the checker reads.
// ocr is not granted: the context step already ran it with the base-branch rules. After
// `--` every git argument is a pathspec, so the diff form can't take options.
// `ctxDir` is absolute, so `Read(/<ctxDir>/**)` yields Claude Code's `//abs` form.
export function allowedTools(vars: { base: string; ctxDir: string; curaDir: string }): string {
  assertSafeRuleValues(vars);
  return [
    gitDiffTool(vars.base),
    `Bash(node ${vars.curaDir}/src/cli.ts check --ctx ${vars.ctxDir}:*)`,
    'Read(./**)',
    `Read(/${vars.ctxDir}/**)`,
    `Edit(/${vars.ctxDir}/${DRAFTS_DIR}/**)`,
    'Grep',
    'Glob',
    'Agent',
    'Task',
  ].join(',');
}

// Blocks ocr's file-reading flags, git's `--output`, and credential files.
export function disallowedTools(): string {
  return [
    'Bash(git *--output*)',
    'Bash(ocr *--background*)',
    'Bash(ocr * -b*)',
    'Bash(ocr * -B*)',
    'Bash(ocr *--rule*)',
    'Bash(ocr *--repo*)',
    'Read(./.git/**)',
    'Read(//**/.env)',
    'Read(//**/.env.local)',
    'Read(~/.*)',
    'Read(~/.*/**)',
    'Read(//etc/**)',
    'Read(//proc/**)',
    'Read(//root/**)',
    'Read(//**/.credentials*)',
    'Read(//**/.runner)',
  ].join(',');
}
