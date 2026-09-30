import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { allowedTools, buildAgents, disallowedTools, DRAFTS_DIR, renderLeadPrompt } from './agents.ts';
import { checkReview, formatErrors } from './check.ts';
import { gatherContext } from './context.ts';
import { createGitHub, type GitHub, type GitHubOptions } from './github.ts';
import { OCR_VERSION, resolveOcr } from './install.ts';
import { checkPlan, fallbackPlan } from './plan.ts';
import { publish, publishFailure } from './publish.ts';
import { loadSchema } from './schema.ts';
import type { CuraConfig, FileFact, Finding, HunkMap, Review, Severity, Thread } from './types.ts';

type Env = NodeJS.ProcessEnv;

export interface Io {
  stdout: (s: string) => void;
  exit: (code: number) => void;
}

export interface Deps {
  createGitHub: (opts: GitHubOptions) => GitHub;
  /** Runs `cmd args` in `cwd` and returns stdout; throws on non-zero exit. */
  exec: (cmd: string, args: string[], cwd: string) => string;
  fetch: typeof fetch;
}

/** Run state `context` persists for `prompt`, `check` and `publish`. */
interface RunState {
  mode: 'full' | 'incremental';
  prevSha: string | null;
  summaryId: number | null;
  reviewableCount: number;
  deletedCount: number;
  base: string;
  headSha: string;
  maxFiles: number;
  maxLines: number;
}

const USAGE = `usage: node src/cli.ts <command>

commands:
  install                       resolve or download the ocr binary
  context                       gather PR context into $CURA_CTX
  prompt                        render the lead prompt, agents and tool rules
  check [--ctx <dir>] [--plan]  validate the review draft (or, with --plan, the scope plan) in <dir>/drafts/
  publish                       publish the review ($CURA_EXECUTION_FILE, else $REVIEW) to the PR
  --help                        show this help`;

const CHECK_USAGE = 'usage: node src/cli.ts check [--ctx <absolute dir>] [--plan]';
// The lead writes its drafts here (see DRAFTS_DIR): Claude Code's Bash permission
// check rejects a heredoc carrying JSON, so the checker can't take them on stdin.
const REVIEW_DRAFT = 'review.json';
const PLAN_DRAFT = 'plan.json';
const FALLBACK_PREFIX = 'FALLBACK PLAN (use this):';
const PLAN_FALLBACK_AFTER = 2;
const FAIL_ON_RANK: Record<string, number> = { P0: 2, P1: 3 };
const SEVERITIES = new Set<string>(['P0', 'P1', 'P2']);
const EMPTY_REVIEW: Review = {
  summary: 'No reviewable files in this PR.',
  risk_note: '',
  scopes: [],
  files: [],
  diagram: '',
  findings: [],
  resolved: [],
  dismissed: [],
  discarded: [],
};

const defaultDeps: Deps = {
  createGitHub,
  exec: (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
  fetch: (...args) => fetch(...args),
};

export async function main(argv: string[], env: Env, io: Io, deps: Partial<Deps> = {}): Promise<void> {
  const d: Deps = { ...defaultDeps, ...deps };
  const [command, ...args] = argv;
  if (command === '--help' || command === '-h') {
    io.stdout(USAGE);
    return io.exit(0);
  }
  if (command !== 'check' && args.length > 0) return usageError(io, USAGE);
  switch (command) {
    case 'install':
      return install(env, io, d);
    case 'context':
      return context(env, io, d);
    case 'prompt':
      return prompt(env, io);
    case 'check':
      return check(args, env, io);
    case 'publish':
      return runPublish(env, io, d);
    default:
      return usageError(io, USAGE);
  }
}

function usageError(io: Io, usage: string): void {
  io.stdout(usage);
  io.exit(2);
}

// ── install ──────────────────────────────────────────────────────────────────

function findOnPath(pathVar: string | undefined, cmd: string): string | null {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of [cmd, `${cmd}.exe`]) {
      const candidate = join(dir, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here; keep looking
      }
    }
  }
  return null;
}

