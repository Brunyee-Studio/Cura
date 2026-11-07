import { countBySeverity, fingerprint } from './score.ts';
import type { Anchor, Category, Finding, FindingMeta, Review, Severity } from './types.ts';

const SUMMARY_MARKER = '<!-- cura:summary -->';
const FINDING_MARKER_RE = /<!-- cura:finding (\{[\s\S]*?\}) -->/g;
const CURA_MARKER_RE = /<!--(\s*)cura:/g;
// Model text is neutralised, so it cannot carry these markers and pass for Cura's own sections.
const FAILED_MARKER = '<!-- cura:review-failed -->';
const FAILURE_LINE_RE = /^<!-- cura:review-failed -->\n> ⚠️ Review failed for .*\n\n?/m;
const OPEN_START = '<!-- cura:open-findings -->';
const OPEN_END = '<!-- cura:open-findings-end -->';

const SEVERITIES: readonly Severity[] = ['P0', 'P1', 'P2'];
const CATEGORIES: readonly Category[] = ['correctness', 'security', 'data-loss', 'performance', 'contract', 'convention', 'test', 'docs'];
const SEVERITY_HEADINGS: Record<Severity, string> = {
  P0: 'P0 — blocks merge',
  P1: 'P1 — fix before release',
  P2: 'P2 — notes',
};
const SCORE_LINE_RE = /^\*\*Confidence [1-5]\/5\*\* — (.*)$/m;
const UNRESOLVED_LINE_RE = /\n\n> ⚠️ \d+ threads? Cura closed could not be resolved on GitHub and still counts? toward the score: (.*)\.$/m;
const THREAD_LINK_RE = /\[thread\]\(([^)]*)\)/g;
const COUNT_PART_RE = /^(\d+ P[012]|No open findings)$/;

export interface OpenFindingLink {
  severity: Severity;
  category: Category;
  title: string;
  path: string;
  line: number | null;
  url: string;
}

export interface SummaryInput {
  review: Review;
  score: number;
  open: OpenFindingLink[];
  resolved: { url: string; path: string; note: string }[];
  dismissed: { url: string; reason: string }[];
  /** Threads the review closed but GitHub refused to resolve: open and scored, which the review did not expect. */
  unresolved: { url: string }[];
  unanchored: number;
  headSha: string;
  base: string;
  mode: 'full' | 'incremental';
  prevSha?: string;
  runUrl: string;
  version: string;
  rerun: string;
}

export function findingMarker(meta: FindingMeta): string {
  const ordered = { v: meta.v, severity: meta.severity, category: meta.category, fingerprint: meta.fingerprint };
  return `<!-- cura:finding ${JSON.stringify(ordered)} -->`;
}

/** Parses the last marker: Cura appends its own after any model-authored text. */
export function parseFindingMarker(body: string): FindingMeta | null {
  const match = [...body.matchAll(FINDING_MARKER_RE)].at(-1);
  if (!match) return null;
  let meta: unknown;
  try {
    meta = JSON.parse(match[1]);
  } catch {
    return null;
  }
  return isFindingMeta(meta) ? meta : null;
}

function isFindingMeta(value: unknown): value is FindingMeta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  return (
    m.v === 1 &&
    SEVERITIES.includes(m.severity as Severity) &&
    CATEGORIES.includes(m.category as Category) &&
    typeof m.fingerprint === 'string'
  );
}

/**
 * Inline comment body. File-level anchors cite the location in text (`citeLine`, default the finding's line);
 * suggestions only apply to exact line anchors.
 */
export function renderFindingComment(f: Finding, opts: { anchor: Anchor; citeLine?: number }): string {
  const { anchor } = opts;
  const cite = anchor.kind === 'file' ? `\`${f.path}:${opts.citeLine ?? f.line}\` — ` : '';
  const parts = [`**[${f.severity} · ${f.category}] ${f.title}**`, `${cite}${f.body}`];
  if (f.suggestion !== undefined && anchor.kind === 'line' && !anchor.snapped) parts.push(fenced('suggestion', f.suggestion));
  const marker = findingMarker({ v: 1, severity: f.severity, category: f.category, fingerprint: fingerprint(f) });
  return `${neutraliseMarkers(parts.join('\n\n'))}\n\n${marker}`;
}

