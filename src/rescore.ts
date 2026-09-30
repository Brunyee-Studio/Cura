import { findSummaryComment } from './context.ts';
import type { GitHub } from './github.ts';
import { threadLink } from './publish.ts';
import { rescoreSummary } from './render.ts';
import { score } from './score.ts';
import { fetchThreads } from './threads.ts';

export interface RescoreOptions {
  gh: GitHub;
  repo: { owner: string; name: string };
  pr: number;
  botLogin: string;
}

export type RescoreResult =
  | { status: 'no-summary' | 'failed-review' }
  | { status: 'updated' | 'unchanged'; score: number; findings: number };

/**
 * Recomputes the summary's score and open-finding links from the open Cura threads, without a model, so threads
 * humans resolved since the review stop counting. The rest of the summary, the reviewed SHA included, stays as the review wrote it.
 */
export async function rescore(opts: RescoreOptions): Promise<RescoreResult> {
  const { gh, repo, pr, botLogin } = opts;
  const summary = await findSummaryComment(gh, repo, pr, botLogin);
  if (!summary) return { status: 'no-summary' };

  const open = (await fetchThreads(gh, repo, pr, botLogin)).filter((t) => !t.isResolved).map((t) => threadLink(t));
  const result = { score: score(open), findings: open.length };
  const body = rescoreSummary(summary.body, result.score, open);
  if (body === null) return { status: 'failed-review' };

  if (body === summary.body) return { status: 'unchanged', ...result };
  await gh.rest('PATCH', `/repos/${repo.owner}/${repo.name}/issues/comments/${summary.id}`, { body });
  return { status: 'updated', ...result };
}