async function install(env: Env, io: Io, d: Deps): Promise<void> {
  const binDir = join(env.RUNNER_TEMP || tmpdir(), 'cura-bin');
  mkdirSync(binDir, { recursive: true });
  const existing = findOnPath(env.PATH, 'ocr');
  const ocr = await resolveOcr({
    version: env.CURA_OCR_VERSION || OCR_VERSION,
    platform: process.platform,
    arch: process.arch,
    binDir,
    which: () => existing,
    fetch: d.fetch,
  });
  if (existing === null && env.GITHUB_PATH) appendFileSync(env.GITHUB_PATH, `${binDir}\n`);
  io.stdout(`ocr: ${ocr}`);
}

// ── context ──────────────────────────────────────────────────────────────────

async function context(env: Env, io: Io, d: Deps): Promise<void> {
  const ctxDir = ctxFromEnv(env);
  mkdirSync(ctxDir, { recursive: true });
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const base = required(env, 'CURA_BASE');
  const headSha = required(env, 'CURA_HEAD_SHA');

  const result = await gatherContext({
    gh: github(env, d),
    exec: (cmd, args, cwd) => d.exec(cmd, args, cwd ?? workspace),
    repo: repoFromEnv(env),
    pr: prFromEnv(env),
    base,
    headSha,
    ctxDir,
    workspace,
    rulesPath: env.CURA_RULES || '.opencodereview/rule.json',
    configPath: env.CURA_CONFIG || '.github/cura.json',
    botLogin: botLogin(env),
  });
  const state: RunState = { ...result, base, headSha, ...caps(env) };
  writeFileSync(join(ctxDir, 'context.json'), `${JSON.stringify(state, null, 2)}\n`);
  const pr = readJson<{ isCrossRepository: boolean }>(ctxDir, 'pr.json');

  setOutputs(env, io, {
    mode: result.mode,
    prev_sha: result.prevSha ?? '',
    summary_id: result.summaryId === null ? '' : String(result.summaryId),
    reviewable_count: String(result.reviewableCount),
    cross_repo: String(pr.isCrossRepository),
    skip_agent: String(skipsAgent(state)),
  });
}

// ── prompt ───────────────────────────────────────────────────────────────────

function prompt(env: Env, io: Io): void {
  const ctxDir = ctxFromEnv(env);
  const state = readJson<RunState>(ctxDir, 'context.json');
  const curaDir = resolve(import.meta.dirname, '..');
  const { maxFiles, maxLines } = state;

  const lead = renderLeadPrompt({
    repo: env.GITHUB_REPOSITORY ?? '',
    pr: prFromEnv(env),
    base: state.base,
    headSha: state.headSha,
    mode: state.mode,
    prevSha: state.prevSha,
    ctxDir,
    curaDir,
    maxFiles,
    maxLines,
  });
  const model = env.CURA_MODEL || undefined;
  const agentsFile = join(ctxDir, 'agents.json');
  const agents = JSON.stringify(buildAgents({ base: state.base, model }));
  const allowed = allowedTools({ base: state.base, ctxDir, curaDir });
  const disallowed = disallowedTools();
  // Claude Code's --json-schema validator doesn't know the draft 2020-12 meta-schema,
  // so drop the `$schema` declaration (the schema itself only uses draft-07 keywords).
  const { $schema: _metaSchema, ...reviewSchema } = loadSchema('review') as Record<string, unknown>;
  const schema = JSON.stringify(reviewSchema);
  writeFileSync(join(ctxDir, 'lead-prompt.md'), lead);
  writeFileSync(agentsFile, agents);

  const claudeArgs = ['--json-schema', schema, '--agents', agents, '--allowedTools', allowed, '--disallowedTools', disallowed];
  if (model) claudeArgs.push('--model', model);

  setOutputs(env, io, {
    prompt: lead,
    allowed_tools: allowed,
    disallowed_tools: disallowed,
    schema,
    agents_file: agentsFile,
    claude_args: claudeArgs.map(shellQuote).join(' '),
  });
}