export function renderSummary(input: SummaryInput): string {
  const { review, open } = input;
  const sections: string[] = ['## Cura review', scoreLine(input.score, open, review.risk_note)];
  if (input.unresolved.length > 0) sections.push(unresolvedLine(input.unresolved));

  if (review.summary.trim()) sections.push(review.summary.trim());

  if (review.scopes.length > 0) {
    const lines = review.scopes.map((s) => `- **${s.name}** — ${s.files.length} files — ${oneLine(s.reviewer_notes)}`);
    sections.push(`### Scopes reviewed\n${lines.join('\n')}`);
  }

  if (review.files.length > 0) {
    const rows = review.files.map((f) => `| \`${cell(f.path)}\` | ${cell(f.overview)} |`);
    sections.push(`<details><summary>Files (${review.files.length})</summary>\n\n| File | Overview |\n| --- | --- |\n${rows.join('\n')}\n\n</details>`);
  }

  if (review.diagram.trim()) sections.push(`### Sequence diagram\n${fenced('mermaid', review.diagram.trim())}`);

  const tail: string[] = [];
  if (input.resolved.length > 0) {
    const lines = input.resolved.map((r) => `- [\`${r.path}\`](${r.url}) — ${oneLine(r.note)}`);
    tail.push(`### Resolved since last review\n${lines.join('\n')}`);
  }

  if (input.dismissed.length > 0) {
    const lines = input.dismissed.map((d) => `- [thread](${d.url}) — ${oneLine(d.reason)}`);
    tail.push(`### Dismissed\n${lines.join('\n')}`);
  }

  if (review.discarded.length > 0) {
    const lines = review.discarded.map((d) => `- \`${d.location}\` — ${oneLine(d.candidate)} — ${oneLine(d.reason)}`);
    tail.push(`<details><summary>Discarded (${review.discarded.length})</summary>\n\n${lines.join('\n')}\n\n</details>`);
  }

  if (input.unanchored > 0) {
    const noun = input.unanchored === 1 ? 'finding' : 'findings';
    tail.push(`> ⚠️ ${input.unanchored} ${noun} could not be anchored to the diff — see the job summary.`);
  }

  tail.push('---', footer(input));
  const body = [neutraliseMarkers(sections.join('\n\n')), openFindingsBlock(open), neutraliseMarkers(tail.join('\n\n'))].join('\n\n');
  return `${SUMMARY_MARKER}\n${body}\n\n<!-- cura:reviewed-sha=${input.headSha} -->\n`;
}

/** Keeps the previous summary (and its confidence line) visible, flagged as stale; replaces any earlier failure notice. */
export function renderFailure(input: { previousBody: string | null; runUrl: string; headSha: string }): string {
  const head = `${FAILED_MARKER}\n> ⚠️ Review failed for \`${short(input.headSha)}\` — [run](${input.runUrl}).`;
  if (input.previousBody === null) return `${SUMMARY_MARKER}\n## Cura review\n\n${head}\n`;
  const rest = input.previousBody.replace(SUMMARY_MARKER, '').replace(FAILURE_LINE_RE, '').replace(/^\n+/, '');
  return `${SUMMARY_MARKER}\n${head} Showing the previous result.\n\n${rest}`;
}

/**
 * The summary with only its score line and open-finding links recomputed; everything else, the reviewed-sha
 * marker included, is kept byte for byte. Null for a failed review's summary, which the next review replaces, and for
 * one without the open-findings markers (an older Cura's), whose links cannot be told from model text.
 */
