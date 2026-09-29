import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseConfig } from './config.ts';
import { parseDiff } from './diff.ts';
import type { GitHub } from './github.ts';
import { matchGlob } from './plan.ts';
import { fetchThreads, isBot } from './threads.ts';
import type { FileFact } from './types.ts';

export interface ContextOptions {
  gh: GitHub;
  /** Runs `cmd args` in `cwd` (default: the workspace) and returns stdout; throws on non-zero exit. */
  exec: (cmd: string, args: string[], cwd?: string) => string;
  repo: { owner: string; name: string };
  pr: number;
  base: string;
  headSha: string;
  ctxDir: string;
  workspace: string;
  rulesPath: string;
  configPath: string;
  botLogin: string;
}

export interface ContextResult {
  mode: 'full' | 'incremental';
  prevSha: string | null;
  summaryId: number | null;
  reviewableCount: number;
  deletedCount: number;
}

interface PreviewFile {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
}

interface Preview {
  reviewable_count: number;
  excluded_count: number;
  reviewable_files: PreviewFile[];
  excluded_files: (PreviewFile & { exclude_reason: string })[];
  [key: string]: unknown;
}

interface PullRequest {
  title: string;
  body: string | null;
  user: { login: string };
  labels: { name: string }[];
  base: { ref: string; repo: { full_name: string } };
  head: { sha: string; repo: { full_name: string } | null };
}

interface IssueComment {
  id: number;
  body: string;
  user: { login: string } | null;
}

const SUMMARY_MARKER = '<!-- cura:summary -->';
const REVIEWED_SHA = /<!-- cura:reviewed-sha=([0-9a-f]{40}) -->/g;
const DIFF_FLAGS = ['--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'];
const GUIDANCE_MAX_BYTES = 64 * 1024;
const PROJECT_RULES_DIR = '.opencodereview';
/** ocr lists a deleted file under `excluded_files` with this reason, unless another exclusion applies first. */
const DELETED_REASON = 'deleted';
const GUIDANCE_ROOT = /^(AGENTS\.md|CLAUDE\.md|CONTRIBUTING.*|README.*)$/;

const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', go: 'go', rs: 'rust', rb: 'ruby', java: 'java', kt: 'kotlin', swift: 'swift',
  sql: 'sql', md: 'markdown', json: 'json', yml: 'yaml', yaml: 'yaml', sh: 'shell', css: 'css', html: 'html',
};

const FACT_STATUSES = new Set<string>(['added', 'modified', 'renamed', 'deleted']);

function languageOf(path: string): string {
  return LANGUAGES[extname(path).slice(1).toLowerCase()] ?? 'other';
}

function toFact(file: PreviewFile): FileFact {
  const slash = file.path.indexOf('/');
  return {
    path: file.path,
    status: (FACT_STATUSES.has(file.status) ? file.status : 'modified') as FileFact['status'],
    language: languageOf(file.path),
    added: file.insertions,
    removed: file.deletions,
    dir: slash === -1 ? 'root' : file.path.slice(0, slash),
  };
}

/** `git show origin/<base>:<path>`, or null when the path is absent on the base branch. */
function showFromBase(opts: ContextOptions, path: string): string | null {
  try {
    return opts.exec('git', ['show', `origin/${opts.base}:${path}`]);
  } catch {
    return null;
  }
}

function applyIgnore(preview: Preview, ignore: string[]): Preview {
  const ignored = (f: PreviewFile) => ignore.some((pattern) => matchGlob(pattern, f.path));
  const reviewable = preview.reviewable_files.filter((f) => !ignored(f));
  const excluded = [
    ...preview.excluded_files.map((f) => (f.exclude_reason === DELETED_REASON && ignored(f) ? { ...f, exclude_reason: 'cura_ignore' } : f)),
    ...preview.reviewable_files.filter(ignored).map((f) => ({ ...f, exclude_reason: 'cura_ignore' })),
  ];
  return {
    ...preview,
    reviewable_count: reviewable.length,
    excluded_count: excluded.length,
    reviewable_files: reviewable,
    excluded_files: excluded,
  };
}