/**
 * Quotes one argument so both a POSIX shell and claude-code-action's `shell-quote`
 * parser (1.8.x) split it back exactly. shell-quote's tokenizer treats a backslash
 * right before a closing quote as escaping it, so no quoted segment may end in `\`:
 * text goes in single quotes, and each `'` (with any backslashes before it) goes in
 * double quotes, where `\\` is one backslash and `'` is literal.
 */
export function shellQuote(arg: string): string {
  if (arg.endsWith('\\')) throw new Error(`claude_args value must not end with a backslash: ${JSON.stringify(arg)}`);
  const pieces = arg.split("'");
  const last = pieces.pop()!;
  const quoted = pieces.map((piece) => {
    const text = piece.replace(/\\+$/, '');
    const slashes = piece.length - text.length;
    return `${text ? `'${text}'` : ''}"${'\\\\'.repeat(slashes)}'"`;
  });
  return quoted.join('') + (last || quoted.length === 0 ? `'${last}'` : '');
}

// ── check ────────────────────────────────────────────────────────────────────

// The agent's permission rule is a prefix match, so anything beyond these exact
// flags is rejected outright rather than interpreted.
function parseCheckArgs(args: string[], env: Env): { ctxDir: string; plan: boolean } | null {
  let ctxDir: string | undefined;
  let plan = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--plan' && !plan) {
      plan = true;
    } else if (args[i] === '--ctx' && ctxDir === undefined && i + 1 < args.length) {
      ctxDir = args[++i];
    } else {
      return null;
    }
  }
  if (env.CURA_CTX && ctxDir !== undefined && ctxDir !== env.CURA_CTX) return null;
  ctxDir ??= env.CURA_CTX;
  // Only a canonical absolute path: no `..`, `.` or trailing-slash variants of the pinned dir.
  if (!ctxDir || !isAbsolute(ctxDir) || resolve(ctxDir) !== ctxDir) return null;
  return { ctxDir, plan };
}

function check(args: string[], env: Env, io: Io): void {
  const parsed = parseCheckArgs(args, env);
  if (!parsed) return usageError(io, CHECK_USAGE);
  const { ctxDir, plan } = parsed;

  const draftFile = join(DRAFTS_DIR, plan ? PLAN_DRAFT : REVIEW_DRAFT);
  let draft: unknown;
  try {
    draft = JSON.parse(readFileSync(join(ctxDir, draftFile), 'utf8'));
  } catch (err) {
    const message = `json.invalid ${draftFile} is not readable JSON: ${(err as Error).message}`;
    return plan ? failPlan(ctxDir, io, message) : fail(io, message);
  }

  if (plan) {
    const facts = readJson<FileFact[]>(ctxDir, 'facts.json');
    const errors = checkPlan(draft, { ...planCaps(ctxDir), facts });
    if (errors.length === 0) return ok(io);
    return failPlan(ctxDir, io, formatErrors(errors));
  }

  const errors = checkReview(draft, loadFacts(ctxDir));
  if (errors.length === 0) return ok(io);
  return fail(io, formatErrors(errors));
}

function ok(io: Io): void {
  io.stdout('OK');
  io.exit(0);
}

function fail(io: Io, message: string): void {
  io.stdout(message);
  io.exit(1);
}

function failPlan(ctxDir: string, io: Io, message: string): void {
  const attemptsFile = join(ctxDir, 'plan-attempts');
  const attempts = (existsSync(attemptsFile) ? Number(readFileSync(attemptsFile, 'utf8')) || 0 : 0) + 1;
  writeFileSync(attemptsFile, String(attempts));
  io.stdout(message);
  if (attempts >= PLAN_FALLBACK_AFTER) {
    const facts = readJson<FileFact[]>(ctxDir, 'facts.json');
    io.stdout(`${FALLBACK_PREFIX} ${JSON.stringify(fallbackPlan(facts, planCaps(ctxDir)))}`);
  }
  io.exit(1);
}

function planCaps(ctxDir: string) {
  const config = readJson<CuraConfig>(ctxDir, 'config.json');
  const { maxFiles, maxLines } = readJson<RunState>(ctxDir, 'context.json');
  return { configScopes: config.scopes ?? [], maxFiles, maxLines };
}

