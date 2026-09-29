import type { Io } from '../src/cli.ts';

/** Recording `Io` for driving `main()`: stdout lines and exit codes are captured. */
export function makeIo() {
  const out: string[] = [];
  const codes: number[] = [];
  const io: Io = { stdout: (s) => void out.push(s), exit: (code) => void codes.push(code) };
  return {
    io,
    text: () => out.join('\n'),
    code: () => codes.at(-1) ?? 0,
  };
}