export function rescoreSummary(body: string, score: number, open: OpenFindingLink[]): string | null {
  const line = SCORE_LINE_RE.exec(body);
  if (line === null || FAILURE_LINE_RE.test(body) || !body.includes(OPEN_START) || !body.includes(OPEN_END)) return null;
  const parts = line[1].split(' · ');
  const noteAt = parts.findIndex((p) => !COUNT_PART_RE.test(p));
  const riskNote = noteAt === -1 ? '' : parts.slice(noteAt).join(' · ');
  const rescored = keepOpenUnresolved(body.replace(SCORE_LINE_RE, () => neutraliseMarkers(scoreLine(score, open, riskNote))), open);
  const start = rescored.indexOf(OPEN_START);
  const end = rescored.indexOf(OPEN_END, start) + OPEN_END.length;
  return rescored.slice(0, start) + openFindingsBlock(open) + rescored.slice(end);
}

/** The open-finding links between Cura's markers, so a re-score replaces exactly them. */
function openFindingsBlock(open: OpenFindingLink[]): string {
  return [OPEN_START, ...severitySections(open).map(neutraliseMarkers), OPEN_END].join('\n\n');
}

/** Drops threads a human has since resolved from the unresolved warning; the re-score cannot know of new ones. */
function keepOpenUnresolved(body: string, open: OpenFindingLink[]): string {
  const openUrls = new Set(open.map((o) => o.url));
  return body.replace(UNRESOLVED_LINE_RE, (_line, links: string) => {
    const kept = [...links.matchAll(THREAD_LINK_RE)].filter((m) => openUrls.has(m[1])).map((m) => ({ url: m[1] }));
    return kept.length === 0 ? '' : `\n\n${neutraliseMarkers(unresolvedLine(kept))}`;
  });
}

function severitySections(open: OpenFindingLink[]): string[] {
  return SEVERITIES.flatMap((severity) => {
    const group = open.filter((o) => o.severity === severity);
    if (group.length === 0) return [];
    const links = group.map((o) => `- [\`${o.line === null ? o.path : `${o.path}:${o.line}`}\`](${o.url}) — **${oneLine(o.title)}**`);
    return [`### ${SEVERITY_HEADINGS[severity]}\n${links.join('\n')}`];
  });
}

function scoreLine(score: number, open: OpenFindingLink[], riskNote: string): string {
  const counts = countBySeverity(open);
  const parts = SEVERITIES.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`);
  if (parts.length === 0) parts.push('No open findings');
  if (riskNote.trim()) parts.push(oneLine(riskNote));
  return `**Confidence ${score}/5** — ${parts.join(' · ')}`;
}

function unresolvedLine(threads: { url: string }[]): string {
  const [noun, verb] = threads.length === 1 ? ['thread', 'counts'] : ['threads', 'count'];
  const links = threads.map((t) => `[thread](${t.url})`).join(', ');
  return `> ⚠️ ${threads.length} ${noun} Cura closed could not be resolved on GitHub and still ${verb} toward the score: ${links}.`;
}

function footer(input: SummaryInput): string {
  const mode = input.mode === 'incremental' && input.prevSha ? `incremental since \`${short(input.prevSha)}\`` : 'full PR';
  return (
    `<sub>Reviewed \`${short(input.headSha)}\` against \`${input.base}\` · ${mode} · ${input.review.files.length} files` +
    ` · [run](${input.runUrl}) · comment \`${input.rerun}\` to re-run · Cura ${/^\d/.test(input.version) ? `v${input.version}` : input.version}</sub>`
  );
}

/** A code fence one backtick longer than the longest backtick run in the content (at least three). */
function fenced(info: string, content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${content}\n${fence}`;
}

/** Model-authored text must not carry a Cura marker: parsers would read it as Cura's own. */
function neutraliseMarkers(text: string): string {
  return text.replace(CURA_MARKER_RE, '<!--$1cura-quoted:');
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim();
}

function cell(text: string): string {
  return oneLine(text).replace(/\|/g, '\\|');
}
