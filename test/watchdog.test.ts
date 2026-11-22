import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  claudeProcesses,
  describeWatch,
  KILL_GRACE_MS,
  lastApiError,
  saveState,
  transcriptsUnder,
  watch,
  type Transcript,
  type WatchDeps,
  type WatchState,
} from '../src/watchdog.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cura-watchdog-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const MINUTE = 60_000;
const START = Date.parse('2026-11-22T05:01:47Z');

/** A fake clock and process table: `writes` are transcript mtimes, visible once the clock reaches them. */
function fakeDeps(opts: { writes?: number[]; pids?: number[]; survivors?: number[] } = {}) {
  let clock = START;
  let killed = false;
  const saved: WatchState[] = [];
  const kills: [number, string][] = [];
  const deps: WatchDeps = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    transcripts: (since) =>
      (opts.writes ?? [])
        .filter((t) => t >= since && t <= clock)
        .map((mtime): Transcript => ({ path: join(root, 'none.jsonl'), mtime }))
        .sort((a, b) => b.mtime - a.mtime),
    findClaude: () => (killed ? (opts.survivors ?? []) : (opts.pids ?? [])),
    kill: (pid, signal) => {
      kills.push([pid, signal]);
      killed = true;
    },
    save: (state) => void saved.push(state),
  };
  return { deps, saved, kills, elapsed: () => clock - START };
}

describe('watch', () => {
  test('stops Claude Code once nothing has been written for the idle time', async () => {
    const { deps, saved, kills, elapsed } = fakeDeps({ pids: [942] });
    const state = await watch({ idleMs: 5 * MINUTE, pollMs: 30_000 }, deps);
    expect(elapsed()).toBe(5 * MINUTE + KILL_GRACE_MS);
    expect(state).toEqual({
      startedAt: '2026-11-22T05:01:47.000Z',
      lastActivity: '2026-11-22T05:01:47.000Z',
      idleMinutes: 5,
      stalled: true,
      stopped: 1,
      lastApiError: null,
    });
    expect(kills).toEqual([[942, 'SIGTERM']]);
    expect(saved.at(-1)).toEqual(state);
    expect(saved.slice(0, -1).every((s) => !s.stalled)).toBe(true);
  });

  test('each transcript write restarts the idle time', async () => {
    const writes = [START + 4 * MINUTE, START + 8 * MINUTE];
    const { deps, elapsed } = fakeDeps({ writes, pids: [942] });
    const state = await watch({ idleMs: 5 * MINUTE, pollMs: 30_000 }, deps);
    expect(state.lastActivity).toBe(new Date(START + 8 * MINUTE).toISOString());
    expect(elapsed()).toBe(13 * MINUTE + KILL_GRACE_MS);
  });

  test('kills a process that outlives SIGTERM', async () => {
    const { deps, kills } = fakeDeps({ pids: [942], survivors: [942] });
    await watch({ idleMs: MINUTE, pollMs: 30_000 }, deps);
    expect(kills).toEqual([
      [942, 'SIGTERM'],
      [942, 'SIGKILL'],
    ]);
  });

  test('reports a stall it cannot stop, and returns without waiting', async () => {
    const { deps, kills, elapsed } = fakeDeps();
    const state = await watch({ idleMs: MINUTE, pollMs: 30_000 }, deps);
    expect(state).toMatchObject({ stalled: true, stopped: 0 });
    expect(kills).toEqual([]);
    expect(elapsed()).toBe(MINUTE);
  });
});

describe('transcriptsUnder', () => {
  test('lists transcripts written since the start, subagents included, newest first', () => {
    const session = join(root, 'projects', '-work-repo');
    mkdirSync(join(session, 'abc', 'subagents'), { recursive: true });
    const file = (path: string, at: number) => {
      writeFileSync(path, '{}\n');
      utimesSync(path, at / 1000, at / 1000);
    };
    file(join(session, 'old.jsonl'), START - MINUTE);
    file(join(session, 'abc.jsonl'), START + MINUTE);
    file(join(session, 'abc', 'subagents', 'agent-1.jsonl'), START + 2 * MINUTE);
    file(join(session, 'notes.txt'), START + 3 * MINUTE);
    expect(transcriptsUnder(join(root, 'projects'), START).map((t) => [t.path, t.mtime])).toEqual([
      [join(session, 'abc', 'subagents', 'agent-1.jsonl'), START + 2 * MINUTE],
      [join(session, 'abc.jsonl'), START + MINUTE],
    ]);
  });

  test('finds nothing when the directory does not exist', () => {
    expect(transcriptsUnder(join(root, 'missing'), START)).toEqual([]);
  });
});

