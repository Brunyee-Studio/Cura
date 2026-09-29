import { inHunk } from './diff.ts';
import { loadSchema, validate } from './schema.ts';
import type { CheckError, Finding, Review, ReviewFacts } from './types.ts';

export function checkReview(review: unknown, facts: ReviewFacts): CheckError[] {
  const schemaErrors = validate(loadSchema('review'), review);
  if (schemaErrors.length > 0) return schemaErrors;

  const draft = review as Review;
  const errors: CheckError[] = [];
  const fail = (code: string, path: string, detail: string) => errors.push({ code, message: `${path}: ${detail}`, path });

  draft.findings.forEach((finding, i) => {
    if (finding.status === 'new') checkAnchor(finding, `/findings/${i}`, facts, fail);
  });
  checkThreads(draft, facts, fail);
  checkCoverage(draft, facts, fail);
  return errors;
}

export function formatErrors(errors: CheckError[]): string {
  if (errors.length === 0) return 'OK';
  return errors.map((e) => `${e.code} ${e.message}`).join('\n');
}

type Fail = (code: string, path: string, detail: string) => void;

// Existing findings are skipped: their comment is already on the PR.
function checkAnchor(finding: Finding, at: string, facts: ReviewFacts, fail: Fail): void {
  if (!facts.hunks[finding.path]) {
    fail('anchor.path', `${at}/path`, `${finding.path} is not changed in this PR`);
    return;
  }
  const hunk = inHunk(facts.hunks, finding.path, finding.line);
  if (!hunk) {
    fail('anchor.line', `${at}/line`, `${finding.path}:${finding.line} is not inside a diff hunk`);
    return;
  }
  if (finding.start_line === undefined) return;
  if (finding.start_line >= finding.line) {
    fail('anchor.range', `${at}/start_line`, `start_line ${finding.start_line} must be before line ${finding.line}`);
  } else if (inHunk(facts.hunks, finding.path, finding.start_line) !== hunk) {
    fail('anchor.range', `${at}/start_line`, `start_line ${finding.start_line} is not in the same hunk as line ${finding.line}`);
  }
}

function checkThreads(review: Review, facts: ReviewFacts, fail: Fail): void {
  const threads = new Map(facts.threads.map((t) => [t.id, t]));
  const checkId = (id: string | undefined, at: string) => {
    const thread = id === undefined ? undefined : threads.get(id);
    if (!thread) fail('thread.unknown', at, `${id ?? '(missing thread_id)'} is not a Cura thread on this PR`);
    else if (thread.isResolved) fail('thread.closed', at, `${id} is already resolved`);
  };

  const findingIds = new Set<string>();
  review.findings.forEach((finding, i) => {
    if (finding.status !== 'existing') return;
    checkId(finding.thread_id, `/findings/${i}/thread_id`);
    if (finding.thread_id !== undefined) findingIds.add(finding.thread_id);
  });

  const closing = [
    ...review.resolved.map((r, i) => ({ id: r.thread_id, at: `/resolved/${i}/thread_id` })),
    ...review.dismissed.map((d, i) => ({ id: d.thread_id, at: `/dismissed/${i}/thread_id` })),
  ];
  for (const { id, at } of closing) {
    if (findingIds.has(id)) fail('thread.conflict', at, `${id} is both kept as a finding and closed`);
    else checkId(id, at);
  }
}

function checkCoverage(review: Review, facts: ReviewFacts, fail: Fail): void {
  const described = new Set(review.files.map((f) => f.path));
  for (const path of [...facts.reviewable, ...facts.deleted]) {
    if (!described.has(path)) fail('files.missing', '/files', `${path} has no overview`);
  }
  const scoped = new Set(review.scopes.flatMap((s) => s.files));
  for (const path of facts.reviewable) {
    if (!scoped.has(path)) fail('scopes.missing', '/scopes', `${path} is not in any scope`);
  }
}