// ── publish ──────────────────────────────────────────────────────────────────

async function runPublish(env: Env, io: Io, d: Deps): Promise<void> {
  const ctxDir = ctxFromEnv(env);
  const state = readJson<RunState>(ctxDir, 'context.json');
  const failOn = env.CURA_FAIL_ON || 'none';
  if (failOn !== 'none' && !Object.hasOwn(FAIL_ON_RANK, failOn)) throw new Error(`CURA_FAIL_ON must be none, P0 or P1 (got ${failOn})`);
  const minSeverity = minSeverityFrom(env, ctxDir);

  const gh = github(env, d);
  const repo = repoFromEnv(env);
  const pr = prFromEnv(env);
  const runUrl = env.RUN_URL ?? '';
  const executionFile = env.CURA_EXECUTION_FILE && existsSync(env.CURA_EXECUTION_FILE) ? env.CURA_EXECUTION_FILE : null;
  const raw = executionFile === null ? (env.REVIEW ?? '').trim() : '';
  const agentSucceeded = env.AGENT_OUTCOME === 'success';

  let review: unknown;
  if (skipsAgent(state) && executionFile === null && raw === '') {
    review = EMPTY_REVIEW;
  } else if (agentSucceeded) {
    review = executionFile === null ? parseJson(raw) : structuredOutputFrom(executionFile);
  }

  if (review === undefined) {
    const previous = readJson<{ body?: string }>(ctxDir, 'summary-comment.json');
    const summaryUrl = await publishFailure({
      gh,
      repo,
      pr,
      summaryId: state.summaryId,
      previousBody: previous.body ?? null,
      runUrl,
      headSha: state.headSha,
    });
    setOutputs(env, io, { score: '0', findings: '0', summary_url: summaryUrl });
    return io.exit(1);
  }

  const facts = loadFacts(ctxDir);
  const warnings = checkReview(review, facts);
  if (warnings.length > 0) stepSummary(env, io, `### Cura: review check warnings\n\n\`\`\`\n${formatErrors(warnings)}\n\`\`\`\n`);

  const result = await publish({
    gh,
    repo,
    pr,
    headSha: state.headSha,
    base: state.base,
    mode: state.mode,
    prevSha: state.prevSha,
    summaryId: state.summaryId,
    review,
    facts,
    runUrl,
    version: env.CURA_VERSION || 'dev',
    minSeverity,
    botLogin: botLogin(env),
  });

  setOutputs(env, io, { score: String(result.score), findings: String(result.findings), summary_url: result.summaryUrl });
  if (result.unanchored.length > 0) stepSummary(env, io, renderUnanchored(result.unanchored));

  // Score encodes the worst open severity: ≤3 means an open P1 or worse, ≤2 an open P0.
  const gateHit = failOn !== 'none' && result.score <= FAIL_ON_RANK[failOn];
  if (result.failed || gateHit) return io.exit(1);
}

/**
 * The review from claude-code-action's execution file (its SDK message list), derived as upstream derives its
 * `structured_output` output: the first `result` message, when it succeeded without error. Read from a file
 * because a large review passed through env exceeds Linux's 128 KiB per-string limit and the step cannot start.
 */
