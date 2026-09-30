import { anchorFinding } from './anchor.ts';
import { GitHubError, type GitHub } from './github.ts';
import { renderFailure, renderFindingComment, renderSummary, type OpenFindingLink } from './render.ts';
import { loadSchema, validate } from './schema.ts';
import { fingerprint, score } from './score.ts';
import { fetchThreads, replyToComment, resolveThread, stripMarkerLine } from './threads.ts';
import type { Anchor, Finding, Review, ReviewFacts, Severity, Thread } from './types.ts';

interface Repo {
  owner: string;
  name: string;
}

export interface PublishOptions {
  gh: GitHub;
  repo: Repo;
  pr: number;
  headSha: string;
  base: string;
  mode: 'full' | 'incremental';
  prevSha: string | null;
  summaryId: number | null;
  review: unknown;
  facts: ReviewFacts & { addedLines: Record<string, number[]>; prFiles: Set<string> };
  runUrl: string;
  version: string;
  minSeverity: Severity;
  botLogin: string;
}

export interface PublishResult {
  score: number;
  findings: number;
  summaryUrl: string;
  unanchored: Finding[];
  /** Threads the review closed but GitHub refused to resolve; they stay open and scored. */
  unresolved: UnresolvedThread[];
  failed: boolean;
}

export interface UnresolvedThread {
  url: string;
  error: string;
}

export interface PublishFailureOptions {
  gh: GitHub;
  repo: Repo;
  pr: number;
  summaryId: number | null;
  previousBody: string | null;
  runUrl: string;
  headSha: string;
}

type LineAnchor = Extract<Anchor, { kind: 'line' }>;
type FileAnchor = Extract<Anchor, { kind: 'file' }>;

interface Placed<A> {
  finding: Finding;
  anchor: A;
}

interface Posted {
  finding: Finding;
  url: string;
}

interface Ctx {
  gh: GitHub;
  repo: Repo;
  pr: number;
  headSha: string;
}

const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };
const TITLE_RE = /^\*\*\[[^\]]*\]\s*([\s\S]*?)\*\*/;
const CITE_RE = /^`[^`\n]*:(\d+)` — /;
const SUGGESTION_RE = /\n\n(`{3,})suggestion\n[\s\S]*\n\1$/;
const SHA_PREFIX_RE = /^(?:fixed|resolved) in `?[0-9a-f]{7,40}`?[.:]\s+/i;

/** Validates the lead's review and deterministically writes comments, thread lifecycle and the summary to the PR. */
export async function publish(opts: PublishOptions): Promise<PublishResult> {
  const { gh, repo, pr, headSha } = opts;
  const ctx: Ctx = { gh, repo, pr, headSha };

  if (validate(loadSchema('review'), opts.review).length > 0) {
    const previousBody = opts.summaryId === null ? null : await fetchSummaryBody(ctx, opts.summaryId);
    const summaryUrl = await publishFailure({ gh, repo, pr, summaryId: opts.summaryId, previousBody, runUrl: opts.runUrl, headSha });
    return { score: 0, findings: 0, summaryUrl, unanchored: [], unresolved: [], failed: true };
  }

  const review = opts.review as Review;
  const kept = review.findings.filter((f) => SEVERITY_RANK[f.severity] <= SEVERITY_RANK[opts.minSeverity]);
  const before = new Map((await fetchThreads(gh, repo, pr, opts.botLogin)).map((t) => [t.id, t]));

  const { posted, unanchored } = await postNewFindings(ctx, kept.filter((f) => f.status === 'new'), opts.facts);
  await editChangedFindings(ctx, kept.filter((f) => f.status === 'existing'), before);
  const closed = await closeThreads(ctx, review, before);

  const after = await fetchThreads(gh, repo, pr, opts.botLogin);
  const open = collectOpen(after, closed.ids, posted, kept);

  const body = renderSummary({
    review,
    score: score(open),
    open,
    resolved: closed.resolved,
    dismissed: closed.dismissed,
    unresolved: closed.unresolved,
    unanchored: unanchored.length,
    headSha,
    base: opts.base,
    mode: opts.mode,
    prevSha: opts.prevSha ?? undefined,
    runUrl: opts.runUrl,
    version: opts.version,
    rerun: '/cura',
  });
  const summaryUrl = await writeSummary(ctx, opts.summaryId, body);
  return { score: score(open), findings: open.length, summaryUrl, unanchored, unresolved: closed.unresolved, failed: false };
}

/** Marks the summary comment as failed, keeping the previous result visible. Returns the summary URL. */
export async function publishFailure(opts: PublishFailureOptions): Promise<string> {
  const body = renderFailure({ previousBody: opts.previousBody, runUrl: opts.runUrl, headSha: opts.headSha });
  return writeSummary(opts, opts.summaryId, body);
}

