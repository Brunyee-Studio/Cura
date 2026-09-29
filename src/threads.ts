import type { GitHub } from './github.ts';
import { parseFindingMarker } from './render.ts';
import type { Thread } from './types.ts';

interface Repo {
  owner: string;
  name: string;
}

interface CommentNode {
  databaseId: number;
  url: string;
  body: string;
  author: { login: string } | null;
}

interface ThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  subjectType: 'LINE' | 'FILE';
  comments: { nodes: CommentNode[] };
}

interface ThreadsPage {
  repository: {
    pullRequest: {
      reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ThreadNode[] };
    };
  };
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine subjectType
          comments(first: 50) { nodes { databaseId url body author { login } } }
        }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`;

const FINDING_MARKER_LINE = '<!-- cura:finding ';

const stripBotSuffix = (login: string) => login.replace(/\[bot\]$/, '');

export function isBot(login: string, botLogin: string): boolean {
  return stripBotSuffix(login) === stripBotSuffix(botLogin);
}

export function stripMarkerLine(body: string): string {
  return body
    .split('\n')
    .filter((line) => !line.includes(FINDING_MARKER_LINE))
    .join('\n')
    .trimEnd();
}

function toThread(node: ThreadNode, botLogin: string): Thread | null {
  const [root, ...rest] = node.comments.nodes;
  if (!root?.author || !isBot(root.author.login, botLogin)) return null;
  const meta = parseFindingMarker(root.body);
  if (!meta) return null;
  return {
    id: node.id,
    commentId: root.databaseId,
    url: root.url,
    path: node.path,
    line: node.line,
    originalLine: node.originalLine,
    subjectType: node.subjectType,
    isResolved: node.isResolved,
    isOutdated: node.isOutdated,
    body: stripMarkerLine(root.body),
    meta,
    replies: rest
      .filter((c) => !c.author || !isBot(c.author.login, botLogin))
      .map((c) => ({ author: c.author?.login ?? 'ghost', body: c.body })),
  };
}

export async function fetchThreads(gh: GitHub, repo: Repo, pr: number, botLogin: string): Promise<Thread[]> {
  const threads: Thread[] = [];
  let after: string | null = null;
  do {
    const page: ThreadsPage = await gh.graphql<ThreadsPage>(THREADS_QUERY, { owner: repo.owner, name: repo.name, pr, after });
    const { pageInfo, nodes } = page.repository.pullRequest.reviewThreads;
    for (const node of nodes) {
      const thread = toThread(node, botLogin);
      if (thread) threads.push(thread);
    }
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after);
  return threads;
}

export async function resolveThread(gh: GitHub, threadId: string): Promise<void> {
  await gh.graphql(RESOLVE_MUTATION, { threadId });
}

export async function replyToComment(gh: GitHub, repo: Repo, pr: number, commentId: number, body: string): Promise<void> {
  await gh.rest('POST', `/repos/${repo.owner}/${repo.name}/pulls/${pr}/comments/${commentId}/replies`, { body });
}
