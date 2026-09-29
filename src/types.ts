export type Severity = 'P0' | 'P1' | 'P2';
export type Category = 'correctness' | 'security' | 'data-loss' | 'performance' | 'contract' | 'convention' | 'test' | 'docs';
export interface Hunk { start: number; end: number }            // RIGHT-side, inclusive, 1-based
export type HunkMap = Record<string, Hunk[]>;                    // keyed by head path
export interface FileFact { path: string; status: 'added' | 'modified' | 'renamed' | 'deleted'; language: string; added: number; removed: number; dir: string }
export interface Scope { name: string; files: string[]; focus: string; context: string[] }
export interface Plan { scopes: Scope[] }
export interface ConfigScope { name: string; paths: string[]; focus?: string; context?: string[] }
export interface CuraConfig { instructions?: string; scopes?: ConfigScope[]; ignore?: string[]; min_severity?: Severity }
export interface Finding { status: 'new' | 'existing'; thread_id?: string; severity: Severity; category: Category; path: string; line: number; start_line?: number; title: string; body: string; suggestion?: string }
export interface Review {
  summary: string; risk_note: string;
  scopes: { name: string; files: string[]; reviewer_notes: string }[];
  files: { path: string; overview: string }[];
  diagram: string; findings: Finding[];
  resolved: { thread_id: string; note: string }[];
  dismissed: { thread_id: string; reason: string }[];
  discarded: { location: string; candidate: string; reason: string }[];
}
export interface FindingMeta { v: 1; severity: Severity; category: Category; fingerprint: string }
export interface Thread { id: string; commentId: number; url: string; path: string; line: number | null; originalLine: number | null; subjectType: 'LINE' | 'FILE'; isResolved: boolean; isOutdated: boolean; body: string; meta: FindingMeta; replies: { author: string; body: string }[] }
export interface CheckError { code: string; message: string; path?: string }
export type Anchor =
  | { kind: 'line'; path: string; line: number; start_line?: number; snapped: boolean }
  | { kind: 'file'; path: string }
  | { kind: 'none'; reason: string };
export interface ReviewFacts { reviewable: string[]; deleted: string[]; hunks: HunkMap; threads: Thread[] }