function structuredOutputFrom(file: string): unknown {
  const messages = parseJson(readFileSync(file, 'utf8'));
  if (!Array.isArray(messages)) return undefined;
  const result = messages.find((m: { type?: unknown } | null) => m?.type === 'result') as
    | { subtype?: unknown; is_error?: unknown; structured_output?: unknown }
    | undefined;
  if (result?.subtype !== 'success' || result.is_error || !result.structured_output) return undefined;
  return result.structured_output;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function minSeverityFrom(env: Env, ctxDir: string): Severity {
  const value = env.CURA_MIN_SEVERITY || readJson<CuraConfig>(ctxDir, 'config.json').min_severity || 'P2';
  if (!SEVERITIES.has(value)) throw new Error(`CURA_MIN_SEVERITY must be P0, P1 or P2 (got ${value})`);
  return value as Severity;
}

function renderUnanchored(findings: Finding[]): string {
  const items = findings.map((f) => `- **[${f.severity}] ${f.title}** — \`${f.path}:${f.line}\`\n\n  ${f.body.replace(/\n/g, '\n  ')}`);
  return `### Cura: findings that could not be anchored\n\n${items.join('\n')}\n`;
}

// ── shared ───────────────────────────────────────────────────────────────────

/** Nothing to review: a deletion-only PR still runs the agent for the impact analysis of removed code. */
function skipsAgent(state: RunState): boolean {
  return state.reviewableCount === 0 && state.deletedCount === 0;
}

function loadFacts(ctxDir: string) {
  const facts = readJson<FileFact[]>(ctxDir, 'facts.json');
  const preview = readJson<{ reviewable_files: PreviewPath[]; excluded_files: PreviewPath[] }>(ctxDir, 'preview.json');
  return {
    reviewable: facts.filter((f) => f.status !== 'deleted').map((f) => f.path),
    deleted: facts.filter((f) => f.status === 'deleted').map((f) => f.path),
    hunks: readJson<HunkMap>(ctxDir, 'hunks.json'),
    addedLines: readJson<Record<string, number[]>>(ctxDir, 'added-lines.json'),
    threads: readJson<Thread[]>(ctxDir, 'threads.json'),
    prFiles: new Set([...preview.reviewable_files, ...preview.excluded_files].filter((f) => f.status !== 'deleted').map((f) => f.path)),
  };
}

interface PreviewPath {
  path: string;
  status: string;
}

function readJson<T>(ctxDir: string, name: string): T {
  return JSON.parse(readFileSync(join(ctxDir, name), 'utf8')) as T;
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function ctxFromEnv(env: Env): string {
  const ctxDir = required(env, 'CURA_CTX');
  if (!isAbsolute(ctxDir) || resolve(ctxDir) !== ctxDir) {
    throw new Error(`CURA_CTX must be a canonical absolute path, without trailing slash, '.' or '..' (got ${ctxDir})`);
  }
  return ctxDir;
}

function repoFromEnv(env: Env): { owner: string; name: string } {
  const [owner, name, ...rest] = required(env, 'GITHUB_REPOSITORY').split('/');
  if (!owner || !name || rest.length > 0) throw new Error(`GITHUB_REPOSITORY must be owner/name (got ${env.GITHUB_REPOSITORY})`);
  return { owner, name };
}

function prFromEnv(env: Env): number {
  const pr = Number(required(env, 'CURA_PR'));
  if (!Number.isInteger(pr) || pr <= 0) throw new Error(`CURA_PR must be a PR number (got ${env.CURA_PR})`);
  return pr;
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer (got ${raw})`);
  return value;
}

function caps(env: Env): { maxFiles: number; maxLines: number } {
  return { maxFiles: positiveInt(env, 'CURA_MAX_FILES', 12), maxLines: positiveInt(env, 'CURA_MAX_LINES', 1500) };
}

function botLogin(env: Env): string {
  return env.CURA_BOT_LOGIN || 'github-actions';
}

function github(env: Env, d: Deps): GitHub {
  return d.createGitHub({ token: required(env, 'GITHUB_TOKEN'), apiUrl: env.GITHUB_API_URL, fetch: d.fetch });
}

/** Appends step outputs to $GITHUB_OUTPUT (stdout when unset); multi-line values use a random heredoc delimiter. */
function setOutputs(env: Env, io: Io, outputs: Record<string, string>): void {
  const lines = Object.entries(outputs).map(([name, value]) => {
    if (!value.includes('\n') && !value.includes('\r')) return `${name}=${value}`;
    const delim = `CURA_${randomBytes(16).toString('hex')}`;
    return `${name}<<${delim}\n${value}\n${delim}`;
  });
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  else io.stdout(lines.join('\n'));
}

function stepSummary(env: Env, io: Io, markdown: string): void {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  else io.stdout(markdown);
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env, {
    stdout: (s) => void process.stdout.write(`${s}\n`),
    exit: (code) => {
      process.exitCode = code;
    },
  }).catch((err: unknown) => {
    process.stderr.write(`cura: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