describe('lastApiError', () => {
  const retry = (at: string, status: number, message: string, attempt: number) =>
    JSON.stringify({ type: 'system', subtype: 'api_error', level: 'error', timestamp: at, error: { status, message }, retryAttempt: attempt, maxRetries: 10 });

  test('reports the latest retried request across transcripts', () => {
    const lead = join(root, 'lead.jsonl');
    const agent = join(root, 'agent.jsonl');
    writeFileSync(lead, [JSON.stringify({ type: 'user', timestamp: '2026-11-22T05:01:48Z' }), retry('2026-11-22T05:02:00Z', 529, 'Overloaded', 1)].join('\n'));
    writeFileSync(agent, retry('2026-11-22T05:03:00Z', 429, 'rate_limit_error: too many\nrequests', 2));
    expect(lastApiError([lead, agent])).toBe('429 rate_limit_error: too many requests (retry 2 of 10)');
  });

  test('reports the error Claude Code gave up with', () => {
    const path = join(root, 'lead.jsonl');
    const gaveUp = { type: 'assistant', isApiErrorMessage: true, timestamp: '2026-11-22T05:04:00Z', message: { content: [{ type: 'text', text: 'API Error: 500 Internal server error' }] } };
    writeFileSync(path, [retry('2026-11-22T05:03:00Z', 500, 'Internal server error', 10), JSON.stringify(gaveUp)].join('\n'));
    expect(lastApiError([path])).toBe('API Error: 500 Internal server error');
  });

  test('shortens a long message to one line', () => {
    const path = join(root, 'lead.jsonl');
    writeFileSync(path, retry('2026-11-22T05:03:00Z', 503, 'x'.repeat(500), 1));
    const error = lastApiError([path])!;
    expect(error).toHaveLength(200);
    expect(error.endsWith('…')).toBe(true);
  });

  test('is null without API errors, and skips unreadable lines and files', () => {
    const path = join(root, 'lead.jsonl');
    writeFileSync(path, ['{"type":"user"}', 'not json api_error', ''].join('\n'));
    expect(lastApiError([path, join(root, 'missing.jsonl')])).toBeNull();
  });
});

describe('claudeProcesses', () => {
  const job = { runId: '44987545243', runnerTemp: '/_work/runner-a/_temp' };
  const ours = ['CLAUDE_CODE_ENTRYPOINT=claude-code-github-action', 'GITHUB_RUN_ID=44987545243', 'RUNNER_TEMP=/_work/runner-a/_temp', 'HOME=/root'];

  function proc(pid: string, comm: string, env: string[]) {
    mkdirSync(join(root, pid));
    writeFileSync(join(root, pid, 'comm'), `${comm}\n`);
    writeFileSync(join(root, pid, 'environ'), `${env.join('\0')}\0`);
  }

  test("finds only this job's Claude Code processes", () => {
    proc('942', 'claude', ours);
    proc('755', 'bun', ours);
    proc('1001', 'claude', ours.map((v) => v.replace('runner-a', 'runner-b')));
    proc('1002', 'claude', ours.filter((v) => !v.startsWith('CLAUDE_CODE_ENTRYPOINT=')));
    mkdirSync(join(root, '1003'));
    mkdirSync(join(root, 'self'));
    expect(claudeProcesses(root, job)).toEqual([942]);
  });

  test('finds nothing without a proc directory', () => {
    expect(claudeProcesses(join(root, 'missing'), job)).toEqual([]);
  });
});

describe('state', () => {
  const state: WatchState = {
    startedAt: '2026-11-22T05:01:47.000Z',
    lastActivity: '2026-11-22T05:02:10.000Z',
    idleMinutes: 5,
    stalled: true,
    stopped: 1,
    lastApiError: '529 Overloaded (retry 3 of 10)',
  };

  test('is saved whole', () => {
    const file = join(root, 'watchdog.json');
    saveState(file, state);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(state);
  });

  test('describes a stall, an unstoppable stall and a session that did not stall', () => {
    expect(describeWatch(state)).toBe(
      'Claude Code wrote nothing for 5 minutes (last activity 2026-11-22T05:02:10.000Z), so Cura stopped it. Its last API error: 529 Overloaded (retry 3 of 10).',
    );
    expect(describeWatch({ ...state, stopped: 0, lastApiError: null })).toBe(
      'Claude Code wrote nothing for 5 minutes (last activity 2026-11-22T05:02:10.000Z), and Cura found no Claude Code process to stop. No API error was recorded.',
    );
    expect(describeWatch({ ...state, stalled: false, stopped: 0 })).toBe(
      "Claude Code's last activity was at 2026-11-22T05:02:10.000Z. Its last API error: 529 Overloaded (retry 3 of 10).",
    );
  });
});
