import { readFileSync } from 'node:fs';

/** What the lead did during a review, read from claude-code-action's execution file (its SDK message list). */
export interface ReviewTrace {
  model: string | null;
  turns: number | null;
  durationMs: number | null;
  costUsd: number | null;
  /** Agent (formerly Task) tool calls, counted by `subagent_type`. */
  subagents: Record<string, number>;
  denials: PermissionDenial[];
  /** `cli.ts check --plan` runs. */
  planChecks: number;
  /** Whether a plan check printed the fallback plan. */
  planFallback: boolean;
}

export interface PermissionDenial {
  tool: string;
  input: unknown;
}

const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
export const FALLBACK_PREFIX = 'FALLBACK PLAN (use this):';
const DENIAL_INPUT_MAX = 120;

type Json = Record<string, unknown>;

/** The trace of an execution file, or null when it is missing or not a message list: the trace is diagnostic only. */
export function readTrace(file: string): ReviewTrace | null {
  let messages: unknown;
  try {
    messages = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  return Array.isArray(messages) ? traceFrom(messages) : null;
}

export function traceFrom(messages: unknown[]): ReviewTrace {
  const msgs = messages.filter(isObject);
  const init = msgs.find((m) => m.type === 'system' && m.subtype === 'init');
  const result = msgs.find((m) => m.type === 'result');
  const subagents: Record<string, number> = {};
  const planCheckIds = new Set<string>();

  for (const block of contentBlocks(msgs, 'assistant', 'tool_use')) {
    const input = isObject(block.input) ? block.input : {};
    if (SUBAGENT_TOOLS.has(String(block.name)) && typeof input.subagent_type === 'string') {
      subagents[input.subagent_type] = (subagents[input.subagent_type] ?? 0) + 1;
    }
    if (block.name === 'Bash' && isPlanCheck(input.command)) planCheckIds.add(String(block.id));
  }

  const planFallback = contentBlocks(msgs, 'user', 'tool_result').some(
    (block) => planCheckIds.has(String(block.tool_use_id)) && resultText(block.content).includes(FALLBACK_PREFIX),
  );

  return {
    model: stringOrNull(init?.model),
    turns: numberOrNull(result?.num_turns),
    durationMs: numberOrNull(result?.duration_ms),
    costUsd: numberOrNull(result?.total_cost_usd),
    subagents,
    denials: (Array.isArray(result?.permission_denials) ? result.permission_denials : [])
      .filter(isObject)
      .map((d) => ({ tool: String(d.tool_name), input: d.tool_input })),
    planChecks: planCheckIds.size,
    planFallback,
  };
}

/** Signs the review skipped a step of the lead's procedure. Incremental and deletion-only reviews may dispatch no reviewer. */
export function traceWarnings(trace: ReviewTrace, review: { mode: 'full' | 'incremental'; reviewable: boolean }): string[] {
  const warnings: string[] = [];
  if (!trace.subagents.verifier) warnings.push('the verifier never ran, so no finding was verified');
  if (review.mode === 'full' && review.reviewable && !trace.subagents['scope-reviewer']) warnings.push('no scope-reviewer ran on this full review');
  return warnings;
}

export function renderTrace(trace: ReviewTrace): string {
  const run = [
    trace.model === null ? null : `\`${trace.model}\``,
    trace.turns === null ? null : `${trace.turns} turns`,
    trace.durationMs === null ? null : formatDuration(trace.durationMs),
    trace.costUsd === null ? null : `$${trace.costUsd.toFixed(2)}`,
  ].filter((part) => part !== null);
  const subagents = Object.entries(trace.subagents).map(([type, count]) => `${type} ×${count}`);
  const lines = [
    '### Cura: review trace',
    '',
    ...(run.length > 0 ? [`- Run: ${run.join(' · ')}`] : []),
    `- Subagents: ${subagents.length > 0 ? subagents.join(', ') : 'none'}`,
    `- Plan checks: ${trace.planChecks}${trace.planFallback ? ' (fallback plan used)' : ''}`,
    `- Permission denials: ${trace.denials.length}`,
    ...trace.denials.map((d) => `  - \`${d.tool}\` \`${trimInput(d.input)}\``),
  ];
  return `${lines.join('\n')}\n`;
}

function isPlanCheck(command: unknown): boolean {
  return typeof command === 'string' && command.includes('cli.ts check --ctx') && /\s--plan\b/.test(command);
}

/** The content blocks of `type` in messages of `role`; subagents' own messages included. */
function contentBlocks(msgs: Json[], role: string, type: string): Json[] {
  return msgs
    .filter((m) => m.type === role && isObject(m.message) && Array.isArray(m.message.content))
    .flatMap((m) => ((m.message as Json).content as unknown[]).filter(isObject))
    .filter((block) => block.type === type);
}

/** A tool_result's content is a string or a list of content blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isObject)
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

// One line inside a code span: backticks would end it, newlines would break the list.
function trimInput(input: unknown): string {
  const text = (JSON.stringify(input) ?? '').replace(/`/g, "'").replace(/\\n/g, ' ');
  return text.length > DENIAL_INPUT_MAX ? `${text.slice(0, DENIAL_INPUT_MAX)}…` : text;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