async function postNewFindings(ctx: Ctx, findings: Finding[], diff: PublishOptions['facts']): Promise<{ posted: Posted[]; unanchored: Finding[] }> {
  const lines: Placed<LineAnchor>[] = [];
  const files: Placed<FileAnchor>[] = [];
  const unanchored: Finding[] = [];
  for (const finding of findings) {
    const anchor = anchorFinding(finding, diff);
    if (anchor.kind === 'line') lines.push({ finding, anchor });
    else if (anchor.kind === 'file') files.push({ finding, anchor });
    else unanchored.push(finding);
  }

  const posted: Posted[] = [];
  if (lines.length > 0) {
    try {
      const res = await ctx.gh.rest<{ html_url: string }>('POST', `${pullsPath(ctx)}/${ctx.pr}/reviews`, {
        commit_id: ctx.headSha,
        event: 'COMMENT',
        body: `Cura found ${lines.length + files.length} new issue(s). See the summary comment.`,
        comments: lines.map(({ finding, anchor }) => ({ ...linePosition(anchor), body: renderFindingComment(finding, { anchor }) })),
      });
      posted.push(...lines.map(({ finding }) => ({ finding, url: res.html_url })));
    } catch (err) {
      if (!isUnprocessable(err)) throw err;
      for (const placed of lines) {
        const url = await postLineComment(ctx, placed);
        if (url !== null) posted.push({ finding: placed.finding, url });
        else files.push({ finding: placed.finding, anchor: { kind: 'file', path: placed.anchor.path } });
      }
    }
  }

  for (const placed of files) {
    const url = await postFileComment(ctx, placed);
    if (url !== null) posted.push({ finding: placed.finding, url });
    else unanchored.push(placed.finding);
  }
  return { posted, unanchored };
}

function linePosition(anchor: LineAnchor) {
  const position = { path: anchor.path, line: anchor.line, side: 'RIGHT' };
  return anchor.start_line === undefined ? position : { ...position, start_line: anchor.start_line, start_side: 'RIGHT' };
}

/** Returns the comment URL, or null when GitHub rejects the anchor (422). */
async function postLineComment(ctx: Ctx, { finding, anchor }: Placed<LineAnchor>): Promise<string | null> {
  const { path, ...position } = linePosition(anchor);
  return postComment(ctx, { body: renderFindingComment(finding, { anchor }), commit_id: ctx.headSha, path, ...position });
}

async function postFileComment(ctx: Ctx, { finding, anchor }: Placed<FileAnchor>): Promise<string | null> {
  return postComment(ctx, { body: renderFindingComment(finding, { anchor }), commit_id: ctx.headSha, path: anchor.path, subject_type: 'file' });
}

async function postComment(ctx: Ctx, payload: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await ctx.gh.rest<{ html_url: string }>('POST', `${pullsPath(ctx)}/${ctx.pr}/comments`, payload);
    return res.html_url;
  } catch (err) {
    if (isUnprocessable(err)) return null;
    throw err;
  }
}

/** PATCHes the root comment of each kept thread whose rendered content no longer matches the finding. */
async function editChangedFindings(ctx: Ctx, findings: Finding[], threads: Map<string, Thread>): Promise<void> {
  for (const finding of findings) {
    const thread = finding.thread_id === undefined ? undefined : threads.get(finding.thread_id);
    if (!thread || thread.isResolved) continue;
    const { anchor, citeLine } = anchorOnThread(thread, finding);
    const body = renderFindingComment(finding, { anchor, citeLine });
    // An outdated thread's suggestion can no longer apply, so it is dropped on edit but never forces one.
    const previous = anchor.kind === 'line' && thread.line === null ? stripSuggestion(thread.body) : thread.body;
    const unchanged =
      thread.meta.severity === finding.severity &&
      thread.meta.category === finding.category &&
      thread.meta.fingerprint === fingerprint(finding) &&
      stripMarkerLine(body) === previous;
    if (!unchanged) await ctx.gh.rest('PATCH', `${pullsPath(ctx)}/comments/${thread.commentId}`, { body });
  }
}

/**
 * Re-renders from where the comment actually sits, so an unchanged finding reproduces its body byte for byte:
 * a file-level thread keeps the line it cited when posted; an outdated line thread stays on its original line
 * without a suggestion; a live line thread keeps its suggestion only on the finding's own line.
 */
function anchorOnThread(thread: Thread, finding: Finding): { anchor: Anchor; citeLine?: number } {
  if (thread.subjectType === 'FILE') {
    return { anchor: { kind: 'file', path: finding.path }, citeLine: citedLine(thread.body) ?? thread.originalLine ?? finding.line };
  }
  if (thread.line === null) {
    return { anchor: { kind: 'line', path: finding.path, line: thread.originalLine ?? finding.line, snapped: true } };
  }
  return { anchor: { kind: 'line', path: finding.path, line: thread.line, snapped: thread.line !== finding.line } };
}

