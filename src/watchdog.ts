import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The watchdog stops a Claude Code session that has gone silent, so a stalled review fails in minutes instead of
 * running to the job timeout. Silence is measured on the session transcripts Claude Code appends to as each
 * message, tool result and API retry lands, subagents included; a step's log shows none of that.
 */

/** File in the context dir the watchdog keeps current, for the publish step. */
export const WATCH_FILE = 'watchdog.json';

export interface WatchState {
  startedAt: string;
  /** Last transcript write, or the watchdog's start when nothing was written yet. */
  lastActivity: string;
  idleMinutes: number;
  /** True once the session was silent for idleMinutes. */
  stalled: boolean;
  /** Claude Code processes the watchdog stopped. */
  stopped: number;
  /** Claude Code's last API error since the start, as `<status> <message>`; null when there was none. */
  lastApiError: string | null;
}

export interface WatchDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Transcripts written at or after `since` (ms), newest first. */
  transcripts: (since: number) => Transcript[];
  findClaude: () => number[];
  kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  save: (state: WatchState) => void;
}

export interface Transcript {
  path: string;
  mtime: number;
}

/** How long a stopped session gets to exit on SIGTERM before it is killed. */
export const KILL_GRACE_MS = 10_000;

/** Polls until the session has been silent for `idleMs`, then stops it and returns. The caller kills it when the session ends. */
export async function watch(opts: { idleMs: number; pollMs: number }, deps: WatchDeps): Promise<WatchState> {
  const start = deps.now();
  for (;;) {
    await deps.sleep(opts.pollMs);
    const files = deps.transcripts(start);
    const last = Math.max(start, files[0]?.mtime ?? 0);
    const state: WatchState = {
      startedAt: new Date(start).toISOString(),
      lastActivity: new Date(last).toISOString(),
      idleMinutes: opts.idleMs / 60_000,
      stalled: deps.now() - last >= opts.idleMs,
      stopped: 0,
      lastApiError: lastApiError(files.map((f) => f.path)),
    };
    if (!state.stalled) {
      deps.save(state);
      continue;
    }
    const pids = deps.findClaude();
    for (const pid of pids) deps.kill(pid, 'SIGTERM');
    state.stopped = pids.length;
    deps.save(state);
    if (pids.length > 0) {
      await deps.sleep(KILL_GRACE_MS);
      for (const pid of deps.findClaude()) deps.kill(pid, 'SIGKILL');
    }
    return state;
  }
}

/** Every `*.jsonl` under `dir` written at or after `since`, newest first; none when `dir` is absent. */
export function transcriptsUnder(dir: string, since: number): Transcript[] {
  let names: string[];
  try {
    names = readdirSync(dir, { recursive: true, encoding: 'utf8' });
  } catch {
    return [];
  }
  const found: Transcript[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    try {
      const mtime = statSync(path).mtimeMs;
      if (mtime >= since) found.push({ path, mtime });
    } catch {
      // removed since the listing
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

const MAX_ERROR_LENGTH = 200;

interface TranscriptEntry {
  type?: unknown;
  subtype?: unknown;
  timestamp?: unknown;
  isApiErrorMessage?: unknown;
  error?: { status?: unknown; message?: unknown };
  retryAttempt?: unknown;
  maxRetries?: unknown;
  message?: { content?: unknown };
}

/**
 * The latest API error in the transcripts: a retried request (`system` / `api_error`) or the error Claude Code
 * gave up with (an assistant message flagged `isApiErrorMessage`). One line, so it can go in a log annotation.
 */
export function lastApiError(paths: string[]): string | null {
  let latest: { at: string; text: string } | null = null;
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('api_error') && !line.includes('"isApiErrorMessage":true')) continue;
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line) as TranscriptEntry;
      } catch {
        continue;
      }
      const described = describeApiError(entry);
      const at = typeof entry.timestamp === 'string' ? entry.timestamp : '';
      if (described !== null && (latest === null || at >= latest.at)) latest = { at, text: described };
    }
  }
  return latest?.text ?? null;
}

function describeApiError(entry: TranscriptEntry): string | null {
  let text: string;
  if (entry.type === 'system' && entry.subtype === 'api_error') {
    const status = typeof entry.error?.status === 'number' ? `${entry.error.status} ` : '';
    const message = typeof entry.error?.message === 'string' ? entry.error.message : 'unknown error';
    const retry = typeof entry.retryAttempt === 'number' && typeof entry.maxRetries === 'number' ? ` (retry ${entry.retryAttempt} of ${entry.maxRetries})` : '';
    text = `${status}${message}${retry}`;
  } else if (entry.type === 'assistant' && entry.isApiErrorMessage === true) {
    const content = entry.message?.content;
    const first = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined) : undefined;
    if (typeof first?.text !== 'string') return null;
    text = first.text;
  } else {
    return null;
  }
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_ERROR_LENGTH ? `${line.slice(0, MAX_ERROR_LENGTH - 1)}…` : line;
}

/**
 * Claude Code processes started by claude-code-action in this job: the `claude` processes under `procDir` whose
 * environment names this run and this runner's temp dir, so another job's session on a shared host is never
 * matched. Linux only; elsewhere there is no `procDir` and nothing is found.
 */
export function claudeProcesses(procDir: string, job: { runId: string; runnerTemp: string }): number[] {
  let entries: string[];
  try {
    entries = readdirSync(procDir);
  } catch {
    return [];
  }
  const wanted = ['CLAUDE_CODE_ENTRYPOINT=claude-code-github-action', `GITHUB_RUN_ID=${job.runId}`, `RUNNER_TEMP=${job.runnerTemp}`];
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(join(procDir, entry, 'comm'), 'utf8').trim() !== 'claude') continue;
      const env = new Set(readFileSync(join(procDir, entry, 'environ'), 'utf8').split('\0'));
      if (wanted.every((v) => env.has(v))) pids.push(Number(entry));
    } catch {
      // exited, or not ours to read
    }
  }
  return pids;
}

/** Written whole and renamed into place, so a reader never sees half a file. */
export function saveState(file: string, state: WatchState): void {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

export function minutes(n: number): string {
  return n === 1 ? '1 minute' : `${n} minutes`;
}

/** One log line on what the watchdog saw, for a review that did not succeed. */
export function describeWatch(state: WatchState): string {
  const error = state.lastApiError === null ? 'No API error was recorded.' : `Its last API error: ${state.lastApiError}.`;
  if (!state.stalled) return `Claude Code's last activity was at ${state.lastActivity}. ${error}`;
  const stopped = state.stopped > 0 ? 'so Cura stopped it' : 'and Cura found no Claude Code process to stop';
  return `Claude Code wrote nothing for ${minutes(state.idleMinutes)} (last activity ${state.lastActivity}), ${stopped}. ${error}`;
}
