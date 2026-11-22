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
  transcriptDir,
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

/**
 * A fake clock and process table. `writes` are transcript mtimes, visible once the clock reaches them; `alive` says
 * which pids exist at a time and whether a kill took. `watch` never returns, so sleep throws `until` ms after the start.
 */
function fakeDeps(opts: { until: number; writes?: number[]; alive?: (at: number, killed: Set<number>) => number[] }) {
  let clock = START;
  const killed = new Set<number>();
  const saved: { at: number; state: WatchState }[] = [];
  const kills: { at: number; pid: number; signal: string }[] = [];
  const logs: string[] = [];
  const deps: WatchDeps = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      if (clock - START > opts.until) throw new Error('end of test');
    },
    transcripts: (since) => ({
      dir: root,
      files: (opts.writes ?? [])
        .filter((t) => t >= since && t <= clock)
        .map((mtime): Transcript => ({ path: join(root, `${mtime - START}.jsonl`), mtime }))
        .sort((a, b) => b.mtime - a.mtime),
    }),
    findClaude: () => opts.alive?.(clock, killed) ?? [],
    kill: (pid, signal) => {
      kills.push({ at: clock - START, pid, signal });
      killed.add(pid);
    },
    save: (state) => void saved.push({ at: clock - START, state }),
    log: (line) => void logs.push(line),
  };
  const run = (idleMs: number) => expect(watch({ idleMs, pollMs: 30_000 }, deps)).rejects.toThrow('end of test');
  return { run, saved, kills, logs, last: () => saved.at(-1)!.state };
}

/** pid 942 runs until killed. */
const lead = (_at: number, killed: Set<number>) => (killed.has(942) ? [] : [942]);

describe('watch', () => {
  test('stops Claude Code once nothing has been written for the idle time', async () => {
    const fake = fakeDeps({ until: 6 * MINUTE, alive: lead });
    await fake.run(5 * MINUTE);
    expect(fake.kills).toEqual([{ at: 5 * MINUTE, pid: 942, signal: 'SIGTERM' }]);
    expect(fake.last()).toEqual({
      startedAt: '2026-11-22T05:01:47.000Z',
      lastActivity: '2026-11-22T05:01:47.000Z',
      idleMinutes: 5,
      stalled: true,
      stopped: 1,
      lastApiError: null,
    });
    expect(fake.saved.filter((s) => s.at < 5 * MINUTE).every((s) => !s.state.stalled)).toBe(true);
  });

  test('each transcript write restarts the idle time', async () => {
    const fake = fakeDeps({ until: 14 * MINUTE, writes: [START + 4 * MINUTE, START + 8 * MINUTE], alive: lead });
    await fake.run(5 * MINUTE);
    expect(fake.kills.map((k) => k.at)).toEqual([13 * MINUTE]);
    expect(fake.last().lastActivity).toBe(new Date(START + 8 * MINUTE).toISOString());
  });

  test('kills a process that outlives SIGTERM', async () => {
    const fake = fakeDeps({ until: 2 * MINUTE, alive: () => [942] });
    await fake.run(MINUTE);
    expect(fake.kills.slice(0, 2)).toEqual([
      { at: MINUTE, pid: 942, signal: 'SIGTERM' },
      { at: MINUTE + KILL_GRACE_MS, pid: 942, signal: 'SIGKILL' },
    ]);
  });

  test('keeps watching after a stall, so the next Claude step is watched too', async () => {
    // The /code-review session (942) stalls at once; the lead (943) starts at 6 min, writes at 7 min, then stalls.
    const alive = (at: number, killed: Set<number>) => [...(killed.has(942) ? [] : [942]), ...(at >= START + 6 * MINUTE && !killed.has(943) ? [943] : [])];
    const fake = fakeDeps({ until: 20 * MINUTE, writes: [START + 7 * MINUTE], alive });
    await fake.run(5 * MINUTE);
    expect(fake.kills.map((k) => [k.at, k.pid, k.signal])).toEqual([
      [5 * MINUTE, 942, 'SIGTERM'],
      // Polls run 30 s apart from the end of the first stall's grace period.
      [12 * MINUTE + KILL_GRACE_MS, 943, 'SIGTERM'],
    ]);
    expect(fake.last()).toMatchObject({ stalled: true, stopped: 1, lastActivity: new Date(START + 7 * MINUTE).toISOString() });
  });

  test('a new write clears the stall, so a later failure is not blamed on it', async () => {
    const fake = fakeDeps({ until: 7 * MINUTE, writes: [START + 6 * MINUTE], alive: lead });
    await fake.run(5 * MINUTE);
    expect(fake.saved.some((s) => s.state.stalled)).toBe(true);
    expect(fake.last()).toMatchObject({ stalled: false, lastActivity: new Date(START + 6 * MINUTE).toISOString() });
  });

  test('keeps the record of a stall it acted on when a later window finds nothing to stop', async () => {
    const fake = fakeDeps({ until: 20 * MINUTE, alive: lead });
    await fake.run(5 * MINUTE);
    expect(fake.kills).toHaveLength(1);
    expect(fake.last()).toMatchObject({ stalled: true, stopped: 1 });
    expect(fake.saved.filter((s) => s.at > 5 * MINUTE)).toEqual([]);
  });

  test('logs the directory, each new transcript and the last activity on every poll, and each stall', async () => {
    const fake = fakeDeps({ until: 2 * MINUTE, writes: [START + 30_000, START + 60_000], alive: lead });
    await fake.run(MINUTE);
    const t = (ms: number) => new Date(START + ms).toISOString();
    expect(fake.logs).toEqual([
      `${t(30_000)} transcript ${join(root, '30000.jsonl')}`,
      `${t(30_000)} dir=${root} transcripts=1 lastActivity=${t(30_000)}`,
      `${t(60_000)} transcript ${join(root, '60000.jsonl')}`,
      `${t(60_000)} dir=${root} transcripts=2 lastActivity=${t(60_000)}`,
      `${t(90_000)} dir=${root} transcripts=2 lastActivity=${t(60_000)}`,
      `${t(120_000)} dir=${root} transcripts=2 lastActivity=${t(60_000)}`,
      `${t(120_000)} silent for 1 minute: stopped 1 Claude Code process(es)`,
    ]);
  });

  test('records a stall it cannot stop', async () => {
    const fake = fakeDeps({ until: 2 * MINUTE });
    await fake.run(MINUTE);
    expect(fake.kills).toEqual([]);
    expect(fake.last()).toMatchObject({ stalled: true, stopped: 0 });
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

  test("watches the job's own session directory once it exists, the whole projects dir until then", () => {
    const projects = join(root, 'projects');
    const workspace = '/_work/github-runner-a/Onus/Onus';
    expect(transcriptDir(projects, workspace)).toBe(projects);
    mkdirSync(join(projects, '--work-github-runner-a-Onus-Onus'), { recursive: true });
    expect(transcriptDir(projects, workspace)).toBe(join(projects, '--work-github-runner-a-Onus-Onus'));
    expect(transcriptDir(projects, '/home/runner/work/my.repo/my.repo')).toBe(projects);
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