/** The line a file-level comment cites at the start of its second paragraph (`path:line` — …). */
function citedLine(body: string): number | undefined {
  const match = CITE_RE.exec(body.split('\n\n')[1] ?? '');
  return match ? Number(match[1]) : undefined;
}

function stripSuggestion(body: string): string {
  return body.replace(SUGGESTION_RE, '');
}

/**
 * Resolves each fixed or dismissed thread once, then replies; human-resolved and unknown threads are left alone.
 * Resolving first means a refused resolve (e.g. a token without `contents: write`) leaves no stray reply behind.
 */
async function closeThreads(ctx: Ctx, review: Review, threads: Map<string, Thread>) {
  const ids = new Set<string>();
  const resolved: { url: string; path: string; note: string }[] = [];
  const dismissed: { url: string; reason: string }[] = [];
  const unresolved: UnresolvedThread[] = [];
  const seen = new Set<string>();
  const closing = [
    ...review.resolved.map((r) => {
      const note = withoutShaPrefix(r.note);
      return { id: r.thread_id, reply: `Resolved in \`${ctx.headSha.slice(0, 7)}\`: ${note}`, record: (t: Thread) => resolved.push({ url: t.url, path: t.path, note }) };
    }),
    ...review.dismissed.map((d) => ({ id: d.thread_id, reply: `Dismissed: ${d.reason}`, record: (t: Thread) => dismissed.push({ url: t.url, reason: d.reason }) })),
  ];
  for (const { id, reply, record } of closing) {
    const thread = threads.get(id);
    if (!thread || thread.isResolved || seen.has(id)) continue;
    seen.add(id);
    try {
      await resolveThread(ctx.gh, id);
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err;
      unresolved.push({ url: thread.url, error: err.message });
      continue;
    }
    ids.add(id);
    await replyToComment(ctx.gh, ctx.repo, ctx.pr, thread.commentId, reply);
    record(thread);
  }
  return { ids, resolved, dismissed, unresolved };
}

/** The reply already names the head commit, so a note that opens by naming one would say it twice. */
function withoutShaPrefix(note: string): string {
  return note.replace(SHA_PREFIX_RE, '') || note;
}

/**
 * Every open Cura thread after publishing — posted, kept and unmentioned alike — so the score and the
 * summary's open list are the same set. Posted findings the refetch has not caught up with fall back to the POST URL.
 */
function collectOpen(threads: Thread[], closedIds: Set<string>, posted: Posted[], findings: Finding[]): OpenFindingLink[] {
  const byFingerprint = new Map(findings.map((f) => [fingerprint(f), f]));
  const openThreads = threads.filter((t) => !t.isResolved && !closedIds.has(t.id));
  const open = openThreads.map((t) => threadLink(t, byFingerprint.get(t.meta.fingerprint)?.title));
  const seen = new Set(openThreads.map((t) => t.meta.fingerprint));
  for (const { finding, url } of posted) {
    if (seen.has(fingerprint(finding))) continue;
    open.push({ severity: finding.severity, category: finding.category, title: finding.title, path: finding.path, line: finding.line, url });
  }
  return open;
}

/** A thread's summary link; its severity and category come from the thread's own finding marker. */
export function threadLink(t: Thread, title = titleFromBody(t.body)): OpenFindingLink {
  return { severity: t.meta.severity, category: t.meta.category, title, path: t.path, line: t.line, url: t.url };
}

function titleFromBody(body: string): string {
  return TITLE_RE.exec(body)?.[1].trim() ?? body.split('\n')[0];
}

async function fetchSummaryBody(ctx: Ctx, summaryId: number): Promise<string | null> {
  const res = await ctx.gh.rest<{ body?: string }>('GET', `${issuesPath(ctx)}/comments/${summaryId}`);
  return res.body ?? null;
}

async function writeSummary(ctx: { gh: GitHub; repo: Repo; pr: number }, summaryId: number | null, body: string): Promise<string> {
  const res = summaryId === null
    ? await ctx.gh.rest<{ html_url: string }>('POST', `${issuesPath(ctx)}/${ctx.pr}/comments`, { body })
    : await ctx.gh.rest<{ html_url: string }>('PATCH', `${issuesPath(ctx)}/comments/${summaryId}`, { body });
  return res.html_url;
}

function pullsPath(ctx: { repo: Repo }): string {
  return `/repos/${ctx.repo.owner}/${ctx.repo.name}/pulls`;
}

function issuesPath(ctx: { repo: Repo }): string {
  return `/repos/${ctx.repo.owner}/${ctx.repo.name}/issues`;
}

function isUnprocessable(err: unknown): boolean {
  return err instanceof GitHubError && err.status === 422;
}