function isAncestor(opts: ContextOptions, sha: string): boolean {
  try {
    opts.exec('git', ['merge-base', '--is-ancestor', sha, 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/** lstat that never follows links; null when the path is missing. */
function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

// The workspace is the PR head checkout: a committed symlink could point at any
// runner-readable secret, so only real files (inside a real `.github` dir) are copied.
function copyGuidance(workspace: string, dest: string): void {
  const sources = readdirSync(workspace)
    .filter((name) => GUIDANCE_ROOT.test(name))
    .map((name) => ({ from: join(workspace, name), name }));
  if (lstatOrNull(join(workspace, '.github'))?.isDirectory()) {
    sources.push({ from: join(workspace, '.github', 'copilot-instructions.md'), name: 'copilot-instructions.md' });
  }

  for (const { from, name } of sources) {
    const stat = lstatOrNull(from);
    if (!stat?.isFile()) continue;
    mkdirSync(dest, { recursive: true });
    const target = join(dest, name);
    if (stat.size <= GUIDANCE_MAX_BYTES) copyFileSync(from, target);
    else writeFileSync(target, readFileSync(from).subarray(0, GUIDANCE_MAX_BYTES));
  }
}

/**
 * Runs `fn` in a throwaway worktree of HEAD whose `.opencodereview/rule.json` is the base branch's (or absent).
 * ocr always reads the project rules (`exclude` and rule text) from its checkout, even with `--rule`, so running
 * it in the PR head would let the PR rewrite its own review scope and rules. ocr's range mode reads only git
 * objects, so the worktree needs no checkout.
 */
function withBaseRulesWorktree<T>(opts: ContextOptions, fn: (dir: string) => T): T {
  const dir = join(opts.ctxDir, 'ocr-worktree');
  opts.exec('git', ['worktree', 'add', '--no-checkout', '--detach', dir, 'HEAD']);
  try {
    // Removed rather than overwritten: a head symlink here must never be written through.
    const rulesDir = join(dir, PROJECT_RULES_DIR);
    rmSync(rulesDir, { recursive: true, force: true });
    const baseRules = showFromBase(opts, `${PROJECT_RULES_DIR}/rule.json`);
    if (baseRules !== null) {
      mkdirSync(rulesDir);
      writeFileSync(join(rulesDir, 'rule.json'), baseRules);
    }
    return fn(dir);
  } finally {
    try {
      opts.exec('git', ['worktree', 'remove', '--force', dir]);
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Runs an `ocr` command in `cwd` and parses its JSON stdout, naming the command on failure. */
function execOcrJson<T>(exec: ContextOptions['exec'], args: string[], cwd: string): T {
  const out = exec('ocr', args, cwd);
  try {
    return JSON.parse(out) as T;
  } catch (err) {
    throw new Error(`ocr ${args.slice(0, 2).join(' ')} returned invalid JSON: ${(err as Error).message}`, { cause: err });
  }
}

/** Writes every input the lead agent, `check` and `publish` read from the context dir. */
export async function gatherContext(opts: ContextOptions): Promise<ContextResult> {
  const { gh, exec, repo, pr, base, ctxDir } = opts;
  const write = (name: string, content: string) => writeFileSync(join(ctxDir, name), content);
  const writeJson = (name: string, value: unknown) => write(name, `${JSON.stringify(value, null, 2)}\n`);
  mkdirSync(ctxDir, { recursive: true });

  const pull = await gh.rest<PullRequest>('GET', `/repos/${repo.owner}/${repo.name}/pulls/${pr}`);
  writeJson('pr.json', {
    title: pull.title,
    body: pull.body,
    author: pull.user.login,
    labels: pull.labels.map((l) => l.name),
    baseRef: pull.base.ref,
    headSha: pull.head.sha,
    isCrossRepository: pull.head.repo?.full_name !== pull.base.repo.full_name,
  });

  write('commits.txt', exec('git', ['log', '--format=%h %s', `origin/${base}..HEAD`]));

  const baseRules = showFromBase(opts, opts.rulesPath);
  const ruleFlag: string[] = [];
  if (baseRules !== null) {
    write('rules.base.json', baseRules);
    ruleFlag.push('--rule', join(ctxDir, 'rules.base.json'));
  }

  const { config, errors } = parseConfig(showFromBase(opts, opts.configPath));
  writeJson('config.json', config);
  if (errors.length > 0) write('config-errors.txt', `${errors.map((e) => `${e.code}: ${e.message}`).join('\n')}\n`);

  const { preview, facts } = withBaseRulesWorktree(opts, (dir) => {
    const rawPreview = execOcrJson<Preview>(exec, ['delegate', 'preview', '--from', `origin/${base}`, '--to', 'HEAD', '-f', 'json', ...ruleFlag], dir);
    const preview = applyIgnore(rawPreview, config.ignore ?? []);
    const deleted = preview.excluded_files.filter((f) => f.exclude_reason === DELETED_REASON);
    const facts = [...preview.reviewable_files, ...deleted].map(toFact);
    const reviewablePaths = facts.filter((f) => f.status !== 'deleted').map((f) => f.path);
    if (reviewablePaths.length > 0) {
      writeJson('rules.json', execOcrJson<unknown>(exec, ['delegate', 'rule', ...ruleFlag, '-f', 'json', ...reviewablePaths], dir));
    }
    return { preview, facts };
  });
  writeJson('preview.json', preview);
  writeJson('facts.json', facts);
  const reviewableCount = facts.filter((f) => f.status !== 'deleted').length;

  const diff = exec('git', ['diff', ...DIFF_FLAGS, `origin/${base}...HEAD`]);
  write('diff.patch', diff);
  const { hunks, addedLines } = parseDiff(diff);
  writeJson('hunks.json', hunks);
  writeJson('added-lines.json', addedLines);

  writeJson('threads.json', await fetchThreads(gh, repo, pr, opts.botLogin));

  const comments = await gh.paginate<IssueComment>(`/repos/${repo.owner}/${repo.name}/issues/${pr}/comments`);
  const summary = comments.findLast(
    (c) => c.user !== null && isBot(c.user.login, opts.botLogin) && c.body.includes(SUMMARY_MARKER),
  );
  writeJson('summary-comment.json', summary ? { id: summary.id, body: summary.body } : {});

  // The last marker is Cura's own; model-authored text above it is neutralised but never trusted.
  const prevSha = summary ? ([...summary.body.matchAll(REVIEWED_SHA)].at(-1)?.[1] ?? null) : null;
  let mode: ContextResult['mode'] = 'full';
  if (prevSha !== null && prevSha !== opts.headSha && isAncestor(opts, prevSha)) {
    write('incremental.diff', exec('git', ['diff', ...DIFF_FLAGS, prevSha, 'HEAD']));
    mode = 'incremental';
  }

  copyGuidance(opts.workspace, join(ctxDir, 'guidance'));

  return { mode, prevSha, summaryId: summary?.id ?? null, reviewableCount, deletedCount: facts.length - reviewableCount };
}
